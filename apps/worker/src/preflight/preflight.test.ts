import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VariaveisAmbiente } from '@gia/contratos';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { executarPreflight } from './preflight.js';
import { executarCli, gravarEvidencia } from './cli.js';
import { verificarRede } from './rede.js';
import { verificarArquivo } from './arquivos.js';
import type { Check } from './tipos.js';

let pasta: string;
let env: VariaveisAmbiente;
const ID = '00000000-0000-4000-8000-000000000001';
const SEGREDO = 'segredo-ficticio-NAO-EXPORTAR';
beforeAll(async () => {
  pasta = await mkdtemp(join(tmpdir(), 'gia-preflight-'));
  const arquivo = join(pasta, 'credencial');
  const banco = join(pasta, 'banco');
  const chave = join(pasta, 'rsa');
  const batimento = join(pasta, 'batimento');
  await writeFile(arquivo, SEGREDO, { mode: 0o600 });
  await writeFile(banco, 'postgres://postgres@127.0.0.1:59999/gia_teste', { mode: 0o600 });
  await writeFile(
    chave,
    generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    }),
    { mode: 0o600 },
  );
  await writeFile(batimento, String(Date.now()));
  env = {
    GIA_AMBIENTE: 'teste',
    GIA_DATABASE_URL_ARQUIVO: banco,
    GIA_PREFLIGHT_API_URL: 'http://127.0.0.1:3099',
    // Porta interna de métricas da API: a única que dá o detalhe da prontidão (M7).
    GIA_PREFLIGHT_API_INTERNA_URL: 'http://127.0.0.1:9199',
    GIA_WORKER_ARQUIVO_SAUDE: batimento,
    GIA_M365_MODO: 'real',
    GIA_M365_TENANT_ID: ID,
    GIA_M365_CLIENT_ID: ID,
    GIA_M365_CLIENT_SECRET_ARQUIVO: arquivo,
    GIA_DOCUSIGN_MODO: 'real',
    GIA_DOCUSIGN_AMBIENTE: 'demo',
    GIA_DOCUSIGN_INTEGRACAO_ID: ID,
    GIA_DOCUSIGN_USUARIO_ID: ID,
    GIA_DOCUSIGN_CONTA_ID: ID,
    GIA_DOCUSIGN_CHAVE_PRIVADA_ARQUIVO: chave,
    GIA_SOFTEXPERT_MODO: 'real',
    GIA_SOFTEXPERT_URL: 'https://se.example.invalid',
    GIA_SOFTEXPERT_AUTENTICACAO: 'contaServico',
    GIA_SOFTEXPERT_USUARIO_SERVICO: 'servico-ficticio',
    GIA_SOFTEXPERT_SENHA_SERVICO_ARQUIVO: arquivo,
    GIA_JIRA_MODO: 'real',
    GIA_JIRA_BASE_URL: 'https://jira.example.invalid',
    GIA_JIRA_EMAIL: 'servico@example.invalid',
    GIA_JIRA_API_TOKEN_ARQUIVO: arquivo,
    GIA_JIRA_ORIGEM_JSON: JSON.stringify({
      projeto: 'RH',
      tipos: { celetista: 'Efetivo', terceiro: 'Externo' },
      campos: {
        tipoSolicitacao: 'tipo',
        nomeCompleto: 'nome',
        cpf: 'cpf',
        matricula: 'matricula',
        emailCorporativo: 'email',
        area: 'area',
        cargo: 'cargo',
        dataAdmissao: 'data',
        gestor: 'gestor',
      },
    }),
  };
});
afterAll(async () => {
  await rm(pasta, { recursive: true, force: true });
});
const redeOk = vi
  .fn<typeof verificarRede>()
  .mockResolvedValue(
    ['dns', 'tcp', 'tls'].map((nome) => ({ nome, estado: 'ok', codigo: 'OK' }) as Check),
  );
function http() {
  return vi.fn<typeof fetch>().mockImplementation(async (destino) => {
    const u = new URL(String(destino));
    if (u.hostname === 'login.microsoftonline.com' || u.pathname === '/oauth/token')
      return Response.json({
        access_token: 'token-ficticio',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    if (u.pathname === '/oauth/userinfo')
      return Response.json({
        accounts: [{ account_id: ID, base_uri: 'https://demo.docusign.net' }],
      });
    if (u.hostname === 'demo.docusign.net') return Response.json({ users: [] });
    if (u.hostname === 'graph.microsoft.com') return Response.json({ value: [{ id: ID }] });
    if (u.hostname === 'se.example.invalid')
      return new Response(
        '<Envelope><Body><getUserDataResponse><Status>FAILURE</Status><Detail>Usuário inexistente</Detail></getUserDataResponse></Body></Envelope>',
        { headers: { 'Content-Type': 'text/xml;charset=UTF-8' } },
      );
    if (u.pathname.endsWith('/myself')) return Response.json({ accountId: ID });
    if (u.pathname.endsWith('/search/jql')) {
      expect(u.searchParams.get('maxResults')).toBe('1');
      const terceiro = u.searchParams.get('jql')!.includes('Externo');
      return Response.json({
        issues: [
          {
            key: terceiro ? 'RH-2' : 'RH-1',
            fields: {
              tipo: terceiro ? 'Externo' : 'Efetivo',
              nome: 'Pessoa Ficticia',
              cpf: '12345678909',
              matricula: null,
              email: 'pessoa@example.invalid',
              area: 'Teste',
              cargo: 'Teste',
              data: '2026-10-15',
              gestor: null,
            },
          },
        ],
        isLast: false,
        nextPageToken: 'nao-percorrer',
      });
    }
    if (u.pathname === '/saude')
      return Response.json(
        { status: 'ok' },
        {
          headers: {
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            'x-correlacao-id': ID,
          },
        },
      );
    if (u.pathname === '/saude/pronta')
      return u.port === '9199'
        ? Response.json({
            status: 'pronta',
            ambiente: 'teste',
            versao: SEGREDO,
            verificacoes: { persistencia: 'ok' },
            escrita: { modo: 'simulado', liberadas: [] },
          })
        : Response.json({ status: 'pronta' });
    if (u.pathname === '/pedidos') return new Response(SEGREDO, { status: 401 });
    throw new Error('endpoint inesperado');
  });
}

it('falha fechado e não faz rede quando escrita foi habilitada', async () => {
  const enviar = vi.fn<typeof fetch>();
  const r = await executarPreflight(
    { GIA_AMBIENTE: 'producao', GIA_ESCRITA_EXTERNA: 'true', GIA_ESCRITA_LIBERADA: 'ad:criar' },
    { fetch: enviar },
  );
  expect(r.codigoSaida).toBe(1);
  expect(r.escritaHabilitada).toBe(false);
  expect(r.gatesObservados.configuracao).toBe('insegura');
  expect(enviar).not.toHaveBeenCalled();
});

it('sem credenciais identifica os cinco sistemas ausentes e não imprime valores', async () => {
  const r = await executarPreflight({
    GIA_AMBIENTE: 'producao',
    GIA_JIRA_API_TOKEN: 'SEGREDO-NAO-PUBLICAVEL',
  });
  expect(r.sistemas).toHaveLength(5);
  expect(r.codigoSaida).toBe(1);
  expect(JSON.stringify(r)).not.toContain('SEGREDO-NAO-PUBLICAVEL');
});

it.each([
  { GIA_JIRA_ESCRITA_HABILITADA: 'true' },
  { GIA_DOCUSIGN_ESCRITA_HABILITADA: 'true' },
  { GIA_ESCRITA_LIBERADA: 'jira:criar' },
  { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
  { NODE_DEBUG: '*' },
  { GIA_PREFLIGHT_TIMEOUT_MS: 'nan' },
  { GIA_JIRA_API_TOKEN: 'segredo-inline', GIA_JIRA_API_TOKEN_ARQUIVO: '/nao-ler' },
])('configuração insegura impede todo envio de credencial', async (inseguro) => {
  const enviar = http();
  const r = await executarPreflight({ ...env, ...inseguro }, { fetch: enviar, rede: redeOk });
  expect(r.codigoSaida).toBe(1);
  expect(enviar).not.toHaveBeenCalled();
  expect(JSON.stringify(r)).not.toContain('segredo-inline');
});

it('timeout é limitado e não revela a exceção de transporte', async () => {
  const enviar = vi.fn<typeof fetch>().mockImplementation(
    (_u, i) =>
      new Promise((_r, rejeitar) => {
        const falhar = () => rejeitar(new Error(SEGREDO));
        if (i?.signal?.aborted) falhar();
        else i?.signal?.addEventListener('abort', falhar, { once: true });
      }),
  );
  const r = await executarPreflight(
    { ...env, GIA_PREFLIGHT_TIMEOUT_MS: '100' },
    { fetch: enviar, rede: redeOk },
  );
  expect(r.codigoSaida).toBe(1);
  expect(JSON.stringify(r)).not.toContain(SEGREDO);
});

it('consentimento DocuSign ausente é bloqueio específico, sem publicar a descrição OAuth', async () => {
  const base = http();
  const r = await executarPreflight(env, {
    rede: redeOk,
    fetch: (u, i) =>
      String(u).includes('/oauth/token')
        ? Promise.resolve(
            Response.json(
              { error: 'consent_required', error_description: SEGREDO },
              { status: 400 },
            ),
          )
        : base(u, i),
  });
  expect(r.sistemas.find((s) => s.sistema === 'docusign')?.checks).toContainEqual({
    nome: 'autenticacaoLeitura',
    estado: 'bloqueado',
    codigo: 'CONSENTIMENTO_PENDENTE',
  });
  expect(JSON.stringify(r)).not.toContain(SEGREDO);
});

it('código e detalhe SOAP controlados pelo fornecedor não entram na evidência', async () => {
  const base = http();
  const r = await executarPreflight(env, {
    rede: redeOk,
    fetch: (u, i) =>
      String(u).includes('se.example.invalid')
        ? Promise.resolve(
            new Response(
              `<Envelope><Body><getUserDataResponse><Status>FAILURE</Status><Code>12345678909</Code><Detail>${SEGREDO}</Detail></getUserDataResponse></Body></Envelope>`,
            ),
          )
        : base(u, i),
  });
  expect(r.sistemas.find((s) => s.sistema === 'softexpert')?.checks).toContainEqual({
    nome: 'autenticacaoLeitura',
    estado: 'bloqueado',
    codigo: 'LEITURA_NAO_VALIDADA',
  });
  expect(JSON.stringify(r)).not.toContain(SEGREDO);
  expect(JSON.stringify(r)).not.toContain('12345678909');
});

it('batimento futuro ou velho não prova vivacidade do worker', async () => {
  for (const instante of [Date.now() + 3600000, Date.now() - 3600000]) {
    const arquivo = join(pasta, `batimento-${instante}`);
    await writeFile(arquivo, String(instante));
    const r = await executarPreflight(
      { ...env, GIA_WORKER_ARQUIVO_SAUDE: arquivo },
      { fetch: http(), rede: redeOk },
    );
    expect(r.checks).toContainEqual({
      nome: 'batimentoWorker',
      estado: 'bloqueado',
      codigo: 'WORKER_SEM_BATIMENTO',
    });
  }
});

it('exercita os quatro HTTP reais, campos dos dois vínculos, API GET e evidência sem dados pessoais', async () => {
  const enviar = http();
  const r = await executarPreflight(env, { fetch: enviar, rede: redeOk });
  for (const s of r.sistemas.filter((s) => s.sistema !== 'ad'))
    expect(s.checks).toContainEqual({ nome: 'autenticacaoLeitura', estado: 'ok', codigo: 'OK' });
  expect(r.sistemas.find((s) => s.sistema === 'jira')?.checks).toContainEqual({
    nome: 'camposOrigem',
    estado: 'ok',
    codigo: 'OK',
  });
  expect(r.checks).toContainEqual({ nome: 'prontidaoApi', estado: 'ok', codigo: 'OK' });
  expect(r.codigoSaida).toBe(1); // AD não configurado, nunca substituído pelo simulador.
  const json = JSON.stringify(r);
  for (const dado of [
    SEGREDO,
    'token-ficticio',
    'pessoa@example.invalid',
    'Pessoa Ficticia',
    '12345678909',
    'RH-1',
    pasta,
    'servico-ficticio',
  ])
    expect(json).not.toContain(dado);
  expect(
    enviar.mock.calls.filter(([, i]) => ['PATCH', 'PUT', 'DELETE'].includes(i?.method ?? '')),
  ).toHaveLength(0);
  expect(enviar.mock.calls.filter(([u]) => String(u).includes('/search/jql'))).toHaveLength(2);
  expect(
    enviar.mock.calls
      .filter(([u]) => String(u).includes('127.0.0.1'))
      .every(([, i]) => i?.method === 'GET'),
  ).toBe(true);
});

it('configuração/arquivo de um sistema falha isoladamente; outro continua sendo conferido', async () => {
  const r = await executarPreflight(
    { ...env, GIA_DOCUSIGN_CHAVE_PRIVADA_ARQUIVO: join(pasta, 'ausente') },
    { fetch: http(), rede: redeOk },
  );
  expect(r.sistemas.find((s) => s.sistema === 'docusign')?.checks).toContainEqual({
    nome: 'cofre',
    recurso: 'chavePrivada',
    estado: 'bloqueado',
    codigo: 'ARQUIVO_AUSENTE_OU_INVALIDO',
  });
  expect(
    r.sistemas
      .find((s) => s.sistema === 'jira')
      ?.checks.some((c) => c.nome === 'autenticacaoLeitura' && c.estado === 'ok'),
  ).toBe(true);
});

it.each([401, 403, 500])(
  'erro HTTP %s mantém relatório fechado e não repete escrita',
  async (status) => {
    const base = http();
    const enviar = vi
      .fn<typeof fetch>()
      .mockImplementation((u, i) =>
        String(u).includes('jira.example.invalid')
          ? Promise.resolve(new Response(SEGREDO, { status }))
          : base(u, i),
      );
    const r = await executarPreflight(
      { ...env, GIA_JIRA_TIMEOUT_MS: '100' },
      { fetch: enviar, rede: redeOk },
    );
    expect(
      r.sistemas
        .find((s) => s.sistema === 'jira')
        ?.checks.some((c) => c.nome === 'autenticacaoLeitura' && c.estado === 'bloqueado'),
    ).toBe(true);
    expect(r.codigoSaida).toBe(1);
    expect(JSON.stringify(r)).not.toContain(SEGREDO);
  },
);

it('campos inválidos ou ausência de amostra nunca aprovam o mapeamento', async () => {
  for (const issues of [[], [{ key: 'RH-1', fields: {} }]]) {
    const base = http();
    const r = await executarPreflight(env, {
      rede: redeOk,
      fetch: (u, i) =>
        String(u).includes('search/jql')
          ? Promise.resolve(Response.json({ issues, isLast: true }))
          : base(u, i),
    });
    expect(
      r.sistemas
        .find((s) => s.sistema === 'jira')
        ?.checks.some((c) => c.nome === 'camposOrigem' && c.estado !== 'ok'),
    ).toBe(true);
  }
});

it('rede/TLS inválidos não enviam credenciais; offline não valida rede nem faz HTTP', async () => {
  const enviar = http();
  const r = await executarPreflight(env, {
    fetch: enviar,
    rede: async () => [{ nome: 'tls', estado: 'bloqueado', codigo: 'TLS_INVALIDO' }],
  });
  expect(enviar.mock.calls.some(([u]) => !String(u).includes('127.0.0.1'))).toBe(false);
  expect(r.codigoSaida).toBe(1);
  enviar.mockClear();
  await executarPreflight(env, { fetch: enviar, offline: true });
  expect(enviar).not.toHaveBeenCalled();
});

it('readiness com escrita real ou dados públicos bloqueia rollback e não imprime o body', async () => {
  const base = http();
  const r = await executarPreflight(env, {
    rede: redeOk,
    fetch: (u, i) =>
      String(u) === 'http://127.0.0.1:9199/saude/pronta'
        ? Promise.resolve(
            Response.json({
              status: 'pronta',
              ambiente: 'teste',
              versao: SEGREDO,
              verificacoes: { persistencia: 'ok' },
              escrita: { modo: 'real', liberadas: ['jira:criar'] },
            }),
          )
        : base(u, i),
  });
  expect(r.checks).toContainEqual({
    nome: 'prontidaoApi',
    estado: 'bloqueado',
    codigo: 'API_ESCRITA_HABILITADA',
  });
  expect(r.producaoPronta).toBe(false);
  expect(r.gatesObservados.api).toBe('ligada');
  expect(JSON.stringify(r)).not.toContain(SEGREDO);
});

it('porta pública com detalhe operacional é proteção inválida e não confirma a escrita (M7)', async () => {
  const base = http();
  const r = await executarPreflight(env, {
    rede: redeOk,
    fetch: (u, i) =>
      String(u) === 'http://127.0.0.1:3099/saude/pronta'
        ? Promise.resolve(
            Response.json({
              status: 'pronta',
              versao: SEGREDO,
              escrita: { modo: 'simulado', liberadas: [] },
            }),
          )
        : base(u, i),
  });
  expect(r.checks).toContainEqual({
    nome: 'prontidaoApi',
    estado: 'bloqueado',
    codigo: 'API_PROTECAO_INVALIDA',
  });
  expect(r.gatesObservados.api).toBe('naoConfirmada');
  expect(JSON.stringify(r)).not.toContain(SEGREDO);
});

it('sem a porta interna a escrita da API não é presumida desligada: bloqueia sem chamar', async () => {
  const enviar = http();
  const semInterna = { ...env, GIA_PREFLIGHT_API_INTERNA_URL: undefined };
  const r = await executarPreflight(semInterna, { fetch: enviar, rede: redeOk });
  expect(r.checks).toContainEqual({
    nome: 'prontidaoApi',
    estado: 'bloqueado',
    codigo: 'API_INTERNA_NAO_CONFIGURADA',
  });
  expect(r.gatesObservados.api).toBe('naoConfirmada');
  expect(enviar.mock.calls.filter(([u]) => String(u).includes(':9199'))).toHaveLength(0);
});

it('porta interna só em HTTP de loopback, sem credencial nem caminho; o resto não é chamado', async () => {
  for (const interna of [
    'https://127.0.0.1:9199',
    'http://10.0.0.5:9199',
    'http://api.interno:9199',
    'http://127.0.0.1:9199/metrics',
    'http://127.0.0.1:9199/?x=1',
  ]) {
    const enviar = http();
    const r = await executarPreflight(
      { ...env, GIA_PREFLIGHT_API_INTERNA_URL: interna },
      { fetch: enviar, rede: redeOk },
    );
    expect(r.checks).toContainEqual({
      nome: 'prontidaoApi',
      estado: 'bloqueado',
      codigo: 'CONFIGURACAO_INVALIDA',
    });
    const chamadasInternas = enviar.mock.calls.filter(([u]) =>
      String(u).endsWith(':9199/saude/pronta'),
    );
    expect(chamadasInternas).toHaveLength(0);
  }
  // Com credencial na URL, a regra de segredo inline recusa antes: nada da API é chamado.
  const enviar = http();
  const r = await executarPreflight(
    { ...env, GIA_PREFLIGHT_API_INTERNA_URL: 'http://usuario:senha@127.0.0.1:9199' },
    { fetch: enviar, rede: redeOk },
  );
  expect(r.checks).toContainEqual(
    expect.objectContaining({ nome: 'segredosInline', codigo: 'SEGREDO_INLINE_RECUSADO' }),
  );
  expect(r.checks).toContainEqual(
    expect.objectContaining({ nome: 'prontidaoApi', estado: 'naoExecutado' }),
  );
  expect(enviar.mock.calls.filter(([u]) => String(u).includes('127.0.0.1'))).toHaveLength(0);
  expect(JSON.stringify(r)).not.toContain('senha');
});

it('artefato privado e verificável não sobrescreve evidência nem publica caminho', async () => {
  const r = await executarPreflight({}, { offline: true });
  const saida = join(pasta, 'evidencia.json');
  const sha = await gravarEvidencia(saida, r);
  const bytes = await readFile(saida);
  expect(sha).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(JSON.parse(bytes.toString())).toEqual(r);
  await expect(gravarEvidencia(saida, r)).rejects.toBeDefined();
  const linhas: string[] = [];
  expect(await executarCli(['--saida', saida], {}, (l) => linhas.push(l))).toBe(1);
  expect(linhas.join('')).not.toContain(pasta);
  expect(await executarCli(['--habilitar-escrita', SEGREDO], {}, (l) => linhas.push(l))).toBe(1);
  expect(linhas.join('')).not.toContain(SEGREDO);
});

it('arquivos vazios, CA inválida e arquivo público não passam como cofre', async () => {
  const vazio = join(pasta, 'vazio');
  await writeFile(vazio, '');
  expect((await verificarArquivo(vazio, 'credencial')).check.estado).toBe('bloqueado');
  expect(
    (await verificarArquivo(String(env['GIA_M365_CLIENT_SECRET_ARQUIVO']), 'ca')).check.estado,
  ).toBe('bloqueado');
  if (process.platform !== 'win32') {
    const aberto = join(pasta, 'publico');
    await writeFile(aberto, SEGREDO);
    await chmod(aberto, 0o644);
    expect((await verificarArquivo(aberto, 'credencial')).check.codigo).toBe(
      'ARQUIVO_PERMISSAO_ABERTA',
    );
  }
});

it.skipIf(!process.env['GIA_AD_TESTE_URL'])(
  'cinco reais + LDAPS Samba → leituras aprovadas, homologação/rollback ainda bloqueiam saída zero',
  async () => {
    const comAd: Record<string, string | undefined> = { ...env, GIA_AD_MODO: 'real' };
    for (const sufixo of [
      'URL',
      'BIND_DN',
      'SENHA_ARQUIVO',
      'BASE_DN',
      'CA_ARQUIVO',
      'TLS_NOME_SERVIDOR',
    ])
      comAd[`GIA_AD_${sufixo}`] = process.env[`GIA_AD_TESTE_${sufixo}`];
    comAd['GIA_AD_OU_INATIVOS'] = `OU=Inativos,${comAd['GIA_AD_BASE_DN']}`;
    await writeFile(String(comAd['GIA_WORKER_ARQUIVO_SAUDE']), String(Date.now()));
    const r = await executarPreflight(comAd, {
      fetch: http(),
      rede: (alvo, ms) => (alvo.host === '127.0.0.1' ? verificarRede(alvo, ms) : redeOk(alvo, ms)),
    });
    expect(
      r.sistemas
        .find((s) => s.sistema === 'ad')
        ?.checks.some((c) => c.nome === 'tls' && c.estado === 'ok'),
    ).toBe(true);
    expect(r.leiturasValidadas).toBe(true);
    expect(r.codigoSaida).toBe(2);
    expect(
      r.sistemas.every((s) =>
        s.checks.some((c) => c.nome === 'homologacao' && c.estado === 'pendente'),
      ),
    ).toBe(true);
    expect(r.checks).toContainEqual({
      nome: 'rollback',
      estado: 'pendente',
      codigo: 'ENSAIO_AUTORIZADO_PENDENTE',
    });
    expect(r.escritaHabilitada).toBe(false);
    expect(r.producaoPronta).toBe(false);
  },
);
