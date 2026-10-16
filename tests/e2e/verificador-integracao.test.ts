import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * O verificador da integração (DEV-291) fixa o hash do blob de cada arquivo
 * declarado como exceção no manifesto. Declarar um arquivo não pode liberar
 * conteúdo novo nele: um desvio do tipo `GIA_BACKDOOR=1 -> sessão simulada`
 * em `apps/api/src/index.ts` ou `apps/worker/src/index.ts` tem de falhar.
 */
const RAIZ = join(import.meta.dirname, '..', '..');
const VERIFICADOR = join(RAIZ, 'scripts', 'verificar-integracao-sprint1.mjs');
const MANIFESTO = 'docs/integracao/sprint1-manifesto.json';
const AUTOR = ['-c', 'user.name=teste', '-c', 'user.email=teste@invalid'];

const BACKDOOR = `\nif (process.env['GIA_BACKDOOR'] === '1') autenticacao = { modo: 'simulada' };\n`;

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

function verificar(repo: string, alvo: string, ...extra: string[]) {
  const r = spawnSync(
    process.execPath,
    [VERIFICADOR, '--repo', repo, '--alvo', alvo, '--somente-blobs', ...extra],
    { encoding: 'utf8' },
  );
  return { codigo: r.status, saida: `${r.stdout}${r.stderr}` };
}

/** Commit com os arquivos trocados (ou apagados, com `null`), sem mexer no worktree nem no branch. */
function commitComMutacao(repo: string, base: string, mutacoes: Record<string, string | null>) {
  const indice = join(mkdtempSync(join(tmpdir(), 'gia-indice-')), 'index');
  const env = { ...process.env, GIT_INDEX_FILE: indice };
  const g = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env }).trim();
  g('read-tree', base);
  for (const [arquivo, conteudo] of Object.entries(mutacoes)) {
    if (conteudo === null) {
      g('update-index', '--force-remove', arquivo);
      continue;
    }
    const blob = execFileSync('git', ['-C', repo, 'hash-object', '-w', '--stdin'], {
      encoding: 'utf8',
      input: conteudo,
    }).trim();
    g('update-index', '--cacheinfo', `100644,${blob},${arquivo}`);
  }
  const arvore = g('write-tree');
  rmSync(dirname(indice), { recursive: true, force: true });
  return execFileSync('git', ['-C', repo, ...AUTOR, 'commit-tree', arvore, '-p', base, '-m', 'x'], {
    encoding: 'utf8',
  }).trim();
}

// Cada caso roda git e node em subprocesso; no Windows isso passa dos 5 s padrão.
const TEMPO_MS = 60_000;

describe(
  'verificador da integração: hash dos arquivos declarados (repositório isolado)',
  { timeout: TEMPO_MS },
  () => {
    const repo = mkdtempSync(join(tmpdir(), 'gia-verificador-'));
    afterAll(() => rmSync(repo, { recursive: true, force: true }));

    const escrever = (arquivo: string, conteudo: string) => {
      mkdirSync(dirname(join(repo, arquivo)), { recursive: true });
      writeFileSync(join(repo, arquivo), conteudo);
    };

    function montar(): string {
      git(repo, 'init', '--quiet');
      escrever('apps/api/src/index.ts', "export const autenticacao = { modo: 'oidc' };\n");
      escrever('apps/worker/src/index.ts', 'export const worker = true;\n');
      escrever('apps/api/src/sessao/autenticacao-ambiente.ts', 'export const x = 1;\n');
      escrever('apps/api/src/livre.ts', 'export const livre = 1;\n');
      escrever(
        MANIFESTO,
        JSON.stringify({
          prs: [],
          ignorados: [],
          substituicoes: [{ pr: 1, arquivo: 'apps/api/src/index.ts', motivo: 'teste' }],
          ajustesIntegracao: [
            { arquivo: 'apps/api/src/sessao/autenticacao-ambiente.ts', motivo: 'teste' },
          ],
          conflitosPorUniao: ['apps/worker/src/index.ts'],
        }),
      );
      git(repo, 'add', '-A');
      git(repo, ...AUTOR, 'commit', '--quiet', '-m', 'base');
      // Revisão: grava os hashes atuais no manifesto e comita.
      expect(verificar(repo, 'HEAD', '--gravar-blobs').codigo).toBe(0);
      git(repo, 'add', '-A');
      git(repo, ...AUTOR, 'commit', '--quiet', '-m', 'hashes');
      return git(repo, 'rev-parse', 'HEAD');
    }

    const base = montar();

    it('sem mudança, os arquivos declarados conferem', () => {
      const r = verificar(repo, base);
      expect(r.saida).toContain('3 arquivo(s) declarado(s) conferido(s) por hash');
      expect(r.codigo).toBe(0);
    });

    it.each(['apps/api/src/index.ts', 'apps/worker/src/index.ts'])(
      'backdoor GIA_BACKDOOR=1 -> sessão simulada em %s falha',
      (arquivo) => {
        const original = git(repo, 'show', `${base}:${arquivo}`);
        const r = verificar(repo, commitComMutacao(repo, base, { [arquivo]: original + BACKDOOR }));
        expect(r.codigo).toBe(1);
        expect(r.saida).toContain(`${arquivo}: conteúdo difere do declarado`);
      },
    );

    it('remover um arquivo declarado ou declarar sem hash também falha', () => {
      const removido = commitComMutacao(repo, base, { 'apps/worker/src/index.ts': null });
      expect(verificar(repo, removido).saida).toContain(
        'apps/worker/src/index.ts: conteúdo difere do declarado (ausente',
      );

      const manifesto = JSON.parse(git(repo, 'show', `${base}:${MANIFESTO}`)) as {
        conflitosPorUniao: string[];
      };
      manifesto.conflitosPorUniao.push('apps/api/src/livre.ts');
      const caminho = join(mkdtempSync(join(tmpdir(), 'gia-manifesto-')), 'manifesto.json');
      writeFileSync(caminho, JSON.stringify(manifesto));
      const r = verificar(repo, base, '--manifesto', caminho);
      expect(r.codigo).toBe(1);
      expect(r.saida).toContain('apps/api/src/livre.ts: declarado sem hash no manifesto');
      rmSync(dirname(caminho), { recursive: true, force: true });
    });
  },
);

/**
 * No repositório real, enquanto este branch for a integração (os hashes do
 * manifesto conferem com o HEAD), injeta o desvio nos dois `index.ts`.
 */
const integracaoAtual = verificar(RAIZ, 'HEAD').codigo === 0;
describe.skipIf(!integracaoAtual)(
  'verificador da integração: repositório real',
  { timeout: TEMPO_MS },
  () => {
    it('backdoor GIA_BACKDOOR=1 nos index.ts da API e do worker falha com saída 1', () => {
      const head = git(RAIZ, 'rev-parse', 'HEAD');
      const mutacoes = Object.fromEntries(
        ['apps/api/src/index.ts', 'apps/worker/src/index.ts'].map((arquivo) => [
          arquivo,
          git(RAIZ, 'show', `${head}:${arquivo}`) + BACKDOOR,
        ]),
      );
      const r = verificar(RAIZ, commitComMutacao(RAIZ, head, mutacoes));
      expect(r.codigo).toBe(1);
      expect(r.saida).toContain('apps/api/src/index.ts: conteúdo difere do declarado');
      expect(r.saida).toContain('apps/worker/src/index.ts: conteúdo difere do declarado');
    });
  },
);
