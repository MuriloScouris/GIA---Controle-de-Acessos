import {
  ErroConfiguracao,
  type VariaveisAmbiente,
} from '@gia/contratos';
import { exigirSegredosForaDoAmbiente } from '@gia/contratos/segredos';
import { criarDestinoJiraCloud } from './destino.js';
import { HttpJira, objeto, type OpcoesHttpJira } from './http.js';
import {
  criarOrigemJiraCloud,
  amostrarOrigemJiraCloud,
  validarOrigem,
  type OpcoesOrigemJiraCloud,
} from './origem.js';
import type { OpcoesConector } from '../motor.js';

/** Opt-in por variável; configuração parcial/errada nunca faz fallback silencioso. */
export function criarJiraDoAmbiente(
  env: VariaveisAmbiente,
  transporte: Pick<OpcoesHttpJira, 'fetch' | 'esperar' | 'auditar'> = {},
  limites: Omit<OpcoesConector, 'modo'> = {},
) {
  exigirSegredosForaDoAmbiente(env);
  const modo = env['GIA_JIRA_MODO'] ?? 'simulado';
  if (modo === 'simulado') {
    if (
      env['GIA_JIRA_ESCRITA_HABILITADA'] !== undefined &&
      env['GIA_JIRA_ESCRITA_HABILITADA'] !== 'false'
    )
      throw new ErroConfiguracao(['GIA_JIRA_MODO', 'GIA_JIRA_ESCRITA_HABILITADA']);
    return null;
  }
  if (modo !== 'real') throw new ErroConfiguracao(['GIA_JIRA_MODO']);
  if (
    env['GIA_JIRA_ESCRITA_HABILITADA'] !== undefined &&
    !['false', 'true'].includes(env['GIA_JIRA_ESCRITA_HABILITADA']!)
  )
    throw new ErroConfiguracao(['GIA_JIRA_ESCRITA_HABILITADA']);
  const http = new HttpJira({
    baseUrl: env['GIA_JIRA_BASE_URL'] ?? '',
    email: env['GIA_JIRA_EMAIL'] ?? '',
    apiToken: env['GIA_JIRA_API_TOKEN'] ?? '',
    timeoutMs: Number(env['GIA_JIRA_TIMEOUT_MS'] ?? '5000'),
    ...transporte,
  });
  let origem: OpcoesOrigemJiraCloud;
  try {
    const valor = objeto(JSON.parse(env['GIA_JIRA_ORIGEM_JSON'] ?? '') as unknown);
    const tipos = objeto(valor.tipos);
    const campos = objeto(valor.campos);
    origem = { ...valor, tipos, campos } as unknown as OpcoesOrigemJiraCloud;
    validarOrigem(origem);
  } catch {
    throw new ErroConfiguracao(['GIA_JIRA_ORIGEM_JSON']);
  }
  return {
    origem: criarOrigemJiraCloud(http, origem),
    amostrar: () => amostrarOrigemJiraCloud(http, origem),
    destino: criarDestinoJiraCloud(http, env['GIA_JIRA_ESCRITA_HABILITADA'] === 'true', limites),
  };
}
