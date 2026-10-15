import { readFile } from 'node:fs/promises';
import { ErroConfiguracao, type VariaveisAmbiente } from '@gia/contratos';

/**
 * Configuração do transporte do Microsoft Graph (client credentials de um app
 * registration no Entra ID), validada no arranque. O segredo do app vem de
 * ARQUIVO montado pelo cofre (regra 12) e é relido quando o token renova.
 * Os hosts são fixos por nuvem: nenhuma URL vem do ambiente (sem SSRF).
 * Erros citam só o nome das variáveis, nunca os valores.
 */
export const VARIAVEIS_M365 = {
  tenantId: 'GIA_M365_TENANT_ID',
  clientId: 'GIA_M365_CLIENT_ID',
  arquivoSegredo: 'GIA_M365_CLIENT_SECRET_ARQUIVO',
  nuvem: 'GIA_M365_NUVEM',
  timeoutMs: 'GIA_M365_TIMEOUT_MS',
  tentativasLeitura: 'GIA_M365_TENTATIVAS_LEITURA',
} as const;

/** Hosts oficiais por nuvem do Microsoft 365. */
export const NUVENS_M365 = {
  global: {
    login: 'https://login.microsoftonline.com',
    graph: 'https://graph.microsoft.com',
  },
  usgov: {
    login: 'https://login.microsoftonline.us',
    graph: 'https://graph.microsoft.us',
  },
} as const;

export type NuvemM365 = keyof typeof NUVENS_M365;

export interface ConfiguracaoM365 {
  readonly tenantId: string;
  readonly clientId: string;
  readonly arquivoSegredo: string;
  readonly nuvem: NuvemM365;
  /** Prazo total de cada método do cliente (token, tentativas e esperas incluídos). */
  readonly timeoutMs: number;
  /** Tentativas de uma LEITURA em falha transitória ou limite de taxa. Escritas: uma só. */
  readonly tentativasLeitura: number;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMINIO = /^(?=.{4,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i;

export function carregarConfiguracaoM365(env: VariaveisAmbiente): ConfiguracaoM365 {
  const erros = new Set<string>();
  const V = VARIAVEIS_M365;
  const texto = (nome: string) => env[nome]?.trim() ?? '';
  const inteiro = (nome: string, padrao: number, min: number, max: number) => {
    const bruto = texto(nome);
    const valor = bruto === '' ? padrao : /^\d+$/.test(bruto) ? Number(bruto) : NaN;
    if (!(valor >= min && valor <= max)) erros.add(nome);
    return valor;
  };

  const tenantId = texto(V.tenantId);
  // "common"/"organizations" aceitariam outro tenant: só o tenant explícito.
  if (!GUID.test(tenantId) && !DOMINIO.test(tenantId)) erros.add(V.tenantId);
  const clientId = texto(V.clientId);
  if (!GUID.test(clientId)) erros.add(V.clientId);
  const arquivoSegredo = texto(V.arquivoSegredo);
  if (arquivoSegredo === '') erros.add(V.arquivoSegredo);
  const nuvem = texto(V.nuvem) || 'global';
  if (!(nuvem in NUVENS_M365)) erros.add(V.nuvem);

  const config: ConfiguracaoM365 = {
    tenantId,
    clientId,
    arquivoSegredo,
    nuvem: nuvem as NuvemM365,
    timeoutMs: inteiro(V.timeoutMs, 20_000, 100, 25_000),
    tentativasLeitura: inteiro(V.tentativasLeitura, 3, 1, 4),
  };
  if (erros.size > 0) throw new ErroConfiguracao([...erros].sort());
  return Object.freeze(config);
}

/** Lê o client secret do arquivo do cofre. Nunca guarda nem registra o valor. */
export async function lerSegredoM365(caminho: string): Promise<string> {
  let conteudo: string;
  try {
    conteudo = await readFile(caminho, 'utf8');
  } catch {
    throw new ErroConfiguracao([VARIAVEIS_M365.arquivoSegredo]);
  }
  const segredo = conteudo.replace(/\r?\n$/, '');
  if (segredo === '' || /[\r\n]/.test(segredo)) {
    throw new ErroConfiguracao([VARIAVEIS_M365.arquivoSegredo]);
  }
  return segredo;
}
