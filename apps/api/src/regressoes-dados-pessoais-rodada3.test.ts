import { pedidoDetalheSchema, resultadoImportacaoSchema, type PapelHumano } from '@gia/contratos';
import { describe, expect, it } from 'vitest';
import { mascararDadosPessoais } from './aplicacao/dados-pessoais.js';
import { cpfFicticio } from './simuladores/cpf-ficticio.js';
import { montarApi } from './teste/apoio.js';

/**
 * Regressão da rodada 3 da revisão do PR #4 (Sol): um CPF só com dígitos
 * seguido de um trecho com cara de data (`<cpf>-01-01`) era cortado pela
 * preservação de datas ISO (`8909-01-01`) antes da máscara de CPF, e chegava
 * inteiro a quem não tem permissão plena.
 */
const SEM_PERMISSAO_PLENA: readonly PapelHumano[] = ['executor', 'auditor'];
const COM_PERMISSAO_PLENA: readonly PapelHumano[] = ['revisor', 'administradorGia'];

function formatado(cpf: string): string {
  return `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
}

function mascarado(cpf: string): string {
  return `${cpf.slice(0, 3)}.***.***-${cpf.slice(9)}`;
}

describe('regressão (Sol): CPF seguido de trecho com cara de data', () => {
  it('motivo com <cpf>-01-01 chega mascarado a executor e auditor; inteiro a quem tem permissão plena', async () => {
    const cpf = cpfFicticio('100000001');
    const api = montarApi();
    const revisor = await api.entrar('revisor');
    const res = await api.importar(revisor);
    expect(res.statusCode).toBe(200);
    const criado = resultadoImportacaoSchema
      .parse(res.json())
      .criados.find((c) => c.chave === 'RH-1001');
    if (!criado) throw new Error('RH-1001 não importado');
    const motivo = `CPF ${cpf}-01-01 divergente no RH.`;
    const rejeicao = await api.comando(revisor, criado.pedidoId, {
      pedidoId: criado.pedidoId,
      versaoEsperada: criado.versao,
      acao: 'rejeitar',
      dados: { motivo },
    });
    expect(rejeicao.statusCode).toBe(200);

    for (const papel of SEM_PERMISSAO_PLENA) {
      const corpo = await api.get(await api.entrar(papel), `/pedidos/${criado.pedidoId}`);
      expect(corpo.statusCode).toBe(200);
      expect(corpo.body).not.toContain(cpf);
      expect(corpo.body).not.toContain(formatado(cpf));
      const detalhe = pedidoDetalheSchema.parse(corpo.json());
      expect(detalhe.motivoRejeicao).toBe(`CPF ${mascarado(cpf)}-01-01 divergente no RH.`);
    }
    for (const papel of COM_PERMISSAO_PLENA) {
      const detalhe = pedidoDetalheSchema.parse(
        (await api.get(await api.entrar(papel), `/pedidos/${criado.pedidoId}`)).json(),
      );
      expect(detalhe.motivoRejeicao).toBe(motivo);
    }
  });
});

describe('máscara de dados pessoais (rodada 3)', () => {
  const cpf = cpfFicticio('100000001');

  it.each([
    [`${cpf}-01-01`, `${mascarado(cpf)}-01-01`],
    [`${cpf}-01-01T10:00:00Z`, `${mascarado(cpf)}-01-01T10:00:00Z`],
    [`CPF ${cpf}-12-31 no RH`, `CPF ${mascarado(cpf)}-12-31 no RH`],
    [`${formatado(cpf)}-01-01`, `${mascarado(cpf)}-01-01`],
  ])('CPF colado em trecho com cara de data é mascarado: %j', (entrada, esperado) => {
    expect(mascararDadosPessoais({ texto: entrada })).toEqual({ texto: esperado });
  });

  it('continua preservando datas ISO e mascarando CPF e matrícula ao redor', () => {
    const resultado = mascararDadosPessoais(
      {
        criadoEm: '2026-10-13T12:00:00.000Z',
        texto: `CPF ${cpf} em 2026-01-01, matrícula 2026 desde 2026-01-15T09:30:00Z.`,
      },
      { matriculas: ['2026'] },
    );
    expect(resultado).toEqual({
      criadoEm: '2026-10-13T12:00:00.000Z',
      texto: `CPF ${mascarado(cpf)} em 2026-01-01, matrícula ***26 desde 2026-01-15T09:30:00Z.`,
    });
  });
});
