import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PACOTE, criarUnidadeDeTrabalhoEmMemoria, urlDoBanco } from './index.js';
import { NO_CI, TEM_BANCO } from './teste/banco-de-teste.js';

describe('@gia/persistencia', () => {
  it('expõe o identificador do pacote', () => {
    expect(PACOTE).toBe('@gia/persistencia');
  });

  it('confirma todas as mudanças quando o trabalho termina bem', async () => {
    const { uow, confirmados } = criarUnidadeDeTrabalhoEmMemoria<string>();
    await uow.executar(async (tx) => {
      tx.push('estado', 'evento');
    });
    expect(confirmados()).toEqual(['estado', 'evento']);
  });

  it('descarta tudo quando o trabalho falha (atomicidade estado + evento)', async () => {
    const { uow, confirmados } = criarUnidadeDeTrabalhoEmMemoria<string>();
    await expect(
      uow.executar(async (tx) => {
        tx.push('estado');
        throw new Error('falha antes do evento');
      }),
    ).rejects.toThrow('falha antes do evento');
    expect(confirmados()).toEqual([]);
  });

  it('acessa o banco só por PostgreSQL + Kysely (ADR-0003)', () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@gia/dominio', 'kysely', 'pg']);
  });

  it('URL do banco ausente: o erro cita só o nome da variável', () => {
    expect(() => urlDoBanco({})).toThrow('Configuração inválida: GIA_DATABASE_URL');
    expect(urlDoBanco({ GIA_DATABASE_URL: 'postgres://localhost/gia' })).toBe(
      'postgres://localhost/gia',
    );
  });

  it('no CI os testes de banco rodam de verdade (GIA_DATABASE_URL_TESTE definida)', () => {
    if (NO_CI) expect(TEM_BANCO).toBe(true);
  });
});
