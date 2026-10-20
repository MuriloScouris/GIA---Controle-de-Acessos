import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

/**
 * Segredos fora do código (regra 12): varre os arquivos versionados atrás de
 * padrões de ALTA confiança — chave privada, tokens com prefixo de provedor e
 * JWT completo. Fixtures fictícias usam valores óbvios ("senha-de-teste",
 * "eyJ-token-ficticio"), que não casam com estes padrões.
 */
const RAIZ = join(import.meta.dirname, '..', '..');

/**
 * A varredura é o teste mais pesado em disco e em processo: um `git ls-files` e a leitura de todos os
 * arquivos versionados. Isolada leva ~0,3 s; na bateria completa (`turbo` roda os pacotes em
 * paralelo e o disco do Windows disputa com eles) o `git` sozinho chegou a ~1 s e o teste a passar de
 * 5 s, o padrão do vitest. Por isso ela é assíncrona, lê em lotes paralelos e tem um prazo próprio:
 * só um travamento real do ambiente estoura o prazo; um segredo achado falha na asserção, nunca no
 * tempo.
 */
const PRAZO_DA_VARREDURA_MS = 60_000;
const LOTE_DE_LEITURA = 64;

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

async function arquivosVersionados(): Promise<string[]> {
  const { stdout } = await promisify(execFile)('git', ['ls-files', '-z'], {
    cwd: RAIZ,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout
    .split('\0')
    .filter((f) => f !== '' && !/\.(png|jpe?g|gif|ico|woff2?|pdf|docx|lock)$/i.test(f))
    .filter((f) => f !== 'pnpm-lock.yaml');
}

/** Lê em lotes paralelos: o tempo é de espera do disco, que se sobrepõe; o lote evita estourar descritores. */
async function lerEmLotes(arquivos: readonly string[]): Promise<Array<[string, string | null]>> {
  const lidos: Array<[string, string | null]> = [];
  for (let i = 0; i < arquivos.length; i += LOTE_DE_LEITURA) {
    const lote = arquivos.slice(i, i + LOTE_DE_LEITURA);
    lidos.push(
      ...(await Promise.all(
        lote.map(async (arquivo): Promise<[string, string | null]> => [
          arquivo,
          await readFile(join(RAIZ, arquivo), 'utf8').catch(() => null),
        ]),
      )),
    );
  }
  return lidos;
}

describe('segredos fora do código', () => {
  it(
    'nenhum arquivo versionado contém segredo com padrão de alta confiança',
    async () => {
      const achados: string[] = [];
      // Este arquivo descreve os padrões e não pode acusar a si mesmo.
      const alvo = (await arquivosVersionados()).filter(
        (arquivo) => !arquivo.endsWith('tests/e2e/segredos.test.ts'),
      );
      // A lista não pode vir vazia (git sem repositório, filtro errado) e passar por vacuidade.
      expect(alvo).toContain('package.json');
      expect(alvo.length).toBeGreaterThan(50);
      const lidos = await lerEmLotes(alvo);
      expect(lidos.filter(([, lido]) => lido !== null).length).toBeGreaterThan(50);
      for (const [arquivo, lido] of lidos) {
        if (lido === null) continue;
        let conteudo = lido;
        for (const fixture of FIXTURES_CONHECIDAS) conteudo = conteudo.replaceAll(fixture, '');
        for (const [nome, padrao] of PADROES) {
          if (padrao.test(conteudo)) achados.push(`${arquivo}: ${nome}`);
        }
      }
      expect(achados).toEqual([]);
    },
    PRAZO_DA_VARREDURA_MS,
  );

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
