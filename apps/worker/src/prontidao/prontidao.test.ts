import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { EvidenciaPreflight, NomeCheck, Check } from '../preflight/tipos.js';
import { executarCliProntidao } from './cli.js';
import { requisitos } from './catalogo.js';
import { montarMatriz } from './matriz.js';

const revisao = 'a'.repeat(40);
const sha256 = 'b'.repeat(64);
const agora = new Date('2026-10-15T18:00:00.000Z');
const ref = 'EV-00000000-0000-4000-8000-000000000001';
const ok = (nome: NomeCheck, destino?: number): Check => ({
  nome,
  estado: 'ok',
  codigo: 'OK',
  ...(destino === undefined ? {} : { destino }),
});
function preflight(): EvidenciaPreflight {
  return {
    schema: 'gia.preflight.v1',
    execucaoId: '00000000-0000-4000-8000-000000000002',
    revisao,
    geradoEm: agora.toISOString(),
    ambiente: 'producao',
    somenteLeitura: true,
    escritaHabilitada: false,
    producaoPronta: false,
    leiturasValidadas: true,
    gatesObservados: { configuracao: 'desligada', api: 'desligada' },
    codigoSaida: 2,
    checks: [
      'ambiente',
      'gates',
      'cofreBanco',
      'vivacidadeApi',
      'prontidaoApi',
      'autorizacaoApi',
      'batimentoWorker',
    ].map((n) => ok(n as NomeCheck)),
    sistemas: (['ad', 'm365', 'docusign', 'softexpert', 'jira'] as const).map((sistema) => ({
      sistema,
      checks: [
        ok('configuracao'),
        ok('cofre'),
        ok('autenticacaoLeitura'),
        ok('dns', 1),
        ok('tcp', 1),
        ok('tls', 1),
        ...(sistema === 'jira' ? [ok('camposOrigem')] : []),
      ],
    })),
  };
}
function registro() {
  return {
    schema: 'gia.decisoes.v1',
    ambiente: 'producao',
    revisao,
    geradoEm: agora.toISOString(),
    itens: [
      {
        id: 'ad.ensaio',
        responsavelConfirmado: true,
        estado: 'declarado',
        evidencia: {
          referencia: ref,
          sha256,
          tipo: 'ensaioRealAutorizado',
          autorizacao: ref,
          ocorridoEm: agora.toISOString(),
        },
      },
    ],
  };
}
function consolidar(dados: unknown, decisoes?: unknown) {
  return montarMatriz(
    {
      revisao,
      preflight: { dados, sha256 },
      ...(decisoes ? { registro: { dados: decisoes, sha256 } } : {}),
    },
    agora,
  );
}
function item(matriz: ReturnType<typeof montarMatriz>, id: string) {
  return matriz.sistemas.flatMap((s) => s.itens).find((i) => i.id === id)!;
}

it('gera matriz completa sem evidencia e mantem NO_GO, titulares e ensaios pendentes', () => {
  const matriz = montarMatriz({ revisao }, agora);
  expect(matriz.codigoSaida).toBe(1);
  expect(matriz.decisao).toBe('NO_GO');
  const itens = matriz.sistemas.flatMap((s) => s.itens);
  expect(itens).toHaveLength(62);
  expect(
    itens.every(
      (i) =>
        !i.pronto &&
        !i.responsavelConfirmado &&
        i.estado === 'pendente' &&
        i.comandos.length > 0 &&
        i.responsavel,
    ),
  ).toBe(true);
  expect(new Set(itens.map((i) => i.id)).size).toBe(62);
  for (const id of [
    'ad.senhaInicial',
    'softexpert.wsdlRevogacao',
    'oidc.sessoes',
    'oidc.integracaoUi',
    'global.regras',
    'global.goLive',
  ])
    expect(item(matriz, id)).toBeDefined();
});
it('leituras completas dao codigo 2 mas nunca aprovam homologacao, OIDC, escrita ou producao', () => {
  const matriz = consolidar(preflight());
  expect(matriz.codigoSaida).toBe(2);
  expect(matriz.leiturasConsolidadas).toBe(true);
  expect(item(matriz, 'ad.credenciais').estado).toBe('leituraComprovada');
  for (const id of ['ad.ensaio', 'ad.escrita', 'oidc.ensaio', 'global.goLive'])
    expect(item(matriz, id).estado).toBe('pendente');
  expect(matriz.producaoPronta).toBe(false);
  expect(matriz.escritaHabilitada).toBe(false);
});
it('registra declaracao de ensaio como pendente de validacao sem autorizar producao', () => {
  const matriz = consolidar(preflight(), registro());
  expect(item(matriz, 'ad.ensaio')).toMatchObject({
    estado: 'declaracaoPendenteDeValidacao',
    responsavelConfirmado: true,
    pronto: false,
    validacaoAdministrativa: 'pendente',
  });
  expect(matriz.producaoPronta).toBe(false);
});
it.each(['teste', 'invalido'] as const)('ambiente %s nao comprova producao', (ambiente) => {
  const matriz = consolidar({ ...preflight(), ambiente });
  expect(matriz.codigoSaida).toBe(1);
  expect(item(matriz, 'ad.redeCa').evidenciaLeitura).toBeNull();
});
it.each(['ligada', 'naoConfirmada'] as const)(
  'gate API %s impede comprovar leituras seguras',
  (api) => {
    const p = preflight();
    expect(consolidar({ ...p, gatesObservados: { ...p.gatesObservados, api } }).codigoSaida).toBe(
      1,
    );
  },
);
it('falha parcial nao apaga evidencia dos outros sistemas e bloqueia consolidacao', () => {
  const p = preflight();
  const matriz = consolidar({
    ...p,
    codigoSaida: 1,
    leiturasValidadas: false,
    sistemas: p.sistemas.map((s) =>
      s.sistema === 'ad'
        ? {
            ...s,
            checks: s.checks.map((c) =>
              c.nome === 'tls' ? { ...c, estado: 'bloqueado', codigo: 'TLS_INVALIDO' } : c,
            ),
          }
        : s,
    ),
  });
  expect(item(matriz, 'ad.redeCa').estado).toBe('bloqueado');
  expect(item(matriz, 'jira.redeCa').estado).toBe('leituraComprovada');
  expect(matriz.codigoSaida).toBe(1);
});
it('nao aceita DNS/TCP de um DC como evidencia de TLS em outro', () => {
  const p = preflight();
  const matriz = consolidar({
    ...p,
    sistemas: p.sistemas.map((s) =>
      s.sistema === 'ad' ? { ...s, checks: [...s.checks, ok('dns', 2), ok('tcp', 2)] } : s,
    ),
  });
  expect(item(matriz, 'ad.redeCa').estado).toBe('pendente');
  expect(matriz.codigoSaida).toBe(1);
});
it('flag superior de leitura validada nao supera bloqueio de segredo inline', () => {
  const p = preflight();
  const matriz = consolidar({
    ...p,
    checks: [
      ...p.checks,
      { nome: 'segredosInline', estado: 'bloqueado', codigo: 'SEGREDO_INLINE_RECUSADO' },
    ],
  });
  expect(matriz.codigoSaida).toBe(1);
  expect(item(matriz, 'ad.credenciais').evidenciaLeitura).toBeNull();
});
it.each([
  { revisao: 'c'.repeat(40) },
  { geradoEm: '2026-10-14T17:59:59.000Z' },
  { geradoEm: '2026-10-15T18:00:01.000Z' },
  { producaoPronta: true },
  { segredo: 'NAO-ECOAR' },
  { sistemas: [] },
])('recusa evidencia inconsistente, vencida, futura ou fora do schema %#', (alteracao) => {
  expect(() => consolidar({ ...preflight(), ...alteracao })).toThrow();
});
it('recusa sistemas/checks duplicados', () => {
  const p = preflight();
  expect(() =>
    consolidar({ ...p, sistemas: [p.sistemas[0], p.sistemas[0], ...p.sistemas.slice(2)] }),
  ).toThrow();
  expect(() => consolidar({ ...p, checks: [...p.checks, p.checks[0]] })).toThrow();
});
it.each(['id', 'responsavel', 'autorizacao', 'tipo', 'futuro', 'duplicado'] as const)(
  'recusa registro administrativo invalido: %s',
  (caso) => {
    const r = registro();
    const original = r.itens[0]!;
    if (caso === 'id') original.id = 'fora.doCatalogo';
    if (caso === 'responsavel') original.responsavelConfirmado = false;
    if (caso === 'autorizacao') original.evidencia.autorizacao = '';
    if (caso === 'tipo') original.evidencia.tipo = 'administrativa';
    if (caso === 'futuro') original.evidencia.ocorridoEm = '2026-10-15T18:01:00.000Z';
    if (caso === 'duplicado') r.itens.push(original);
    expect(() => consolidar(preflight(), r)).toThrow();
  },
);
it('declaracao explicita de bloqueio prevalece sobre leitura automatizada', () => {
  const r = registro();
  r.itens[0]!.id = 'ad.credenciais';
  r.itens[0]!.estado = 'bloqueado';
  expect(item(consolidar(preflight(), r), 'ad.credenciais').estado).toBe('bloqueado');
});

let pasta: string;
beforeAll(async () => {
  pasta = await mkdtemp(join(tmpdir(), 'gia-prontidao-'));
});
afterAll(async () => {
  await rm(pasta, { recursive: true, force: true });
});
async function arquivo(nome: string, dados: unknown) {
  const caminho = join(pasta, nome);
  const texto = JSON.stringify(dados);
  await writeFile(caminho, texto, { mode: 0o600 });
  return { caminho, checksum: createHash('sha256').update(texto).digest('hex') };
}
it('CLI grava arquivo privado, checksum verificavel e nao sobrescreve evidencia', async () => {
  const saida = join(pasta, 'matriz.json');
  const linhas: string[] = [];
  expect(
    await executarCliProntidao(['--revisao', revisao, '--saida', saida], (l) => linhas.push(l)),
  ).toBe(1);
  const bytes = await readFile(saida);
  const publicado = JSON.parse(linhas[0]!);
  expect(publicado.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  if (process.platform !== 'win32') expect((await stat(saida)).mode & 0o077).toBe(0);
  expect(
    await executarCliProntidao(['--revisao', revisao, '--saida', saida], (l) => linhas.push(l)),
  ).toBe(1);
  expect(linhas[1]).toContain('MATRIZ_NAO_VERIFICADA');
  expect(await readFile(saida)).toEqual(bytes);
});
it('CLI importa preflight por bytes e digest, sem ecoar paths', async () => {
  const p = { ...preflight(), geradoEm: new Date().toISOString() };
  const a = await arquivo('origem-secreta.json', p);
  const linhas: string[] = [];
  expect(
    await executarCliProntidao(
      ['--revisao', revisao, '--preflight', a.caminho, '--preflight-sha256', a.checksum],
      (l) => linhas.push(l),
    ),
  ).toBe(2);
  expect(linhas.join('')).not.toContain(a.caminho);
  expect(linhas.join('')).toContain('NO_GO');
});
it.each(
  [
    ['--token', 'SEGREDO-NAO-ECOAR'],
    ['--revisao', 'SEGREDO-NAO-ECOAR'],
    ['--revisao', revisao, '--revisao', revisao],
    ['--revisao', revisao, '--preflight', 'SEGREDO-NAO-ECOAR'],
    ['--revisao', revisao, '--saida'],
  ].map((args) => ({ args })),
)('CLI recusa argumentos inseguros sem eco ou stack %#', async ({ args }) => {
  const linhas: string[] = [];
  expect(await executarCliProntidao(args, (l) => linhas.push(l))).toBe(1);
  expect(linhas.join('')).toContain('MATRIZ_NAO_VERIFICADA');
  expect(linhas.join('')).not.toContain('SEGREDO-NAO-ECOAR');
});
it('CLI recusa checksum divergente, arquivo grande e payload com dado privado sem eco', async () => {
  const fontes = [
    await arquivo('alterada.json', preflight()),
    await arquivo('grande.json', 'x'.repeat(1024 * 1024)),
    await arquivo('privada.json', { ...preflight(), segredo: 'SEGREDO-NAO-ECOAR' }),
  ];
  for (const [indice, a] of fontes.entries()) {
    const linhas: string[] = [];
    expect(
      await executarCliProntidao(
        [
          '--revisao',
          revisao,
          '--preflight',
          a.caminho,
          '--preflight-sha256',
          indice === 0 ? sha256 : a.checksum,
        ],
        (l) => linhas.push(l),
      ),
    ).toBe(1);
    expect(linhas.join('')).not.toContain('SEGREDO-NAO-ECOAR');
    expect(linhas.join('')).not.toContain(a.caminho);
  }
});
it('nenhum requisito oferece comando de habilitacao de escrita ou segredo inline', () => {
  expect(requisitos.every((r) => r.decisaoNecessaria && r.responsavel && r.comandos.length)).toBe(
    true,
  );
  const matriz = montarMatriz({ revisao }, agora);
  expect(JSON.stringify(matriz)).not.toContain('GIA_ESCRITA_EXTERNA=true');
});
it('mesmo todas as declaracoes preenchidas nao tornam qualquer item pronto', () => {
  const r = registro();
  const evidencia = r.itens[0]!.evidencia;
  r.itens = requisitos.map((i) => ({
    id: i.id,
    estado: 'declarado',
    responsavelConfirmado: true,
    evidencia,
  }));
  const matriz = consolidar(preflight(), r);
  expect(matriz.decisao).toBe('NO_GO');
  expect(
    matriz.sistemas
      .flatMap((s) => s.itens)
      .every((i) => i.pronto === false && i.validacaoAdministrativa === 'pendente'),
  ).toBe(true);
});
it('nao copia codigo dinamico nem nome de variavel do arquivo para a matriz', () => {
  const p = preflight();
  const matriz = consolidar({
    ...p,
    checks: [
      ...p.checks,
      {
        nome: 'segredosInline',
        estado: 'bloqueado',
        codigo: 'TOKEN_SECRETO_NAO_ECOAR',
        variaveis: ['SEGREDO_NAO_ECOAR'],
      },
    ],
  });
  expect(JSON.stringify(matriz)).not.toContain('NAO_ECOAR');
});
it('CLI importa registro sanitizado mas preserva decisao pendente', async () => {
  const r = registro();
  r.geradoEm = new Date().toISOString();
  r.itens[0]!.evidencia.ocorridoEm = r.geradoEm;
  const a = await arquivo('registro.json', r);
  const linhas: string[] = [];
  expect(
    await executarCliProntidao(
      ['--revisao', revisao, '--registro', a.caminho, '--registro-sha256', a.checksum],
      (l) => linhas.push(l),
    ),
  ).toBe(1);
  expect(linhas[0]).toContain('declaracaoPendenteDeValidacao');
  expect(linhas[0]).not.toContain(a.caminho);
});
