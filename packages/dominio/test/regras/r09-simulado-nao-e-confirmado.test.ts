import { describe, expect, it } from 'vitest';
import {
  configuracaoPadrao,
  consolidarPedido,
  itensDoDocumento,
  registrarResultadoOperacao,
  solicitarExecucao,
  POLITICA_EXECUCAO_PADRAO,
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
  valor,
} from '../apoio/fabricas.js';

function simulacaoCompleta() {
  const aprovado = cenarioAprovado({ sistemas: ['ad', 'jira'] });
  const simulacao = valor(
    solicitarExecucao(
      {
        pedido: aprovado.pedido,
        revisao: aprovado.revisao,
        itens: aprovado.itens,
        operacoesExistentes: [],
        configuracao: configuracaoPadrao(),
        modo: 'simulado',
      },
      aprovado.pedido.versao,
      ctxExecutor(),
    ),
  );
  const ultimaEtapa = { ad: 'adicionarGrupos', jira: 'adicionarGrupos' } as const;
  const registros = aprovado.itens.map((item) =>
    valor(
      registrarResultadoOperacao(
        {
          operacao: reservar(operacaoDo(simulacao.operacoes, item)),
          item,
          resultado: resultadoConector({
            modo: 'simulado',
            efeito: 'confirmado',
            etapa: ultimaEtapa[item.sistema as 'ad' | 'jira'],
          }),
        },
        POLITICA_EXECUCAO_PADRAO,
        ctxServico(),
      ),
    ),
  );
  return { aprovado, simulacao, registros };
}

describe('Regra 9 — Simulado não é confirmado', () => {
  it('solicitar simulação não altera itens nem o pedido', () => {
    const { aprovado, simulacao } = simulacaoCompleta();
    expect(simulacao.itens).toHaveLength(0);
    expect(simulacao.pedido).toBe(aprovado.pedido);
    expect(simulacao.pedido.status).toBe('aprovado');
    expect(simulacao.eventos[0]?.tipo).toBe('simulacaoSolicitada');
  });

  it('resultado simulado `confirmado` nunca confirma o item', () => {
    const { aprovado, registros } = simulacaoCompleta();
    for (const registro of registros) {
      expect(registro.operacao.efeito).toBe('confirmado');
      expect(registro.operacao.modo).toBe('simulado');
      expect(registro.item.status).toBe('pendente');
      expect(registro.item.confirmadoEm).toBeNull();
    }
    const consolidado = valor(
      consolidarPedido(
        {
          pedido: aprovado.pedido,
          itens: registros.map((registro) => registro.item),
          operacoes: registros.map((registro) => registro.operacao),
        },
        ctxServico(),
      ),
    );
    expect(consolidado.pedido.status).toBe('aprovado');
  });

  it('simulação não gera documento de acessos', () => {
    const { aprovado } = simulacaoCompleta();
    expect(codigoErro(itensDoDocumento(aprovado.pedido, aprovado.itens))).toBe(
      'DOCUMENTO_INDISPONIVEL',
    );
  });

  it('resultado simulado numa operação real vira `desconhecido` e vai para conferência', () => {
    const cenario = cenarioEmExecucao({ sistemas: ['ad'] });
    const item = itemDo(cenario.itens, 'ad');
    const registrado = valor(
      registrarResultadoOperacao(
        {
          operacao: reservar(operacaoDo(cenario.operacoes, item)),
          item,
          resultado: resultadoConector({
            modo: 'simulado',
            efeito: 'confirmado',
            etapa: 'adicionarGrupos',
          }),
        },
        POLITICA_EXECUCAO_PADRAO,
        ctxServico(),
      ),
    );
    expect(registrado.operacao.efeito).toBe('desconhecido');
    expect(registrado.operacao.codigo).toBe('MODO_DIVERGENTE');
    expect(registrado.item.status).toBe('desconhecido');
    expect(registrado.proximoPasso.tipo).toBe('reconciliar');
  });

  it('documento só leva itens confirmados de verdade', () => {
    const cenario = cenarioEmExecucao({ sistemas: ['ad'] });
    const item = itemDo(cenario.itens, 'ad');
    const registrado = valor(
      registrarResultadoOperacao(
        {
          operacao: reservar(operacaoDo(cenario.operacoes, item)),
          item,
          resultado: resultadoConector({ etapa: 'adicionarGrupos' }),
        },
        POLITICA_EXECUCAO_PADRAO,
        ctxServico(),
      ),
    );
    const consolidado = valor(
      consolidarPedido(
        { pedido: cenario.pedido, itens: [registrado.item], operacoes: [registrado.operacao] },
        ctxServico(),
      ),
    );
    expect(consolidado.pedido.status).toBe('concluido');
    expect(
      valor(itensDoDocumento(consolidado.pedido, [registrado.item])).map((i) => i.sistema),
    ).toEqual(['ad']);
  });
});
