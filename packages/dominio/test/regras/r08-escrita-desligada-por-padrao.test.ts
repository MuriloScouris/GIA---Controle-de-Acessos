import { describe, expect, it } from 'vitest';
import {
  alterarLiberacaoEscrita,
  configuracaoPadrao,
  escritaLiberada,
  solicitarExecucao,
  LIBERACAO_ESCRITA_PADRAO,
  SISTEMAS,
} from '../../src/index.js';
import {
  cenarioAprovado,
  codigoErro,
  ctxAdminGia,
  ctxAdminTecnico,
  ctxExecutor,
  ctxRevisor,
  itemDo,
  valor,
} from '../apoio/fabricas.js';

describe('Regra 8 — Escrita desligada por padrão', () => {
  it('todo sistema nasce com criar e revogar desligados', () => {
    for (const sistema of SISTEMAS) {
      expect(escritaLiberada(LIBERACAO_ESCRITA_PADRAO, sistema, 'criar')).toBe(false);
      expect(escritaLiberada(LIBERACAO_ESCRITA_PADRAO, sistema, 'revogar')).toBe(false);
      expect(configuracaoPadrao().liberacaoEscrita[sistema]).toEqual({
        criar: false,
        revogar: false,
      });
    }
  });

  it('execução real sem liberação é recusada, listando os sistemas bloqueados', () => {
    const aprovado = cenarioAprovado();
    const resultado = solicitarExecucao(
      {
        pedido: aprovado.pedido,
        revisao: aprovado.revisao,
        itens: aprovado.itens,
        operacoesExistentes: [],
        configuracao: configuracaoPadrao(),
        modo: 'real',
      },
      aprovado.pedido.versao,
      ctxExecutor(),
    );
    expect(codigoErro(resultado)).toBe('ESCRITA_NAO_LIBERADA');
    expect(!resultado.ok && resultado.erro.detalhes?.['sistemas']).toEqual([...SISTEMAS]);
  });

  it('cada sistema e cada tipo de escrita é liberado separadamente', () => {
    const liberadoAd = valor(
      alterarLiberacaoEscrita(
        configuracaoPadrao(),
        { sistema: 'ad', tipo: 'criar', liberada: true },
        1,
        ctxAdminTecnico(),
      ),
    ).configuracao;
    expect(escritaLiberada(liberadoAd.liberacaoEscrita, 'ad', 'criar')).toBe(true);
    expect(escritaLiberada(liberadoAd.liberacaoEscrita, 'ad', 'revogar')).toBe(false);
    expect(escritaLiberada(liberadoAd.liberacaoEscrita, 'jira', 'criar')).toBe(false);

    const aprovado = cenarioAprovado({ sistemas: ['ad', 'jira'] });
    const todos = solicitarExecucao(
      {
        pedido: aprovado.pedido,
        revisao: aprovado.revisao,
        itens: aprovado.itens,
        operacoesExistentes: [],
        configuracao: liberadoAd,
        modo: 'real',
      },
      aprovado.pedido.versao,
      ctxExecutor(),
    );
    expect(codigoErro(todos)).toBe('ESCRITA_NAO_LIBERADA');
    expect(!todos.ok && todos.erro.detalhes?.['sistemas']).toEqual(['jira']);

    const soAd = valor(
      solicitarExecucao(
        {
          pedido: aprovado.pedido,
          revisao: aprovado.revisao,
          itens: aprovado.itens,
          operacoesExistentes: [],
          configuracao: liberadoAd,
          modo: 'real',
          itemIds: [itemDo(aprovado.itens, 'ad').id],
        },
        aprovado.pedido.versao,
        ctxExecutor(),
      ),
    );
    expect(soAd.operacoes.map((op) => op.sistema)).toEqual(['ad']);
  });

  it('liberar escrita é exclusivo do administrador técnico — nem o Administrador do Gia libera', () => {
    for (const ctx of [ctxAdminGia(), ctxExecutor(), ctxRevisor()]) {
      const resultado = alterarLiberacaoEscrita(
        configuracaoPadrao(),
        { sistema: 'ad', tipo: 'criar', liberada: true },
        1,
        ctx,
      );
      expect(codigoErro(resultado)).toBe('PERMISSAO_NEGADA');
    }
  });

  it('a liberação é versionada e auditada', () => {
    const alterado = valor(
      alterarLiberacaoEscrita(
        configuracaoPadrao(),
        { sistema: 'm365', tipo: 'criar', liberada: true },
        1,
        ctxAdminTecnico(),
      ),
    );
    expect(alterado.configuracao.versao).toBe(2);
    expect(alterado.eventos[0]).toMatchObject({
      tipo: 'liberacaoEscritaAlterada',
      sistema: 'm365',
      antes: { criar: false, revogar: false },
      depois: { criar: true, revogar: false },
    });
    const conflito = alterarLiberacaoEscrita(
      alterado.configuracao,
      { sistema: 'm365', tipo: 'criar', liberada: false },
      1,
      ctxAdminTecnico(),
    );
    expect(codigoErro(conflito)).toBe('CONFLITO_DE_VERSAO');
  });

  it('modo simulado não precisa de liberação, pois não escreve no destino', () => {
    const aprovado = cenarioAprovado();
    const simulado = valor(
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
    expect(simulado.operacoes).toHaveLength(5);
    expect(simulado.operacoes.every((op) => op.modo === 'simulado')).toBe(true);
  });
});
