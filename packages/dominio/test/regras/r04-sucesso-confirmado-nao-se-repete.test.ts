import { describe, expect, it } from 'vitest';
import {
  aprovarPedido,
  consolidarPedido,
  editarProposta,
  gerarChaveIdempotencia,
  garantirOperacaoUnica,
  reabrirPedido,
  registrarResultadoOperacao,
  solicitarExecucao,
  verificarIdentidade,
  POLITICA_EXECUCAO_PADRAO,
  type ItemAcesso,
  type Operacao,
} from '../../src/index.js';
import {
  cenarioEmExecucao,
  codigoErro,
  configuracaoComEscrita,
  ctxExecutor,
  ctxRevisor,
  ctxServico,
  itemDo,
  itemProposto,
  operacaoDo,
  parametrosJira,
  reservar,
  resultadoConector,
  substituirItens,
  valor,
  type CenarioEmExecucao,
} from '../apoio/fabricas.js';

/** AD confirmado e Jira com falha definitiva; pedido consolidado em `concluidoComErros`. */
function cenarioAdConfirmadoJiraFalhou(): CenarioEmExecucao & { operacoes: Operacao[] } {
  const cenario = cenarioEmExecucao({ sistemas: ['ad', 'jira'] });
  const ad = itemDo(cenario.itens, 'ad');
  const jira = itemDo(cenario.itens, 'jira');
  const adOk = valor(
    registrarResultadoOperacao(
      {
        operacao: reservar(operacaoDo(cenario.operacoes, ad)),
        item: ad,
        resultado: resultadoConector({ etapa: 'adicionarGrupos' }),
      },
      POLITICA_EXECUCAO_PADRAO,
      ctxServico(),
    ),
  );
  const jiraFalhou = valor(
    registrarResultadoOperacao(
      {
        operacao: reservar(operacaoDo(cenario.operacoes, jira)),
        item: jira,
        resultado: resultadoConector({
          efeito: 'semEfeito',
          codigo: 'GRUPO_INEXISTENTE',
          etapa: null,
        }),
      },
      POLITICA_EXECUCAO_PADRAO,
      ctxServico(),
    ),
  );
  const itens = substituirItens(cenario.itens, [adOk.item, jiraFalhou.item]);
  const operacoes = [adOk.operacao, jiraFalhou.operacao];
  const consolidado = valor(
    consolidarPedido({ pedido: cenario.pedido, itens, operacoes }, ctxServico()),
  );
  return { ...cenario, pedido: consolidado.pedido, itens, operacoes };
}

describe('Regra 4 — Sucesso confirmado não se repete', () => {
  it('reprocessar cria operação só para o que falta', () => {
    const cenario = cenarioAdConfirmadoJiraFalhou();
    expect(cenario.pedido.status).toBe('concluidoComErros');

    const reprocesso = valor(
      solicitarExecucao(
        {
          pedido: cenario.pedido,
          revisao: cenario.revisao,
          itens: cenario.itens,
          operacoesExistentes: cenario.operacoes,
          configuracao: cenario.configuracao,
          modo: 'real',
        },
        cenario.pedido.versao,
        ctxExecutor(),
      ),
    );
    expect(reprocesso.operacoes.map((op) => op.sistema)).toEqual(['jira']);
    expect(reprocesso.itens.map((item) => item.sistema)).toEqual(['jira']);
  });

  it('pedir explicitamente a execução de um item confirmado é recusado', () => {
    const cenario = cenarioAdConfirmadoJiraFalhou();
    const ad = itemDo(cenario.itens, 'ad');
    const resultado = solicitarExecucao(
      {
        pedido: cenario.pedido,
        revisao: cenario.revisao,
        itens: cenario.itens,
        operacoesExistentes: cenario.operacoes,
        configuracao: cenario.configuracao,
        modo: 'real',
        itemIds: [ad.id],
      },
      cenario.pedido.versao,
      ctxExecutor(),
    );
    expect(codigoErro(resultado)).toBe('ITEM_JA_CONFIRMADO');
  });

  it('resultado chegando para item já confirmado não o altera', () => {
    const cenario = cenarioAdConfirmadoJiraFalhou();
    const ad = itemDo(cenario.itens, 'ad');
    const operacaoAtrasada: Operacao = reservar({
      ...operacaoDo(cenario.operacoes, ad),
      id: 'op-atrasada',
      status: 'pendente',
      lease: null,
    });
    const resultado = registrarResultadoOperacao(
      {
        operacao: operacaoAtrasada,
        item: ad,
        resultado: resultadoConector({ efeito: 'semEfeito' }),
      },
      POLITICA_EXECUCAO_PADRAO,
      ctxServico(),
    );
    expect(codigoErro(resultado)).toBe('ITEM_JA_CONFIRMADO');
  });

  it('sucesso parcial é retomado a partir da próxima etapa', () => {
    const cenario = cenarioEmExecucao({ sistemas: ['ad'] });
    const ad = itemDo(cenario.itens, 'ad');
    const parcial = valor(
      registrarResultadoOperacao(
        {
          operacao: reservar(operacaoDo(cenario.operacoes, ad)),
          item: ad,
          resultado: resultadoConector({
            efeito: 'parcial',
            etapa: 'habilitarConta',
            codigo: 'GRUPO_FALHOU',
          }),
        },
        POLITICA_EXECUCAO_PADRAO,
        ctxServico(),
      ),
    );
    expect(parcial.item.status).toBe('parcial');
    const consolidado = valor(
      consolidarPedido(
        { pedido: cenario.pedido, itens: [parcial.item], operacoes: [parcial.operacao] },
        ctxServico(),
      ),
    );
    const retomada = valor(
      solicitarExecucao(
        {
          pedido: consolidado.pedido,
          revisao: cenario.revisao,
          itens: [parcial.item],
          operacoesExistentes: [parcial.operacao],
          configuracao: cenario.configuracao,
          modo: 'real',
        },
        consolidado.pedido.versao,
        ctxExecutor(),
      ),
    );
    expect(retomada.operacoes[0]?.etapaInicial).toBe('adicionarGrupos');
  });

  it('chave de idempotência é determinística e a inserção não duplica operação', () => {
    const dados = {
      pedidoId: 'p',
      revisaoId: 'r',
      itemId: 'i',
      acao: 'provisionar',
      modo: 'real',
      geracao: 1,
    } as const;
    expect(gerarChaveIdempotencia(dados)).toBe(gerarChaveIdempotencia({ ...dados }));
    expect(gerarChaveIdempotencia(dados)).not.toBe(
      gerarChaveIdempotencia({ ...dados, geracao: 2 }),
    );

    const cenario = cenarioEmExecucao({ sistemas: ['ad'] });
    const existente = cenario.operacoes[0]!;
    const repetida = { ...existente, id: 'outro-id' };
    const garantida = garantirOperacaoUnica(cenario.operacoes, repetida);
    expect(garantida.criada).toBe(false);
    expect(garantida.operacao.id).toBe(existente.id);
  });

  it('não cria segunda operação para item que já tem operação ativa', () => {
    const cenario = cenarioEmExecucao({ sistemas: ['ad', 'jira'] });
    const jira = itemDo(cenario.itens, 'jira');
    const jiraComoSeFosseNovo: ItemAcesso = { ...jira, status: 'falhou' };
    const resultado = solicitarExecucao(
      {
        pedido: cenario.pedido,
        revisao: cenario.revisao,
        itens: substituirItens(cenario.itens, [jiraComoSeFosseNovo]),
        operacoesExistentes: cenario.operacoes,
        configuracao: cenario.configuracao,
        modo: 'real',
        itemIds: [jira.id],
      },
      cenario.pedido.versao,
      ctxExecutor(),
    );
    expect(codigoErro(resultado)).toBe('ITEM_EM_EXECUCAO');
  });

  it('nova revisão herda o sucesso de sistemas sem mudança e só executa o que mudou', () => {
    const cenario = cenarioAdConfirmadoJiraFalhou();
    const reaberto = valor(
      reabrirPedido(
        {
          pedido: cenario.pedido,
          revisao: cenario.revisao,
          itens: cenario.itens,
          motivo: 'corrigir grupos do Jira',
        },
        cenario.pedido.versao,
        ctxRevisor(),
      ),
    );
    const editado = valor(
      editarProposta(
        {
          pedido: reaberto.pedido,
          revisao: reaberto.revisao,
          configuracao: configuracaoComEscrita(),
          itens: reaberto.revisao.itens.map((item) =>
            item.sistema === 'jira'
              ? itemProposto('jira', parametrosJira({ grupos: ['jira-software-users'] }))
              : item,
          ),
        },
        reaberto.pedido.versao,
        ctxRevisor(),
      ),
    );
    const verificado = valor(
      verificarIdentidade(
        { pedido: editado.pedido, revisao: editado.revisao, usos: [] },
        editado.pedido.versao,
        ctxRevisor(),
      ),
    );
    const reaprovado = valor(
      aprovarPedido(
        {
          pedido: verificado.pedido,
          revisao: verificado.revisao,
          colaborador: cenario.colaborador,
          itensAnteriores: cenario.itens,
        },
        verificado.pedido.versao,
        ctxRevisor(),
      ),
    );
    const ad = itemDo(reaprovado.itens, 'ad');
    expect(ad.status).toBe('confirmado');
    expect(ad.herdadoDeItemId).toBe(itemDo(cenario.itens, 'ad').id);
    expect(itemDo(reaprovado.itens, 'jira').status).toBe('pendente');

    const execucao = valor(
      solicitarExecucao(
        {
          pedido: reaprovado.pedido,
          revisao: reaprovado.revisao,
          itens: reaprovado.itens,
          operacoesExistentes: [],
          configuracao: configuracaoComEscrita(),
          modo: 'real',
        },
        reaprovado.pedido.versao,
        ctxExecutor(),
      ),
    );
    expect(execucao.operacoes.map((op) => op.sistema)).toEqual(['jira']);
  });
});
