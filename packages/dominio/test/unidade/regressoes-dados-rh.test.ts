import { describe, expect, it } from 'vitest';
import { configuracaoPadrao, criarColaborador, receberChamado } from '../../src/index.js';
import {
  chamado,
  codigoErro,
  CPF_ANA,
  ctxRevisor,
  itensSugeridos,
  valor,
} from '../apoio/fabricas.js';

/** Marcador fictício, o mesmo do parecer do Revisor Sol. */
const MARCADOR = 'FICTICIO-SOMENTE-REVISAO';

function receberComDadosRh(mudancas: { nomeCompleto?: string; matricula?: string }) {
  const base = chamado({ idExterno: 'RH-SEGREDO-COLABORADOR' });
  return receberChamado(
    {
      chamado: { ...base, dadosRh: { ...base.dadosRh, ...mudancas } },
      pedidoMesmaOrigem: null,
      colaboradorExistente: null,
      configuracao: configuracaoPadrao(),
      versaoRegras: 'v',
      itensSugeridos: itensSugeridos(['jira']),
    },
    ctxRevisor(),
  );
}

describe('Regressão — nome e matrícula do RH não levam segredo ao Colaborador (regra 12)', () => {
  it.each([
    ['nomeCompleto', { nomeCompleto: `Ana password=${MARCADOR}` }],
    ['matricula', { matricula: `Bearer ${MARCADOR}` }],
  ] as const)('%s com segredo: colaborador, pedido, eventos e resposta limpos', (_, mudancas) => {
    const recebido = valor(receberComDadosRh(mudancas));
    if (recebido.tipo !== 'criado') throw new Error('esperava pedido criado');

    expect(recebido.colaboradorCriado).toBe(true);
    expect(JSON.stringify(recebido.colaborador)).not.toContain(MARCADOR);
    expect(JSON.stringify(recebido.pedido)).not.toContain(MARCADOR);
    expect(JSON.stringify(recebido.revisao)).not.toContain(MARCADOR);
    expect(JSON.stringify(recebido.eventos)).not.toContain(MARCADOR);
    // A resposta inteira, não só as partes conhecidas.
    expect(JSON.stringify(recebido)).not.toContain(MARCADOR);
  });

  it('nome e matrícula sem segredo continuam íntegros no colaborador', () => {
    const recebido = valor(receberComDadosRh({ nomeCompleto: 'Ana  Souza', matricula: 'M123' }));
    if (recebido.tipo !== 'criado') throw new Error('esperava pedido criado');
    expect(recebido.colaborador.nome).toBe('Ana Souza');
    expect(recebido.colaborador.matricula).toBe('M123');
  });

  it.each([
    ['nome', { nome: `Ana password=${MARCADOR}`, matricula: 'M123' }],
    ['matricula', { nome: 'Ana Souza', matricula: `Bearer ${MARCADOR}` }],
  ] as const)('criarColaborador direto recusa %s com segredo', (_, dados) => {
    const resultado = criarColaborador(
      { ...dados, cpf: CPF_ANA, tipoVinculo: 'celetista', dataAdmissao: '2026-11-03' },
      ctxRevisor(),
    );
    expect(codigoErro(resultado)).toBe('SEGREDO_NAO_PERMITIDO');
    expect(JSON.stringify(resultado)).not.toContain(MARCADOR);
  });
});
