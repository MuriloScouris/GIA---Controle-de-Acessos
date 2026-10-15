import { POLITICA_EXECUCAO_PADRAO, type ContextoItem, type ParametrosJira } from '@gia/dominio';
import { afterEach, expect, it, vi } from 'vitest';
import { montarConectores } from './index.js';
import { aplicarGatesDeEscrita } from './gates.js';
import { carregarGatesDeEscrita } from '@gia/contratos';
import { conectoresReaisDoAmbiente } from './reais.js';

afterEach(() => vi.unstubAllGlobals());

it('worker seleciona Jira real por contexto; operações simuladas continuam sem rede', async () => {
  const fetchFake = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 401 }));
  vi.stubGlobal('fetch', fetchFake);
  const campos = {
    tipoSolicitacao: 'tipo',
    nomeCompleto: 'nome',
    cpf: 'cpf',
    matricula: 'matricula',
    emailCorporativo: 'email',
    area: 'area',
    cargo: 'cargo',
    dataAdmissao: 'data',
    gestor: 'gestor',
  };
  const env = {
    GIA_AMBIENTE: 'teste',
    GIA_ESCRITA_EXTERNA: 'true',
    GIA_ESCRITA_LIBERADA: 'jira:criar',
    GIA_JIRA_MODO: 'real',
    GIA_JIRA_BASE_URL: 'https://tenant.example.invalid',
    GIA_JIRA_EMAIL: 'servico@example.invalid',
    GIA_JIRA_API_TOKEN: 'token-ficticio',
    GIA_JIRA_ESCRITA_HABILITADA: 'true',
    GIA_JIRA_ORIGEM_JSON: JSON.stringify({
      projeto: 'RH',
      tipos: { celetista: 'Efetivo', terceiro: 'Externo' },
      campos,
    }),
  };
  const conectores = aplicarGatesDeEscrita(
    montarConectores(POLITICA_EXECUCAO_PADRAO).conectores,
    await conectoresReaisDoAmbiente(env, POLITICA_EXECUCAO_PADRAO),
    carregarGatesDeEscrita(env),
  );
  const parametros: ParametrosJira = {
    sistema: 'jira',
    email: 'pessoa@example.invalid',
    nome: 'Pessoa Ficticia',
    grupos: [],
  };
  const ctx: ContextoItem = {
    operacaoId: '00000000-0000-4000-8000-000000000001',
    itemId: '00000000-0000-4000-8000-000000000002',
    chaveIdempotencia: 'gia:teste:1',
    modo: 'simulado',
    parametros,
    etapaInicial: null,
  };
  expect(await conectores.jira.provisionar(ctx)).toMatchObject({
    modo: 'simulado',
    efeito: 'confirmado',
  });
  expect(fetchFake).not.toHaveBeenCalled();
  expect(await conectores.jira.provisionar({ ...ctx, modo: 'real' })).toMatchObject({
    modo: 'real',
    efeito: 'semEfeito',
    codigo: 'JIRA_AUTENTICACAO',
  });
  expect(fetchFake).toHaveBeenCalledTimes(1);
});
