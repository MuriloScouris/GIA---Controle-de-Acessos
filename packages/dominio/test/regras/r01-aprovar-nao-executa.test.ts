import { describe, expect, it } from 'vitest';
import { aprovarPedido, solicitarExecucao } from '../../src/index.js';
import {
  cenarioVerificado,
  codigoErro,
  configuracaoComEscrita,
  ctxAdminGia,
  ctxRevisor,
  valor,
} from '../apoio/fabricas.js';

describe('Regra 1 — Aprovar não executa', () => {
  it('aprovação grava a decisão e não produz nenhuma operação', () => {
    const base = cenarioVerificado();
    const aprovado = valor(
      aprovarPedido(
        {
          pedido: base.pedido,
          revisao: base.revisao,
          colaborador: base.colaborador,
          itensAnteriores: [],
        },
        base.pedido.versao,
        ctxRevisor(),
      ),
    );

    expect(aprovado.pedido.status).toBe('aprovado');
    expect(aprovado.revisao.situacao).toBe('aprovada');
    expect(Object.keys(aprovado)).not.toContain('operacoes');
    expect(aprovado.itens).toHaveLength(5);
    for (const item of aprovado.itens) {
      expect(item.status).toBe('pendente');
      expect(item.ultimaOperacaoId).toBeNull();
      expect(item.geracao).toBe(0);
      expect(item.idExterno).toBeNull();
    }
  });

  it('nenhum evento de execução é emitido na aprovação', () => {
    const base = cenarioVerificado();
    const aprovado = valor(
      aprovarPedido(
        {
          pedido: base.pedido,
          revisao: base.revisao,
          colaborador: base.colaborador,
          itensAnteriores: [],
        },
        base.pedido.versao,
        ctxRevisor(),
      ),
    );
    const tipos = aprovado.eventos.map((evento) => evento.tipo);
    expect(tipos).toContain('pedidoAprovado');
    expect(tipos).not.toContain('execucaoSolicitada');
    expect(tipos).not.toContain('operacaoReservada');
    expect(tipos).not.toContain('operacaoResultadoRegistrado');
  });

  it('quem aprova (revisor) não pode solicitar execução: são comandos e permissões distintos', () => {
    const base = cenarioVerificado();
    const aprovado = valor(
      aprovarPedido(
        {
          pedido: base.pedido,
          revisao: base.revisao,
          colaborador: base.colaborador,
          itensAnteriores: [],
        },
        base.pedido.versao,
        ctxRevisor(),
      ),
    );
    const resultado = solicitarExecucao(
      {
        pedido: aprovado.pedido,
        revisao: aprovado.revisao,
        itens: aprovado.itens,
        operacoesExistentes: [],
        configuracao: configuracaoComEscrita(),
        modo: 'real',
      },
      aprovado.pedido.versao,
      ctxRevisor(),
    );
    expect(codigoErro(resultado)).toBe('PERMISSAO_NEGADA');
  });

  it('nem o Administrador do Gia executa ao aprovar', () => {
    const base = cenarioVerificado();
    const aprovado = valor(
      aprovarPedido(
        {
          pedido: base.pedido,
          revisao: base.revisao,
          colaborador: base.colaborador,
          itensAnteriores: [],
        },
        base.pedido.versao,
        ctxAdminGia(),
      ),
    );
    expect(aprovado.pedido.status).toBe('aprovado');
    expect(aprovado.itens.every((item) => item.status === 'pendente')).toBe(true);
    expect(Object.keys(aprovado)).not.toContain('operacoes');
  });
});
