import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PACOTE } from './index.js';

const raiz = join(import.meta.dirname, '..');
const fontes = readdirSync(join(raiz, 'src'))
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => readFileSync(join(raiz, 'src', f), 'utf8'));

describe('@gia/dominio', () => {
  it('expõe o identificador do pacote', () => {
    expect(PACOTE).toBe('@gia/dominio');
  });

  it('não declara dependências (domínio puro, sem I/O)', () => {
    const pkg = JSON.parse(readFileSync(join(raiz, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies).toEqual({});
  });

  it('não importa módulos de I/O, frameworks nem outros pacotes do Gia', () => {
    for (const fonte of fontes) {
      expect(fonte).not.toMatch(/from\s+['"](node:|fastify|react|zod|@gia\/)/);
    }
  });
});
