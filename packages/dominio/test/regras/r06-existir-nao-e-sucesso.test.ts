import { describe, expect, it } from 'vitest';
import {
  avaliarExistencia,
  reconciliarItem,
  registrarResultadoOperacao,
  resultadoDeFalhaTecnica,
  POLITICA_EXECUCAO_PADRAO,
  type ResultadoExistencia,
} from '../../src/index.js';
import {
  AGORA,
  cenarioEmExecucao,
  codigoErro,
  ctxExecutor,
  ctxServico,
  depois,
  itemDo,
  operacaoDo,
  parametrosAd,
  reservar,
  resultadoConector,
  valor,
} from '../apoio/fabricas.js';

function itemDesconhecido() {
  const cenario = cenarioEmExecucao({ sistemas: ['ad'] });
  const item = itemDo(cenario.itens, 'ad');
  const registrado = valor(
    registrarResultadoOperacao(
      {
        operacao: reservar(operacaoDo(cenario.operacoes, item)),
        item,
        resultado: resultadoDeFalhaTecnica({ tipo: 'timeout', etapa: null }, 'real'),
      },
      POLITICA_EXECUCAO_PADRAO,
      ctxServico(),
    ),
  );
  return { ...cenario, item: registrado.item, operacao: registrado.operacao };
}

function conferencia(mudancas: Partial<ResultadoExistencia> = {}): ResultadoExistencia {
  return {
    modo: 'real',
    contaExiste: true,
    acessosEncontrados: [],
    // Conta criada e habilitada no AD; grupos ainda não conferidos.
    etapaComprovada: 'habilitarConta',
    referenciaExterna: 'CN=ana.souza',
    conferidaEm: depois(60_000),
    ...mudancas,
  };
}

describe('Regra 6 — Existir não é sucesso', () => {
  it('conta encontrada sem os grupos é `incompleto`, com a lista do que falta', () => {
    const avaliacao = avaliarExistencia(
      { contaExiste: true, acessosEncontrados: [] },
      parametrosAd(),
    );
    expect(avaliacao.situacao).toBe('incompleto');
    expect(avaliacao.faltantes).toEqual(['grupo:gg_financeiro', 'grupo:gg_vpn']);
  });

  it('só é `completo` quando todos os acessos esperados foram encontrados', () => {
    const avaliacao = avaliarExistencia(
      { contaExiste: true, acessosEncontrados: ['grupo:GG_Financeiro', 'grupo:GG_VPN'] },
      parametrosAd(),
    );
    expect(avaliacao).toEqual({ situacao: 'completo', faltantes: [] });
    expect(
      avaliarExistencia({ contaExiste: false, acessosEncontrados: [] }, parametrosAd()).situacao,
    ).toBe('ausente');
  });

  it('reconciliação recusa marcar sucesso só porque a conta existe', () => {
    const cenario = itemDesconhecido();
    const resultado = reconciliarItem(
      {
        pedido: cenario.pedido,
        item: cenario.item,
        operacao: cenario.operacao,
        conferencia: conferencia({ acessosEncontrados: ['grupo:GG_VPN'] }),
        desfecho: 'confirmado',
      },
      cenario.item.versao,
      ctxExecutor(depois(60_000)),
    );
    expect(codigoErro(resultado)).toBe('DESFECHO_DIVERGE_DA_CONFERENCIA');
  });

  it('com todos os acessos conferidos, o operador confirma o desfecho', () => {
    const cenario = itemDesconhecido();
    const reconciliado = valor(
      reconciliarItem(
        {
          pedido: cenario.pedido,
          item: cenario.item,
          operacao: cenario.operacao,
          conferencia: conferencia({ acessosEncontrados: ['grupo:GG_Financeiro', 'grupo:GG_VPN'] }),
          desfecho: 'confirmado',
        },
        cenario.item.versao,
        ctxExecutor(depois(60_000)),
      ),
    );
    expect(reconciliado.item.status).toBe('confirmado');
    expect(reconciliado.operacao.status).toBe('reconciliada');
  });

  it('conta encontrada com acessos faltando é reconciliada como parcial', () => {
    const cenario = itemDesconhecido();
    const reconciliado = valor(
      reconciliarItem(
        {
          pedido: cenario.pedido,
          item: cenario.item,
          operacao: cenario.operacao,
          conferencia: conferencia(),
          desfecho: 'parcial',
        },
        cenario.item.versao,
        ctxExecutor(depois(60_000)),
      ),
    );
    expect(reconciliado.item.status).toBe('parcial');
    expect(reconciliado.avaliacao.faltantes).toHaveLength(2);
  });

  it('conferência antiga (anterior à operação) não serve de prova', () => {
    const cenario = itemDesconhecido();
    const resultado = reconciliarItem(
      {
        pedido: cenario.pedido,
        item: cenario.item,
        operacao: cenario.operacao,
        conferencia: conferencia({ conferidaEm: depois(-60_000, AGORA) }),
        desfecho: 'falhou',
      },
      cenario.item.versao,
      ctxExecutor(),
    );
    expect(codigoErro(resultado)).toBe('DADO_INVALIDO');
  });

  it('conector que diz `confirmado` sem chegar à última etapa é registrado como parcial', () => {
    const cenario = cenarioEmExecucao({ sistemas: ['ad'] });
    const item = itemDo(cenario.itens, 'ad');
    const registrado = valor(
      registrarResultadoOperacao(
        {
          operacao: reservar(operacaoDo(cenario.operacoes, item)),
          item,
          resultado: resultadoConector({ efeito: 'confirmado', etapa: 'criarContaDesabilitada' }),
        },
        POLITICA_EXECUCAO_PADRAO,
        ctxServico(),
      ),
    );
    expect(registrado.item.status).toBe('parcial');
    expect(registrado.operacao.efeito).toBe('parcial');
  });
});
