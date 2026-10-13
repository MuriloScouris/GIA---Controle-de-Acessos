import { describe, expect, it } from 'vitest';
import { chaveDeOrigem, configuracaoPadrao, receberChamado } from '../../src/index.js';
import {
  cenarioRecebido,
  chamado,
  codigoErro,
  ctxRevisor,
  itensSugeridos,
  valor,
} from '../apoio/fabricas.js';

describe('Regra 10 — Uma origem, um pedido', () => {
  it('o mesmo ID do Jira devolve o pedido existente e não cria outro', () => {
    const existente = cenarioRecebido();
    const segundo = valor(
      receberChamado(
        {
          chamado: chamado({ idExterno: 'RH-100' }),
          pedidoMesmaOrigem: existente.pedido,
          colaboradorExistente: existente.colaborador,
          configuracao: configuracaoPadrao(),
          versaoRegras: 'regras-v8',
          itensSugeridos: itensSugeridos(),
        },
        ctxRevisor(),
      ),
    );
    expect(segundo.tipo).toBe('duplicado');
    expect(segundo.pedido).toBe(existente.pedido);
    expect(segundo.eventos).toHaveLength(0);
  });

  it('a chave de origem ignora caixa e espaços do ID externo', () => {
    expect(chaveDeOrigem({ sistema: 'jira', idExterno: ' rh-100 ' })).toBe(
      chaveDeOrigem({ sistema: 'jira', idExterno: 'RH-100' }),
    );
    expect(chaveDeOrigem({ sistema: 'jira', idExterno: 'RH-100' })).not.toBe(
      chaveDeOrigem({ sistema: 'jira', idExterno: 'RH-101' }),
    );
  });

  it('pedido informado com outra origem é recusado (busca inconsistente)', () => {
    const existente = cenarioRecebido();
    const resultado = receberChamado(
      {
        chamado: chamado({ idExterno: 'RH-999' }),
        pedidoMesmaOrigem: existente.pedido,
        colaboradorExistente: null,
        configuracao: configuracaoPadrao(),
        versaoRegras: 'regras-v8',
        itensSugeridos: [],
      },
      ctxRevisor(),
    );
    expect(codigoErro(resultado)).toBe('ORIGEM_DIVERGENTE');
  });

  it('uma pessoa pode ter vários pedidos com origens diferentes', () => {
    const primeiro = cenarioRecebido();
    const segundo = valor(
      receberChamado(
        {
          chamado: chamado({ idExterno: 'RH-200' }),
          pedidoMesmaOrigem: null,
          colaboradorExistente: primeiro.colaborador,
          configuracao: configuracaoPadrao(),
          versaoRegras: 'regras-v8',
          itensSugeridos: itensSugeridos(['jira']),
        },
        ctxRevisor(),
      ),
    );
    if (segundo.tipo !== 'criado') throw new Error('esperava pedido criado');
    expect(segundo.pedido.id).not.toBe(primeiro.pedido.id);
    expect(segundo.pedido.colaboradorId).toBe(primeiro.colaborador.id);
    expect(segundo.colaboradorCriado).toBe(false);
    expect(segundo.eventos.map((evento) => evento.tipo)).toEqual(['pedidoRecebido']);
  });
});
