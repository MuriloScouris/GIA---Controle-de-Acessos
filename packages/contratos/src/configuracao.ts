import { z } from 'zod';

export const PACOTE = '@gia/contratos';

/**
 * Configuração de ambiente validada no arranque. A escrita nos sistemas de
 * destino nasce desligada (regra 8). `GIA_ESCRITA_EXTERNA=true` é só a chave
 * mestra: nunca vale em desenvolvimento, e cada sistema/operação ainda precisa
 * estar em `GIA_ESCRITA_LIBERADA` (ver `gates.ts`). Nenhum segredo faz parte do
 * esquema.
 */
const formatoAmbiente = {
  ambiente: z.enum(['desenvolvimento', 'teste', 'producao']).default('desenvolvimento'),
  escritaExterna: z.boolean().default(false),
};

function semEscritaEmDesenvolvimento(c: {
  readonly ambiente: string;
  readonly escritaExterna: boolean;
}): boolean {
  return !(c.escritaExterna && c.ambiente === 'desenvolvimento');
}

export const configuracaoAmbienteSchema = z
  .object(formatoAmbiente)
  .refine(semEscritaEmDesenvolvimento, { path: ['escritaExterna'] });

export type ConfiguracaoAmbiente = z.infer<typeof configuracaoAmbienteSchema>;

export const configuracaoApiSchema = z
  .object({ ...formatoAmbiente, porta: z.number().int().min(1).max(65535).default(3000) })
  .refine(semEscritaEmDesenvolvimento, { path: ['escritaExterna'] });

export type ConfiguracaoApi = z.infer<typeof configuracaoApiSchema>;

/** Erro de configuração com mensagem sanitizada: lista só os nomes das variáveis, nunca os valores. */
export class ErroConfiguracao extends Error {
  readonly variaveis: readonly string[];

  constructor(variaveis: readonly string[]) {
    super(`Configuração inválida: ${variaveis.join(', ')}`);
    this.name = 'ErroConfiguracao';
    this.variaveis = variaveis;
  }
}

export type VariaveisAmbiente = Readonly<Record<string, string | undefined>>;

const NOME_VARIAVEL: Record<string, string> = {
  ambiente: 'GIA_AMBIENTE',
  escritaExterna: 'GIA_ESCRITA_EXTERNA',
  porta: 'PORT',
};

function definido(valor: string | undefined): string | undefined {
  return valor === undefined || valor === '' ? undefined : valor;
}

function converterBooleano(valor: string | undefined): boolean | string | undefined {
  const v = definido(valor);
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

function converterInteiro(valor: string | undefined): number | string | undefined {
  const v = definido(valor);
  return v !== undefined && /^\d+$/.test(v) ? Number(v) : v;
}

function semIndefinidos(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

function validar<T>(schema: z.ZodType<T>, bruto: Record<string, unknown>): T {
  const resultado = schema.safeParse(semIndefinidos(bruto));
  if (resultado.success) return resultado.data;
  const campos = new Set(
    resultado.error.issues.map((i) => NOME_VARIAVEL[String(i.path[0])] ?? String(i.path[0])),
  );
  throw new ErroConfiguracao([...campos].sort());
}

/** Lê e valida GIA_AMBIENTE e GIA_ESCRITA_EXTERNA. */
export function carregarConfiguracaoAmbiente(env: VariaveisAmbiente): ConfiguracaoAmbiente {
  return validar(configuracaoAmbienteSchema, {
    ambiente: definido(env['GIA_AMBIENTE']),
    escritaExterna: converterBooleano(env['GIA_ESCRITA_EXTERNA']),
  });
}

/** Lê e valida a configuração da API: ambiente, escrita externa e PORT. */
export function carregarConfiguracaoApi(env: VariaveisAmbiente): ConfiguracaoApi {
  return validar(configuracaoApiSchema, {
    ambiente: definido(env['GIA_AMBIENTE']),
    escritaExterna: converterBooleano(env['GIA_ESCRITA_EXTERNA']),
    porta: converterInteiro(env['PORT']),
  });
}
