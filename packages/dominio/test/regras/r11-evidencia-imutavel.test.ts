import { describe, expect, it } from 'vitest';
import * as dominio from '../../src/index.js';
import {
  anexarEventos,
  criarEvento,
  editarProposta,
  exigirRascunho,
  registrarCorrecao,
  REGISTRO_VAZIO,
  type Evento,
} from '../../src/index.js';
import {
  AGORA,
  cenarioAprovado,
  codigoErro,
  configuracaoComEscrita,
  ctxRevisor,
  valor,
} from '../apoio/fabricas.js';

function eventoDeTeste(id = 'evento-1'): Evento {
  return valor(
    criarEvento({
      id,
      tipo: 'pedidoAprovado',
      origem: 'gia',
      ator: { tipo: 'humano', id: 'u1', nome: 'Revisora', papeis: ['revisor'] },
      instante: AGORA,
      pedidoId: 'pedido-1',
      antes: { status: 'pendenteAprovacao' },
      depois: { status: 'aprovado', itens: [{ sistema: 'ad' }] },
    }),
  );
}

describe('Regra 11 — Evidência imutável', () => {
  it('evento criado é congelado em profundidade', () => {
    const evento = eventoDeTeste();
    expect(Object.isFrozen(evento)).toBe(true);
    expect(Object.isFrozen(evento.depois)).toBe(true);
    expect(() => {
      (evento as { tipo: string }).tipo = 'pedidoRejeitado';
    }).toThrow(TypeError);
    expect(() => {
      (evento.depois as { status: string }).status = 'rejeitado';
    }).toThrow(TypeError);
  });

  it('o registro só aceita inserção: devolve um novo registro e não aceita alteração', () => {
    const primeiro = valor(anexarEventos(REGISTRO_VAZIO, [eventoDeTeste('e1')]));
    const segundo = valor(anexarEventos(primeiro, [eventoDeTeste('e2')]));
    expect(primeiro).toHaveLength(1);
    expect(segundo).toHaveLength(2);
    expect(Object.isFrozen(segundo)).toBe(true);
    expect(() => (segundo as Evento[]).pop()).toThrow(TypeError);
    expect(() => (segundo as Evento[]).splice(0, 1)).toThrow(TypeError);
  });

  it('um ID já gravado não pode ser regravado', () => {
    const registro = valor(anexarEventos(REGISTRO_VAZIO, [eventoDeTeste('e1')]));
    expect(codigoErro(anexarEventos(registro, [eventoDeTeste('e1')]))).toBe('EVENTO_DUPLICADO');
  });

  it('correção entra como novo evento que aponta para o original, que fica intacto', () => {
    const original = eventoDeTeste('e1');
    const registro = valor(anexarEventos(REGISTRO_VAZIO, [original]));
    const corrigido = valor(
      registrarCorrecao(
        registro,
        {
          eventoOriginalId: 'e1',
          motivo: 'status registrado errado',
          correcao: { status: 'rejeitado' },
        },
        ctxRevisor(),
      ),
    );
    expect(corrigido.registro).toHaveLength(2);
    expect(corrigido.registro[0]).toBe(original);
    expect(corrigido.evento).toMatchObject({
      tipo: 'correcaoRegistrada',
      corrigeEventoId: 'e1',
      antes: { status: 'aprovado' },
      depois: { status: 'rejeitado' },
    });
    expect(
      codigoErro(
        registrarCorrecao(
          registro,
          { eventoOriginalId: 'e1', motivo: ' ', correcao: {} },
          ctxRevisor(),
        ),
      ),
    ).toBe('MOTIVO_OBRIGATORIO');
  });

  it('o domínio não oferece operação de alterar ou remover evento', () => {
    const nomes = Object.keys(dominio);
    expect(
      nomes.filter((nome) => /(remover|excluir|apagar|editar|atualizar|alterar)Evento/i.test(nome)),
    ).toEqual([]);
  });

  it('revisão aprovada é congelada e não pode ser editada', () => {
    const aprovado = cenarioAprovado();
    expect(Object.isFrozen(aprovado.revisao)).toBe(true);
    expect(Object.isFrozen(aprovado.revisao.itens)).toBe(true);
    expect(codigoErro(exigirRascunho(aprovado.revisao))).toBe('REVISAO_IMUTAVEL');
    expect(() => {
      (aprovado.revisao as { versaoRegras: string }).versaoRegras = 'outra';
    }).toThrow(TypeError);

    const edicao = editarProposta(
      {
        pedido: { ...aprovado.pedido, status: 'pendenteAprovacao' },
        revisao: aprovado.revisao,
        configuracao: configuracaoComEscrita(),
        itens: [],
      },
      aprovado.pedido.versao,
      ctxRevisor(),
    );
    expect(codigoErro(edicao)).toBe('REVISAO_IMUTAVEL');
  });
});
