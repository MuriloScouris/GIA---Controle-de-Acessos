import { describe, expect, it } from 'vitest';
import {
  interpretarEstadoParaRevogacao,
  registrarResultadoOperacao,
  statusItemPorEfeito,
  POLITICA_EXECUCAO_PADRAO,
  type ResultadoOperacao,
} from '../../src/index.js';
import {
  cenarioEmExecucao,
  ctxServico,
  itemDo,
  operacaoDo,
  reservar,
  valor,
} from '../apoio/fabricas.js';

function revogarComResultado(resultado: ResultadoOperacao) {
  const cenario = cenarioEmExecucao({ sistemas: ['ad'] });
  const item = itemDo(cenario.itens, 'ad');
  const operacao = reservar({ ...operacaoDo(cenario.operacoes, item), acao: 'revogar' });
  return valor(
    registrarResultadoOperacao(
      { operacao, item, resultado },
      POLITICA_EXECUCAO_PADRAO,
      ctxServico(),
    ),
  );
}

describe('Regra 5 — Conta ausente na revogação é falha; acesso já revogado é sucesso', () => {
  it('conta ausente é falha definitiva (sem retentativa automática)', () => {
    const resultado = interpretarEstadoParaRevogacao(
      { contaExiste: false, acessoAtivo: false },
      'real',
    );
    expect(resultado).toMatchObject({
      efeito: 'semEfeito',
      codigo: 'CONTA_AUSENTE',
      transitorio: false,
    });
    expect(statusItemPorEfeito(resultado!.efeito)).toBe('falhou');

    const registrado = revogarComResultado(resultado!);
    expect(registrado.proximoPasso.tipo).toBe('finalizar');
    expect(registrado.item.status).toBe('falhou');
    expect(registrado.operacao.status).toBe('concluida');
  });

  it('acesso já revogado é sucesso confirmado', () => {
    const resultado = interpretarEstadoParaRevogacao(
      { contaExiste: true, acessoAtivo: false },
      'real',
    );
    expect(resultado).toMatchObject({ efeito: 'confirmado', codigo: 'JA_REVOGADO' });

    const registrado = revogarComResultado(resultado!);
    expect(registrado.item.status).toBe('confirmado');
    expect(registrado.operacao.efeito).toBe('confirmado');
  });

  it('conta existente com acesso ativo ainda precisa ser revogada', () => {
    expect(
      interpretarEstadoParaRevogacao({ contaExiste: true, acessoAtivo: true }, 'real'),
    ).toBeNull();
  });
});
