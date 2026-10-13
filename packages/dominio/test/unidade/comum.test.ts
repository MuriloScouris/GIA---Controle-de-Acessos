import { describe, expect, it } from 'vitest';
import {
  acessosEsperados,
  congelarProfundo,
  ehCpfValido,
  ehDataCivilValida,
  ehInstanteValido,
  exigirTransicao,
  igualdadeEstrutural,
  criarEvento,
  mascararCpf,
  mascararCpfs,
  proximaEtapa,
  sanitizar,
} from '../../src/index.js';
import { codigoErro, CPF_ANA, parametrosM365 } from '../apoio/fabricas.js';

describe('Utilitários do domínio', () => {
  it('valida CPF pelos dígitos verificadores', () => {
    expect(ehCpfValido(CPF_ANA)).toBe(true);
    expect(ehCpfValido('529.982.247-25')).toBe(true);
    expect(ehCpfValido('529.982.247-24')).toBe(false);
    expect(ehCpfValido('000.000.000-00')).toBe(false);
    expect(ehCpfValido('123')).toBe(false);
    expect(mascararCpf('529.982.247-25')).toBe('529.***.***-25');
    expect(mascararCpf('1')).toBe('***');
  });

  it('valida instantes UTC e datas civis', () => {
    expect(ehInstanteValido('2026-10-13T12:00:00.000Z')).toBe(true);
    expect(ehInstanteValido('2026-10-13T12:00:00-03:00')).toBe(false);
    expect(ehDataCivilValida('2028-02-29')).toBe(true);
    expect(ehDataCivilValida('2027-02-29')).toBe(false);
  });

  it('máquina de estados recusa transição fora da tabela', () => {
    const tabela = { a: ['b'], b: [] } as const satisfies Record<'a' | 'b', readonly ('a' | 'b')[]>;
    expect(exigirTransicao(tabela, 'a', 'b').ok).toBe(true);
    expect(codigoErro(exigirTransicao(tabela, 'b', 'a'))).toBe('TRANSICAO_INVALIDA');
  });

  it('igualdade estrutural ignora a ordem das chaves', () => {
    expect(igualdadeEstrutural({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(igualdadeEstrutural({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(igualdadeEstrutural([1], { 0: 1 })).toBe(false);
  });

  it('congela em profundidade e sanitiza referências circulares sem estourar', () => {
    const objeto = congelarProfundo({ a: { b: [1] } });
    expect(Object.isFrozen(objeto.a.b)).toBe(true);
    const circular: Record<string, unknown> = { nome: 'x' };
    circular['eu'] = circular;
    expect(sanitizar(circular)).toEqual({ nome: 'x', eu: '[REFERENCIA_CIRCULAR]' });
  });

  it('etapas e acessos esperados por sistema', () => {
    expect(proximaEtapa('ad', 'provisionar', null)).toBe('criarContaDesabilitada');
    expect(proximaEtapa('ad', 'provisionar', 'habilitarConta')).toBe('adicionarGrupos');
    expect(proximaEtapa('ad', 'provisionar', 'adicionarGrupos')).toBeNull();
    expect(acessosEsperados(parametrosM365({ planosLicenca: ['E3', 'E3'], grupo: null }))).toEqual([
      'conta',
      'licenca:e3',
    ]);
  });

  it('eventos guardam CPF mascarado; o CPF completo fica só no cadastro', () => {
    expect(mascararCpfs({ cpf: '529.982.247-25', a: [{ cpfTitular: '52998224725' }] })).toEqual({
      cpf: '529.***.***-25',
      a: [{ cpfTitular: '529.***.***-25' }],
    });
    const evento = criarEvento({
      id: 'e-cpf',
      tipo: 'propostaEditada',
      origem: 'gia',
      ator: { tipo: 'humano', id: 'u', nome: 'R', papeis: ['revisor'] },
      instante: '2026-10-13T12:00:00.000Z',
      depois: { itens: [{ parametros: { sistema: 'ad', cpf: CPF_ANA } }] },
    });
    expect(JSON.stringify(evento)).not.toContain(CPF_ANA);
  });
});
