import {
  pedidoDetalheSchema,
  resultadoImportacaoSchema,
  type PapelHumano,
  type PedidoDetalhe,
} from '@gia/contratos';
import { describe, expect, it } from 'vitest';
import { mascararDadosPessoais } from './aplicacao/dados-pessoais.js';
import { cpfFicticio } from './simuladores/cpf-ficticio.js';
import { montarApi } from './teste/apoio.js';

/**
 * Regressão da rodada 4 da revisão do PR #4 (Sol): matrícula conhecida
 * seguida de trecho com cara de data (`778899-01-01`) era cortada pela
 * preservação de datas ISO (`8899-01-01`) e chegava inteira em texto livre a
 * quem não tem permissão plena.
 */
const SEM_PERMISSAO_PLENA: readonly PapelHumano[] = ['executor', 'auditor'];
const COM_PERMISSAO_PLENA: readonly PapelHumano[] = ['revisor', 'administradorGia'];

function chamado(key: string, campos: Record<string, unknown>): unknown {
  return {
    key,
    fields: {
      tipoSolicitacao: 'Admissão - Celetista',
      nomeCompleto: 'Bia Ficticia Lopes',
      emailCorporativo: 'bia.lopes@exemplo.com.br',
      area: 'Tecnologia',
      cargo: 'Analista',
      dataAdmissao: '2026-11-03',
      ...campos,
    },
  };
}

function tecnicos(detalhe: PedidoDetalhe) {
  const { id, status, versao, tipoVinculo, criadoEm, atualizadoEm } = detalhe;
  return { id, status, versao, tipoVinculo, criadoEm, atualizadoEm };
}

describe('regressão (Sol): matrícula seguida de trecho com cara de data', () => {
  it('motivo e gestor com 778899-01-01 chegam mascarados a executor e auditor; inteiros a quem tem permissão plena', async () => {
    const matricula = '778899';
    const gestor = `Matrícula ${matricula}-01-01 no RH`;
    const motivo = `Matrícula ${matricula}-01-01T10:00:00Z divergente`;
    const api = montarApi({
      chamados: [chamado('RH-4001', { cpf: cpfFicticio('400000004'), matricula, gestor })],
    });
    const revisor = await api.entrar('revisor');
    const res = await api.importar(revisor);
    expect(res.statusCode).toBe(200);
    const criado = resultadoImportacaoSchema.parse(res.json()).criados[0];
    if (!criado) throw new Error('nenhum pedido criado');
    const rejeicao = await api.comando(revisor, criado.pedidoId, {
      pedidoId: criado.pedidoId,
      versaoEsperada: criado.versao,
      acao: 'rejeitar',
      dados: { motivo },
    });
    expect(rejeicao.statusCode).toBe(200);
    const completo = pedidoDetalheSchema.parse(
      (await api.get(revisor, `/pedidos/${criado.pedidoId}`)).json(),
    );

    for (const papel of SEM_PERMISSAO_PLENA) {
      const corpo = await api.get(await api.entrar(papel), `/pedidos/${criado.pedidoId}`);
      expect(corpo.statusCode).toBe(200);
      expect(corpo.body).not.toContain(matricula);
      const detalhe = pedidoDetalheSchema.parse(corpo.json());
      expect(detalhe.dadosRh.matricula).toBe('***99');
      expect(detalhe.dadosRh.gestor).toBe('Matrícula ***99-01-01 no RH');
      expect(detalhe.motivoRejeicao).toBe('Matrícula ***99-01-01T10:00:00Z divergente');
      expect(tecnicos(detalhe)).toEqual(tecnicos(completo));
    }
    for (const papel of COM_PERMISSAO_PLENA) {
      const detalhe = pedidoDetalheSchema.parse(
        (await api.get(await api.entrar(papel), `/pedidos/${criado.pedidoId}`)).json(),
      );
      expect(detalhe.dadosRh.matricula).toBe(matricula);
      expect(detalhe.dadosRh.gestor).toBe(gestor);
      expect(detalhe.motivoRejeicao).toBe(motivo);
    }
  });
});

describe('máscara de dados pessoais (rodada 4)', () => {
  it.each([
    ['778899', '778899-01-01', '***99-01-01'],
    ['778899', 'Matrícula 778899-01-01T10:00:00Z', 'Matrícula ***99-01-01T10:00:00Z'],
    ['778899', 'Ref. 778899-12-31.', 'Ref. ***99-12-31.'],
    ['AB2026', 'Código AB2026-01-01', 'Código ***26-01-01'],
    ['X-2026', 'Código X-2026-01-01', 'Código ***26-01-01'],
    ['8899', 'Número 778899-01-01', 'Número 77***99-01-01'],
  ])(
    'matrícula %j colada em trecho com cara de data é mascarada: %j',
    (matricula, entrada, esperado) => {
      expect(mascararDadosPessoais({ texto: entrada }, { matriculas: [matricula] })).toEqual({
        texto: esperado,
      });
    },
  );

  it('continua preservando datas ISO legítimas, campos técnicos e CPF', () => {
    const cpf = cpfFicticio('100000001');
    const resultado = mascararDadosPessoais(
      {
        criadoEm: '2026-10-13T12:00:00.000Z',
        dataAdmissao: '2026-11-03',
        texto: `Matrícula 778899 em 2026-01-01; 2026 desde 2026-01-15T09:30:00Z; CPF ${cpf}-01-01.`,
      },
      { matriculas: ['778899', '2026'] },
    );
    expect(resultado).toEqual({
      criadoEm: '2026-10-13T12:00:00.000Z',
      dataAdmissao: '2026-11-03',
      texto: `Matrícula ***99 em 2026-01-01; ***26 desde 2026-01-15T09:30:00Z; CPF 100.***.***-${cpf.slice(9)}-01-01.`,
    });
  });
});
