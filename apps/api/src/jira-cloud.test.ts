import { criarJiraDoAmbiente } from '@gia/conectores';
import { resultadoImportacaoSchema } from '@gia/contratos';
import { afterEach, expect, it, vi } from 'vitest';
import { criarAppDoAmbiente } from './index.js';
import { cpfFicticio } from './simuladores/cpf-ficticio.js';
import { montarApi } from './teste/apoio.js';

afterEach(() => vi.unstubAllGlobals());
const origem = {
  projeto: 'RH',
  tipos: { celetista: 'RH efetivo', terceiro: 'RH externo' },
  campos: {
    tipoSolicitacao: 'tipo',
    nomeCompleto: 'nome',
    cpf: 'cpf',
    matricula: 'matricula',
    emailCorporativo: 'email',
    area: 'area',
    cargo: 'cargo',
    dataAdmissao: 'data',
    gestor: 'gestor',
  },
};
const env = {
  GIA_JIRA_MODO: 'real',
  GIA_JIRA_BASE_URL: 'https://tenant.example.invalid',
  GIA_JIRA_EMAIL: 'servico@example.invalid',
  GIA_JIRA_API_TOKEN: 'token-ficticio',
  GIA_JIRA_ORIGEM_JSON: JSON.stringify(origem),
};
function chamado(key: string, tipo: string, cpf: string) {
  return {
    key,
    fields: {
      tipo,
      nome: 'Pessoa Ficticia',
      cpf,
      matricula: null,
      email: 'pessoa@example.invalid',
      area: 'Tecnologia',
      cargo: 'Analista',
      data: '2026-11-01',
      gestor: null,
    },
  };
}

it('origem REST → API → transações e auditoria: dois vínculos, falha isolada, reprocessamento e concorrência', async () => {
  const issues = [
    chamado('RH-1', 'RH efetivo', cpfFicticio('000000001')),
    chamado('RH-2', 'RH externo', cpfFicticio('000000002')),
    { key: 'RH-3', fields: {} },
  ];
  const fetchFake = vi
    .fn<typeof fetch>()
    .mockImplementation(async () =>
      Response.json({ issues: [...issues, issues[0]], isLast: true }),
    );
  const jira = criarJiraDoAmbiente(env, { fetch: fetchFake });
  if (jira === null) throw new Error('Jira não montado');
  const api = montarApi({ fonteJira: jira.origem });
  try {
    const cookie = await api.entrar('revisor');
    const primeira = resultadoImportacaoSchema.parse((await api.importar(cookie)).json());
    expect(primeira.criados.map((c) => c.tipoVinculo)).toEqual(['celetista', 'terceiro']);
    expect(primeira.recusados).toMatchObject([{ chave: 'RH-3', codigo: 'DADO_INVALIDO' }]);
    expect(api.persistencia.espiar.pedidos()).toHaveLength(2);
    const antes = api.persistencia.espiar.eventos();
    expect(antes.length).toBeGreaterThan(0);
    expect(new Set(antes.filter((e) => e.pedidoId !== null).map((e) => e.pedidoId))).toEqual(
      new Set(primeira.criados.map((c) => c.pedidoId)),
    );
    const repeticoes = await Promise.all([api.importar(cookie), api.importar(cookie)]);
    for (const resposta of repeticoes) {
      expect(resposta.statusCode).toBe(200);
      const r = resultadoImportacaoSchema.parse(resposta.json());
      expect(r.criados).toEqual([]);
      expect(r.duplicados).toHaveLength(2);
    }
    expect(api.persistencia.espiar.pedidos()).toHaveLength(2);
    expect(api.persistencia.espiar.eventos()).toEqual(antes);
    expect(JSON.stringify(antes)).not.toContain('token-ficticio');
  } finally {
    await api.app.close();
  }
});

it('entrypoint monta a origem do ambiente, sem fallback simulado quando a configuração falha', async () => {
  const fetchFake = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ issues: [], isLast: true }));
  vi.stubGlobal('fetch', fetchFake);
  // DEV-288: em `teste`, a sessão simulada exige opt-in explícito.
  const app = criarAppDoAmbiente({ ...env, GIA_AMBIENTE: 'teste', GIA_AUTH_SIMULADA: 'true' });
  try {
    const login = await app.inject({
      method: 'POST',
      url: '/sessao/simulada',
      headers: { 'x-gia-csrf': '1' },
      payload: { papel: 'revisor' },
    });
    const resposta = await app.inject({
      method: 'POST',
      url: '/importacoes/jira',
      headers: { 'x-gia-csrf': '1', cookie: String(login.headers['set-cookie']).split(';')[0]! },
      payload: {},
    });
    expect(resposta.statusCode).toBe(200);
    expect(fetchFake).toHaveBeenCalledTimes(1);
    expect(String(fetchFake.mock.calls[0]?.[0])).toContain('/rest/api/3/search/jql');
  } finally {
    await app.close();
  }
  expect(() => criarAppDoAmbiente({ GIA_JIRA_MODO: 'real' })).toThrow('GIA_JIRA_BASE_URL');
});
