import { describe, expect, it } from 'vitest';
import {
  cancelarOperacao,
  recuperarLeaseExpirado,
  registrarResultadoOperacao,
  renovarLease,
  reservarOperacao,
  POLITICA_EXECUCAO_PADRAO,
  TRANSICOES_OPERACAO,
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
  reservar,
  resultadoConector,
  valor,
} from '../apoio/fabricas.js';

function operacaoAd() {
  const cenario = cenarioEmExecucao({ sistemas: ['ad'] });
  const item = itemDo(cenario.itens, 'ad');
  return { item, operacao: operacaoDo(cenario.operacoes, item) };
}

describe('Operação — lease e reserva', () => {
  it('reserva grava lease com expiração e conta a tentativa', () => {
    const { operacao } = operacaoAd();
    const reservada = valor(
      reservarOperacao(
        operacao,
        { dependenciaConfirmada: true },
        POLITICA_EXECUCAO_PADRAO,
        ctxServico(),
      ),
    );
    expect(reservada.operacao).toMatchObject({
      status: 'reservada',
      tentativas: 1,
      lease: { workerId: 'worker-1', reservadaEm: AGORA, expiraEm: depois(120_000) },
      versao: operacao.versao + 1,
    });
    expect(reservada.eventos[0]?.tipo).toBe('operacaoReservada');
  });

  it('dois workers nunca reservam a mesma operação', () => {
    const { operacao } = operacaoAd();
    const reservada = reservar(operacao);
    const segunda = reservarOperacao(
      reservada,
      { dependenciaConfirmada: true },
      POLITICA_EXECUCAO_PADRAO,
      ctxServico(AGORA, 'worker-2'),
    );
    expect(codigoErro(segunda)).toBe('LEASE_INDISPONIVEL');
  });

  it('operação reagendada só fica disponível no instante previsto', () => {
    const { operacao } = operacaoAd();
    const futura = { ...operacao, disponivelEm: depois(5_000) };
    expect(
      codigoErro(
        reservarOperacao(
          futura,
          { dependenciaConfirmada: true },
          POLITICA_EXECUCAO_PADRAO,
          ctxServico(),
        ),
      ),
    ).toBe('LEASE_INDISPONIVEL');
    expect(
      reservarOperacao(
        futura,
        { dependenciaConfirmada: true },
        POLITICA_EXECUCAO_PADRAO,
        ctxServico(depois(5_000)),
      ).ok,
    ).toBe(true);
  });

  it('só o serviço executor reserva', () => {
    const { operacao } = operacaoAd();
    expect(
      codigoErro(
        reservarOperacao(
          operacao,
          { dependenciaConfirmada: true },
          POLITICA_EXECUCAO_PADRAO,
          ctxExecutor(),
        ),
      ),
    ).toBe('PERMISSAO_NEGADA');
  });

  it('renova o lease só para o dono e antes de expirar', () => {
    const { operacao } = operacaoAd();
    const reservada = reservar(operacao);
    const renovada = valor(
      renovarLease(reservada, POLITICA_EXECUCAO_PADRAO, ctxServico(depois(30_000))),
    );
    expect(renovada.lease?.expiraEm).toBe(depois(150_000));
    expect(
      codigoErro(
        renovarLease(reservada, POLITICA_EXECUCAO_PADRAO, ctxServico(depois(30_000), 'worker-2')),
      ),
    ).toBe('LEASE_INVALIDO');
    expect(
      codigoErro(renovarLease(reservada, POLITICA_EXECUCAO_PADRAO, ctxServico(depois(120_000)))),
    ).toBe('LEASE_INVALIDO');
  });

  it('resultado só é aceito do dono do lease, dentro da validade', () => {
    const { operacao, item } = operacaoAd();
    const reservada = reservar(operacao);
    const resultado = resultadoConector({ etapa: 'adicionarGrupos' });
    expect(
      codigoErro(
        registrarResultadoOperacao(
          { operacao: reservada, item, resultado },
          POLITICA_EXECUCAO_PADRAO,
          ctxServico(AGORA, 'worker-2'),
        ),
      ),
    ).toBe('LEASE_INVALIDO');
    expect(
      codigoErro(
        registrarResultadoOperacao(
          { operacao: reservada, item, resultado },
          POLITICA_EXECUCAO_PADRAO,
          ctxServico(depois(120_000)),
        ),
      ),
    ).toBe('LEASE_INVALIDO');
    expect(
      codigoErro(
        registrarResultadoOperacao(
          { operacao, item, resultado },
          POLITICA_EXECUCAO_PADRAO,
          ctxServico(),
        ),
      ),
    ).toBe('LEASE_INVALIDO');
  });

  it('operação finalizada não recebe novo resultado', () => {
    const { operacao, item } = operacaoAd();
    const concluida = valor(
      registrarResultadoOperacao(
        {
          operacao: reservar(operacao),
          item,
          resultado: resultadoConector({ etapa: 'adicionarGrupos' }),
        },
        POLITICA_EXECUCAO_PADRAO,
        ctxServico(),
      ),
    );
    expect(concluida.operacao.status).toBe('concluida');
    expect(
      codigoErro(
        registrarResultadoOperacao(
          { operacao: concluida.operacao, item: concluida.item, resultado: resultadoConector() },
          POLITICA_EXECUCAO_PADRAO,
          ctxServico(),
        ),
      ),
    ).toBe('OPERACAO_JA_FINALIZADA');
  });

  it('lease expirado em leitura devolve a operação para a fila', () => {
    const { operacao, item } = operacaoAd();
    const leitura = reservar({ ...operacao, acao: 'validar' });
    const recuperada = valor(
      recuperarLeaseExpirado(leitura, item, ctxServico(depois(120_000), 'worker-2')),
    );
    expect(recuperada.operacao).toMatchObject({ status: 'pendente', lease: null });
    expect(recuperada.item).toBe(item);
    expect(codigoErro(recuperarLeaseExpirado(leitura, item, ctxServico(depois(1_000))))).toBe(
      'LEASE_INDISPONIVEL',
    );
  });

  it('cancela apenas operações ainda pendentes, com motivo', () => {
    const { operacao } = operacaoAd();
    expect(codigoErro(cancelarOperacao(operacao, '', ctxExecutor()))).toBe('MOTIVO_OBRIGATORIO');
    expect(
      valor(cancelarOperacao(operacao, 'pedido reaberto', ctxExecutor())).operacao.status,
    ).toBe('cancelada');
    expect(codigoErro(cancelarOperacao(reservar(operacao), 'tarde demais', ctxExecutor()))).toBe(
      'TRANSICAO_INVALIDA',
    );
  });

  it('estados finais da operação não têm saída', () => {
    expect(TRANSICOES_OPERACAO.concluida).toEqual([]);
    expect(TRANSICOES_OPERACAO.reconciliada).toEqual([]);
    expect(TRANSICOES_OPERACAO.cancelada).toEqual([]);
    expect(TRANSICOES_OPERACAO.aguardandoReconciliacao).toEqual(['reconciliada']);
  });
});
