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

const git = promisify(execFile);

async function saidaDoGit(...args: string[]): Promise<string[]> {
  const { stdout } = await git('git', args, {
    cwd: RAIZ,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.split('\0').filter((f) => f !== '');
}

/**
 * Arquivos a varrer e, à parte, os que o Git ainda lista mas que foram apagados do disco (`git rm`
 * ainda não feito). Só estes podem faltar sem falhar a varredura: não há conteúdo no disco para
 * conter segredo, e no CI (checkout limpo) a lista é sempre vazia.
 */
async function arquivosVersionados(): Promise<{
  arquivos: string[];
  removidos: ReadonlySet<string>;
}> {
  const [todos, removidos] = await Promise.all([
    saidaDoGit('ls-files', '-z'),
    saidaDoGit('ls-files', '--deleted', '-z'),
  ]);
  return {
    arquivos: todos
      .filter((f) => !/\.(png|jpe?g|gif|ico|woff2?|pdf|docx|lock)$/i.test(f))
      .filter((f) => f !== 'pnpm-lock.yaml'),
    removidos: new Set(removidos),
  };
}

type LeitorDeArquivo = (arquivo: string) => Promise<string>;
const lerDoDisco: LeitorDeArquivo = (arquivo) => readFile(join(RAIZ, arquivo), 'utf8');

interface Leitura {
  readonly lidos: ReadonlyArray<readonly [arquivo: string, conteudo: string]>;
  /** Arquivos que não puderam ser lidos, com o código do erro: nunca são ignorados em silêncio. */
  readonly ilegiveis: readonly string[];
}

/**
 * Lê em lotes paralelos: o tempo é de espera do disco, que se sobrepõe; o lote evita estourar
 * descritores. Falha de leitura vira `ilegiveis` (o teste falha com o caminho), exceto o arquivo
 * apagado do disco que o Git ainda lista (`removidos`, ENOENT), que é pulado de forma explícita.
 */
async function lerEmLotes(
  arquivos: readonly string[],
  removidos: ReadonlySet<string> = new Set(),
  ler: LeitorDeArquivo = lerDoDisco,
): Promise<Leitura> {
  const lidos: Array<readonly [string, string]> = [];
  const ilegiveis: string[] = [];
  for (let i = 0; i < arquivos.length; i += LOTE_DE_LEITURA) {
    const lote = arquivos.slice(i, i + LOTE_DE_LEITURA);
    await Promise.all(
      lote.map(async (arquivo) => {
        try {
          lidos.push([arquivo, await ler(arquivo)]);
        } catch (erro) {
          const codigo = (erro as { code?: unknown } | null)?.code;
          if (codigo === 'ENOENT' && removidos.has(arquivo)) return;
          ilegiveis.push(`${arquivo} (${typeof codigo === 'string' ? codigo : 'erro de leitura'})`);
        }
      }),
    );
  }
  return { lidos, ilegiveis: ilegiveis.sort() };
}

/** Um achado por arquivo e padrão; o conteúdo conhecido como fixture é descontado antes. */
function acharSegredos(lidos: Leitura['lidos']): string[] {
  const achados: string[] = [];
  for (const [arquivo, original] of lidos) {
    let conteudo = original;
    for (const fixture of FIXTURES_CONHECIDAS) conteudo = conteudo.replaceAll(fixture, '');
    for (const [nome, padrao] of PADROES) {
      if (padrao.test(conteudo)) achados.push(`${arquivo}: ${nome}`);
    }
  }
  return achados.sort();
}

describe('segredos fora do código', () => {
  it(
    'nenhum arquivo versionado contém segredo com padrão de alta confiança',
    async () => {
      const versionados = await arquivosVersionados();
      // Este arquivo descreve os padrões e não pode acusar a si mesmo.
      const alvo = versionados.arquivos.filter(
        (arquivo) => !arquivo.endsWith('tests/e2e/segredos.test.ts'),
      );
      // A lista não pode vir vazia (git sem repositório, filtro errado) e passar por vacuidade.
      expect(alvo).toContain('package.json');
      expect(alvo.length).toBeGreaterThan(50);
      const { lidos, ilegiveis } = await lerEmLotes(alvo, versionados.removidos);
      // Arquivo que não pôde ser lido não foi varrido: falha, com o caminho, em vez de sumir.
      expect(ilegiveis, 'arquivos versionados que não puderam ser lidos').toEqual([]);
      expect(lidos.length).toBeGreaterThan(50);
      expect(acharSegredos(lidos)).toEqual([]);
    },
    PRAZO_DA_VARREDURA_MS,
  );

  describe('falha de leitura derruba a varredura, nunca a esconde', () => {
    const erroDeLeitura = (codigo: string) => Object.assign(new Error('falha'), { code: codigo });
    /** Leitor em memória: um arquivo com segredo, um sem, e os que o teste fizer falhar. */
    const leitorCom =
      (falhas: Record<string, string>): LeitorDeArquivo =>
      async (arquivo) => {
        if (arquivo in falhas) throw erroDeLeitura(falhas[arquivo]!);
        return arquivo === 'com-segredo.txt' ? `chave ${'AKIA'}ABCDEFGHIJKLMNOP` : 'nada aqui';
      };

    it('arquivo ilegível é listado com o caminho e o código, e os demais seguem varridos', async () => {
      const { lidos, ilegiveis } = await lerEmLotes(
        ['ok.txt', 'com-segredo.txt', 'protegido/chave.pem', 'outro.txt'],
        new Set(),
        leitorCom({ 'protegido/chave.pem': 'EACCES' }),
      );
      expect(ilegiveis).toEqual(['protegido/chave.pem (EACCES)']);
      expect(lidos.map(([arquivo]) => arquivo).sort()).toEqual([
        'com-segredo.txt',
        'ok.txt',
        'outro.txt',
      ]);
      // A falha de um arquivo não esconde o segredo de outro.
      expect(acharSegredos(lidos)).toEqual(['com-segredo.txt: chave de acesso AWS']);
    });

    it('ENOENT só é perdoado para arquivo apagado do disco que o Git ainda lista', async () => {
      const leitor = leitorCom({ 'apagado.txt': 'ENOENT', 'sumiu-sem-git.txt': 'ENOENT' });
      const { lidos, ilegiveis } = await lerEmLotes(
        ['ok.txt', 'apagado.txt', 'sumiu-sem-git.txt'],
        new Set(['apagado.txt']),
        leitor,
      );
      expect(lidos.map(([arquivo]) => arquivo)).toEqual(['ok.txt']);
      // O que o Git não reconhece como apagado e não abre continua sendo falha.
      expect(ilegiveis).toEqual(['sumiu-sem-git.txt (ENOENT)']);
    });

    it('ENOENT é o único código perdoado: apagado do disco com outro erro continua falhando', async () => {
      // Listado como removido, mas com EACCES: não é ausência, é arquivo que não pôde ser lido.
      const { ilegiveis } = await lerEmLotes(
        ['a.txt'],
        new Set(['a.txt']),
        leitorCom({ 'a.txt': 'EACCES' }),
      );
      expect(ilegiveis).toEqual(['a.txt (EACCES)']);
    });

    it('com o disco de verdade: um caminho rastreado que não abre como arquivo (diretório) falha com o caminho', async () => {
      const { lidos, ilegiveis } = await lerEmLotes(['package.json', 'tests']);
      expect(lidos.map(([arquivo]) => arquivo)).toEqual(['package.json']);
      expect(ilegiveis).toEqual(['tests (EISDIR)']);
    });

    it('erro sem código ainda é falha, com o caminho', async () => {
      const { ilegiveis } = await lerEmLotes(['x.txt'], new Set(), async () => {
        throw new Error('sem código');
      });
      expect(ilegiveis).toEqual(['x.txt (erro de leitura)']);
    });
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
