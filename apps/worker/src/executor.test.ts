import { criarCatalogoSimulado } from '@gia/conectores';
import {
  POLITICA_EXECUCAO_PADRAO,
  type Instante,
  type Operacao,
  type PoliticaExecucao,
  type TipoEvento,
} from '@gia/dominio';
import {
  criarPersistenciaPostgres,
  ErroDeConcorrencia,
  type RepositoriosComFila,
  type UnidadeDeTrabalho,
} from '@gia/persistencia';
import {
  criarBancoDeTeste,
  TEM_BANCO,
  TEMPO_BANCO_MS,
  type BancoDeTeste,
} from '@gia/persistencia/teste';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CODIGO_ACAO_NAO_SUPORTADA,
  CODIGO_ERRO_NO_CONECTOR,
  criarExecutor,
  type DependenciasExecutor,
  type Executor,
} from './executor.js';
import {
  agendadorManual,
  cenario,
  conectoresProgramados,
  depois,
  gravar,
  INICIO,
  operacao,
  resultado,
  type ConectoresProgramados,
} from './teste/fabricas.js';

let banco: BancoDeTeste;
let persistencia: UnidadeDeTrabalho<RepositoriosComFila>;
let agora: Instante;
const LEASE = POLITICA_EXECUCAO_PADRAO.duracaoLeaseMs;

beforeAll(async () => {
  if (!TEM_BANCO) return;
  banco = await criarBancoDeTeste();
  persistencia = criarPersistenciaPostgres(banco.db);
}, TEMPO_BANCO_MS);
afterAll(async () => {
  await banco?.descartar();
}, TEMPO_BANCO_MS);

/** A fila é global: cada teste começa sem nada reservável (operações não podem ser apagadas). */
beforeEach(async () => {
  agora = INICIO;
  if (!TEM_BANCO) return;
  await sql`
    update operacoes
    set status = 'cancelada', lease_worker_id = null, lease_expira_em = null,
        dados = dados || '{"status": "cancelada", "lease": null}'::jsonb
    where status in ('pendente', 'reservada')
  `.execute(banco.db);
});

function executor(
  conectores: DependenciasExecutor['conectores'],
  mudancas: Partial<DependenciasExecutor> = {},
): Executor {
  return criarExecutor({
    persistencia,
    conectores,
    politica: POLITICA_EXECUCAO_PADRAO,
    workerId: 'worker-1',
    agora: () => agora,
    novoId: randomUUID,
    sortearJitter: () => 0,
    agendar: () => () => undefined,
    ...mudancas,
  });
}

async function ler(id: string): Promise<Operacao> {
  const op = await persistencia.executar((tx) => tx.fila.operacaoPorId(id));
  if (op === null) throw new Error('operação sumiu');
  return op;
}

async function item(id: string) {
  const lido = await persistencia.executar((tx) => tx.fila.itemPorId(id));
  if (lido === null) throw new Error('item sumiu');
  return lido;
}

async function pedido(id: string) {
  return persistencia.executar((tx) => tx.pedidos.porId(id));
}

async function eventos(tipo: TipoEvento, operacaoId: string) {
  const todos = await persistencia.executar((tx) => tx.eventos.porTipo(tipo));
  return todos.filter((e) => e.operacaoId === operacaoId);
}

function chamadasDe(programados: ConectoresProgramados, operacaoId: string) {
  return programados.chamadas.filter((c) => c.ctx.operacaoId === operacaoId);
}

describe.skipIf(!TEM_BANCO)('worker: execução', { timeout: TEMPO_BANCO_MS }, () => {
  it('simulação pelos conectores simulados: operações concluídas, itens intactos (regra 9)', async () => {
    const catalogo = criarCatalogoSimulado({
      agora: () => agora,
      jira: { grupos: ['jira-servicedesk-users'] },
      softexpert: { areas: ['Tecnologia'], funcoes: ['Analista'], grupos: ['Leitores'] },
      docusign: { perfis: ['Remetente'], grupos: ['Tecnologia'] },
    });
    const c = cenario(['jira', 'softexpert', 'docusign'], { modo: 'simulado' });
    const ops = (['jira', 'softexpert', 'docusign'] as const).map((s) => operacao(c, s));
    await gravar(persistencia, c, ops);

    const relatorio = await executor(catalogo.conectores).processarLote();
    expect(relatorio.reservadas).toBe(3);
    expect(relatorio.desfechos.map((d) => d.tipo)).toEqual([
      'registrada',
      'registrada',
      'registrada',
    ]);
    for (const op of ops) {
      expect(await ler(op.id)).toMatchObject({
        status: 'concluida',
        efeito: 'confirmado',
        lease: null,
        tentativas: 1,
      });
      expect(await eventos('operacaoResultadoRegistrado', op.id)).toHaveLength(1);
    }
    for (const original of Object.values(c.itens)) {
      expect(await item(original.id)).toEqual(original);
    }
    expect((await pedido(c.pedido.id))?.status).toBe('aprovado');
    // O simulador do destino recebeu a conta, com o grupo pedido.
    const parametrosJira = c.itens.jira!.parametros as { readonly email: string };
    expect(catalogo.simuladores.jira.usuario(parametrosJira.email)?.grupos).toEqual([
      'jira-servicedesk-users',
    ]);
  });

  it('escrita real confirmada: item confirmado e pedido consolidado', async () => {
    const programados = conectoresProgramados();
    const c = cenario(['jira']);
    const op = operacao(c, 'jira');
    await gravar(persistencia, c, [op]);

    await executor(programados.conectores).processarLote();
    expect(chamadasDe(programados, op.id).map((ch) => ch.ctx)).toEqual([
      {
        operacaoId: op.id,
        itemId: c.itens.jira!.id,
        chaveIdempotencia: op.chaveIdempotencia,
        modo: 'real',
        parametros: c.itens.jira!.parametros,
        etapaInicial: null,
      },
    ]);
    expect(await ler(op.id)).toMatchObject({ status: 'concluida', efeito: 'confirmado' });
    expect(await item(c.itens.jira!.id)).toMatchObject({
      status: 'confirmado',
      idExterno: 'ext-jira',
      ultimaOperacaoId: op.id,
      confirmadoEm: INICIO,
    });
    expect((await pedido(c.pedido.id))?.status).toBe('concluido');
    const mudancas = await persistencia.executar((tx) =>
      tx.eventos.porTipo('statusPedidoAlterado'),
    );
    expect(mudancas.filter((e) => e.pedidoId === c.pedido.id)).toHaveLength(1);
  });

  it('M365 só roda depois de o AD ser confirmado', async () => {
    const programados = conectoresProgramados();
    const c = cenario(['ad', 'm365']);
    const ad = operacao(c, 'ad');
    const m365 = operacao(c, 'm365');
    await gravar(persistencia, c, [ad, m365]);

    const primeiro = await executor(programados.conectores).processarLote();
    expect(primeiro.reservadas).toBe(1);
    expect(programados.chamadas.map((ch) => ch.sistema)).toEqual(['ad']);
    const segundo = await executor(programados.conectores).processarLote();
    expect(segundo.reservadas).toBe(1);
    expect(programados.chamadas.map((ch) => ch.sistema)).toEqual(['ad', 'm365']);
    expect((await item(c.itens.m365!.id)).status).toBe('confirmado');
    expect((await pedido(c.pedido.id))?.status).toBe('concluido');
  });

  it('ação que o worker não executa é encerrada sem chamar o conector', async () => {
    const programados = conectoresProgramados();
    const c = cenario(['jira']);
    const op = operacao(c, 'jira', { acao: 'validar' });
    await gravar(persistencia, c, [op]);

    await executor(programados.conectores).processarLote();
    expect(programados.chamadas).toEqual([]);
    expect(await ler(op.id)).toMatchObject({
      status: 'concluida',
      efeito: 'semEfeito',
      codigo: CODIGO_ACAO_NAO_SUPORTADA,
    });
    expect((await item(c.itens.jira!.id)).status).toBe('emExecucao');
  });
});

describe.skipIf(!TEM_BANCO)('worker: falhas', { timeout: TEMPO_BANCO_MS }, () => {
  it('falha transitória volta à fila com backoff e a nova tentativa retoma da etapa seguinte', async () => {
    const programados = conectoresProgramados();
    programados.programar('ad', () =>
      resultado('ad', 'semEfeito', { etapa: 'definirSenha', codigo: 'LIMITE', transitorio: true }),
    );
    const c = cenario(['ad']);
    const op = operacao(c, 'ad');
    await gravar(persistencia, c, [op]);
    const w = executor(programados.conectores);

    await w.processarLote();
    const backoff = POLITICA_EXECUCAO_PADRAO.backoffMs[0]!;
    expect(await ler(op.id)).toMatchObject({
      status: 'pendente',
      lease: null,
      tentativas: 1,
      etapaAlcancada: 'definirSenha',
      disponivelEm: depois(backoff),
    });
    // Antes do backoff ninguém pega a operação.
    expect((await w.processarLote()).reservadas).toBe(0);

    agora = depois(backoff);
    await w.processarLote();
    const tentativas = chamadasDe(programados, op.id);
    expect(tentativas.map((ch) => ch.ctx.etapaInicial)).toEqual([null, 'habilitarConta']);
    expect(new Set(tentativas.map((ch) => ch.ctx.chaveIdempotencia))).toEqual(
      new Set([op.chaveIdempotencia]),
    );
    expect(await ler(op.id)).toMatchObject({ status: 'concluida', tentativas: 2 });
    expect((await item(c.itens.ad!.id)).status).toBe('confirmado');
  });

  it('falha definitiva: item falhou, dependente M365 cancelado e pedido concluído com erros', async () => {
    const programados = conectoresProgramados();
    programados.programar('ad', () => resultado('ad', 'semEfeito', { codigo: 'OU_INEXISTENTE' }));
    const c = cenario(['ad', 'm365']);
    const ad = operacao(c, 'ad');
    const m365 = operacao(c, 'm365');
    await gravar(persistencia, c, [ad, m365]);

    await executor(programados.conectores).processarLote();
    expect(await ler(ad.id)).toMatchObject({ status: 'concluida', efeito: 'semEfeito' });
    expect((await item(c.itens.ad!.id)).status).toBe('falhou');
    expect((await ler(m365.id)).status).toBe('cancelada');
    expect((await item(c.itens.m365!.id)).status).toBe('pendente');
    expect((await pedido(c.pedido.id))?.status).toBe('concluidoComErros');
    expect(programados.chamadas.map((ch) => ch.sistema)).toEqual(['ad']);
  });

  it('resultado desconhecido em escrita real vai para reconciliação, sem nova tentativa', async () => {
    const programados = conectoresProgramados();
    programados.programar('jira', () => resultado('jira', 'desconhecido', { codigo: 'TIMEOUT' }));
    const c = cenario(['jira']);
    const op = operacao(c, 'jira');
    await gravar(persistencia, c, [op]);
    const w = executor(programados.conectores);

    await w.processarLote();
    expect(await ler(op.id)).toMatchObject({
      status: 'aguardandoReconciliacao',
      efeito: 'desconhecido',
    });
    expect((await item(c.itens.jira!.id)).status).toBe('desconhecido');
    agora = depois(10 * LEASE);
    expect((await w.processarLote()).reservadas).toBe(0);
    expect(chamadasDe(programados, op.id)).toHaveLength(1);
  });

  it('conector que lança exceção vira resultado desconhecido (regra 3)', async () => {
    const programados = conectoresProgramados();
    programados.programar('jira', () => {
      throw new Error('falha interna com dado sensível 12345678909');
    });
    const c = cenario(['jira']);
    const op = operacao(c, 'jira');
    await gravar(persistencia, c, [op]);

    await executor(programados.conectores).processarLote();
    const gravada = await ler(op.id);
    expect(gravada).toMatchObject({
      status: 'aguardandoReconciliacao',
      codigo: CODIGO_ERRO_NO_CONECTOR,
    });
    expect(gravada.mensagem).not.toContain('12345678909');
  });

  it('conflito com outra transação ao gravar: relê e grava, sem perder o resultado', async () => {
    const programados = conectoresProgramados();
    const c = cenario(['jira']);
    const op = operacao(c, 'jira');
    await gravar(persistencia, c, [op]);
    let falhas = 1;
    let chamou = false;
    const comConflito: UnidadeDeTrabalho<RepositoriosComFila> = {
      executar: (trabalho) => {
        if (chamou && falhas > 0) {
          falhas -= 1;
          return Promise.reject(new ErroDeConcorrencia('pedidos', c.pedido.id));
        }
        return persistencia.executar(trabalho);
      },
    };
    programados.programar('jira', () => {
      chamou = true;
      return resultado('jira', 'confirmado');
    });

    const r = await executor(programados.conectores, { persistencia: comConflito }).processarLote();
    expect(r.desfechos.map((d) => d.tipo)).toEqual(['registrada']);
    expect((await ler(op.id)).status).toBe('concluida');
    expect(chamadasDe(programados, op.id)).toHaveLength(1);
  });
});

describe.skipIf(!TEM_BANCO)('worker: lease e retomada', { timeout: TEMPO_BANCO_MS }, () => {
  it('workers concorrentes: cada operação é executada uma única vez', async () => {
    const programados = conectoresProgramados();
    const ops: Operacao[] = [];
    for (let i = 0; i < 6; i += 1) {
      const c = cenario(['jira']);
      const op = operacao(c, 'jira');
      await gravar(persistencia, c, [op]);
      ops.push(op);
    }
    const politica: PoliticaExecucao = { ...POLITICA_EXECUCAO_PADRAO, lotePorWorker: 2 };
    const outra = criarPersistenciaPostgres(banco.outraConexao());
    const workers = [
      executor(programados.conectores, { politica, workerId: 'worker-a' }),
      executor(programados.conectores, { politica, workerId: 'worker-b', persistencia: outra }),
      executor(programados.conectores, { politica, workerId: 'worker-c', persistencia: outra }),
    ];
    await Promise.all(workers.map((w) => w.processarLote()));
    await Promise.all(workers.map((w) => w.processarLote()));

    for (const op of ops) {
      expect(chamadasDe(programados, op.id), op.id).toHaveLength(1);
      expect((await ler(op.id)).status).toBe('concluida');
      expect(await eventos('operacaoResultadoRegistrado', op.id)).toHaveLength(1);
    }
  });

  it('renova o lease enquanto o conector trabalha: outro worker não toma a operação', async () => {
    const programados = conectoresProgramados();
    let responder!: () => void;
    const resposta = new Promise<void>((r) => {
      responder = r;
    });
    let chamado!: () => void;
    const foiChamado = new Promise<void>((r) => {
      chamado = r;
    });
    programados.programar('jira', async () => {
      chamado();
      await resposta;
      return resultado('jira', 'confirmado');
    });
    const c = cenario(['jira']);
    const op = operacao(c, 'jira');
    await gravar(persistencia, c, [op]);
    const relogio = agendadorManual();

    const w1 = executor(programados.conectores, { agendar: relogio.agendar });
    const lote = w1.processarLote();
    await foiChamado;
    agora = depois(LEASE - 10_000);
    expect(relogio.disparar()).toBe(1);
    await vi.waitFor(async () =>
      expect((await ler(op.id)).lease?.expiraEm).toBe(depois(2 * LEASE - 10_000)),
    );

    // Passou do vencimento original, mas não do renovado.
    agora = depois(LEASE + 1_000);
    const w2 = executor(programados.conectores, { workerId: 'worker-2' });
    expect(await w2.processarLote()).toMatchObject({
      reservadas: 0,
      recuperadas: { reagendadas: 0, paraReconciliacao: 0 },
    });

    responder();
    expect((await lote).desfechos.map((d) => d.tipo)).toEqual(['registrada']);
    expect((await ler(op.id)).status).toBe('concluida');
    expect(chamadasDe(programados, op.id)).toHaveLength(1);
  });

  it('lease perdido: o resultado tardio é descartado e só a nova execução vale', async () => {
    const programados = conectoresProgramados('simulado');
    let responder!: () => void;
    const resposta = new Promise<void>((r) => {
      responder = r;
    });
    let chamado!: () => void;
    const foiChamado = new Promise<void>((r) => {
      chamado = r;
    });
    programados.programar('jira', async () => {
      chamado();
      await resposta;
      return resultado('jira', 'confirmado', { modo: 'simulado', codigo: 'TARDIO' });
    });
    const c = cenario(['jira'], { modo: 'simulado' });
    const op = operacao(c, 'jira');
    await gravar(persistencia, c, [op]);

    const lento = executor(programados.conectores).processarLote();
    await foiChamado;
    // O worker 1 travou além do lease: o worker 2 recupera e executa de novo.
    agora = depois(LEASE + 1);
    const w2 = await executor(programados.conectores, { workerId: 'worker-2' }).processarLote();
    expect(w2.recuperadas.reagendadas).toBe(1);
    expect(w2.desfechos.map((d) => d.tipo)).toEqual(['registrada']);

    responder();
    const tardio = await lento;
    expect(tardio.desfechos).toMatchObject([
      { tipo: 'descartada', operacaoId: op.id, erro: { codigo: 'OPERACAO_JA_FINALIZADA' } },
    ]);
    expect(await ler(op.id)).toMatchObject({ status: 'concluida', codigo: 'OK', tentativas: 2 });
    expect(await eventos('operacaoResultadoRegistrado', op.id)).toHaveLength(1);
    // Mesma chave de idempotência nas duas chamadas.
    expect(new Set(chamadasDe(programados, op.id).map((ch) => ch.ctx.chaveIdempotencia)).size).toBe(
      1,
    );
  });

  it('worker caiu antes de gravar: escrita real vai para reconciliação, sem reenvio às cegas', async () => {
    const programados = conectoresProgramados();
    const c = cenario(['jira']);
    const op = operacao(c, 'jira');
    await gravar(persistencia, c, [op]);
    let caiu = false;
    programados.programar('jira', () => {
      caiu = true;
      return resultado('jira', 'confirmado');
    });
    const quedaAoGravar: UnidadeDeTrabalho<RepositoriosComFila> = {
      executar: (trabalho) =>
        caiu ? Promise.reject(new Error('conexão perdida')) : persistencia.executar(trabalho),
    };

    const w1 = await executor(programados.conectores, {
      persistencia: quedaAoGravar,
    }).processarLote();
    expect(w1.desfechos).toMatchObject([{ tipo: 'naoGravada', operacaoId: op.id, causa: 'Error' }]);
    expect((await ler(op.id)).status).toBe('reservada');

    // Outro worker (ou o mesmo, reiniciado) retoma depois do lease.
    agora = depois(LEASE);
    const w2 = await executor(programados.conectores, { workerId: 'worker-2' }).processarLote();
    expect(w2.recuperadas.paraReconciliacao).toBe(1);
    expect(await ler(op.id)).toMatchObject({
      status: 'aguardandoReconciliacao',
      codigo: 'LEASE_EXPIRADO',
    });
    expect((await item(c.itens.jira!.id)).status).toBe('desconhecido');
    expect(chamadasDe(programados, op.id)).toHaveLength(1);
  });

  it('worker caiu antes de gravar uma simulação: volta à fila e roda de novo com a mesma chave', async () => {
    const programados = conectoresProgramados('simulado');
    const c = cenario(['jira'], { modo: 'simulado' });
    const op = operacao(c, 'jira');
    await gravar(persistencia, c, [op]);
    let caiu = false;
    programados.programar('jira', () => {
      caiu = true;
      return resultado('jira', 'confirmado', { modo: 'simulado' });
    });
    const quedaAoGravar: UnidadeDeTrabalho<RepositoriosComFila> = {
      executar: (trabalho) =>
        caiu ? Promise.reject(new Error('conexão perdida')) : persistencia.executar(trabalho),
    };
    await executor(programados.conectores, { persistencia: quedaAoGravar }).processarLote();

    agora = depois(LEASE);
    const retomada = await executor(programados.conectores, {
      workerId: 'worker-2',
    }).processarLote();
    expect(retomada.recuperadas.reagendadas).toBe(1);
    expect(retomada.desfechos.map((d) => d.tipo)).toEqual(['registrada']);
    expect(await ler(op.id)).toMatchObject({ status: 'concluida', tentativas: 2 });
    const chamadas = chamadasDe(programados, op.id);
    expect(chamadas).toHaveLength(2);
    expect(new Set(chamadas.map((ch) => ch.ctx.chaveIdempotencia))).toEqual(
      new Set([op.chaveIdempotencia]),
    );
  });
});
