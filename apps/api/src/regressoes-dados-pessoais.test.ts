import {
  listaPedidosSchema,
  pedidoDetalheSchema,
  resultadoImportacaoSchema,
  resultadoItemSchema,
  resultadoItensSchema,
  type PapelHumano,
  type ResultadoImportacao,
} from '@gia/contratos';
import { describe, expect, it } from 'vitest';
import { mascararDadosPessoais } from './aplicacao/dados-pessoais.js';
import { cpfFicticio } from './simuladores/cpf-ficticio.js';
import { montarApi, type ApiDeTeste } from './teste/apoio.js';

/**
 * Regressões do P1 da revisão do PR #4: o campo `cpf` saía mascarado, mas o
 * CPF (e a matrícula) colados em texto livre chegavam inteiros a papéis sem
 * permissão plena. Agora a projeção inteira é mascarada para eles.
 */
const SEM_PERMISSAO_PLENA: readonly PapelHumano[] = ['executor', 'auditor'];
const COM_PERMISSAO_PLENA: readonly PapelHumano[] = ['revisor', 'administradorGia'];

function formatado(cpf: string): string {
  return `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
}

/** O CPF não aparece em nenhuma forma (só dígitos ou com máscara de formatação). */
function semCpf(corpo: string, cpf: string): void {
  expect(corpo).not.toContain(cpf);
  expect(corpo).not.toContain(formatado(cpf));
}

function chamado(key: string, campos: Record<string, unknown>): unknown {
  return {
    key,
    fields: {
      tipoSolicitacao: 'Admissão - Celetista',
      emailCorporativo: 'bia.lopes@exemplo.com.br',
      area: 'Tecnologia',
      cargo: 'Analista',
      dataAdmissao: '2026-11-03',
      gestor: null,
      matricula: null,
      ...campos,
    },
  };
}

async function importar(api: ApiDeTeste, cookie: string): Promise<ResultadoImportacao> {
  const res = await api.importar(cookie);
  expect(res.statusCode).toBe(200);
  return resultadoImportacaoSchema.parse(res.json());
}

function primeiroPedido(relatorio: ResultadoImportacao): string {
  const pedidoId = relatorio.criados[0]?.pedidoId;
  if (pedidoId === undefined) throw new Error('nenhum pedido criado');
  return pedidoId;
}

describe('regressão: CPF em motivo de rejeição', () => {
  it('executor e auditor recebem o motivo mascarado; revisor e Administrador do Gia, inteiro', async () => {
    const cpf = cpfFicticio('100000001');
    const api = montarApi();
    const revisor = await api.entrar('revisor');
    const relatorio = await importar(api, revisor);
    const criado = relatorio.criados.find((c) => c.chave === 'RH-1001');
    if (!criado) throw new Error('RH-1001 não importado');
    const motivo = `CPF divergente ${formatado(cpf)} no cadastro do RH.`;
    const rejeicao = await api.comando(revisor, criado.pedidoId, {
      pedidoId: criado.pedidoId,
      versaoEsperada: criado.versao,
      acao: 'rejeitar',
      dados: { motivo },
    });
    expect(rejeicao.statusCode).toBe(200);

    for (const papel of SEM_PERMISSAO_PLENA) {
      const res = await api.get(await api.entrar(papel), `/pedidos/${criado.pedidoId}`);
      expect(res.statusCode).toBe(200);
      semCpf(res.body, cpf);
      const detalhe = pedidoDetalheSchema.parse(res.json());
      expect(detalhe.dadosRh.cpf).toBe('100.***.***-' + cpf.slice(9));
      expect(detalhe.motivoRejeicao).toBe(
        `CPF divergente 100.***.***-${cpf.slice(9)} no cadastro do RH.`,
      );
    }
    for (const papel of COM_PERMISSAO_PLENA) {
      const detalhe = pedidoDetalheSchema.parse(
        (await api.get(await api.entrar(papel), `/pedidos/${criado.pedidoId}`)).json(),
      );
      expect(detalhe.motivoRejeicao).toBe(motivo);
      expect(detalhe.dadosRh.cpf).toBe(cpf);
    }
  });
});

describe('regressão: CPF e matrícula em texto do RH', () => {
  it('nome, gestor, matrícula e parâmetros chegam mascarados a quem não tem permissão plena', async () => {
    const cpf = cpfFicticio('300000003');
    const outroCpf = cpfFicticio('300000004');
    const matricula = 'MAT-778899';
    const api = montarApi({
      chamados: [
        chamado('RH-3001', {
          nomeCompleto: `Bia ${cpf} Lopes`,
          cpf,
          matricula,
          gestor: `Gestor CPF ${formatado(outroCpf)} matrícula ${matricula}`,
        }),
      ],
    });
    const admin = await api.entrar('administradorGia');
    const pedidoId = primeiroPedido(await importar(api, admin));
    const pedido = pedidoDetalheSchema.parse((await api.get(admin, `/pedidos/${pedidoId}`)).json());
    // Aprovado, para que existam itens e resultados a consultar.
    const aprovado = await api.comando(admin, pedidoId, {
      pedidoId,
      versaoEsperada: pedido.versao,
      acao: 'aprovar',
      dados: {},
    });
    expect(aprovado.statusCode).toBe(200);

    for (const papel of SEM_PERMISSAO_PLENA) {
      const cookie = await api.entrar(papel);
      const detalhe = await api.get(cookie, `/pedidos/${pedidoId}`);
      const itens = await api.get(cookie, `/pedidos/${pedidoId}/itens`);
      for (const res of [detalhe, itens]) {
        expect(res.statusCode).toBe(200);
        semCpf(res.body, cpf);
        semCpf(res.body, outroCpf);
        expect(res.body).not.toContain(matricula);
      }
      const visto = pedidoDetalheSchema.parse(detalhe.json());
      expect(visto.dadosRh.nomeCompleto).toBe(
        `Bia ${formatado(cpf).slice(0, 4)}***.***-${cpf.slice(9)} Lopes`,
      );
      expect(visto.dadosRh.matricula).toBe('***99');
      expect(visto.dadosRh.gestor).toBe(
        `Gestor CPF 300.***.***-${outroCpf.slice(9)} matrícula ***99`,
      );
      const softexpert = visto.revisao.itens.find((item) => item.sistema === 'softexpert');
      expect(softexpert?.parametros['identificador']).toBe('***99');
      // IDs continuam utilizáveis.
      expect(visto.id).toBe(pedidoId);
      resultadoItensSchema.parse(itens.json());
    }

    for (const papel of COM_PERMISSAO_PLENA) {
      const visto = pedidoDetalheSchema.parse(
        (await api.get(await api.entrar(papel), `/pedidos/${pedidoId}`)).json(),
      );
      expect(visto.dadosRh.nomeCompleto).toBe(`Bia ${cpf} Lopes`);
      expect(visto.dadosRh.matricula).toBe(matricula);
    }
  });
});

describe('regressão: CPF na listagem', () => {
  it('nome do colaborador e chave da issue saem mascarados na lista e na importação', async () => {
    const cpf = cpfFicticio('400000004');
    const chave = `RH-${cpf}`;
    const chamados = [chamado(chave, { nomeCompleto: `Caio ${formatado(cpf)} Reis`, cpf })];

    const api = montarApi({ chamados });
    await importar(api, await api.entrar('revisor'));
    for (const papel of SEM_PERMISSAO_PLENA) {
      const res = await api.get(await api.entrar(papel), '/pedidos');
      expect(res.statusCode).toBe(200);
      semCpf(res.body, cpf);
      const [resumo] = listaPedidosSchema.parse(res.json()).pedidos;
      expect(resumo?.nomeColaborador).toBe(`Caio 400.***.***-${cpf.slice(9)} Reis`);
      expect(resumo?.idExterno).toBe(`RH-400.***.***-${cpf.slice(9)}`);
    }
    for (const papel of COM_PERMISSAO_PLENA) {
      const [resumo] = listaPedidosSchema.parse(
        (await api.get(await api.entrar(papel), '/pedidos')).json(),
      ).pedidos;
      expect(resumo?.idExterno).toBe(chave);
    }

    // Solicitante: o relatório da importação e a lista dos próprios pedidos também.
    const outra = montarApi({ chamados });
    const solicitante = await outra.entrar('solicitante');
    const importacao = await outra.importar(solicitante);
    semCpf(importacao.body, cpf);
    const lista = await outra.get(solicitante, '/pedidos');
    expect(listaPedidosSchema.parse(lista.json()).pedidos).toHaveLength(1);
    semCpf(lista.body, cpf);
  });
});

describe('regressão: CPF no histórico do item', () => {
  it('observação manual com CPF sai mascarada para o executor e inteira para o Administrador do Gia', async () => {
    const cpf = cpfFicticio('100000001');
    const api = montarApi();
    const admin = await api.entrar('administradorGia');
    const relatorio = await importar(api, admin);
    const criado = relatorio.criados.find((c) => c.chave === 'RH-1001');
    if (!criado) throw new Error('RH-1001 não importado');
    const pedidoId = criado.pedidoId;
    const aprovado = await api.comando(admin, pedidoId, {
      pedidoId,
      versaoEsperada: criado.versao,
      acao: 'aprovar',
      dados: {},
    });
    const { versao } = aprovado.json() as { versao: number };
    const itens = resultadoItensSchema.parse(
      (await api.get(admin, `/pedidos/${pedidoId}/itens`)).json(),
    );
    const itemId = itens.itens[0]?.id;
    const observacao = `Conta criada para o CPF ${cpf} pelo suporte.`;
    const executor = await api.entrar('executor');
    const manual = await api.comando(executor, pedidoId, {
      pedidoId,
      versaoEsperada: versao,
      acao: 'registrarAcessoManual',
      dados: { itemId, observacao },
    });
    expect(manual.statusCode).toBe(200);

    const visto = await api.get(executor, `/pedidos/${pedidoId}/itens/${itemId}`);
    semCpf(visto.body, cpf);
    expect(resultadoItemSchema.parse(visto.json()).id).toBe(itemId);
    const completo = resultadoItemSchema.parse(
      (await api.get(admin, `/pedidos/${pedidoId}/itens/${itemId}`)).json(),
    );
    expect(completo.observacaoManual).toBe(observacao);
  });
});

describe('máscara de dados pessoais', () => {
  it('não altera UUIDs, mesmo quando contêm uma sequência que parece CPF', () => {
    const id = `5e0f6a10-0000-4000-8000-a${cpfFicticio('100000001')}`;
    expect(id).toHaveLength(36);
    const mascarado = mascararDadosPessoais({
      id,
      ids: [id],
      texto: `id ${cpfFicticio('100000001')}`,
    });
    expect(mascarado.id).toBe(id);
    expect(mascarado.ids).toEqual([id]);
    expect(mascarado.texto).not.toContain(cpfFicticio('100000001'));
  });

  it('não muta a entrada', () => {
    const entrada = { cpf: cpfFicticio('100000001'), matricula: 'M1001' };
    mascararDadosPessoais(entrada, { matriculas: ['M1001'] });
    expect(entrada).toEqual({ cpf: cpfFicticio('100000001'), matricula: 'M1001' });
  });
});
