import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  consolidarPedido,
  registrarResultadoOperacao,
  reservarOperacao,
  solicitarExecucao,
  CODIGO_IDENTIDADE_NAO_SINCRONIZADA,
  DEPENDENCIA_DE_SISTEMA,
  ETAPAS_DE_CRIACAO_DE_USUARIO,
  ETAPAS_PROVISIONAR,
  POLITICA_EXECUCAO_PADRAO,
  type ParametrosM365,
} from '../../src/index.js';
import {
  cenarioAprovado,
  cenarioEmExecucao,
  codigoErro,
  ctxExecutor,
  ctxServico,
  itemDo,
  operacaoDo,
  reservar,
  resultadoConector,
  configuracaoComEscrita,
  substituirItens,
  valor,
} from '../apoio/fabricas.js';

describe('Regra 7 — M365 não cria usuário', () => {
  it('as etapas do M365 começam aguardando a identidade sincronizada e não criam conta', () => {
    expect(ETAPAS_PROVISIONAR.m365[0]).toBe('aguardarIdentidadeSincronizada');
    for (const etapa of ETAPAS_PROVISIONAR.m365) {
      expect(ETAPAS_DE_CRIACAO_DE_USUARIO).not.toContain(etapa);
    }
    expect(DEPENDENCIA_DE_SISTEMA.m365).toBe('ad');
  });

  it('os parâmetros do M365 não têm campo de criação de usuário nem senha', () => {
    expectTypeOf<keyof ParametrosM365>().toEqualTypeOf<
      'sistema' | 'upn' | 'email' | 'nome' | 'planosLicenca' | 'paisUso' | 'grupo'
    >();
  });

  it('M365 na mesma execução que o AD fica aguardando a dependência', () => {
    const cenario = cenarioEmExecucao({ sistemas: ['ad', 'm365'] });
    const ad = itemDo(cenario.itens, 'ad');
    const m365 = itemDo(cenario.itens, 'm365');
    expect(m365.status).toBe('aguardandoDependencia');
    expect(operacaoDo(cenario.operacoes, m365).dependeDeItemId).toBe(ad.id);
    expect(ad.status).toBe('emExecucao');
  });

  it('a operação do M365 não é reservada enquanto o AD não estiver confirmado', () => {
    const cenario = cenarioEmExecucao({ sistemas: ['ad', 'm365'] });
    const operacao = operacaoDo(cenario.operacoes, itemDo(cenario.itens, 'm365'));
    const resultado = reservarOperacao(
      operacao,
      { dependenciaConfirmada: false },
      POLITICA_EXECUCAO_PADRAO,
      ctxServico(),
    );
    expect(codigoErro(resultado)).toBe('DEPENDENCIA_PENDENTE');
  });

  it('pedir só o M365 com o AD ainda pendente é recusado', () => {
    const aprovado = cenarioAprovado({ sistemas: ['ad', 'm365'] });
    const resultado = solicitarExecucao(
      {
        pedido: aprovado.pedido,
        revisao: aprovado.revisao,
        itens: aprovado.itens,
        operacoesExistentes: [],
        configuracao: configuracaoComEscrita(),
        modo: 'real',
        itemIds: [itemDo(aprovado.itens, 'm365').id],
      },
      aprovado.pedido.versao,
      ctxExecutor(),
    );
    expect(codigoErro(resultado)).toBe('DEPENDENCIA_PENDENTE');
  });

  it('identidade ainda não sincronizada no Entra: aguarda sem consumir tentativa', () => {
    const cenario = cenarioEmExecucao({ sistemas: ['ad', 'm365'] });
    const m365 = itemDo(cenario.itens, 'm365');
    const operacao = reservar(operacaoDo(cenario.operacoes, m365));
    const registrado = valor(
      registrarResultadoOperacao(
        {
          operacao,
          item: m365,
          resultado: resultadoConector({
            efeito: 'semEfeito',
            codigo: CODIGO_IDENTIDADE_NAO_SINCRONIZADA,
            transitorio: true,
            etapa: null,
          }),
        },
        POLITICA_EXECUCAO_PADRAO,
        ctxServico(),
      ),
    );
    expect(registrado.proximoPasso).toEqual({
      tipo: 'aguardarDependencia',
      aguardarMs: POLITICA_EXECUCAO_PADRAO.esperaSincronizacaoM365Ms,
    });
    expect(registrado.operacao.status).toBe('pendente');
    expect(registrado.operacao.tentativas).toBe(0);
    expect(registrado.item.status).toBe('aguardandoDependencia');
  });

  it('resultado do M365 dizendo que criou usuário é recusado', () => {
    const cenario = cenarioEmExecucao({ sistemas: ['ad', 'm365'] });
    const m365 = itemDo(cenario.itens, 'm365');
    const resultado = registrarResultadoOperacao(
      {
        operacao: reservar(operacaoDo(cenario.operacoes, m365)),
        item: m365,
        // Simula um adaptador defeituoso que reporta etapa de criação.
        resultado: resultadoConector({ etapa: 'criarUsuario' }),
      },
      POLITICA_EXECUCAO_PADRAO,
      ctxServico(),
    );
    expect(codigoErro(resultado)).toBe('M365_NAO_CRIA_USUARIO');
  });

  it('se o AD falha, a espera do M365 é cancelada e o item volta a pendente', () => {
    const cenario = cenarioEmExecucao({ sistemas: ['ad', 'm365'] });
    const ad = itemDo(cenario.itens, 'ad');
    const adFalhou = valor(
      registrarResultadoOperacao(
        {
          operacao: reservar(operacaoDo(cenario.operacoes, ad)),
          item: ad,
          resultado: resultadoConector({ efeito: 'semEfeito', codigo: 'OU_INEXISTENTE' }),
        },
        POLITICA_EXECUCAO_PADRAO,
        ctxServico(),
      ),
    );
    const itens = substituirItens(cenario.itens, [adFalhou.item]);
    const operacoes = cenario.operacoes.map((op) =>
      op.id === adFalhou.operacao.id ? adFalhou.operacao : op,
    );
    const consolidado = valor(
      consolidarPedido({ pedido: cenario.pedido, itens, operacoes }, ctxServico()),
    );

    expect(consolidado.operacoes).toHaveLength(1);
    expect(consolidado.operacoes[0]).toMatchObject({ sistema: 'm365', status: 'cancelada' });
    expect(consolidado.itens[0]).toMatchObject({ sistema: 'm365', status: 'pendente' });
    expect(consolidado.pedido.status).toBe('concluidoComErros');
  });
});
