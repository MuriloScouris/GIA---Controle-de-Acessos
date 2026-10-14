import type { Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationResultSet } from 'kysely/migration';
import type { BancoGia } from './esquema.js';
import * as esquemaInicial from './migracoes/0001-esquema-inicial.js';

/**
 * Migrações versionadas, aplicadas em ordem pelo nome. Uma migração já
 * publicada nunca é editada: mudança de esquema é sempre uma migração nova.
 */
export const MIGRACOES: Readonly<Record<string, Migration>> = Object.freeze({
  '0001-esquema-inicial': esquemaInicial,
});

function migrador(db: Kysely<BancoGia>): Migrator {
  return new Migrator({
    db,
    provider: { getMigrations: async () => ({ ...MIGRACOES }) },
    migrationTableName: 'gia_migracoes',
    migrationLockTableName: 'gia_migracoes_trava',
  });
}

export class ErroDeMigracao extends Error {
  constructor(
    readonly migracao: string | null,
    causa: unknown,
  ) {
    super(`Migração ${migracao ?? '(desconhecida)'} falhou`, { cause: causa });
    this.name = 'ErroDeMigracao';
  }
}

function exigirSucesso(resultado: MigrationResultSet): readonly string[] {
  if (resultado.error !== undefined) {
    const falhou = resultado.results?.find((r) => r.status === 'Error');
    throw new ErroDeMigracao(falhou?.migrationName ?? null, resultado.error);
  }
  return (resultado.results ?? []).map((r) => r.migrationName);
}

/**
 * Aplica as migrações pendentes; devolve os nomes aplicadas agora. Seguro
 * com várias instâncias subindo juntas: o Kysely serializa por trava no banco.
 */
export async function migrarParaUltima(db: Kysely<BancoGia>): Promise<readonly string[]> {
  return exigirSucesso(await migrador(db).migrateToLatest());
}

/** Desfaz a última migração aplicada (uso em desenvolvimento e testes). */
export async function desfazerUltima(db: Kysely<BancoGia>): Promise<readonly string[]> {
  return exigirSucesso(await migrador(db).migrateDown());
}
