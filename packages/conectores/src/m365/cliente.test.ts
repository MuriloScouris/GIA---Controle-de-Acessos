import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { avaliarExistencia } from '@gia/dominio';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GraphFalso, erroDeRedeGraph, erroGraph } from '../teste/graph-falso.js';
import { contexto, contextoRevogacao, paramsM365 } from '../teste/fabricas.js';
import { ClienteGraphHttp, type RegistroChamadaGraph } from './cliente.js';
import type { ConfiguracaoM365 } from './configuracao.js';
import { criarConectorM365Real } from './real.js';

const SEGREDO = 'segredo-ficticio-do-app';
let pasta = '';
let arquivoSegredo = '';
beforeAll(async () => {
  pasta = await mkdtemp(join(tmpdir(), 'gia-m365-'));
  arquivoSegredo = join(pasta, 'segredo');
  await writeFile(arquivoSegredo, `${SEGREDO}\n`);
});
afterAll(async () => {
  await rm(pasta, { recursive: true, force: true });
});

function configuracao(extra: Partial<ConfiguracaoM365> = {}): ConfiguracaoM365 {
  return {
    tenantId: '11111111-2222-4333-8444-555555555555',
    clientId: '66666666-7777-4888-9999-000000000000',
    arquivoSegredo,
    nuvem: 'global',
    timeoutMs: 2_000,
    tentativasLeitura: 3,
    ...extra,
  };
}

let graph: GraphFalso;
let registros: RegistroChamadaGraph[];
const UPN = 'maria.souza@exemplo.com.br';

beforeEach(() => {
  graph = new GraphFalso();
  registros = [];
  graph.sku('SPB', 90, 87);
  graph.sku('Office_365_E3_(no_Teams)', 40, 39);
  graph.sku('TEAMS_ESSENTIALS_AAD', 45, 45);
  graph.grupo('Empresa - Todos', { mail: 'todos@exemplo.com.br' });
});

const deps = () => ({
  fetch: graph.fetch,
  aoRegistrar: (r: RegistroChamadaGraph) => registros.push(r),
  esperaBaseMs: 1,
});
const cliente = (extra: Partial<ConfiguracaoM365> = {}) =>
  new ClienteGraphHttp(configuracao(extra), deps());
const conector = (extra: Partial<ConfiguracaoM365> = {}) =>
  criarConectorM365Real(configuracao(extra), deps());
const params = (extra: Parameters<typeof paramsM365>[0] = {}) =>
  paramsM365({ planosLicenca: ['SPB'], paisUso: 'BR', grupo: 'Empresa - Todos', ...extra });

describe('autenticação (client credentials)', () => {
  it('pede token ao tenant explícito com o segredo do cofre e o reutiliza', async () => {
    await cliente().testar();
    await cliente().testar();
    const c = cliente();
    await c.testar();
    await c.testar();
    const pedidos = graph.requisicoes.filter((r) => r.caminho === '/token');
    expect(pedidos).toHaveLength(3); // um por instância; a segunda chamada da mesma instância reutiliza
    const corpo = new URLSearchParams(pedidos[0]!.corpo);
    expect(Object.fromEntries(corpo)).toEqual({
      client_id: '66666666-7777-4888-9999-000000000000',
      client_secret: SEGREDO,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    });
  });

  it('401 do Graph renova o token uma vez; persistindo, é credencial recusada', async () => {
    const c = cliente();
    await c.testar();
    graph.programar('GET /organization', erroGraph(401, 'InvalidAuthenticationToken', 'expired'));
    await c.testar();
    expect(graph.tokensEmitidos).toBe(2);

    graph.programar(
      'GET /organization',
      erroGraph(401, 'InvalidAuthenticationToken', 'x'),
      erroGraph(401, 'InvalidAuthenticationToken', 'x'),
    );
    await expect(c.testar()).rejects.toMatchObject({
      tipo: 'recusado',
      codigo: 'M365_AUTENTICACAO',
    });
  });

  it.each([
    ['AADSTS7000222: The provided client secret keys are expired.', 'M365_SEGREDO_EXPIRADO'],
    ['AADSTS7000215: Invalid client secret provided.', 'M365_SEGREDO_INVALIDO'],
    ['AADSTS700016: Application not found in the directory.', 'M365_APP_OU_TENANT_INEXISTENTE'],
  ])('traduz o erro do Entra ID "%s" sem repetir a descrição', async (descricao, codigo) => {
    graph.programar(
      'POST /token',
      new Response(JSON.stringify({ error: 'invalid_client', error_description: descricao }), {
        status: 401,
      }),
    );
    const resultado = await conector().testarConexao();
    expect(resultado).toMatchObject({ disponivel: false, codigo, modo: 'real' });
    expect(resultado.mensagem).not.toContain('client secret keys');
  });

  it('segredo ausente no cofre: erro de configuração, nada é enviado', async () => {
    const resultado = await conector({ arquivoSegredo: join(pasta, 'nao-existe') }).testarConexao();
    expect(resultado).toMatchObject({ disponivel: false, codigo: 'M365_CONFIGURACAO' });
    expect(graph.requisicoes).toHaveLength(0);
  });
});

describe('dependência da sincronização do AD (regra 7)', () => {
  it('sem a identidade no Entra ID: semEfeito transitório, sem nenhuma escrita', async () => {
    const resultado = await conector().provisionar(contexto(params()));
    expect(resultado).toMatchObject({
      efeito: 'semEfeito',
      codigo: 'IDENTIDADE_NAO_SINCRONIZADA',
      transitorio: true,
      modo: 'real',
    });
    expect(graph.requisicoes.some((r) => r.metodo !== 'GET' && r.caminho !== '/token')).toBe(false);
  });

  it('acha a conta pelo e-mail quando o UPN do AD virou onmicrosoft.com', async () => {
    graph.sincronizar('maria.souza@empresa.onmicrosoft.com', { mail: UPN });
    const usuario = await cliente().buscarUsuario(UPN, UPN);
    expect(usuario).toMatchObject({ paisUso: null, licencas: [], grupos: [] });
  });

  it('acha pelo proxyAddresses com a consulta avançada (ConsistencyLevel + $count)', async () => {
    graph.sincronizar('m.souza@empresa.onmicrosoft.com', { proxyAddresses: [`SMTP:${UPN}`] });
    expect(await cliente().buscarUsuario(UPN, UPN)).not.toBeNull();
    const avancada = graph.requisicoes.find((r) => r.caminho.includes('proxyAddresses'))!;
    expect(avancada.cabecalhos.get('consistencylevel')).toBe('eventual');
    expect(avancada.caminho).toContain('%24count=true'.replace('%24', '$'));
  });

  it('e-mail com aspas é escapado no filtro OData', async () => {
    await cliente().buscarUsuario('x@exemplo.com.br', "o'brien@exemplo.com.br");
    const filtro = graph.requisicoes.find((r) => r.caminho.includes('mail%20eq'))!;
    expect(decodeURIComponent(filtro.caminho)).toContain("mail eq 'o''brien@exemplo.com.br'");
  });
});

describe('provisionamento: país, licenças e grupo', () => {
  it('provisiona nas quatro etapas e a conferência comprova tudo', async () => {
    const u = graph.sincronizar(UPN, { mail: UPN });
    const c = conector();
    const resultado = await c.provisionar(contexto(params()));
    expect(resultado).toMatchObject({
      efeito: 'confirmado',
      etapa: 'adicionarGrupo',
      referenciaExterna: u.id,
      modo: 'real',
    });
    expect(u.usageLocation).toBe('BR');
    expect(u.assignedLicenses).toEqual([{ skuId: graph.skus[0]!.skuId }]);
    expect(graph.grupos[0]!.membros).toEqual([u.id]);
    const corpo = JSON.parse(
      graph.requisicoes.find((r) => r.caminho.endsWith('/assignLicense'))!.corpo,
    );
    expect(corpo).toEqual({
      addLicenses: [{ skuId: graph.skus[0]!.skuId, disabledPlans: [] }],
      removeLicenses: [],
    });

    const existencia = await c.conferirExistencia(contexto(params()));
    expect(existencia).toMatchObject({ contaExiste: true, etapaComprovada: 'adicionarGrupo' });
    expect(avaliarExistencia(existencia, params()).situacao).not.toBe('incompleto');
  });

  it('idempotente: reprovisionar não reatribui licença nem duplica membro (400 "already exist" é sucesso)', async () => {
    graph.sincronizar(UPN);
    const c = conector();
    await c.provisionar(contexto(params()));
    const escritas = () =>
      graph.requisicoes.filter((r) => r.metodo !== 'GET' && r.caminho !== '/token').length;
    const antes = escritas();
    expect(await c.provisionar(contexto(params()))).toMatchObject({ efeito: 'confirmado' });
    expect(escritas()).toBe(antes);
    // Mesmo com a checagem de membro defasada, o 400 "already exist" vira sucesso.
    graph.programar('GET /groups/:id/members', new Response(JSON.stringify({ value: [] })));
    await expect(
      cliente().adicionarAoGrupo(graph.usuarios[0]!.id, 'Empresa - Todos'),
    ).resolves.toBeUndefined();
  });

  it('retomada: falha transitória no grupo e a nova tentativa só faz o que falta', async () => {
    const u = graph.sincronizar(UPN);
    graph.programar(
      'POST /groups/:id/members/$ref',
      erroGraph(429, 'TooManyRequests', 'x', { 'retry-after': '7' }),
    );
    const c = conector();
    const parcial = await c.provisionar(contexto(params()));
    expect(parcial).toMatchObject({
      efeito: 'parcial',
      etapa: 'atribuirLicencas',
      transitorio: true,
      tentarAposMs: 7_000,
    });
    const retomada = await c.provisionar(contexto(params(), { etapaInicial: 'adicionarGrupo' }));
    expect(retomada).toMatchObject({ efeito: 'confirmado', etapa: 'adicionarGrupo' });
    expect(u.assignedLicenses).toHaveLength(1);
    expect(graph.requisicoes.filter((r) => r.caminho.endsWith('/assignLicense'))).toHaveLength(1);
  });

  it('sem assento: falha antes de chamar o assignLicense; poucos assentos: aviso na validação', async () => {
    graph.sincronizar(UPN);
    const c = conector();
    const semAssento = await c.provisionar(
      contexto(params({ planosLicenca: ['TEAMS_ESSENTIALS_AAD'] })),
    );
    expect(semAssento).toMatchObject({
      efeito: 'parcial',
      etapa: 'definirPais',
      codigo: 'SEM_ASSENTO',
    });
    expect(graph.requisicoes.some((r) => r.caminho.endsWith('/assignLicense'))).toBe(false);

    const validacao = await c.validar(
      contexto(params({ planosLicenca: ['SPB', 'TEAMS_ESSENTIALS_AAD', 'Teams_Ess'] })),
    );
    expect(validacao.impedimentos.map((i) => i.codigo)).toEqual([
      'SEM_ASSENTO',
      'PLANO_INEXISTENTE',
    ]);
    expect(validacao.avisos.map((a) => a.codigo)).toEqual(['POUCOS_ASSENTOS']);
  });

  it('grupo sincronizado do AD é recusado sem tentar; grupo ambíguo também', async () => {
    graph.sincronizar(UPN);
    graph.grupo('Do AD', { onPremisesSyncEnabled: true });
    expect(await conector().provisionar(contexto(params({ grupo: 'Do AD' })))).toMatchObject({
      efeito: 'parcial',
      codigo: 'M365_GRUPO_SINCRONIZADO_DO_AD',
    });
    graph.grupo('Repetido');
    graph.grupo('Repetido');
    expect(await conector().provisionar(contexto(params({ grupo: 'Repetido' })))).toMatchObject({
      codigo: 'M365_GRUPO_AMBIGUO',
    });
    expect(graph.requisicoes.some((r) => r.caminho.endsWith('/members/$ref'))).toBe(false);
  });

  it('respeita o país de uso já igual e reconhece a conta pelos grupos paginados', async () => {
    const u = graph.sincronizar(UPN, { usageLocation: 'BR' });
    graph.tamanhoPagina = 2;
    for (const nome of ['A', 'B', 'C']) graph.grupo(nome, { membros: [u.id] });
    await cliente().definirPaisDeUso(u.id, 'BR');
    expect(graph.requisicoes.some((r) => r.metodo === 'PATCH')).toBe(false);
    const usuario = await cliente().buscarUsuario(UPN);
    expect(usuario!.grupos).toEqual(expect.arrayContaining(['A', 'B', 'C']));
  });
});

describe('remoção segura de licenças', () => {
  it('remove só os planos pedidos que a conta tem, nunca as outras licenças', async () => {
    const [spb, e3] = graph.skus;
    const u = graph.sincronizar(UPN, {
      usageLocation: 'BR',
      assignedLicenses: [{ skuId: spb!.skuId }, { skuId: e3!.skuId }],
    });
    const resultado = await conector().revogar(
      contextoRevogacao(params({ planosLicenca: ['SPB'] })),
    );
    expect(resultado).toMatchObject({
      efeito: 'confirmado',
      etapa: 'removerLicencas',
      modo: 'real',
    });
    expect(u.assignedLicenses).toEqual([{ skuId: e3!.skuId }]);
    const corpo = JSON.parse(
      graph.requisicoes.find((r) => r.caminho.endsWith('/assignLicense'))!.corpo,
    );
    expect(corpo).toEqual({ addLicenses: [], removeLicenses: [spb!.skuId] });
  });

  it('licença já removida é JA_REVOGADO; conta ausente é falha (regra 5)', async () => {
    graph.sincronizar(UPN, { usageLocation: 'BR' });
    expect(await conector().revogar(contextoRevogacao(params()))).toMatchObject({
      codigo: 'JA_REVOGADO',
    });
    expect(
      await conector().revogar(
        contextoRevogacao(
          params({ upn: 'ninguem@exemplo.com.br', email: 'ninguem@exemplo.com.br' }),
        ),
      ),
    ).toMatchObject({
      efeito: 'semEfeito',
    });
    expect(graph.requisicoes.some((r) => r.caminho.endsWith('/assignLicense'))).toBe(false);
  });
});

describe('timeout, retry e limite de taxa', () => {
  it('leitura respeita Retry-After e repete; escrita nunca repete', async () => {
    graph.programar(
      'GET /subscribedSkus',
      erroGraph(429, 'TooManyRequests', 'x', { 'retry-after': '0' }),
      erroGraph(503, 'ServiceUnavailable', 'x'),
    );
    expect(await cliente().planoExiste('SPB')).toBe(true);
    expect(graph.requisicoes.filter((r) => r.caminho.startsWith('/subscribedSkus'))).toHaveLength(
      3,
    );

    graph.sincronizar(UPN);
    graph.programar('PATCH /users/:id', erroGraph(500, 'InternalServerError', 'x'));
    expect(await conector().provisionar(contexto(params()))).toMatchObject({
      efeito: 'desconhecido',
      codigo: 'M365_HTTP_500',
    });
    expect(graph.requisicoes.filter((r) => r.metodo === 'PATCH')).toHaveLength(1);
  });

  it('escrita sem resposta no prazo é desconhecida (regra 3)', async () => {
    graph.sincronizar(UPN);
    graph.programar('POST /users/:id/assignLicense', 'pendurar');
    expect(await conector({ timeoutMs: 300 }).provisionar(contexto(params()))).toMatchObject({
      efeito: 'desconhecido',
      codigo: 'M365_TEMPO_ESGOTADO',
      etapa: 'definirPais',
    });
  });

  it('rede recusada na leitura é repetida e acaba como conexaoRecusada; 403 é permissão', async () => {
    graph.programar(
      'GET /organization',
      erroDeRedeGraph('ECONNREFUSED'),
      erroDeRedeGraph('ECONNREFUSED'),
      erroDeRedeGraph('ECONNREFUSED'),
    );
    await expect(cliente().testar()).rejects.toMatchObject({ tipo: 'conexaoRecusada' });
    graph.programar(
      'GET /organization',
      erroGraph(403, 'Authorization_RequestDenied', 'Insufficient privileges'),
    );
    await expect(cliente({ tentativasLeitura: 1 }).testar()).rejects.toMatchObject({
      tipo: 'recusado',
      codigo: 'M365_PERMISSAO_INSUFICIENTE',
    });
  });
});

describe('auditoria e segurança', () => {
  it('registra cada chamada com client-request-id, sem UPN, e-mail, token nem segredo', async () => {
    graph.sincronizar(UPN, { mail: UPN });
    await conector().provisionar(contexto(params()));
    const texto = JSON.stringify(registros);
    for (const sensivel of [UPN, SEGREDO, 'token-ficticio']) expect(texto).not.toContain(sensivel);
    const enviados = graph.requisicoes
      .filter((r) => r.caminho !== '/token')
      .map((r) => r.cabecalhos.get('client-request-id'));
    expect(registros.filter((r) => r.operacao !== 'token').map((r) => r.idRequisicao)).toEqual(
      expect.arrayContaining(enviados.slice(-3)),
    );
    expect(new Set(registros.map((r) => r.operacao))).toEqual(
      new Set([
        'token',
        'buscarUsuario',
        'listarPlanos',
        'definirPaisDeUso',
        'atribuirLicencas',
        'buscarGrupo',
        'adicionarAoGrupo',
      ]),
    );
  });

  it('só segue paginação do próprio Graph (sem SSRF por @odata.nextLink)', async () => {
    const u = graph.sincronizar(UPN);
    graph.programar(
      'GET /users/:id/memberOf/microsoft.graph.group',
      new Response(
        JSON.stringify({ value: [], '@odata.nextLink': 'https://atacante.exemplo/roubar' }),
      ),
    );
    await cliente().buscarUsuario(u.id);
    expect(graph.requisicoes.every((r) => !r.caminho.includes('atacante'))).toBe(true);
  });
});
