import { readFile } from 'node:fs/promises';
import { ErroConfiguracao, type VariaveisAmbiente } from '@gia/contratos';
import { z } from 'zod';

/**
 * Configuração do transporte LDAPS do Active Directory, lida do ambiente e
 * validada no arranque. Nenhum segredo passa por variável de ambiente: a senha
 * da conta de serviço e o CA vêm de ARQUIVOS montados pelo cofre (regra 12), e
 * a senha é relida a cada conexão para acompanhar a rotação. Erros citam só o
 * nome das variáveis, nunca os valores.
 */
export const VARIAVEIS_AD = {
  urls: 'GIA_AD_URL',
  bindDn: 'GIA_AD_BIND_DN',
  arquivoSenha: 'GIA_AD_SENHA_ARQUIVO',
  baseDn: 'GIA_AD_BASE_DN',
  ouInativos: 'GIA_AD_OU_INATIVOS',
  atributoCpf: 'GIA_AD_ATRIBUTO_CPF',
  arquivoCa: 'GIA_AD_CA_ARQUIVO',
  nomeServidorTls: 'GIA_AD_TLS_NOME_SERVIDOR',
  timeoutConexaoMs: 'GIA_AD_TIMEOUT_CONEXAO_MS',
  timeoutOperacaoMs: 'GIA_AD_TIMEOUT_OPERACAO_MS',
  tentativasLeitura: 'GIA_AD_TENTATIVAS_LEITURA',
} as const;

/** Atributo onde o CPF fica gravado quando o ambiente não informa outro. */
export const ATRIBUTO_CPF_PADRAO = 'employeeID';

export interface ConfiguracaoAd {
  /** Um ou mais controladores de domínio, sempre `ldaps://`; o seguinte só é tentado se o anterior não conectou. */
  readonly urls: readonly string[];
  readonly bindDn: string;
  readonly arquivoSenha: string;
  readonly baseDn: string;
  readonly ouInativos: string;
  readonly atributoCpf: string;
  readonly arquivoCa: string | null;
  /** Nome esperado no certificado quando o DC é acessado por IP ou apelido. A verificação nunca é desligada. */
  readonly nomeServidorTls: string | null;
  readonly timeoutConexaoMs: number;
  readonly timeoutOperacaoMs: number;
  /** Tentativas de uma LEITURA quando nenhum DC aceita a conexão. Escritas nunca são repetidas aqui. */
  readonly tentativasLeitura: number;
}

const DN = z
  .string()
  .trim()
  .regex(/^[A-Za-z]+=.+/)
  .refine((dn) => /(^|,)\s*DC=/i.test(dn));

const URL_LDAPS = z
  .string()
  .trim()
  .regex(/^ldaps:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/?$/i);

const esquema = z
  .object({
    urls: z.array(URL_LDAPS).min(1),
    bindDn: DN,
    arquivoSenha: z.string().trim().min(1),
    baseDn: DN,
    ouInativos: DN,
    atributoCpf: z
      .string()
      .trim()
      .regex(/^[A-Za-z][A-Za-z0-9-]*$/),
    arquivoCa: z.string().trim().min(1).nullable(),
    nomeServidorTls: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9.-]+$/)
      .nullable(),
    timeoutConexaoMs: z.number().int().min(100).max(60_000),
    timeoutOperacaoMs: z.number().int().min(100).max(120_000),
    tentativasLeitura: z.number().int().min(1).max(5),
  })
  .refine((c) => sufixoDe(c.ouInativos, c.baseDn), { path: ['ouInativos'] });

function sufixoDe(dn: string, base: string): boolean {
  const normalizar = (valor: string) => valor.replace(/\s*,\s*/g, ',').toLowerCase();
  const filho = normalizar(dn);
  const pai = normalizar(base);
  return filho === pai || filho.endsWith(`,${pai}`);
}

function texto(env: VariaveisAmbiente, nome: string): string | undefined {
  const valor = env[nome]?.trim();
  return valor === undefined || valor === '' ? undefined : valor;
}

function inteiro(env: VariaveisAmbiente, nome: string, padrao: number): number | string {
  const valor = texto(env, nome);
  if (valor === undefined) return padrao;
  return /^\d+$/.test(valor) ? Number(valor) : valor;
}

/**
 * Lê e valida a configuração do AD. Também recusa `NODE_DEBUG=ldapts`: com ele
 * a biblioteca registra as mensagens LDAP inteiras, inclusive a senha inicial.
 */
export function carregarConfiguracaoAd(env: VariaveisAmbiente): ConfiguracaoAd {
  if (/(^|[,\s])ldapts($|[,\s])/i.test(env['NODE_DEBUG'] ?? '')) {
    throw new ErroConfiguracao(['NODE_DEBUG']);
  }
  const bruto = {
    urls: (texto(env, VARIAVEIS_AD.urls) ?? '')
      .split(',')
      .map((url) => url.trim())
      .filter((url) => url !== ''),
    bindDn: texto(env, VARIAVEIS_AD.bindDn),
    arquivoSenha: texto(env, VARIAVEIS_AD.arquivoSenha),
    baseDn: texto(env, VARIAVEIS_AD.baseDn),
    ouInativos: texto(env, VARIAVEIS_AD.ouInativos),
    atributoCpf: texto(env, VARIAVEIS_AD.atributoCpf) ?? ATRIBUTO_CPF_PADRAO,
    arquivoCa: texto(env, VARIAVEIS_AD.arquivoCa) ?? null,
    nomeServidorTls: texto(env, VARIAVEIS_AD.nomeServidorTls) ?? null,
    timeoutConexaoMs: inteiro(env, VARIAVEIS_AD.timeoutConexaoMs, 5_000),
    timeoutOperacaoMs: inteiro(env, VARIAVEIS_AD.timeoutOperacaoMs, 10_000),
    tentativasLeitura: inteiro(env, VARIAVEIS_AD.tentativasLeitura, 2),
  };
  const lido = esquema.safeParse(bruto);
  if (lido.success) return lido.data;
  const variaveis = new Set(
    lido.error.issues.map((issue) => {
      const campo = String(issue.path[0]) as keyof typeof VARIAVEIS_AD;
      return VARIAVEIS_AD[campo] ?? 'GIA_AD';
    }),
  );
  throw new ErroConfiguracao([...variaveis].sort());
}

/** Lê a senha da conta de serviço do arquivo do cofre. Nunca guarda nem registra o valor. */
export async function lerSegredoDeArquivo(caminho: string, variavel: string): Promise<string> {
  let conteudo: string;
  try {
    conteudo = await readFile(caminho, 'utf8');
  } catch {
    throw new ErroConfiguracao([variavel]);
  }
  // Arquivos de segredo costumam terminar com quebra de linha.
  const segredo = conteudo.replace(/\r?\n$/, '');
  if (segredo === '') throw new ErroConfiguracao([variavel]);
  return segredo;
}
