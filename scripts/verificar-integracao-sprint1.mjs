#!/usr/bin/env node
// Verificação independente da integração da Sprint 1 (DEV-291).
//
// Uso: node scripts/verificar-integracao-sprint1.mjs [--alvo <ref>] [--sem-fetch]
//   --alvo: o que verificar (padrão: HEAD).
//
// Nada aqui usa os commits de merge publicados nem as resoluções deles. Parte
// só dos commits de origem de cada PR (fixados em sprint1-manifesto.json):
//
// 1. Fixação: o head de cada PR no GitHub ainda é o integrado.
// 2. Preservação: toda linha que cada PR adiciona (contra a própria base) existe
//    no alvo, e todo arquivo que ele cria continua lá. Exceção só se declarada
//    no manifesto, com motivo e o teste que cobre o comportamento.
// 3. Reconstrução do zero: num worktree temporário, a partir de origin/main,
//    aplica a contribuição de cada PR na ordem do manifesto; conflito é
//    resolvido por união mecânica (os dois lados). A árvore obtida é comparada
//    com o alvo: todo arquivo diferente precisa estar declarado no manifesto
//    (resolução de conflito, ajuste de integração ou substituição).
//
// Não altera branches; o worktree temporário é removido no fim. Sai 1 se algo
// não declarado aparecer.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opcao = (nome) => {
  const i = args.indexOf(nome);
  return i === -1 ? undefined : args[i + 1];
};
const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifesto = JSON.parse(
  readFileSync(join(raiz, 'docs/integracao/sprint1-manifesto.json'), 'utf8'),
);
const IGNORADOS = new Set(manifesto.ignorados);

const git = (cwd, ...a) =>
  execFileSync('git', ['-C', cwd, ...a], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const tenta = (cwd, ...a) => {
  try {
    return { ok: true, saida: git(cwd, ...a) };
  } catch (e) {
    return { ok: false, saida: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};
const linhas = (texto) => texto.split('\n').filter((l) => l !== '');

if (!args.includes('--sem-fetch')) git(raiz, 'fetch', '--quiet', 'origin');
const alvo = git(raiz, 'rev-parse', opcao('--alvo') ?? 'HEAD').trim();
const falhas = [];
const falhar = (msg) => {
  falhas.push(msg);
  console.log(`  FALHA ${msg}`);
};

const declarado = (lista, pr, arquivo) =>
  lista.find((d) => (d.pr === undefined || d.pr === pr) && d.arquivo === arquivo);

// Normalização: espaço, vírgula/ponto e vírgula finais e linhas sem conteúdo.
const normalizar = (l) => l.trim().replace(/[,;]+$/, '');
const relevante = (l) => /[\p{L}\p{N}]/u.test(l);

console.log(`Alvo: ${alvo}`);

// 1 + 2 — fixação e preservação, PR a PR.
console.log('\n== Fixação e preservação (a partir dos commits de origem)');
const usados = new Set();
for (const pr of manifesto.prs) {
  const head = git(raiz, 'rev-parse', `origin/${pr.ref}`).trim();
  const titulo = `#${pr.numero} ${pr.ref}`;
  if (head !== pr.head) {
    falhar(`${titulo}: head mudou (${head.slice(0, 7)} ≠ ${pr.head.slice(0, 7)}); reintegrar`);
    continue;
  }
  const base = git(raiz, 'merge-base', `origin/${pr.base}`, pr.head).trim();
  const ancestral = tenta(raiz, 'merge-base', '--is-ancestor', pr.head, alvo).ok;
  const semEquivalente = linhas(git(raiz, 'cherry', alvo, pr.head, base)).filter((l) =>
    l.startsWith('+'),
  ).length;
  const commits = linhas(git(raiz, 'rev-list', `${base}..${pr.head}`)).length;
  let perdidas = 0;
  let aceitas = 0;
  for (const entrada of linhas(git(raiz, 'diff', '--name-status', '--no-renames', base, pr.head))) {
    const [status, arquivo] = entrada.split('\t');
    if (IGNORADOS.has(arquivo)) continue;
    const noAlvo = tenta(raiz, 'show', `${alvo}:${arquivo}`);
    if (status === 'D') {
      if (noAlvo.ok) falhar(`${titulo}: ${arquivo} foi removido pelo PR e voltou no alvo`);
      continue;
    }
    const adicionadas = linhas(git(raiz, 'diff', '-U0', base, pr.head, '--', arquivo))
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .map((l) => normalizar(l.slice(1)))
      .filter(relevante);
    const presentes = new Set(noAlvo.ok ? noAlvo.saida.split('\n').map(normalizar) : []);
    const faltam = adicionadas.filter((l) => !presentes.has(l));
    if (faltam.length === 0 && noAlvo.ok) continue;
    const d = declarado(manifesto.substituicoes, pr.numero, arquivo);
    if (d) {
      usados.add(d);
      aceitas += faltam.length;
      if (!noAlvo.ok && d.removido !== true)
        falhar(`${titulo}: ${arquivo} ausente no alvo, mas o manifesto não declara remoção`);
      for (const c of d.cobertura ?? [])
        if (!tenta(raiz, 'cat-file', '-e', `${alvo}:${c}`).ok)
          falhar(`${titulo}: cobertura declarada para ${arquivo} não existe: ${c}`);
    } else {
      perdidas += faltam.length;
      if (args.includes('--detalhe'))
        for (const l of faltam) console.log(`      - ${l.slice(0, 160)}`);
      falhar(
        `${titulo}: ${arquivo} — ${noAlvo.ok ? `${faltam.length} linha(s) do PR fora do alvo` : 'arquivo ausente no alvo'}; ex.: ${(faltam[0] ?? '').slice(0, 100)}`,
      );
    }
  }
  console.log(
    `  #${pr.numero}: ${ancestral ? 'ancestral do alvo' : 'commits reaplicados'}; ` +
      `${commits} commit(s), ${semEquivalente} sem patch equivalente; ` +
      `${perdidas} linha(s) perdida(s), ${aceitas} substituída(s) por declaração`,
  );
}
for (const d of manifesto.substituicoes)
  if (!usados.has(d)) console.log(`  aviso: substituição declarada sem uso: #${d.pr} ${d.arquivo}`);

// 3 — reconstrução do zero.
console.log('\n== Reconstrução do zero a partir de origin/main');
const pasta = mkdtempSync(join(tmpdir(), 'gia-reconstrucao-'));
const autor = ['-c', 'user.name=reconstrucao', '-c', 'user.email=reconstrucao@invalid'];
const semRerere = ['-c', 'rerere.enabled=false', '-c', 'merge.conflictStyle=merge'];
git(raiz, 'worktree', 'add', '--quiet', '--detach', pasta, 'origin/main');
const conflitados = new Map();

/** União mecânica: cada bloco em conflito vira "nosso" seguido de "deles". */
function unir(arquivo) {
  const caminho = join(pasta, arquivo);
  if (!existsSync(caminho)) return false;
  const texto = readFileSync(caminho, 'utf8');
  if (!texto.includes('<<<<<<< ')) return false;
  writeFileSync(
    caminho,
    texto.replace(
      /^<<<<<<< [^\n]*\n([\s\S]*?)^=======\n([\s\S]*?)^>>>>>>> [^\n]*\n/gm,
      (_, nosso, deles) => nosso + deles,
    ),
  );
  return true;
}

try {
  for (const pr of manifesto.prs) {
    const base = git(raiz, 'merge-base', `origin/${pr.base}`, pr.head).trim();
    // A contribuição do próprio PR (contra a sua base), aplicada com 3 vias.
    const patch = git(raiz, 'diff', '--binary', '--full-index', base, pr.head);
    if (patch.trim() === '') continue;
    const arquivoPatch = join(pasta, '..', `gia-pr-${pr.numero}.patch`);
    writeFileSync(arquivoPatch, patch);
    const r = tenta(pasta, ...semRerere, 'apply', '--3way', '--index', arquivoPatch);
    rmSync(arquivoPatch, { force: true });
    if (!r.ok) {
      const emConflito = linhas(git(pasta, 'diff', '--name-only', '--diff-filter=U'));
      if (emConflito.length === 0) throw new Error(`#${pr.numero}: patch não aplicou\n${r.saida}`);
      for (const arquivo of emConflito) {
        if (!unir(arquivo)) git(pasta, 'checkout', '--theirs', '--', arquivo);
        git(pasta, 'add', '--', arquivo);
        conflitados.set(arquivo, [...(conflitados.get(arquivo) ?? []), pr.numero]);
      }
    }
    git(pasta, ...autor, 'commit', '--quiet', '--allow-empty', '-m', `reconstrução #${pr.numero}`);
    console.log(`  #${pr.numero} aplicado${r.ok ? '' : ' (com união de conflitos)'}`);
  }
  const diferentes = linhas(git(pasta, 'diff', '--name-only', 'HEAD', alvo)).filter(
    (a) => !IGNORADOS.has(a),
  );
  console.log(`\n  ${diferentes.length} arquivo(s) diferem entre a reconstrução e o alvo`);
  for (const arquivo of diferentes) {
    const d =
      declarado(manifesto.ajustesIntegracao, undefined, arquivo) ??
      manifesto.substituicoes.find((s) => s.arquivo === arquivo);
    const origem = conflitados.has(arquivo)
      ? `união de conflito (#${conflitados.get(arquivo).join(', #')})`
      : null;
    if (d) console.log(`  declarado: ${arquivo} — ${d.motivo}`);
    else if (origem && manifesto.conflitosPorUniao.includes(arquivo))
      console.log(`  declarado: ${arquivo} — ${origem}, resolvido à mão no alvo`);
    else
      falhar(
        `${arquivo} difere da reconstrução e não está declarado${origem ? ` (${origem})` : ''}`,
      );
  }
} finally {
  git(raiz, 'worktree', 'remove', '--force', pasta);
}

if (falhas.length > 0) {
  console.log(`\nFALHOU: ${falhas.length} problema(s) não declarado(s).`);
  process.exitCode = 1;
} else {
  console.log('\nOK: nada dos PRs de origem se perdeu sem declaração; reconstrução confere.');
}
