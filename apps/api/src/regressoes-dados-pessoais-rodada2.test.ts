import {
  listaPedidosSchema,
  pedidoDetalheSchema,
  resultadoImportacaoSchema,
  resultadoItensSchema,
  type PapelHumano,
  type PedidoDetalhe,
  type ResumoPedido,
} from '@gia/contratos';
import { describe, expect, it } from 'vitest';
import { mascararDadosPessoais } from './aplicacao/dados-pessoais.js';
import { cpfFicticio } from './simuladores/cpf-ficticio.js';
import { montarApi, type ApiDeTeste } from './teste/apoio.js';

/**
 * Regressões da rodada 2 da revisão do PR #4: matrícula na chave da issue
 * (Terra), matrícula que coincide com campos técnicos e matrícula com
 * caracteres especiais de substituição (Sol).
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
      gestor: null,
      ...campos,
    },
  };
}

async function importarUm(api: ApiDeTeste, cookie: string): Promise<string> {
  const res = await api.importar(cookie);
  expect(res.statusCode).toBe(200);
  const pedidoId = resultadoImportacaoSchema.parse(res.json()).criados[0]?.pedidoId;
  if (pedidoId === undefined) throw new Error('nenhum pedido criado');
  return pedidoId;
}

describe('regressão (Terra): matrícula na chave da issue do Jira', () => {
  it('RH-<matrícula> sai mascarada no relatório de importação e na lista', async () => {
    const matricula = '778899';
    const api = montarApi({
      chamados: [chamado(`RH-${matricula}`, { cpf: cpfFicticio('500000005'), matricula })],
    });
    const solicitante = await api.entrar('solicitante');
    for (const rodada of ['criados', 'duplicados'] as const) {
      const res = await api.importar(solicitante);
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(matricula);
      const relatorio = resultadoImportacaoSchema.parse(res.json());
      expect(relatorio[rodada].map((r) => r.chave)).toEqual(['RH-***99']);
    }
    for (const papel of ['solicitante', ...SEM_PERMISSAO_PLENA] as const) {
      const lista = await api.get(await api.entrar(papel), '/pedidos');
      expect(lista.body).not.toContain(matricula);
      expect(listaPedidosSchema.parse(lista.json()).pedidos[0]?.idExterno).toBe('RH-***99');
    }
    for (const papel of COM_PERMISSAO_PLENA) {
      const lista = await api.get(await api.entrar(papel), '/pedidos');
      expect(listaPedidosSchema.parse(lista.json()).pedidos[0]?.idExterno).toBe(`RH-${matricula}`);
    }
  });
});

/** Campos técnicos do detalhe, que a máscara nunca pode alterar. */
function tecnicosDoDetalhe(detalhe: PedidoDetalhe) {
  return {
    id: detalhe.id,
    status: detalhe.status,
    versao: detalhe.versao,
    tipoVinculo: detalhe.tipoVinculo,
    criadoEm: detalhe.criadoEm,
    atualizadoEm: detalhe.atualizadoEm,
    colaboradorId: detalhe.colaboradorId,
    origem: detalhe.origem.sistema,
    dataAdmissao: detalhe.dadosRh.dataAdmissao,
    revisao: {
      id: detalhe.revisao.id,
      situacao: detalhe.revisao.situacao,
      versaoRegras: detalhe.revisao.versaoRegras,
      aprovadaEm: detalhe.revisao.aprovadaEm,
      origemIdentidade: detalhe.revisao.identidade?.origem,
      verificacao: detalhe.revisao.verificacaoIdentidade?.situacao,
      verificadaEm: detalhe.revisao.verificacaoIdentidade?.verificadaEm,
      sistemas: detalhe.revisao.itens.map((item) => [item.sistema, item.parametros['sistema']]),
    },
    itens: detalhe.itens.map((item) => [item.id, item.sistema, item.status, item.versao]),
  };
}

function tecnicosDaLista(pedidos: readonly ResumoPedido[]) {
  return pedidos.map(({ id, status, versao, tipoVinculo, criadoEm, atualizadoEm }) => ({
    id,
    status,
    versao,
    tipoVinculo,
    criadoEm,
    atualizadoEm,
  }));
}

describe('regressão (Sol): matrícula que coincide com campos técnicos', () => {
  it.each(['2026', 'jira', 'aprovado'])(
    'matrícula %j não altera instantes, datas, enums nem IDs, e a resposta segue o contrato',
    async (matricula) => {
      const api = montarApi({
        chamados: [
          chamado('RH-6001', {
            cpf: cpfFicticio('600000006'),
            matricula,
            gestor: 'Gestora desde 2026-01-15T09:30:00Z',
          }),
        ],
      });
      const admin = await api.entrar('administradorGia');
      const pedidoId = await importarUm(api, admin);
      const antes = pedidoDetalheSchema.parse(
        (await api.get(admin, `/pedidos/${pedidoId}`)).json(),
      );
      const aprovado = await api.comando(admin, pedidoId, {
        pedidoId,
        versaoEsperada: antes.versao,
        acao: 'aprovar',
        dados: {},
      });
      expect(aprovado.statusCode).toBe(200);
      const completo = pedidoDetalheSchema.parse(
        (await api.get(admin, `/pedidos/${pedidoId}`)).json(),
      );
      const listaCompleta = listaPedidosSchema.parse((await api.get(admin, '/pedidos')).json());

      for (const papel of SEM_PERMISSAO_PLENA) {
        const cookie = await api.entrar(papel);
        // Schemas estritos do contrato: instantes e enums continuam válidos.
        const detalhe = pedidoDetalheSchema.parse(
          (await api.get(cookie, `/pedidos/${pedidoId}`)).json(),
        );
        const lista = listaPedidosSchema.parse((await api.get(cookie, '/pedidos')).json());
        const itens = resultadoItensSchema.parse(
          (await api.get(cookie, `/pedidos/${pedidoId}/itens`)).json(),
        );

        expect(tecnicosDoDetalhe(detalhe)).toEqual(tecnicosDoDetalhe(completo));
        expect(tecnicosDaLista(lista.pedidos)).toEqual(tecnicosDaLista(listaCompleta.pedidos));
        expect(itens.itens.map((item) => [item.id, item.sistema, item.status])).toEqual(
          completo.itens.map((item) => [item.id, item.sistema, item.status]),
        );
        expect(detalhe.dadosRh.matricula).toBe(`***${matricula.slice(-2)}`);
        // Instante ISO dentro de texto livre também é preservado.
        expect(detalhe.dadosRh.gestor).toBe('Gestora desde 2026-01-15T09:30:00Z');
      }
    },
  );
});

describe('regressão (Sol): matrícula com caracteres especiais de substituição', () => {
  it.each(['AB$&', 'CD$`', "EF$'", 'GH$$', 'IJ$1', 'K.L*M'])(
    'matrícula %j é mascarada literalmente no texto livre',
    async (matricula) => {
      const api = montarApi({
        chamados: [
          chamado('RH-7001', {
            cpf: cpfFicticio('700000007'),
            matricula,
            gestor: `Matrícula ${matricula} no RH`,
          }),
        ],
      });
      const revisor = await api.entrar('revisor');
      const pedidoId = await importarUm(api, revisor);
      const sufixo = matricula.slice(-2);

      for (const papel of SEM_PERMISSAO_PLENA) {
        const res = await api.get(await api.entrar(papel), `/pedidos/${pedidoId}`);
        expect(res.statusCode).toBe(200);
        const detalhe = pedidoDetalheSchema.parse(res.json());
        expect(detalhe.dadosRh.gestor).toBe(`Matrícula ***${sufixo} no RH`);
        expect(detalhe.dadosRh.matricula).toBe(`***${sufixo}`);
        expect(JSON.stringify(detalhe)).not.toContain(matricula);
      }
      const completo = pedidoDetalheSchema.parse(
        (await api.get(revisor, `/pedidos/${pedidoId}`)).json(),
      );
      expect(completo.dadosRh.gestor).toBe(`Matrícula ${matricula} no RH`);
    },
  );
});

describe('máscara de dados pessoais (rodada 2)', () => {
  it('preserva campos técnicos e datas ISO no texto livre; mascara o resto literalmente', () => {
    const resultado = mascararDadosPessoais(
      {
        criadoEm: '2026-10-13T12:00:00.000Z',
        status: 'aprovado',
        texto: 'Admitida em 2026-11-03T10:00:00Z, matrícula 2026 (AB$&), aprovado.',
      },
      { matriculas: ['2026', 'AB$&', 'aprovado'] },
    );
    expect(resultado).toEqual({
      criadoEm: '2026-10-13T12:00:00.000Z',
      status: 'aprovado',
      texto: 'Admitida em 2026-11-03T10:00:00Z, matrícula ***26 (***$&), ***do.',
    });
  });
});
