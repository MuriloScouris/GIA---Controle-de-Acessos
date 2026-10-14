import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import {
  criarBancoDeTeste,
  TEM_BANCO,
  TEMPO_BANCO_MS,
  type BancoDeTeste,
} from '../teste/banco-de-teste.js';
import { desfazerUltima, MIGRACOES, migrarParaUltima } from './migrador.js';

let banco: BancoDeTeste | undefined;
afterEach(async () => {
  await banco?.descartar();
  banco = undefined;
}, TEMPO_BANCO_MS);

async function tabelas(b: BancoDeTeste): Promise<string[]> {
  const r = await sql<{ nome: string }>`
    select table_name as nome from information_schema.tables
    where table_schema = 'public' and table_name not like 'gia_migracoes%'
    order by table_name
  `.execute(b.db);
  return r.rows.map((linha) => linha.nome);
}

/** Chave primária e FKs de `eventos`. */
async function restricoesDeEventos(b: BancoDeTeste): Promise<string[]> {
  const r = await sql<{ nome: string }>`
    select conname as nome from pg_constraint
    where conrelid = 'eventos'::regclass and contype in ('f', 'p')
    order by conname
  `.execute(b.db);
  return r.rows.map((linha) => linha.nome);
}

describe.skipIf(!TEM_BANCO)('migrações', { timeout: TEMPO_BANCO_MS }, () => {
  it('banco vazio vai à última migração; rodar de novo não aplica nada', async () => {
    banco = await criarBancoDeTeste({ migrar: false });
    expect(await migrarParaUltima(banco.db)).toEqual(Object.keys(MIGRACOES));
    expect(await tabelas(banco)).toEqual([
      'colaboradores',
      'eventos',
      'itens',
      'operacoes',
      'pedidos',
      'revisoes',
    ]);
    expect(await migrarParaUltima(banco.db)).toEqual([]);
  });

  it('instâncias subindo juntas aplicam cada migração uma única vez', async () => {
    banco = await criarBancoDeTeste({ migrar: false });
    const outra = banco.outraConexao();
    const [a, b] = await Promise.all([migrarParaUltima(banco.db), migrarParaUltima(outra)]);
    expect([...a, ...b]).toEqual(Object.keys(MIGRACOES));
  });

  it('cada migração desfaz e refaz sem sobras', async () => {
    banco = await criarBancoDeTeste();
    expect(await desfazerUltima(banco.db)).toEqual(['0002-eventos-referencias']);
    expect(await restricoesDeEventos(banco)).toEqual(['eventos_corrige_fk', 'eventos_pkey']);
    expect(await desfazerUltima(banco.db)).toEqual(['0001-esquema-inicial']);
    expect(await tabelas(banco)).toEqual([]);
    expect(await migrarParaUltima(banco.db)).toEqual(Object.keys(MIGRACOES));
    expect(await restricoesDeEventos(banco)).toEqual([
      'eventos_colaborador_fk',
      'eventos_corrige_fk',
      'eventos_operacao_fk',
      'eventos_pedido_fk',
      'eventos_pkey',
    ]);
  });
});
