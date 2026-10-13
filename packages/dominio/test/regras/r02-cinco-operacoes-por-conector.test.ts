import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  decidirProximoPasso,
  ehOperacaoDeEscrita,
  resultadoDeFalhaTecnica,
  OPERACOES_CONECTOR,
  OPERACOES_DE_ESCRITA,
  POLITICA_EXECUCAO_PADRAO,
  type Conector,
  type ContextoItem,
  type ContextoRevogacao,
  type OperacaoConector,
  type ResultadoConexao,
  type ResultadoExistencia,
  type ResultadoOperacao,
  type ResultadoValidacao,
} from '../../src/index.js';
import { AGORA, parametrosAd, resultadoConector } from '../apoio/fabricas.js';

/** Conector de teste: registra quais operações foram chamadas. */
class ConectorSimulado implements Conector {
  readonly chamadas: OperacaoConector[] = [];
  readonly chaves: string[] = [];

  testarConexao(): Promise<ResultadoConexao> {
    this.chamadas.push('testarConexao');
    return Promise.resolve({ modo: 'simulado', disponivel: true, codigo: 'OK', mensagem: 'ok' });
  }
  validar(ctx: ContextoItem): Promise<ResultadoValidacao> {
    this.chamadas.push('validar');
    this.chaves.push(ctx.chaveIdempotencia);
    return Promise.resolve({ modo: 'simulado', impedimentos: [], avisos: [] });
  }
  conferirExistencia(ctx: ContextoItem): Promise<ResultadoExistencia> {
    this.chamadas.push('conferirExistencia');
    this.chaves.push(ctx.chaveIdempotencia);
    return Promise.resolve({
      modo: 'simulado',
      contaExiste: false,
      acessosEncontrados: [],
      referenciaExterna: null,
      conferidaEm: AGORA,
    });
  }
  provisionar(ctx: ContextoItem): Promise<ResultadoOperacao> {
    this.chamadas.push('provisionar');
    this.chaves.push(ctx.chaveIdempotencia);
    return Promise.resolve(resultadoConector({ modo: 'simulado', etapa: 'adicionarGrupos' }));
  }
  revogar(ctx: ContextoRevogacao): Promise<ResultadoOperacao> {
    this.chamadas.push('revogar');
    this.chaves.push(ctx.chaveIdempotencia);
    return Promise.resolve(resultadoConector({ modo: 'simulado', etapa: 'moverParaOuInativos' }));
  }
}

describe('Regra 2 — Cinco operações distintas por conector', () => {
  it('o contrato tem exatamente cinco operações, sem repetição', () => {
    expect(OPERACOES_CONECTOR).toEqual([
      'testarConexao',
      'validar',
      'conferirExistencia',
      'provisionar',
      'revogar',
    ]);
    expect(new Set(OPERACOES_CONECTOR).size).toBe(5);
  });

  it('a interface Conector expõe exatamente essas cinco operações', () => {
    expectTypeOf<keyof Conector>().toEqualTypeOf<OperacaoConector>();
    expectTypeOf<(typeof OPERACOES_CONECTOR)[number]>().toEqualTypeOf<OperacaoConector>();
  });

  it('cada operação é uma chamada independente no adaptador', async () => {
    const conector = new ConectorSimulado();
    const ctx: ContextoItem = {
      operacaoId: 'op',
      itemId: 'item',
      chaveIdempotencia: 'chave',
      modo: 'simulado',
      parametros: parametrosAd(),
      etapaInicial: null,
    };
    await conector.testarConexao();
    await conector.validar(ctx);
    await conector.conferirExistencia(ctx);
    await conector.provisionar(ctx);
    await conector.revogar({ ...ctx, motivo: 'teste' });
    expect(conector.chamadas).toEqual([...OPERACOES_CONECTOR]);
    expect(conector.chaves).toEqual(['chave', 'chave', 'chave', 'chave']);
  });

  it('só provisionar e revogar escrevem; testar, validar e conferir são leituras', () => {
    expect(OPERACOES_DE_ESCRITA).toEqual(['provisionar', 'revogar']);
    expect(OPERACOES_CONECTOR.filter(ehOperacaoDeEscrita)).toEqual(['provisionar', 'revogar']);
    expect(ehOperacaoDeEscrita('validar')).toBe(false);
    expect(ehOperacaoDeEscrita('conferirExistencia')).toBe(false);
    expect(ehOperacaoDeEscrita('testarConexao')).toBe(false);
  });

  it('leitura incerta pode ser repetida; escrita incerta nunca é repetida automaticamente', () => {
    const timeout = resultadoDeFalhaTecnica({ tipo: 'timeout', etapa: null }, 'real');
    for (const leitura of ['testarConexao', 'validar', 'conferirExistencia'] as const) {
      expect(
        decidirProximoPasso(
          { acao: leitura, modo: 'real', resultado: timeout, tentativas: 1 },
          POLITICA_EXECUCAO_PADRAO,
        ).tipo,
      ).toBe('retentar');
    }
    for (const escrita of OPERACOES_DE_ESCRITA) {
      expect(
        decidirProximoPasso(
          { acao: escrita, modo: 'real', resultado: timeout, tentativas: 1 },
          POLITICA_EXECUCAO_PADRAO,
        ).tipo,
      ).toBe('reconciliar');
    }
  });
});
