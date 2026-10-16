import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RegistroMetricas,
  carregarGatesDeEscrita,
  criarRegistrador,
  type GatesDeEscrita,
} from '@gia/contratos';
import {
  POLITICA_EXECUCAO_PADRAO,
  type ContextoItem,
  type Instante,
  type ModoExecucao,
  type Operacao,
} from '@gia/dominio';
import {
  criarPersistenciaPostgres,
  type RepositoriosComFila,
  type UnidadeDeTrabalho,
} from '@gia/persistencia';
import {
  criarBancoDeTeste,
  TEM_BANCO,
  TEMPO_BANCO_MS,
  type BancoDeTeste,
} from '@gia/persistencia/teste';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { criarExecutor } from './executor.js';
import {
  CODIGO_CONECTOR_REAL_INDISPONIVEL,
  CODIGO_ESCRITA_NAO_LIBERADA,
  ConectorRealIndisponivel,
  aplicarGatesDeEscrita,
  type DecisaoGate,
} from './gates.js';
import { iniciar } from './index.js';
import {
  criarObservabilidadeWorker,
  registrarBatimento,
  verificarBatimento,
} from './observabilidade.js';
import { sondarWorker } from './saude.js';
import { INICIO, cenario, conectoresProgramados, gravar, operacao } from './teste/fabricas.js';

const LIGADO_AD: GatesDeEscrita = carregarGatesDeEscrita({
  GIA_AMBIENTE: 'teste',
  GIA_ESCRITA_EXTERNA: 'true',
  GIA_ESCRITA_LIBERADA: 'ad:criar',
});
const DESLIGADO = carregarGatesDeEscrita({ GIA_AMBIENTE: 'teste' });

/** Contexto de um item AD fictício, como o executor monta para o conector. */
function ctx(modo: ModoExecucao): ContextoItem {
  const item = cenario(['ad'], { modo }).itens.ad!;
  return {
    operacaoId: randomUUID(),
    itemId: item.id,
    chaveIdempotencia: `gia:${modo}:teste`,
    modo,
    parametros: item.parametros,
    etapaInicial: null,
  };
}

describe('gate de escrita no worker (fail-closed)', () => {
  function montar(gates: GatesDeEscrita, comReal = true) {
    const simulados = conectoresProgramados('simulado');
    const reais = conectoresProgramados('real');
    const decisoes: DecisaoGate[] = [];
    const conectores = aplicarGatesDeEscrita(
      simulados.conectores,
      comReal ? { ad: reais.conectores.ad } : {},
      gates,
      (d) => decisoes.push(d),
    );
    return { simulados, reais, decisoes, conectores };
  }

  it('operação simulada vai sempre ao simulador, com ou sem gate', async () => {
    const { simulados, reais, conectores, decisoes } = montar(DESLIGADO);
    await conectores.ad.provisionar(ctx('simulado'));
    expect(simulados.chamadas).toHaveLength(1);
    expect(reais.chamadas).toHaveLength(0);
    expect(decisoes).toEqual([]);
  });

  it('operação real com a chave desligada não chama ninguém (rollback da escrita)', async () => {
    const { simulados, reais, conectores, decisoes } = montar(DESLIGADO);
    const resultado = await conectores.ad.provisionar(ctx('real'));
    expect(resultado).toMatchObject({
      efeito: 'semEfeito',
      modo: 'real',
      codigo: CODIGO_ESCRITA_NAO_LIBERADA,
      transitorio: false,
    });
    expect(simulados.chamadas).toHaveLength(0);
    expect(reais.chamadas).toHaveLength(0);
    expect(decisoes.map((d) => d.decisao)).toEqual(['bloqueada']);
  });

  it('libera só o sistema e a operação listados', async () => {
    const { reais, conectores, decisoes } = montar(LIGADO_AD);
    expect(await conectores.ad.provisionar(ctx('real'))).toMatchObject({
      efeito: 'confirmado',
      modo: 'real',
    });
    expect(await conectores.ad.revogar({ ...ctx('real'), motivo: 'teste' })).toMatchObject({
      codigo: CODIGO_ESCRITA_NAO_LIBERADA,
    });
    expect(reais.chamadas.map((c) => c.acao)).toEqual(['provisionar']);
    expect(decisoes.map((d) => [d.tipo, d.decisao])).toEqual([
      ['criar', 'liberada'],
      ['revogar', 'bloqueada'],
    ]);
  });

  it('liberado mas sem conector real: semEfeito, nunca o simulador (regra 9)', async () => {
    const { simulados, conectores } = montar(LIGADO_AD, false);
    expect(await conectores.ad.provisionar(ctx('real'))).toMatchObject({
      efeito: 'semEfeito',
      codigo: CODIGO_CONECTOR_REAL_INDISPONIVEL,
    });
    expect(simulados.chamadas).toHaveLength(0);
    expect(() => conectores.ad.validar(ctx('real'))).toThrow(ConectorRealIndisponivel);
  });

  it('iniciar descreve os gates e recusa segredo por valor em produção', () => {
    expect(iniciar({})).toContain('escrita externa desligada');
    expect(
      iniciar({
        GIA_AMBIENTE: 'teste',
        GIA_ESCRITA_EXTERNA: 'true',
        GIA_ESCRITA_LIBERADA: 'ad:criar',
        GIA_AD_MODO: 'real',
      }),
    ).toContain('escrita externa LIGADA: ad:criar');
    expect(() => iniciar({ GIA_AMBIENTE: 'producao', GIA_AD_SENHA: 'x' })).toThrow(/GIA_AD_SENHA/);
    expect(() => iniciar({ GIA_WORKER_METRICAS_PORTA: 'abc' })).toThrow(
      /GIA_WORKER_METRICAS_PORTA/,
    );
  });
});

describe('batimento e sonda de vivacidade', () => {
  let pasta = '';
  beforeAll(async () => {
    pasta = await mkdtemp(join(tmpdir(), 'gia-worker-'));
  });
  afterAll(async () => {
    await rm(pasta, { recursive: true, force: true });
  });

  it('batimento recente é saudável; velho, ausente ou corrompido não', async () => {
    const arquivo = join(pasta, 'batimento');
    await registrarBatimento(arquivo, 1_000_000);
    expect(await verificarBatimento(arquivo, 5_000, 1_003_000)).toEqual({
      saudavel: true,
      idadeMs: 3_000,
    });
    expect(await verificarBatimento(arquivo, 5_000, 1_010_000)).toMatchObject({ saudavel: false });
    expect(await verificarBatimento(join(pasta, 'nao-existe'), 5_000)).toEqual({
      saudavel: false,
      idadeMs: null,
    });
    await writeFile(join(pasta, 'lixo'), 'abc');
    expect(await verificarBatimento(join(pasta, 'lixo'), 5_000)).toEqual({
      saudavel: false,
      idadeMs: null,
    });
  });

  it('a sonda sai 0 com batimento recente e 1 sem configuração', async () => {
    const arquivo = join(pasta, 'sonda');
    await registrarBatimento(arquivo, Date.now());
    expect((await sondarWorker({ GIA_WORKER_ARQUIVO_SAUDE: arquivo })).codigo).toBe(0);
    expect((await sondarWorker({})).codigo).toBe(1);
  });
});

let banco: BancoDeTeste;
let persistencia: UnidadeDeTrabalho<RepositoriosComFila>;
const agora: Instante = INICIO;

describe.skipIf(!TEM_BANCO)(
  'worker com gates e observabilidade (PostgreSQL)',
  { timeout: TEMPO_BANCO_MS },
  () => {
    beforeAll(async () => {
      banco = await criarBancoDeTeste();
      persistencia = criarPersistenciaPostgres(banco.db);
    }, TEMPO_BANCO_MS);
    afterAll(async () => {
      await banco?.descartar();
    }, TEMPO_BANCO_MS);
    beforeEach(async () => {
      await sql`
      update operacoes
      set status = 'cancelada', lease_worker_id = null, lease_expira_em = null,
          dados = dados || '{"status": "cancelada", "lease": null}'::jsonb
      where status in ('pendente', 'reservada')
    `.execute(banco.db);
    });

    function executar(gates: GatesDeEscrita, reais = conectoresProgramados('real')) {
      const linhas: Record<string, unknown>[] = [];
      const metricas = new RegistroMetricas();
      const log = criarRegistrador({
        servico: 'worker',
        ambiente: 'teste',
        saida: (l) => linhas.push(JSON.parse(l) as Record<string, unknown>),
      });
      const obs = criarObservabilidadeWorker(log, metricas);
      const executor = criarExecutor({
        persistencia,
        conectores: aplicarGatesDeEscrita(
          conectoresProgramados('simulado').conectores,
          { ad: reais.conectores.ad },
          gates,
          obs.aoDecidirGate,
        ),
        politica: POLITICA_EXECUCAO_PADRAO,
        workerId: 'worker-gates',
        agora: () => agora,
        novoId: randomUUID,
        sortearJitter: () => 0,
        agendar: () => () => undefined,
      });
      return {
        reais,
        linhas,
        metricas,
        async lote() {
          const relatorio = await executor.processarLote();
          obs.aoTerminarLote(relatorio, 1_760_000_000_000);
          return relatorio;
        },
      };
    }

    async function ler(id: string): Promise<Operacao> {
      const op = await persistencia.executar((tx) => tx.fila.operacaoPorId(id));
      if (op === null) throw new Error('operação sumiu');
      return op;
    }

    it('rollback: operação real já na fila, chave desligada → registrada sem efeito e sem chamada', async () => {
      const c = cenario(['ad'], { modo: 'real' });
      const op = operacao(c, 'ad');
      await gravar(persistencia, c, [op]);
      const w = executar(DESLIGADO);
      const relatorio = await w.lote();
      expect(relatorio.desfechos.map((d) => d.tipo)).toEqual(['registrada']);
      expect(await ler(op.id)).toMatchObject({
        efeito: 'semEfeito',
        codigo: CODIGO_ESCRITA_NAO_LIBERADA,
      });
      expect(w.reais.chamadas).toHaveLength(0);
      expect(w.metricas.exportar()).toContain(
        'gia_worker_gate_escrita_total{sistema="ad",tipo="criar",decisao="bloqueada"} 1',
      );
    });

    it('liberado: executa no conector real e registra a operação com correlação, sem dado pessoal', async () => {
      const c = cenario(['ad'], { modo: 'real' });
      const op = operacao(c, 'ad');
      await gravar(persistencia, c, [op]);
      const w = executar(LIGADO_AD);
      await w.lote();
      expect(w.reais.chamadas).toHaveLength(1);
      const registro = w.linhas.find((l) => l['evento'] === 'operacao_registrada');
      expect(registro).toMatchObject({
        operacaoId: op.id,
        pedidoId: op.pedidoId,
        itemId: op.itemId,
        sistema: 'ad',
        acao: 'provisionar',
        modo: 'real',
        efeito: 'confirmado',
      });
      const texto = JSON.stringify(w.linhas);
      expect(texto).not.toContain(c.colaborador.login);
      expect(texto).not.toContain(c.colaborador.cpf);
      expect(w.metricas.exportar()).toContain(
        'gia_worker_operacoes_total{sistema="ad",acao="provisionar",modo="real",desfecho="registrada",efeito="confirmado"} 1',
      );
    });
  },
);
