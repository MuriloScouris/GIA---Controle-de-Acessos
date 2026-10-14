import { POLITICA_EXECUCAO_PADRAO, type Operacao, type PoliticaExecucao } from '@gia/dominio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErroDeConcorrencia } from '../erros.js';
import type { RepositoriosComFila } from '../portas.js';
import { criarPersistenciaPostgres } from '../postgres/persistencia-postgres.js';
import {
  criarBancoDeTeste,
  TEM_BANCO,
  TEMPO_BANCO_MS,
  type BancoDeTeste,
} from '../teste/banco-de-teste.js';
import { cenario, ctxServico, depois, INICIO, operacao, type Cenario } from '../teste/fabricas.js';
import type { UnidadeDeTrabalho } from '../unidade-de-trabalho.js';
import { recuperarLeasesExpirados, renovarLeaseDaOperacao, reservarLote } from './lease.js';

let banco: BancoDeTeste;
let persistencia: UnidadeDeTrabalho<RepositoriosComFila>;
const LEASE = POLITICA_EXECUCAO_PADRAO.duracaoLeaseMs;

beforeAll(async () => {
  banco = await criarBancoDeTeste();
}, TEMPO_BANCO_MS);
afterAll(async () => {
  await banco?.descartar();
}, TEMPO_BANCO_MS);

/** Cada teste usa um banco limpo de operações: a fila é global. */
async function filaLimpa(): Promise<void> {
  await banco.db.deleteFrom('operacoes').execute();
  persistencia = criarPersistenciaPostgres(banco.db);
}

function politica(lote: number): PoliticaExecucao {
  return { ...POLITICA_EXECUCAO_PADRAO, lotePorWorker: lote };
}

async function gravar(c: Cenario, operacoes: readonly Operacao[]): Promise<void> {
  await persistencia.executar(async (tx) => {
    await tx.colaboradores.salvar(c.colaborador);
    await tx.pedidos.salvar(c.pedido);
    await tx.revisoes.salvar(c.revisao);
    await tx.itens.salvar(Object.values(c.itens));
    await tx.operacoes.salvar(operacoes);
  });
}

/** Várias operações independentes (um cenário por operação, para não colidir item ativo). */
async function pendentes(quantidade: number): Promise<Operacao[]> {
  const ops: Operacao[] = [];
  for (let i = 0; i < quantidade; i += 1) {
    const c = cenario();
    const op = operacao(c.itens.jira, { disponivelEm: depois(-1000 * (quantidade - i)) });
    await gravar(c, [op]);
    ops.push(op);
  }
  return ops;
}

async function lerOperacao(id: string): Promise<Operacao> {
  const op = await persistencia.executar((tx) => tx.fila.operacaoPorId(id));
  if (op === null) throw new Error('operação sumiu');
  return op;
}

describe.skipIf(!TEM_BANCO)('lease: reserva', { timeout: TEMPO_BANCO_MS }, () => {
  it('reserva as disponíveis em ordem, até o lote, com lease, tentativa e evento', async () => {
    await filaLimpa();
    const ops = await pendentes(3);
    const futura = cenario();
    await gravar(futura, [operacao(futura.itens.jira, { disponivelEm: depois(60_000) })]);

    const { reservadas, recusadas } = await reservarLote(persistencia, politica(2), ctxServico());
    expect(recusadas).toEqual([]);
    expect(reservadas.map((o) => o.id)).toEqual([ops[0]!.id, ops[1]!.id]);
    const gravada = await lerOperacao(ops[0]!.id);
    expect(gravada).toMatchObject({
      status: 'reservada',
      tentativas: 1,
      versao: 2,
      lease: { workerId: 'worker-1', reservadaEm: INICIO, expiraEm: depois(LEASE) },
    });
    const eventos = await persistencia.executar((tx) => tx.eventos.porTipo('operacaoReservada'));
    expect(eventos.filter((e) => e.operacaoId === ops[0]!.id)).toHaveLength(1);

    // A seguinte pega a que sobrou; a futura ainda não está disponível.
    const segunda = await reservarLote(persistencia, politica(10), ctxServico(INICIO, 'worker-2'));
    expect(segunda.reservadas.map((o) => o.id)).toEqual([ops[2]!.id]);
  });

  it('operação cuja dependência não está confirmada fica na fila', async () => {
    await filaLimpa();
    const c = cenario();
    const m365 = operacao(c.itens.m365, { dependeDeItemId: c.itens.ad.id });
    await gravar(c, [m365]);
    expect((await reservarLote(persistencia, politica(10), ctxServico())).reservadas).toEqual([]);

    await persistencia.executar((tx) =>
      tx.itens.salvar([{ ...c.itens.ad, status: 'confirmado', versao: 2 }]),
    );
    const { reservadas } = await reservarLote(persistencia, politica(10), ctxServico());
    expect(reservadas.map((o) => o.id)).toEqual([m365.id]);
  });

  it('consumidores concorrentes nunca recebem a mesma operação (SKIP LOCKED)', async () => {
    await filaLimpa();
    const ops = await pendentes(4);
    const outra = criarPersistenciaPostgres(banco.outraConexao());

    // A primeira transação trava as duas primeiras e ainda não terminou.
    let liberar!: () => void;
    const segura = new Promise<void>((r) => {
      liberar = r;
    });
    let travou!: (ids: string[]) => void;
    const travadas = new Promise<string[]>((r) => {
      travou = r;
    });
    const primeira = persistencia.executar(async (tx) => {
      const candidatas = await tx.fila.reservaveis({ agora: INICIO, limite: 2 });
      travou(candidatas.map((o) => o.id));
      await segura;
    });
    expect(await travadas).toEqual([ops[0]!.id, ops[1]!.id]);

    // A segunda não espera nem repete as travadas: pega as demais.
    const segunda = await reservarLote(outra, politica(10), ctxServico(INICIO, 'worker-2'));
    expect(segunda.reservadas.map((o) => o.id)).toEqual([ops[2]!.id, ops[3]!.id]);
    liberar();
    await primeira;
  });

  it('muitos workers ao mesmo tempo: cada operação é reservada exatamente uma vez', async () => {
    await filaLimpa();
    const ops = await pendentes(12);
    const conexoes = [persistencia, criarPersistenciaPostgres(banco.outraConexao())];
    const lotes = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        reservarLote(conexoes[i % 2]!, politica(3), ctxServico(INICIO, `worker-${i}`)),
      ),
    );
    const ids = lotes.flatMap((l) => l.reservadas.map((o) => o.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(ops.map((o) => o.id).sort());
  });
});

describe.skipIf(!TEM_BANCO)('lease: renovação', { timeout: TEMPO_BANCO_MS }, () => {
  it('só o dono renova, e só antes de vencer', async () => {
    await filaLimpa();
    const [op] = await pendentes(1);
    await reservarLote(persistencia, politica(1), ctxServico());

    const meio = depois(POLITICA_EXECUCAO_PADRAO.renovacaoLeaseMs);
    const renovada = await renovarLeaseDaOperacao(
      persistencia,
      op!.id,
      POLITICA_EXECUCAO_PADRAO,
      ctxServico(meio),
    );
    expect(renovada.ok && renovada.valor.lease?.expiraEm).toBe(depois(LEASE, meio));

    const intruso = await renovarLeaseDaOperacao(
      persistencia,
      op!.id,
      POLITICA_EXECUCAO_PADRAO,
      ctxServico(meio, 'worker-intruso'),
    );
    expect(!intruso.ok && intruso.erro.codigo).toBe('LEASE_INVALIDO');

    const vencido = await renovarLeaseDaOperacao(
      persistencia,
      op!.id,
      POLITICA_EXECUCAO_PADRAO,
      ctxServico(depois(LEASE + 1, meio)),
    );
    expect(!vencido.ok && vencido.erro.codigo).toBe('LEASE_INVALIDO');
  });

  it('renovação que perde a corrida para a recuperação do lease é recusada', async () => {
    await filaLimpa();
    const [op] = await pendentes(1);
    await reservarLote(persistencia, politica(1), ctxServico());
    const lidaAntes = await lerOperacao(op!.id);

    const expirado = depois(LEASE + 1);
    await recuperarLeasesExpirados(persistencia, 10, ctxServico(expirado, 'worker-2'));
    // O worker 1 ainda tinha a versão antiga em mãos e tenta gravá-la.
    await expect(
      persistencia.executar((tx) =>
        tx.operacoes.salvar([{ ...lidaAntes, versao: lidaAntes.versao + 1 }]),
      ),
    ).rejects.toBeInstanceOf(ErroDeConcorrencia);
    expect((await lerOperacao(op!.id)).status).toBe('pendente');
  });
});

describe.skipIf(!TEM_BANCO)(
  'lease: recuperação de lease vencido',
  { timeout: TEMPO_BANCO_MS },
  () => {
    it('leitura ou simulação volta para a fila; escrita real vai para reconciliação', async () => {
      await filaLimpa();
      const simulada = cenario();
      const opSimulada = operacao(simulada.itens.jira);
      await gravar(simulada, [opSimulada]);
      const real = cenario();
      const itemReal = { ...real.itens.ad, status: 'emExecucao' as const };
      const opReal = operacao(itemReal, { modo: 'real', acao: 'provisionar' });
      await gravar({ ...real, itens: { ...real.itens, ad: itemReal } }, [opReal]);

      await reservarLote(persistencia, politica(10), ctxServico());
      const ainda = await recuperarLeasesExpirados(persistencia, 10, ctxServico(depois(LEASE - 1)));
      expect(ainda).toEqual({ reagendadas: [], paraReconciliacao: [], recusadas: [] });

      const expirado = depois(LEASE);
      const r = await recuperarLeasesExpirados(persistencia, 10, ctxServico(expirado, 'worker-2'));
      expect(r.recusadas).toEqual([]);
      expect(r.reagendadas.map((o) => o.id)).toEqual([opSimulada.id]);
      expect(r.paraReconciliacao.map((o) => o.id)).toEqual([opReal.id]);

      expect(await lerOperacao(opSimulada.id)).toMatchObject({
        status: 'pendente',
        lease: null,
        disponivelEm: expirado,
      });
      expect(await lerOperacao(opReal.id)).toMatchObject({
        status: 'aguardandoReconciliacao',
        lease: null,
        efeito: 'desconhecido',
      });
      const [itemGravado] = (
        await persistencia.executar((tx) => tx.itens.doPedido(real.pedido.id))
      ).filter((i) => i.id === itemReal.id);
      expect(itemGravado?.status).toBe('desconhecido');

      // A reagendada pode ser reservada de novo, pela segunda tentativa.
      const nova = await reservarLote(persistencia, politica(10), ctxServico(expirado, 'worker-3'));
      expect(nova.reservadas.map((o) => [o.id, o.tentativas])).toEqual([[opSimulada.id, 2]]);
    });
  },
);
