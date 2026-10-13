import { describe, expect, it } from 'vitest';
import {
  consolidarPedido,
  recuperarLeaseExpirado,
  registrarAcessoManual,
  registrarResultadoOperacao,
  resultadoDeFalhaTecnica,
  solicitarExecucao,
  POLITICA_EXECUCAO_PADRAO,
} from '../../src/index.js';
import {
  cenarioEmExecucao,
  codigoErro,
  ctxExecutor,
  ctxServico,
  depois,
  itemDo,
  operacaoDo,
  reservar,
  substituirItens,
  valor,
} from '../apoio/fabricas.js';

describe('Regra 3 — Timeout é resultado desconhecido', () => {
  it('timeout e resposta perdida viram `desconhecido`, nunca sucesso nem falha', () => {
    for (const tipo of ['timeout', 'respostaPerdida'] as const) {
      const resultado = resultadoDeFalhaTecnica({ tipo, etapa: 'criarContaDesabilitada' }, 'real');
      expect(resultado.efeito).toBe('desconhecido');
      expect(resultado.efeito).not.toBe('confirmado');
      expect(resultado.efeito).not.toBe('semEfeito');
      expect(resultado.transitorio).toBe(false);
    }
  });

  it('só falhas que comprovadamente não chegaram ao destino viram `semEfeito` transitório', () => {
    expect(resultadoDeFalhaTecnica({ tipo: 'conexaoRecusada', etapa: null }, 'real')).toMatchObject(
      {
        efeito: 'semEfeito',
        transitorio: true,
      },
    );
    expect(
      resultadoDeFalhaTecnica({ tipo: 'limiteDeTaxa', etapa: null, tentarAposMs: 60_000 }, 'real'),
    ).toMatchObject({ efeito: 'semEfeito', transitorio: true, tentarAposMs: 60_000 });
  });

  it('timeout numa escrita leva a operação para reconciliação e o item para `desconhecido`, sem retentativa', () => {
    const cenario = cenarioEmExecucao({ sistemas: ['ad'] });
    const item = itemDo(cenario.itens, 'ad');
    const operacao = reservar(operacaoDo(cenario.operacoes, item));

    const registrado = valor(
      registrarResultadoOperacao(
        {
          operacao,
          item,
          resultado: resultadoDeFalhaTecnica({ tipo: 'timeout', etapa: 'definirSenha' }, 'real'),
        },
        POLITICA_EXECUCAO_PADRAO,
        ctxServico(),
      ),
    );

    expect(registrado.proximoPasso.tipo).toBe('reconciliar');
    expect(registrado.operacao.status).toBe('aguardandoReconciliacao');
    expect(registrado.operacao.efeito).toBe('desconhecido');
    expect(registrado.item.status).toBe('desconhecido');
    expect(registrado.eventos.map((evento) => evento.tipo)).toContain(
      'operacaoEncaminhadaParaReconciliacao',
    );
  });

  it('item desconhecido não é reexecutado nem marcado manualmente: vai para conferência', () => {
    const cenario = cenarioEmExecucao({ sistemas: ['ad'] });
    const item = itemDo(cenario.itens, 'ad');
    const operacao = reservar(operacaoDo(cenario.operacoes, item));
    const registrado = valor(
      registrarResultadoOperacao(
        {
          operacao,
          item,
          resultado: resultadoDeFalhaTecnica({ tipo: 'timeout', etapa: null }, 'real'),
        },
        POLITICA_EXECUCAO_PADRAO,
        ctxServico(),
      ),
    );
    const itens = substituirItens(cenario.itens, [registrado.item]);
    const consolidado = valor(
      consolidarPedido(
        { pedido: cenario.pedido, itens, operacoes: [registrado.operacao] },
        ctxServico(),
      ),
    );
    expect(consolidado.pedido.status).toBe('concluidoComErros');

    const reexecucao = solicitarExecucao(
      {
        pedido: consolidado.pedido,
        revisao: cenario.revisao,
        itens,
        operacoesExistentes: [registrado.operacao],
        configuracao: cenario.configuracao,
        modo: 'real',
        itemIds: [item.id],
      },
      consolidado.pedido.versao,
      ctxExecutor(),
    );
    expect(codigoErro(reexecucao)).toBe('ITEM_AGUARDANDO_CONFERENCIA');

    const manual = registrarAcessoManual(
      { pedido: consolidado.pedido, item: registrado.item, observacao: 'criado à mão' },
      registrado.item.versao,
      ctxExecutor(),
    );
    expect(codigoErro(manual)).toBe('ITEM_AGUARDANDO_CONFERENCIA');
  });

  it('worker que caiu durante uma escrita: lease expirado vira resultado desconhecido', () => {
    const cenario = cenarioEmExecucao({ sistemas: ['ad'] });
    const item = itemDo(cenario.itens, 'ad');
    const operacao = reservar(operacaoDo(cenario.operacoes, item));
    const tarde = depois(POLITICA_EXECUCAO_PADRAO.duracaoLeaseMs + 1);

    const recuperado = valor(recuperarLeaseExpirado(operacao, item, ctxServico(tarde, 'worker-2')));
    expect(recuperado.operacao.status).toBe('aguardandoReconciliacao');
    expect(recuperado.operacao.efeito).toBe('desconhecido');
    expect(recuperado.item.status).toBe('desconhecido');
  });

  it('timeout em leitura (validar/conferir) é repetido com backoff, pois não altera nada', () => {
    const cenario = cenarioEmExecucao({ sistemas: ['ad'] });
    const item = itemDo(cenario.itens, 'ad');
    const operacao = reservar({
      ...operacaoDo(cenario.operacoes, item),
      acao: 'conferirExistencia',
    });
    const registrado = valor(
      registrarResultadoOperacao(
        {
          operacao,
          item,
          resultado: resultadoDeFalhaTecnica({ tipo: 'timeout', etapa: null }, 'real'),
        },
        POLITICA_EXECUCAO_PADRAO,
        ctxServico(),
      ),
    );
    expect(registrado.proximoPasso).toEqual({ tipo: 'retentar', aguardarMs: 5_000 });
    expect(registrado.operacao.status).toBe('pendente');
    expect(registrado.item.status).toBe(item.status);
  });
});
