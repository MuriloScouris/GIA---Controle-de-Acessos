import {
  pedidoDetalheSchema,
  respostaErroSchema,
  respostaSucessoSchema,
  resultadoImportacaoSchema,
  resultadoItensSchema,
} from '@gia/contratos';
import { lerZip, TIPO_DOCX } from '@gia/documentos';
import type { Evento, TipoEvento } from '@gia/dominio';
import {
  criarBancoDeTeste,
  TEM_BANCO,
  TEMPO_BANCO_MS,
  type BancoDeTeste,
} from '@gia/persistencia/teste';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fornecedoresReaisDeTeste,
  simuladoresPara,
  solicitarExecucaoReal,
  subirGia,
  subirWorker,
  type Gia,
} from './apoio.js';

/**
 * Primeira entrega ponta a ponta simulada: chamado do Jira → proposta →
 * aprovação → fila → worker → conectores simulados → resultado por item →
 * auditoria, com API e worker sobre o mesmo PostgreSQL. Cada teste tem um
 * banco próprio e nenhuma chamada sai para a rede.
 */
const fetchBloqueado = vi.fn(() => {
  throw new Error('chamada de rede externa não permitida nos testes');
});

let banco: BancoDeTeste;
let gia: Gia;

beforeEach(async () => {
  vi.stubGlobal('fetch', fetchBloqueado);
  if (!TEM_BANCO) return;
  banco = await criarBancoDeTeste();
  gia = subirGia(banco);
}, TEMPO_BANCO_MS);

afterEach(async () => {
  vi.unstubAllGlobals();
  fetchBloqueado.mockClear();
  await gia?.fechar();
  await banco?.descartar();
}, TEMPO_BANCO_MS);

async function importarEAprovar(chave: string): Promise<{ pedidoId: string; versao: number }> {
  const revisor = await gia.entrar('revisor');
  const importacao = await gia.post(revisor, '/importacoes/jira', {});
  expect(importacao.statusCode).toBe(200);
  const criado = resultadoImportacaoSchema
    .parse(importacao.json())
    .criados.find((c) => c.chave === chave);
  if (!criado) throw new Error(`${chave} não foi importado`);
  const detalhe = pedidoDetalheSchema.parse(
    (await gia.get(revisor, `/pedidos/${criado.pedidoId}`)).json(),
  );
  const aprovacao = await gia.post(revisor, `/pedidos/${criado.pedidoId}/comandos`, {
    pedidoId: criado.pedidoId,
    versaoEsperada: detalhe.versao,
    acao: 'aprovar',
    dados: {},
  });
  expect(aprovacao.statusCode).toBe(200);
  return {
    pedidoId: criado.pedidoId,
    versao: respostaSucessoSchema.parse(aprovacao.json()).versao,
  };
}

async function solicitarExecucaoSimulada(pedidoId: string, versao: number): Promise<string[]> {
  const executor = await gia.entrar('executor');
  const res = await gia.post(executor, `/pedidos/${pedidoId}/comandos`, {
    pedidoId,
    versaoEsperada: versao,
    acao: 'solicitarExecucao',
    dados: {},
  });
  expect(res.statusCode).toBe(202);
  return [...(respostaSucessoSchema.parse(res.json()).operacaoIds ?? [])];
}

async function lerBanco(pedidoId: string) {
  return gia.persistencia.executar(async (tx) => ({
    pedido: await tx.pedidos.porId(pedidoId),
    itens: await tx.itens.doPedido(pedidoId),
    operacoes: await tx.operacoes.doPedido(pedidoId),
  }));
}

async function eventosDoPedido(pedidoId: string, tipos: readonly TipoEvento[]) {
  const todos: Evento[] = [];
  for (const tipo of tipos) {
    todos.push(...(await gia.persistencia.executar((tx) => tx.eventos.porTipo(tipo))));
  }
  return todos.filter((e) => e.pedidoId === pedidoId);
}

const TIPOS_DA_TRILHA: readonly TipoEvento[] = [
  'pedidoRecebido',
  'pedidoAprovado',
  'simulacaoSolicitada',
  'execucaoSolicitada',
  'operacaoReservada',
  'operacaoResultadoRegistrado',
  'statusPedidoAlterado',
  'documentoEmitido',
];

describe.skipIf(!TEM_BANCO)('entrega ponta a ponta simulada', { timeout: TEMPO_BANCO_MS }, () => {
  it('Jira → aprovação → fila → worker → simuladores: tudo executado, nada confirmado (regra 9)', async () => {
    const { pedidoId, versao } = await importarEAprovar('RH-1001');
    // Aprovar não executa (regra 1): nenhuma operação até a solicitação.
    expect((await lerBanco(pedidoId)).operacoes).toEqual([]);

    const operacaoIds = await solicitarExecucaoSimulada(pedidoId, versao);
    const { itens } = await lerBanco(pedidoId);
    expect(operacaoIds).toHaveLength(itens.length);
    const simuladores = simuladoresPara(itens);
    const relatorio = await subirWorker(banco, simuladores.conectores).processarLote();
    expect(relatorio.desfechos.map((d) => d.tipo)).toEqual(itens.map(() => 'registrada'));

    // Resultado por item pela API: operações simuladas concluídas, itens intactos.
    const executor = await gia.entrar('executor');
    const resultado = resultadoItensSchema.parse(
      (await gia.get(executor, `/pedidos/${pedidoId}/itens`)).json(),
    );
    for (const item of resultado.itens) {
      expect(item.status, item.sistema).toBe('pendente');
      expect(item.operacoes.map((op) => [op.modo, op.status, op.efeito])).toEqual([
        ['simulado', 'concluida', 'confirmado'],
      ]);
    }
    const final = await lerBanco(pedidoId);
    expect(final.pedido?.status).toBe('aprovado');

    // Os simuladores receberam as contas, com os acessos da proposta.
    const ad = itens.find((i) => i.sistema === 'ad')!.parametros as { login: string };
    expect(simuladores.simuladores.ad.conta(ad.login)).not.toBeNull();
    const jira = itens.find((i) => i.sistema === 'jira')!.parametros as { email: string };
    expect(simuladores.simuladores.jira.usuario(jira.email)?.grupos.length).toBeGreaterThan(0);

    // Simulação não gera documento (regra 9).
    const documento = await gia.get(executor, `/pedidos/${pedidoId}/documento`);
    expect(documento.statusCode).toBe(422);
    expect(respostaErroSchema.parse(documento.json()).codigo).toBe('DOCUMENTO_INDISPONIVEL');

    // Trilha de auditoria completa, com o ator certo em cada passo.
    const trilha = await eventosDoPedido(pedidoId, TIPOS_DA_TRILHA);
    const contagem = (tipo: TipoEvento) => trilha.filter((e) => e.tipo === tipo).length;
    expect(contagem('pedidoRecebido')).toBe(1);
    expect(contagem('pedidoAprovado')).toBe(1);
    expect(contagem('simulacaoSolicitada')).toBe(1);
    expect(contagem('operacaoReservada')).toBe(itens.length);
    expect(contagem('operacaoResultadoRegistrado')).toBe(itens.length);
    expect(contagem('documentoEmitido')).toBe(0);
    expect(
      trilha
        .filter((e) => e.tipo === 'operacaoResultadoRegistrado')
        .every((e) => e.ator?.tipo === 'servico'),
    ).toBe(true);
    expect(fetchBloqueado).not.toHaveBeenCalled();
  });

  it('worker que cai antes de gravar: outro retoma pelo lease, com a mesma chave, sem perder nada', async () => {
    const { pedidoId, versao } = await importarEAprovar('RH-1001');
    await solicitarExecucaoSimulada(pedidoId, versao);
    const { itens } = await lerBanco(pedidoId);
    const simuladores = simuladoresPara(itens);
    const chamadas: { operacaoId: string; chave: string }[] = [];
    let chamouAlgum = false;
    const conectores = Object.fromEntries(
      Object.entries(simuladores.conectores).map(([sistema, conector]) => [
        sistema,
        {
          ...conector,
          provisionar: (ctx: Parameters<typeof conector.provisionar>[0]) => {
            chamadas.push({ operacaoId: ctx.operacaoId, chave: ctx.chaveIdempotencia });
            chamouAlgum = true;
            return conector.provisionar(ctx);
          },
        },
      ]),
    ) as typeof simuladores.conectores;

    // Worker A: reserva o lote, chama o primeiro fornecedor e perde o banco antes de gravar.
    const banco_ = gia.persistencia;
    const workerA = subirWorker(banco, conectores, {
      workerId: 'worker-a',
      persistencia: {
        executar: (trabalho) =>
          chamouAlgum ? Promise.reject(new Error('conexão perdida')) : banco_.executar(trabalho),
      },
    });
    // Sem banco, o lote aborta (o ciclo do worker registra e segue); o que ficou
    // reservado espera o lease vencer. Só a primeira operação chegou ao fornecedor.
    await expect(workerA.processarLote()).rejects.toThrow('conexão perdida');
    expect(chamadas).toHaveLength(1);
    expect((await lerBanco(pedidoId)).operacoes.map((op) => op.status)).toEqual(
      itens.map(() => 'reservada'),
    );

    // Worker B, depois do lease: recupera tudo (simulação volta à fila) e executa.
    const depoisDoLease = new Date(Date.now() + 121_000).toISOString();
    const workerB = subirWorker(banco, conectores, {
      workerId: 'worker-b',
      agora: () => depoisDoLease,
    });
    const retomada = await workerB.processarLote();
    expect(retomada.recuperadas.reagendadas).toBe(itens.length);
    expect(retomada.desfechos.every((d) => d.tipo === 'registrada')).toBe(true);

    const final = await lerBanco(pedidoId);
    expect(final.operacoes.map((op) => op.status)).toEqual(itens.map(() => 'concluida'));
    // Cada operação foi registrada uma vez; a interrompida foi chamada de novo com a mesma chave.
    for (const op of final.operacoes) {
      const deEssa = chamadas.filter((c) => c.operacaoId === op.id);
      expect(deEssa.length).toBe(op.id === chamadas[0]!.operacaoId ? 2 : 1);
      expect(new Set(deEssa.map((c) => c.chave))).toEqual(new Set([op.chaveIdempotencia]));
    }
    const registros = await eventosDoPedido(pedidoId, ['operacaoResultadoRegistrado']);
    expect(registros).toHaveLength(itens.length);
    expect(fetchBloqueado).not.toHaveBeenCalled();
  });

  it('fornecedor com timeout: resultado desconhecido, e o reprocessamento conclui depois', async () => {
    const { pedidoId, versao } = await importarEAprovar('RH-1001');
    await solicitarExecucaoSimulada(pedidoId, versao);
    const { itens } = await lerBanco(pedidoId);
    const simuladores = simuladoresPara(itens);
    simuladores.aplicarCenario('timeout');
    const worker = subirWorker(banco, simuladores.conectores);

    await worker.processarLote();
    const depoisDoTimeout = await lerBanco(pedidoId);
    // Timeout é desconhecido, nunca sucesso nem falha (regra 3); simulação não altera itens.
    expect(depoisDoTimeout.operacoes.map((op) => [op.status, op.efeito])).toEqual(
      itens.map(() => ['concluida', 'desconhecido']),
    );
    expect(depoisDoTimeout.itens.map((i) => i.status)).toEqual(itens.map(() => 'pendente'));

    // O fornecedor volta; o executor pede de novo e cada item ganha uma nova operação.
    simuladores.aplicarCenario('sucesso');
    await solicitarExecucaoSimulada(pedidoId, depoisDoTimeout.pedido!.versao);
    await worker.processarLote();
    const final = await lerBanco(pedidoId);
    for (const item of itens) {
      const ops = final.operacoes.filter((op) => op.itemId === item.id);
      expect(
        ops.map((op) => op.efeito),
        item.sistema,
      ).toEqual(['desconhecido', 'confirmado']);
      expect(new Set(ops.map((op) => op.chaveIdempotencia)).size).toBe(2);
    }
    expect(fetchBloqueado).not.toHaveBeenCalled();
  });

  it('documento de acessos de um pedido concluído: só confirmados, download auditado e protegido', async () => {
    const { pedidoId } = await importarEAprovar('RH-1001');
    await solicitarExecucaoReal(gia.persistencia, pedidoId);
    const fornecedores = fornecedoresReaisDeTeste();
    const worker = subirWorker(banco, fornecedores.conectores);
    // M365 só depois do AD confirmado: dois lotes.
    await worker.processarLote();
    await worker.processarLote();
    const concluido = await lerBanco(pedidoId);
    expect(concluido.pedido?.status).toBe('concluido');
    expect(concluido.itens.every((i) => i.status === 'confirmado')).toBe(true);

    const executor = await gia.entrar('executor');
    const res = await gia.get(executor, `/pedidos/${pedidoId}/documento`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(TIPO_DOCX);
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="acessos-jira-RH-1001\.docx"$/,
    );
    expect(res.headers['cache-control']).toBe('no-store');

    const xml = new TextDecoder().decode(lerZip(res.rawPayload).get('word/document.xml'));
    expect(xml).toContain('Formulário de acessos');
    expect(xml).toContain('jira:RH-1001');
    for (const item of concluido.itens) {
      expect(xml).toContain(item.idExterno!);
    }
    // Sem CPF, matrícula ou segredo no documento.
    expect(xml).not.toContain(concluido.pedido!.dadosRh.cpf);
    if (concluido.pedido!.dadosRh.matricula !== null) {
      expect(xml).not.toContain(concluido.pedido!.dadosRh.matricula);
    }
    expect(xml).not.toMatch(/senha:|password/i);

    // Download registrado: um evento por emissão, com o ator da sessão.
    const revisor = await gia.entrar('revisor');
    expect((await gia.get(revisor, `/pedidos/${pedidoId}/documento`)).statusCode).toBe(200);
    const emissoes = await eventosDoPedido(pedidoId, ['documentoEmitido']);
    expect(emissoes.map((e) => e.ator?.papeis)).toEqual([['executor'], ['revisor']]);

    // Sem permissão: auditor 403; solicitante não enxerga o pedido (404); sem sessão 401.
    const auditor = await gia.get(await gia.entrar('auditor'), `/pedidos/${pedidoId}/documento`);
    expect(auditor.statusCode).toBe(403);
    const solicitante = await gia.get(
      await gia.entrar('solicitante'),
      `/pedidos/${pedidoId}/documento`,
    );
    expect(solicitante.statusCode).toBe(404);
    expect((await gia.get(null, `/pedidos/${pedidoId}/documento`)).statusCode).toBe(401);
    expect(await eventosDoPedido(pedidoId, ['documentoEmitido'])).toHaveLength(2);
    expect(fetchBloqueado).not.toHaveBeenCalled();
  });
});
