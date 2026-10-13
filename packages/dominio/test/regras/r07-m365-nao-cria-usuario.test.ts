import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  comprovarAcessoManual,
  consolidarPedido,
  registrarAcessoManual,
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
  AGORA,
  confirmarAd,
  depois,
  contexto,
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
    const ad = itemDo(cenario.itens, 'ad');
    expect(ad.status).toBe('emExecucao');
    const resultado = reservarOperacao(
      operacao,
      { dependencia: ad },
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
    const operacao = reservar(operacaoDo(cenario.operacoes, m365), AGORA, confirmarAd(cenario));
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
        operacao: reservar(operacaoDo(cenario.operacoes, m365), AGORA, confirmarAd(cenario)),
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

  describe('guarda de dependência: item real do AD, não booleano', () => {
    it('reserva sem o item do AD é recusada; booleano antigo não é aceito', () => {
      const cenario = cenarioEmExecucao({ sistemas: ['ad', 'm365'] });
      const operacao = operacaoDo(cenario.operacoes, itemDo(cenario.itens, 'm365'));
      expect(
        codigoErro(
          reservarOperacao(operacao, { dependencia: null }, POLITICA_EXECUCAO_PADRAO, ctxServico()),
        ),
      ).toBe('DEPENDENCIA_PENDENTE');
      const legado = reservarOperacao(
        operacao,
        // @ts-expect-error — `dependenciaConfirmada: true` não é mais aceito como prova.
        { dependenciaConfirmada: true },
        POLITICA_EXECUCAO_PADRAO,
        ctxServico(),
      );
      expect(codigoErro(legado)).toBe('DEPENDENCIA_PENDENTE');
    });

    it('item de outro pedido, outra revisão ou outro sistema não serve de dependência', () => {
      const cenario = cenarioEmExecucao({ sistemas: ['ad', 'm365', 'jira'] });
      const operacao = operacaoDo(cenario.operacoes, itemDo(cenario.itens, 'm365'));
      const adConfirmado = confirmarAd(cenario);
      const forjados = [
        { ...adConfirmado, id: 'outro-item' },
        { ...adConfirmado, pedidoId: 'outro-pedido' },
        { ...adConfirmado, revisaoId: 'outra-revisao' },
        { ...itemDo(cenario.itens, 'jira'), id: adConfirmado.id, status: 'confirmado' as const },
      ];
      for (const dependencia of forjados) {
        expect(
          codigoErro(
            reservarOperacao(operacao, { dependencia }, POLITICA_EXECUCAO_PADRAO, ctxServico()),
          ),
        ).toBe('DEPENDENCIA_INVALIDA');
      }
      expect(
        reservarOperacao(
          operacao,
          { dependencia: adConfirmado },
          POLITICA_EXECUCAO_PADRAO,
          ctxServico(),
        ).ok,
      ).toBe(true);
    });

    it('AD registrado manualmente não libera a reserva do M365', () => {
      const cenario = cenarioEmExecucao({ sistemas: ['ad', 'm365'] });
      const operacao = operacaoDo(cenario.operacoes, itemDo(cenario.itens, 'm365'));
      const adManual = { ...itemDo(cenario.itens, 'ad'), status: 'registradoManual' as const };
      expect(
        codigoErro(
          reservarOperacao(
            operacao,
            { dependencia: adManual },
            POLITICA_EXECUCAO_PADRAO,
            ctxServico(),
          ),
        ),
      ).toBe('DEPENDENCIA_NAO_COMPROVADA');
    });

    it('AD registrado manualmente não libera a solicitação do M365 até ser comprovado por conferência', () => {
      const aprovado = cenarioAprovado({ sistemas: ['ad', 'm365'] });
      const ad = itemDo(aprovado.itens, 'ad');
      const m365 = itemDo(aprovado.itens, 'm365');
      const adManual = valor(
        registrarAcessoManual(
          { pedido: aprovado.pedido, item: ad, observacao: 'conta criada pelo suporte' },
          ad.versao,
          ctxExecutor(),
        ),
      ).item;
      const solicitar = (adAtual: typeof ad) =>
        solicitarExecucao(
          {
            pedido: aprovado.pedido,
            revisao: aprovado.revisao,
            itens: [adAtual, m365],
            operacoesExistentes: [],
            configuracao: configuracaoComEscrita(),
            modo: 'real',
            itemIds: [m365.id],
          },
          aprovado.pedido.versao,
          ctxExecutor(),
        );
      expect(codigoErro(solicitar(adManual))).toBe('DEPENDENCIA_NAO_COMPROVADA');

      const conferencia = {
        modo: 'real' as const,
        contaExiste: true,
        acessosEncontrados: ['grupo:GG_Financeiro', 'grupo:GG_VPN'],
        referenciaExterna: 'CN=ana.souza',
        conferidaEm: depois(60_000),
      };
      const ctx = ctxExecutor(depois(60_000));
      expect(
        codigoErro(
          comprovarAcessoManual(
            {
              pedido: aprovado.pedido,
              item: adManual,
              conferencia: { ...conferencia, acessosEncontrados: [] },
            },
            adManual.versao,
            ctx,
          ),
        ),
      ).toBe('EXISTENCIA_INCOMPLETA');
      expect(
        codigoErro(
          comprovarAcessoManual(
            {
              pedido: aprovado.pedido,
              item: adManual,
              conferencia: { ...conferencia, modo: 'simulado' },
            },
            adManual.versao,
            ctx,
          ),
        ),
      ).toBe('CONFERENCIA_SIMULADA');
      expect(
        codigoErro(
          comprovarAcessoManual(
            { pedido: aprovado.pedido, item: adManual, conferencia },
            adManual.versao,
            contexto(['revisor']),
          ),
        ),
      ).toBe('PERMISSAO_NEGADA');

      const comprovado = valor(
        comprovarAcessoManual(
          { pedido: aprovado.pedido, item: adManual, conferencia },
          adManual.versao,
          ctx,
        ),
      );
      expect(comprovado.item.status).toBe('confirmado');
      expect(comprovado.eventos[0]?.tipo).toBe('acessoManualComprovado');

      const execucao = valor(solicitar(comprovado.item));
      const operacao = execucao.operacoes[0]!;
      expect(operacao.dependeDeItemId).toBe(ad.id);
      expect(execucao.itens[0]?.status).toBe('emExecucao');
      expect(reservar(operacao, AGORA, comprovado.item).status).toBe('reservada');
    });
  });
});
