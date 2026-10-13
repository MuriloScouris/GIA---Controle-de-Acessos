import { z } from 'zod';

export const PACOTE = '@gia/contratos';

/**
 * Configuração de ambiente validada no arranque.
 * A escrita nos sistemas de destino nasce desligada e não pode ser ligada neste scaffold;
 * nenhum segredo faz parte do esquema.
 */
export const configuracaoAmbienteSchema = z.object({
  ambiente: z.enum(['desenvolvimento', 'teste', 'producao']).default('desenvolvimento'),
  escritaExterna: z.literal(false).default(false),
});

export type ConfiguracaoAmbiente = z.infer<typeof configuracaoAmbienteSchema>;

export const configuracaoApiSchema = configuracaoAmbienteSchema.extend({
  porta: z.number().int().min(1).max(65535).default(3000),
});

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
