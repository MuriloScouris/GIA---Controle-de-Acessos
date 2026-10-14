import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { criarBanco } from '../postgres/conexao.js';
import type { BancoGia } from '../postgres/esquema.js';
import { migrarParaUltima } from '../postgres/migrador.js';

/**
 * Apoio a testes (`@gia/persistencia/teste`), não usado em produção. Testes
 * de persistência usam PostgreSQL real (ADR-0003), apontado por
 * `GIA_DATABASE_URL_TESTE` (usuário com permissão de criar banco). Cada
 * arquivo de teste cria um banco descartável e o apaga no fim.
 *
 * Sem a variável, os testes de banco são pulados localmente
 * (`describe.skipIf(!TEM_BANCO)`); no CI (`CI` definido) a ausência é falha,
 * para o pulo nunca passar despercebido.
 */
export const URL_TESTE = process.env.GIA_DATABASE_URL_TESTE ?? '';
export const TEM_BANCO = URL_TESTE !== '';
export const NO_CI = (process.env.CI ?? '') !== '';

/** Criar e apagar bancos é lento sob carga (testes de vários pacotes em paralelo). */
export const TEMPO_BANCO_MS = 60_000;

export interface BancoDeTeste {
  readonly db: Kysely<BancoGia>;
  /** Outra conexão ao mesmo banco, para simular uma segunda instância. */
  outraConexao(): Kysely<BancoGia>;
  descartar(): Promise<void>;
}

async function comAdmin(trabalho: (admin: pg.Client) => Promise<void>): Promise<void> {
  const admin = new pg.Client({ connectionString: URL_TESTE });
  await admin.connect();
  try {
    await trabalho(admin);
  } finally {
    await admin.end();
  }
}

/** Banco vazio; com `migrar` (padrão), já na última migração. */
export async function criarBancoDeTeste({ migrar = true } = {}): Promise<BancoDeTeste> {
  // Nome gerado aqui, nunca vindo de fora: seguro para interpolar no DDL.
  const nome = `gia_teste_${randomUUID().replaceAll('-', '')}`;
  await comAdmin(async (admin) => {
    await admin.query(`create database ${nome}`);
  });
  const url = new URL(URL_TESTE);
  url.pathname = `/${nome}`;
  const conexoes: Kysely<BancoGia>[] = [];
  const conectar = (): Kysely<BancoGia> => {
    const db = criarBanco({ url: url.toString(), maxConexoes: 5 });
    conexoes.push(db);
    return db;
  };
  const db = conectar();
  if (migrar) await migrarParaUltima(db);
  return {
    db,
    outraConexao: conectar,
    async descartar() {
      await Promise.all(conexoes.map((conexao) => conexao.destroy()));
      await comAdmin(async (admin) => {
        await admin.query(`drop database if exists ${nome} with (force)`);
      });
    },
  };
}
