import { describe, expect, it } from 'vitest';
import {
  alterarStatusColaborador,
  criarColaborador,
  TRANSICOES_COLABORADOR,
} from '../../src/index.js';
import { codigoErro, CPF_ANA, ctxExecutor, ctxRevisor, valor } from '../apoio/fabricas.js';

function colaborador() {
  return valor(
    criarColaborador(
      {
        cpf: `${CPF_ANA.slice(0, 3)}.${CPF_ANA.slice(3, 6)}.${CPF_ANA.slice(6, 9)}-${CPF_ANA.slice(9)}`,
        matricula: ' M1 ',
        nome: ' Ana  Souza ',
        tipoVinculo: 'celetista',
        dataAdmissao: '2026-11-03',
      },
      ctxRevisor(),
    ),
  ).colaborador;
}

describe('Colaborador', () => {
  it('nasce ativo, com CPF normalizado e sem identidade efetiva', () => {
    expect(colaborador()).toMatchObject({
      cpf: CPF_ANA,
      matricula: 'M1',
      nome: 'Ana Souza',
      status: 'ativo',
      login: null,
      email: null,
      versao: 1,
    });
  });

  it('recusa CPF inválido, nome vazio e data inválida', () => {
    const base = {
      cpf: CPF_ANA,
      matricula: null,
      nome: 'Ana',
      tipoVinculo: 'celetista',
      dataAdmissao: '2026-11-03',
    } as const;
    expect(codigoErro(criarColaborador({ ...base, cpf: '123.456.789-00' }, ctxRevisor()))).toBe(
      'CPF_INVALIDO',
    );
    expect(codigoErro(criarColaborador({ ...base, nome: ' ' }, ctxRevisor()))).toBe(
      'DADO_INVALIDO',
    );
    expect(
      codigoErro(criarColaborador({ ...base, dataAdmissao: '2026-02-30' }, ctxRevisor())),
    ).toBe('DADO_INVALIDO');
  });

  it('transições de status: afastar, desligar e readmitir', () => {
    expect(TRANSICOES_COLABORADOR.desligado).toEqual(['ativo']);
    const ativo = colaborador();
    const desligado = valor(
      alterarStatusColaborador(
        ativo,
        { status: 'desligado', data: '2027-01-31' },
        1,
        ctxExecutor(),
      ),
    ).colaborador;
    expect(desligado).toMatchObject({
      status: 'desligado',
      dataDesligamento: '2027-01-31',
      versao: 2,
    });
    expect(
      codigoErro(
        alterarStatusColaborador(
          desligado,
          { status: 'afastado', data: '2027-02-01' },
          2,
          ctxExecutor(),
        ),
      ),
    ).toBe('TRANSICAO_INVALIDA');
    const readmitido = valor(
      alterarStatusColaborador(
        desligado,
        { status: 'ativo', data: '2027-06-01' },
        2,
        ctxExecutor(),
      ),
    ).colaborador;
    expect(readmitido).toMatchObject({
      status: 'ativo',
      dataAdmissao: '2027-06-01',
      dataDesligamento: null,
    });
  });

  it('alteração de status exige versão atual e permissão', () => {
    const ativo = colaborador();
    expect(
      codigoErro(
        alterarStatusColaborador(
          ativo,
          { status: 'afastado', data: '2027-01-01' },
          9,
          ctxExecutor(),
        ),
      ),
    ).toBe('CONFLITO_DE_VERSAO');
    expect(
      codigoErro(
        alterarStatusColaborador(
          ativo,
          { status: 'afastado', data: '2027-01-01' },
          1,
          ctxRevisor(),
        ),
      ),
    ).toBe('PERMISSAO_NEGADA');
  });
});
