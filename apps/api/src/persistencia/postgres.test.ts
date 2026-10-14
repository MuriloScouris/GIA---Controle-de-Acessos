import {
  pedidoDetalheSchema,
  respostaSucessoSchema,
  resultadoImportacaoSchema,
  resultadoItensSchema,
  type ResultadoImportacao,
} from '@gia/contratos';
import { criarAtorDeServico, POLITICA_EXECUCAO_PADRAO } from '@gia/dominio';
import {
  criarPersistenciaPostgres,
  reservarLote,
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INICIO, montarApi, type ApiDeTeste } from '../teste/apoio.js';

/**
 * Contrato: os mesmos casos de uso da API, pelo HTTP, sobre a persistência
 * PostgreSQL em vez da memória. A API de produção ainda sobe com a memória;
 * este teste garante que a troca não muda o comportamento.
 */
let banco: BancoDeTeste;
let persistencia: UnidadeDeTrabalho<RepositoriosComFila>;

beforeAll(async () => {
  if (!TEM_BANCO) return;
  banco = await criarBancoDeTeste();
  persistencia = criarPersistenciaPostgres(banco.db);
}, TEMPO_BANCO_MS);
afterAll(async () => {
  await banco?.descartar();
}, TEMPO_BANCO_MS);

function apiNoBanco(): ApiDeTeste {
  return montarApi({ persistencia: criarPersistenciaPostgres(banco.outraConexao()) });
}

async function importar(api: ApiDeTeste, cookie: string): Promise<ResultadoImportacao> {
  const res = await api.importar(cookie);
  expect(res.statusCode).toBe(200);
  return resultadoImportacaoSchema.parse(res.json());
}

async function versaoDoPedido(api: ApiDeTeste, cookie: string, pedidoId: string) {
  const res = await api.get(cookie, `/pedidos/${pedidoId}`);
  expect(res.statusCode).toBe(200);
  return pedidoDetalheSchema.parse(res.json()).versao;
}

describe.skipIf(!TEM_BANCO)('API sobre PostgreSQL', { timeout: TEMPO_BANCO_MS }, () => {
  it('importa, deduplica pela origem, aprova e enfileira na mesma transação dos eventos', async () => {
    const api = apiNoBanco();
    const revisor = await api.entrar('revisor');
    const executor = await api.entrar('executor');

    const relatorio = await importar(api, revisor);
    expect(relatorio.criados.length).toBeGreaterThan(0);
    // Reimportar não duplica: a origem é única no banco.
    const reimportacao = await importar(api, revisor);
    expect(reimportacao.criados).toEqual([]);
    const duplicados = new Set(reimportacao.duplicados.map((d) => d.chave));
    expect(relatorio.criados.every((c) => duplicados.has(c.chave))).toBe(true);

    const pedidoId = relatorio.criados.find((c) => c.chave === 'RH-1001')!.pedidoId;
    const aprovacao = await api.comando(revisor, pedidoId, {
      pedidoId,
      versaoEsperada: await versaoDoPedido(api, revisor, pedidoId),
      acao: 'aprovar',
      dados: {},
    });
    expect(aprovacao.statusCode).toBe(200);
    const aprovado = respostaSucessoSchema.parse(aprovacao.json());

    const solicitacao = await api.comando(executor, pedidoId, {
      pedidoId,
      versaoEsperada: aprovado.versao,
      acao: 'solicitarExecucao',
      dados: {},
    });
    expect(solicitacao.statusCode).toBe(202);
    const { operacaoIds } = respostaSucessoSchema.parse(solicitacao.json());

    const { operacoes, simulacoes } = await persistencia.executar(async (tx) => ({
      operacoes: await tx.operacoes.doPedido(pedidoId),
      simulacoes: (await tx.eventos.porTipo('simulacaoSolicitada')).filter(
        (e) => e.pedidoId === pedidoId,
      ),
    }));
    expect(operacoes.map((o) => o.id).sort()).toEqual([...(operacaoIds ?? [])].sort());
    expect(operacoes.every((o) => o.modo === 'simulado' && o.status === 'pendente')).toBe(true);
    expect(simulacoes).toHaveLength(1);

    // Repetir a solicitação não duplica operação (chave de idempotência e item ativo).
    const repetida = await api.comando(executor, pedidoId, {
      pedidoId,
      versaoEsperada: aprovado.versao,
      acao: 'solicitarExecucao',
      dados: {},
    });
    expect(repetida.statusCode).not.toBe(500);
    const depoisDaRepeticao = await persistencia.executar((tx) => tx.operacoes.doPedido(pedidoId));
    expect(depoisDaRepeticao).toHaveLength(operacoes.length);

    // O consumidor da fila reserva com lease o que não depende de outro item.
    const ctx = {
      ator: criarAtorDeServico({ id: 'worker-1', nome: 'Serviço executor' }, null),
      agora: INICIO,
      correlacaoId: 'correlacao-worker',
      novoId: randomUUID,
    };
    const { reservadas } = await reservarLote(persistencia, POLITICA_EXECUCAO_PADRAO, ctx);
    expect(reservadas.map((o) => o.id).sort()).toEqual(
      operacoes
        .filter((o) => o.dependeDeItemId === null)
        .map((o) => o.id)
        .sort(),
    );
    const itens = resultadoItensSchema.parse(
      (await api.get(executor, `/pedidos/${pedidoId}/itens`)).json(),
    );
    const statusNaApi = itens.itens.flatMap((item) => item.operacoes.map((op) => op.status));
    expect(statusNaApi.filter((s) => s === 'reservada')).toHaveLength(reservadas.length);
  });

  it('duas aprovações simultâneas da mesma versão: uma grava, a outra recebe 409', async () => {
    const primeira = apiNoBanco();
    const segunda = apiNoBanco();
    const revisorA = await primeira.entrar('revisor');
    const revisorB = await segunda.entrar('revisor');
    const relatorio = await importar(primeira, revisorA);
    // RH-1001 já foi aprovado no teste anterior; RH-1002 ainda está pendente.
    const pedidoId = [...relatorio.criados, ...relatorio.duplicados].find(
      (p) => p.chave === 'RH-1002',
    )!.pedidoId;
    const versaoEsperada = await versaoDoPedido(primeira, revisorA, pedidoId);
    const comando = { pedidoId, versaoEsperada, acao: 'aprovar', dados: {} };

    const respostas = await Promise.all([
      primeira.comando(revisorA, pedidoId, comando),
      segunda.comando(revisorB, pedidoId, comando),
    ]);
    expect(respostas.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const vencedora = respostaSucessoSchema.parse(
      respostas.find((r) => r.statusCode === 200)!.json(),
    );
    expect(await versaoDoPedido(segunda, revisorB, pedidoId)).toBe(vencedora.versao);
    const aprovacoes = await persistencia.executar((tx) => tx.eventos.porTipo('pedidoAprovado'));
    expect(aprovacoes.filter((e) => e.pedidoId === pedidoId)).toHaveLength(1);
  });

  it('duas edições simultâneas (cada uma avança duas versões): uma grava, a outra recebe 409', async () => {
    const primeira = apiNoBanco();
    const segunda = apiNoBanco();
    const revisorA = await primeira.entrar('revisor');
    const revisorB = await segunda.entrar('revisor');
    const relatorio = await importar(primeira, revisorA);
    // RH-1003 continua pendente nos testes anteriores (identidade em uso).
    const pedidoId = [...relatorio.criados, ...relatorio.duplicados].find(
      (p) => p.chave === 'RH-1003',
    )!.pedidoId;
    const res = await primeira.get(revisorA, `/pedidos/${pedidoId}`);
    const lido = pedidoDetalheSchema.parse(res.json());
    const edicao = (login: string) => ({
      pedidoId,
      versaoEsperada: lido.versao,
      acao: 'editarProposta',
      dados: {
        identidade: { login, email: `${login}@exemplo.com.br`, nomeExibicao: 'João P.' },
        itens: lido.revisao.itens,
      },
    });

    const respostas = await Promise.all([
      primeira.comando(revisorA, pedidoId, edicao('joao.paralelo.a')),
      segunda.comando(revisorB, pedidoId, edicao('joao.paralelo.b')),
    ]);
    expect(respostas.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const vencedora = respostaSucessoSchema.parse(
      respostas.find((r) => r.statusCode === 200)!.json(),
    );
    // Editar (v+1) e revalidar a identidade (v+2) na mesma transação.
    expect(vencedora.versao).toBe(lido.versao + 2);
    const final = pedidoDetalheSchema.parse(
      (await segunda.get(revisorB, `/pedidos/${pedidoId}`)).json(),
    );
    expect(final.versao).toBe(vencedora.versao);
    const loginVencedor = respostas[0]!.statusCode === 200 ? 'joao.paralelo.a' : 'joao.paralelo.b';
    expect(final.revisao.identidade?.login).toBe(loginVencedor);
    const edicoes = await persistencia.executar((tx) => tx.eventos.porTipo('propostaEditada'));
    expect(edicoes.filter((e) => e.pedidoId === pedidoId)).toHaveLength(1);
  });

  it('outra instância da API enxerga o que foi gravado (API sem estado em memória)', async () => {
    const api = apiNoBanco();
    const revisor = await api.entrar('revisor');
    await importar(api, revisor);
    const nova = apiNoBanco();
    const lista = await nova.get(await nova.entrar('revisor'), '/pedidos');
    expect(lista.statusCode).toBe(200);
    expect((lista.json() as { pedidos: unknown[] }).pedidos.length).toBeGreaterThan(0);
  });
});
