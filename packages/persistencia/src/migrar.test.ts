import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { migrar } from './migrar.js';
import { MIGRACOES } from './postgres/migrador.js';
import {
  criarBancoDeTeste,
  TEM_BANCO,
  TEMPO_BANCO_MS,
  type BancoDeTeste,
} from './teste/banco-de-teste.js';

let pasta: string;
beforeAll(async () => {
  pasta = await mkdtemp(join(tmpdir(), 'gia-migrar-'));
});
afterAll(async () => {
  await rm(pasta, { recursive: true, force: true });
});

const URL_FICTICIA = 'postgres://gia:senha-ficticia@127.0.0.1:1/gia';

describe('migrar: URL do banco como segredo', () => {
  it('em produção recusa a URL com senha por valor, citando só o nome', async () => {
    const erro = await migrar({ GIA_AMBIENTE: 'producao', GIA_DATABASE_URL: URL_FICTICIA }).catch(
      (e: unknown) => e as Error,
    );
    expect(erro).toBeInstanceOf(Error);
    expect((erro as Error).message).toBe('Configuração inválida: GIA_DATABASE_URL');
    expect((erro as Error).message).not.toContain('senha-ficticia');
  });

  it('valor e arquivo ao mesmo tempo é erro', async () => {
    const arquivo = join(pasta, 'url-dupla');
    await writeFile(arquivo, URL_FICTICIA);
    await expect(
      migrar({ GIA_DATABASE_URL: URL_FICTICIA, GIA_DATABASE_URL_ARQUIVO: arquivo }),
    ).rejects.toThrow('Configuração inválida: GIA_DATABASE_URL');
  });

  it('arquivo ilegível ou vazio é erro sobre GIA_DATABASE_URL_ARQUIVO', async () => {
    await expect(migrar({ GIA_DATABASE_URL_ARQUIVO: join(pasta, 'nao-existe') })).rejects.toThrow(
      'GIA_DATABASE_URL_ARQUIVO',
    );
    const vazio = join(pasta, 'vazio');
    await writeFile(vazio, '');
    await expect(migrar({ GIA_DATABASE_URL_ARQUIVO: vazio })).rejects.toThrow(
      'GIA_DATABASE_URL_ARQUIVO',
    );
  });
});

describe.skipIf(!TEM_BANCO)('migrar com o banco', { timeout: TEMPO_BANCO_MS }, () => {
  let banco: BancoDeTeste | undefined;
  afterEach(async () => {
    await banco?.descartar();
    banco = undefined;
  }, TEMPO_BANCO_MS);

  it('em produção lê a URL de GIA_DATABASE_URL_ARQUIVO e aplica as migrações', async () => {
    banco = await criarBancoDeTeste({ migrar: false });
    const arquivo = join(pasta, 'url');
    await writeFile(arquivo, `${banco.url}\n`);
    expect(await migrar({ GIA_AMBIENTE: 'producao', GIA_DATABASE_URL_ARQUIVO: arquivo })).toEqual(
      Object.keys(MIGRACOES),
    );
  });
});
