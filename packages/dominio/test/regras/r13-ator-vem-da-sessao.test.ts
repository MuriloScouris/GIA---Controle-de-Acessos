import { describe, expect, it } from 'vitest';
import {
  aprovarPedido,
  criarAtorDaSessao,
  criarEvento,
  extrairDadosPermitidos,
  rejeitarAtorNoPayload,
  type AtorAutenticado,
  type ContextoComando,
} from '../../src/index.js';
import {
  AGORA,
  cenarioEmExecucao,
  cenarioVerificado,
  codigoErro,
  ctxServico,
  itemDo,
  novoId,
  operacaoDo,
  reservar,
  valor,
} from '../apoio/fabricas.js';

describe('Regra 13 — Ator vem da sessão', () => {
  it('o tipo AtorAutenticado só nasce da sessão validada no servidor', () => {
    const doNavegador = {
      tipo: 'humano',
      id: 'qualquer',
      nome: 'Forjado',
      papeis: ['administradorGia'],
    } as const;
    // @ts-expect-error — objeto vindo do cliente não é um AtorAutenticado.
    const forjado: AtorAutenticado = doNavegador;
    expect(forjado.id).toBe('qualquer');

    const daSessao = criarAtorDaSessao({ usuarioId: 'u-1', nome: 'Revisora', papeis: ['revisor'] });
    expect(daSessao).toMatchObject({ tipo: 'humano', id: 'u-1', papeis: ['revisor'] });
    expect(Object.isFrozen(daSessao)).toBe(true);
  });

  it('payload que tenta informar o ator é recusado, mesmo aninhado', () => {
    expect(codigoErro(rejeitarAtorNoPayload({ versaoEsperada: 3, aprovadoPor: 'u-9' }))).toBe(
      'ATOR_INFORMADO_PELO_CLIENTE',
    );
    expect(codigoErro(rejeitarAtorNoPayload({ dados: { itens: [{ ator: { id: 'u-9' } }] } }))).toBe(
      'ATOR_INFORMADO_PELO_CLIENTE',
    );
    expect(codigoErro(rejeitarAtorNoPayload({ USUARIOID: 'u-9' }))).toBe(
      'ATOR_INFORMADO_PELO_CLIENTE',
    );
    expect(rejeitarAtorNoPayload({ versaoEsperada: 3, motivo: 'ok' }).ok).toBe(true);
  });

  it('extrai só os dados permitidos do comando', () => {
    const dados = valor(
      extrairDadosPermitidos({ versaoEsperada: 2, motivo: 'x' }, ['versaoEsperada', 'motivo']),
    );
    expect(dados).toEqual({ versaoEsperada: 2, motivo: 'x' });
    expect(
      codigoErro(extrairDadosPermitidos({ versaoEsperada: 2, atorId: 'u-9' }, ['versaoEsperada'])),
    ).toBe('ATOR_INFORMADO_PELO_CLIENTE');
    expect(
      codigoErro(
        extrairDadosPermitidos({ versaoEsperada: 2, status: 'aprovado' }, ['versaoEsperada']),
      ),
    ).toBe('DADO_INVALIDO');
    expect(codigoErro(extrairDadosPermitidos('texto', ['versaoEsperada']))).toBe('DADO_INVALIDO');
  });

  it('quem aprovou é o ator da sessão, gravado na revisão e no evento', () => {
    const base = cenarioVerificado();
    const ctx: ContextoComando = {
      ator: criarAtorDaSessao({
        usuarioId: 'revisora-7',
        nome: 'Revisora Sete',
        papeis: ['revisor'],
      }),
      agora: AGORA,
      correlacaoId: 'req-1',
      novoId,
    };
    const aprovado = valor(
      aprovarPedido(
        {
          pedido: base.pedido,
          revisao: base.revisao,
          colaborador: base.colaborador,
          itensAnteriores: [],
          // @ts-expect-error — o comando não aceita ator nos dados.
          aprovadoPor: 'outra-pessoa',
        },
        base.pedido.versao,
        ctx,
      ),
    );
    expect(aprovado.revisao.aprovadaPor).toMatchObject({ tipo: 'humano', id: 'revisora-7' });
    for (const evento of aprovado.eventos) {
      expect(evento.ator).toMatchObject({ tipo: 'humano', id: 'revisora-7' });
      expect(evento.correlacaoId).toBe('req-1');
    }
  });

  it('operação registra o humano solicitante; o worker age em nome dele', () => {
    const cenario = cenarioEmExecucao({ sistemas: ['ad'] });
    const operacao = operacaoDo(cenario.operacoes, itemDo(cenario.itens, 'ad'));
    expect(operacao.solicitadaPor).toMatchObject({ tipo: 'humano', id: 'usuario-executor' });

    const reservada = reservar(operacao);
    expect(reservada.lease?.workerId).toBe(ctxServico().ator.id);
    const ator = ctxServico().ator;
    expect(ator.tipo === 'servico' && ator.emNomeDe).toBe('usuario-executor');
  });

  it('evento originado no Gia sem ator é recusado', () => {
    const resultado = criarEvento({
      id: 'e1',
      tipo: 'pedidoAprovado',
      origem: 'gia',
      ator: null,
      instante: AGORA,
    });
    expect(codigoErro(resultado)).toBe('EVENTO_SEM_ATOR');
    const sincronizacao = valor(
      criarEvento({
        id: 'e2',
        tipo: 'alteracaoDetectadaNaSincronizacao',
        origem: 'sincronizacaoAd',
        ator: null,
        instante: AGORA,
      }),
    );
    expect(sincronizacao.ator).toBeNull();
  });
});
