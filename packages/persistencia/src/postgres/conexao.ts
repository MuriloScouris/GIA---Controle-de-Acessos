import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { BancoGia } from './esquema.js';

export const VARIAVEL_URL_BANCO = 'GIA_DATABASE_URL';

export interface OpcoesConexao {
  /** URL `postgres://...`. Vem do ambiente; nunca é registrada em log. */
  readonly url: string;
  readonly maxConexoes?: number;
  /** ADR-0004: 5 s para abrir conexão. */
  readonly timeoutConexaoMs?: number;
}

export function criarBanco(opcoes: OpcoesConexao): Kysely<BancoGia> {
  return new Kysely<BancoGia>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString: opcoes.url,
        max: opcoes.maxConexoes ?? 10,
        connectionTimeoutMillis: opcoes.timeoutConexaoMs ?? 5_000,
      }),
    }),
  });
}

/** Lê a URL do banco do ambiente; o erro cita só o nome da variável, nunca o valor. */
export function urlDoBanco(env: Readonly<Record<string, string | undefined>>): string {
  const url = env[VARIAVEL_URL_BANCO];
  if (url === undefined || url.trim() === '') {
    throw new Error(`Configuração inválida: ${VARIAVEL_URL_BANCO}`);
  }
  return url;
}
