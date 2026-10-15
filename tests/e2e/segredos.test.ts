import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Segredos fora do código (regra 12): varre os arquivos versionados atrás de
 * padrões de ALTA confiança — chave privada, tokens com prefixo de provedor e
 * JWT completo. Fixtures fictícias usam valores óbvios ("senha-de-teste",
 * "eyJ-token-ficticio"), que não casam com estes padrões.
 */
const RAIZ = join(import.meta.dirname, '..', '..');

const PADROES: readonly (readonly [string, RegExp])[] = [
  ['chave privada PEM', /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ['chave de acesso AWS', /\bAKIA[0-9A-Z]{16}\b/],
  ['token do GitHub', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['token do Slack', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['token da Atlassian', /\bATATT3[A-Za-z0-9_\-=]{30,}\b/],
  ['JWT completo', /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{20,}\b/],
];

/**
 * Valores fictícios conhecidos, versionados de propósito como fixture. Só o
 * valor exato é aceito, nunca o arquivo inteiro.
 */
const FIXTURES_CONHECIDAS: readonly string[] = [
  // Teste da regra 12 no domínio: payload de exemplo do jwt.io, assinatura "signature-de-teste".
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLWRlLXRlc3Rl',
];

function arquivosVersionados(): string[] {
  const saida = execFileSync('git', ['ls-files', '-z'], { cwd: RAIZ, encoding: 'utf8' });
  return saida
    .split('\0')
    .filter((f) => f !== '' && !/\.(png|jpe?g|gif|ico|woff2?|pdf|docx|lock)$/i.test(f))
    .filter((f) => f !== 'pnpm-lock.yaml');
}

describe('segredos fora do código', () => {
  it('nenhum arquivo versionado contém segredo com padrão de alta confiança', () => {
    const achados: string[] = [];
    for (const arquivo of arquivosVersionados()) {
      // Este arquivo descreve os padrões e não pode acusar a si mesmo.
      if (arquivo.endsWith('tests/e2e/segredos.test.ts')) continue;
      let conteudo: string;
      try {
        conteudo = readFileSync(join(RAIZ, arquivo), 'utf8');
      } catch {
        continue;
      }
      for (const fixture of FIXTURES_CONHECIDAS) conteudo = conteudo.replaceAll(fixture, '');
      for (const [nome, padrao] of PADROES) {
        if (padrao.test(conteudo)) achados.push(`${arquivo}: ${nome}`);
      }
    }
    expect(achados).toEqual([]);
  });

  it('os padrões pegam um segredo real (o teste não passa por vacuidade)', () => {
    const jwt = [
      'eyJhbGciOiJIUzI1NiJ9xxxxxx',
      'eyJzdWIiOiIxMjM0NTY3ODkwIn0x',
      'dozvPAsHuvqWjr6nnYIa5IeH8xX0w',
    ].join('.');
    expect(PADROES.some(([, p]) => p.test(jwt))).toBe(true);
    expect(PADROES.some(([, p]) => p.test(`-----BEGIN ${'PRIVATE'} KEY-----`))).toBe(true);
    expect(PADROES.some(([, p]) => p.test('senha-de-teste eyJ-token-ficticio'))).toBe(false);
  });
});
