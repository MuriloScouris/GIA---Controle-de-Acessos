import { createHash } from 'node:crypto';
import { sessaoRespostaSchema, type ErroConfiguracao } from '@gia/contratos';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type CryptoKey,
} from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { criarApp, type Autenticacao, type OpcoesApp } from './app.js';
import { criarAppDoAmbiente } from './index.js';
import { COOKIE_ESTADO_OIDC, type EventoLogin } from './http/rotas-oidc.js';
import { COOKIE_SESSAO } from './http/protocolo.js';
import { autenticacaoDoAmbiente } from './sessao/autenticacao-ambiente.js';
import { proxiesConfiaveis } from './proxies-confiaveis.js';
import { LIMITES_PADRAO } from './sessao/logins-pendentes.js';
import { criarSessoesSimuladas, type SessoesSimuladas } from './sessao/sessoes-simuladas.js';
import {
  carregarConfiguracaoOidc,
  criarClienteOidc,
  papeisDoToken,
  retornoLocal,
  type ConfiguracaoOidc,
} from './sessao/oidc.js';

const TENANT = '11111111-2222-4333-8444-555555555555';
const CLIENTE = '66666666-7777-4888-9999-000000000000';
const OID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const GRUPO_REVISORES = 'cccccccc-1111-4222-8333-444444444444';
const GRUPO_AUDITORES = 'dddddddd-1111-4222-8333-444444444444';
const GRUPO_EXECUTORES = 'eeeeeeee-1111-4222-8333-444444444444';
/** Grupo existente no tenant, mas fora do mapa: nunca dá papel. */
const GRUPO_NAO_MAPEADO = 'ffffffff-1111-4222-8333-444444444444';
const SEGREDO = 'segredo-ficticio-do-app';
const ENV_OIDC = {
  GIA_OIDC_TENANT_ID: TENANT,
  GIA_OIDC_CLIENT_ID: CLIENTE,
  GIA_OIDC_CLIENT_SECRET_ARQUIVO: '/run/secrets/oidc',
  GIA_OIDC_REDIRECT_URI: 'https://gia.exemplo.com.br/api/sessao/oidc/retorno',
  GIA_OIDC_POS_LOGOUT_URI: 'https://gia.exemplo.com.br/login',
  GIA_OIDC_MAPA_PAPEIS: `${GRUPO_REVISORES}=revisor,${GRUPO_AUDITORES}=auditor,${GRUPO_EXECUTORES}=executor`,
};

let chavePrivada: CryptoKey;
let outraChave: CryptoKey;
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const par = await generateKeyPair('RS256');
  chavePrivada = par.privateKey;
  outraChave = (await generateKeyPair('RS256')).privateKey;
  const publica: JWK = { ...(await exportJWK(par.publicKey)), kid: 'chave-1', alg: 'RS256' };
  jwks = createLocalJWKSet({ keys: [publica] });
});

async function idToken(
  claims: Record<string, unknown>,
  opcoes: { chave?: CryptoKey; alg?: string; expira?: string } = {},
): Promise<string> {
  const { aud, ...resto } = claims;
  return new SignJWT({ tid: TENANT, oid: OID, name: 'Pessoa Fictícia', ...resto })
    .setProtectedHeader({ alg: opcoes.alg ?? 'RS256', kid: 'chave-1' })
    .setIssuer(`https://login.microsoftonline.com/${TENANT}/v2.0`)
    .setAudience(typeof aud === 'string' ? aud : CLIENTE)
    .setIssuedAt()
    .setExpirationTime(opcoes.expira ?? '10m')
    .sign(opcoes.chave ?? chavePrivada);
}

/** Monta a API com OIDC e um Entra ID falso que devolve o ID token que o teste mandar. */
function montar(
  gerarToken: (nonce: string) => Promise<string> | string,
  extra: Partial<ConfiguracaoOidc> = {},
  opcoesApp: Partial<OpcoesApp> = {},
) {
  const pedidosDeToken: URLSearchParams[] = [];
  const eventos: EventoLogin[] = [];
  let ultimoNonce = '';
  const config = { ...carregarConfiguracaoOidc(ENV_OIDC), ...extra };
  const cliente = criarClienteOidc(config, {
    chaves: jwks,
    lerSegredo: async () => SEGREDO,
    fetch: async (_url, init) => {
      const corpo = new URLSearchParams(String(init?.body));
      pedidosDeToken.push(corpo);
      return new Response(
        JSON.stringify({ id_token: await gerarToken(ultimoNonce), token_type: 'Bearer' }),
        {
          status: 200,
        },
      );
    },
  });
  const iniciarOriginal = cliente.iniciar.bind(cliente);
  const autenticacao: Autenticacao = {
    modo: 'oidc',
    cliente: {
      ...cliente,
      iniciar: (retorno) => {
        const r = iniciarOriginal(retorno);
        ultimoNonce = r.pendente.nonce;
        return r;
      },
    },
    auditarLogin: (e) => eventos.push(e),
  };
  const app = criarApp({ ambiente: 'producao', autenticacao, ...opcoesApp });
  return { app, pedidosDeToken, eventos };
}

function cookie(setCookie: string | string[] | undefined, nome: string): string | null {
  const lista = Array.isArray(setCookie) ? setCookie : setCookie === undefined ? [] : [setCookie];
  const linha = lista.find((c) => c.startsWith(`${nome}=`));
  return linha ?? null;
}

async function entrar(app: ReturnType<typeof montar>['app'], retorno = '/pedidos') {
  const res = await app.inject({
    method: 'GET',
    url: `/sessao/oidc/entrar?retorno=${encodeURIComponent(retorno)}`,
  });
  const local = new URL(String(res.headers.location));
  const linhaEstado = cookie(res.headers['set-cookie'], COOKIE_ESTADO_OIDC)!;
  const estado = linhaEstado.split(';')[0]!.split('=')[1]!;
  return { res, local, estado, linhaEstado };
}

async function retornar(
  app: ReturnType<typeof montar>['app'],
  query: string,
  estadoCookie: string | null,
) {
  return app.inject({
    method: 'GET',
    url: `/sessao/oidc/retorno?${query}`,
    headers: estadoCookie === null ? {} : { cookie: `${COOKIE_ESTADO_OIDC}=${estadoCookie}` },
  });
}

describe('configuração do OIDC', () => {
  it('exige tenant e cliente por GUID, segredo em arquivo e retorno HTTPS', () => {
    expect(carregarConfiguracaoOidc(ENV_OIDC)).toMatchObject({
      tenantId: TENANT,
      clientId: CLIENTE,
      mapaPapeis: {
        [GRUPO_REVISORES]: ['revisor'],
        [GRUPO_AUDITORES]: ['auditor'],
        [GRUPO_EXECUTORES]: ['executor'],
      },
    });
    const variaveis = (env: Record<string, string>) => {
      try {
        carregarConfiguracaoOidc(env);
      } catch (erro) {
        return (erro as ErroConfiguracao).variaveis;
      }
      return [];
    };
    expect(
      variaveis({
        ...ENV_OIDC,
        GIA_OIDC_TENANT_ID: 'common',
        GIA_OIDC_REDIRECT_URI: 'http://gia.exemplo.com.br/retorno',
        GIA_OIDC_MAPA_PAPEIS: 'grupo=root',
      }),
    ).toEqual(['GIA_OIDC_MAPA_PAPEIS', 'GIA_OIDC_REDIRECT_URI', 'GIA_OIDC_TENANT_ID']);
  });

  it('retorno depois do login só aceita caminho local', () => {
    expect(retornoLocal('/pedidos/1?aba=itens#topo')).toBe('/pedidos/1?aba=itens#topo');
    for (const fora of [
      '//atacante.exemplo',
      '/\\atacante.exemplo',
      'https://atacante.exemplo',
      'javascript:alert(1)',
      '/\u0000x',
      '',
      undefined,
      42,
    ]) {
      expect(retornoLocal(fora)).toBe('/');
    }
  });

  it('mapa só aceita object ID de grupo → papel humano (M1)', () => {
    const variaveis = (mapa: string) => {
      try {
        carregarConfiguracaoOidc({ ...ENV_OIDC, GIA_OIDC_MAPA_PAPEIS: mapa });
      } catch (erro) {
        return (erro as ErroConfiguracao).variaveis;
      }
      return [];
    };
    for (const invalido of [
      'Gia.Auditoria=auditor', // valor de app role por nome
      'administradorGia=administradorGia', // nome de papel como chave
      'Administradores do GIA=administradorGia',
      `${GRUPO_REVISORES}=servicoExecutor`, // identidade técnica do worker
      `${GRUPO_REVISORES}=administrador`, // papel inexistente
      `${GRUPO_REVISORES}=revisor=executor`,
      `${GRUPO_REVISORES}`,
      `${GRUPO_REVISORES}=revisor,`,
      `{${GRUPO_REVISORES}}=revisor`,
      '__proto__=administradorGia',
    ])
      expect(variaveis(invalido), invalido).toEqual(['GIA_OIDC_MAPA_PAPEIS']);
    // O erro cita só a variável, nunca o valor configurado.
    try {
      carregarConfiguracaoOidc({ ...ENV_OIDC, GIA_OIDC_MAPA_PAPEIS: 'Gia.Secreto=auditor' });
    } catch (erro) {
      expect((erro as Error).message).not.toContain('Gia.Secreto');
    }
    // GUID em maiúsculas é normalizado; o mesmo grupo pode acumular papéis.
    const config = carregarConfiguracaoOidc({
      ...ENV_OIDC,
      GIA_OIDC_MAPA_PAPEIS: `${GRUPO_REVISORES.toUpperCase()}=revisor, ${GRUPO_REVISORES}=executor,${GRUPO_REVISORES}=revisor`,
    });
    expect(config.mapaPapeis).toEqual({ [GRUPO_REVISORES]: ['revisor', 'executor'] });
    // Sem mapa, ninguém tem papel (e o login nega): não há papel implícito.
    const semMapa = carregarConfiguracaoOidc({ ...ENV_OIDC, GIA_OIDC_MAPA_PAPEIS: '' });
    expect(semMapa.mapaPapeis).toEqual({});
  });

  it('papéis vêm só dos object IDs mapeados na claim groups (M1)', () => {
    const mapa = carregarConfiguracaoOidc(ENV_OIDC).mapaPapeis;
    expect(papeisDoToken({ groups: [GRUPO_REVISORES, GRUPO_EXECUTORES] }, mapa)).toEqual([
      'executor',
      'revisor',
    ]);
    expect(papeisDoToken({ groups: [GRUPO_AUDITORES.toUpperCase()] }, mapa)).toEqual(['auditor']);
    for (const payload of [
      // app roles com o nome exato de um papel: antes concediam, agora não
      { roles: ['administradorGia', 'administradorTecnico', 'revisor', 'executor', 'auditor'] },
      // grupo cujo "nome" é um papel (sem object ID)
      { groups: ['administradorGia', 'revisor'] },
      // object ID mapeado, mas na claim roles: só groups conta
      { roles: [GRUPO_REVISORES] },
      // grupo real do tenant, fora do mapa
      { groups: [GRUPO_NAO_MAPEADO] },
      // identidade técnica nunca vem do token
      { roles: ['servicoExecutor'], groups: ['servicoExecutor'] },
      // chaves do protótipo e formatos estranhos
      { groups: ['__proto__', 'constructor', 'toString'] },
      { groups: [42, null, { id: GRUPO_REVISORES }, [GRUPO_REVISORES]] },
      { groups: GRUPO_REVISORES },
      { groups: [` ${GRUPO_REVISORES}`] },
      {},
    ])
      expect(papeisDoToken(payload as never, mapa), JSON.stringify(payload)).toEqual([]);
    // Mistura: só o grupo mapeado vale; o resto é ignorado, sem elevar.
    expect(
      papeisDoToken(
        { roles: ['administradorGia'], groups: [GRUPO_AUDITORES, GRUPO_NAO_MAPEADO, 'revisor'] },
        mapa,
      ),
    ).toEqual(['auditor']);
  });
});

describe('login de produção com Entra ID (Authorization Code + PKCE)', () => {
  it('entrar redireciona ao Entra ID do tenant com PKCE S256, state e nonce, e liga o estado ao navegador', async () => {
    const { app } = montar((nonce) => idToken({ nonce, groups: [GRUPO_REVISORES] }));
    const { res, local, linhaEstado } = await entrar(app);
    expect(res.statusCode).toBe(302);
    expect(`${local.origin}${local.pathname}`).toBe(
      `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
    );
    expect(Object.fromEntries(local.searchParams)).toMatchObject({
      client_id: CLIENTE,
      response_type: 'code',
      redirect_uri: ENV_OIDC.GIA_OIDC_REDIRECT_URI,
      scope: 'openid profile email',
      code_challenge_method: 'S256',
    });
    expect(local.searchParams.get('state')).toMatch(/^[\w-]{43}$/);
    expect(local.searchParams.get('nonce')).toMatch(/^[\w-]{43}$/);
    expect(linhaEstado).toMatch(/HttpOnly; Secure; SameSite=Lax; Max-Age=300$/);
  });

  it('retorno válido troca o código com o verificador PKCE, valida o token e abre a sessão', async () => {
    const { app, pedidosDeToken, eventos } = montar((nonce) =>
      idToken({
        nonce,
        groups: [GRUPO_REVISORES],
        email: 'pessoa@exemplo.com.br',
      }),
    );
    const { local, estado } = await entrar(app, '/pedidos/123');
    const res = await retornar(app, `code=codigo-ficticio&state=${estado}`, estado);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/pedidos/123');
    const linhaSessao = cookie(res.headers['set-cookie'], COOKIE_SESSAO)!;
    expect(linhaSessao).toMatch(/HttpOnly; Secure; SameSite=Strict; Max-Age=\d+$/);

    const troca = pedidosDeToken[0]!;
    expect(Object.fromEntries(troca)).toMatchObject({
      grant_type: 'authorization_code',
      code: 'codigo-ficticio',
      client_secret: SEGREDO,
      redirect_uri: ENV_OIDC.GIA_OIDC_REDIRECT_URI,
    });
    const desafio = createHash('sha256').update(troca.get('code_verifier')!).digest('base64url');
    expect(desafio).toBe(local.searchParams.get('code_challenge'));

    const sessao = sessaoRespostaSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/sessao',
          headers: { cookie: linhaSessao.split(';')[0]! },
        })
      ).json(),
    );
    expect(sessao).toMatchObject({ usuarioId: OID, nome: 'Pessoa Fictícia', papeis: ['revisor'] });
    expect(eventos.map((e) => e.evento)).toEqual(['login_iniciado', 'login_concluido']);
    expect(JSON.stringify(eventos)).not.toMatch(/codigo-ficticio|pessoa@|Pessoa Fict|eyJ/);
  });

  it('sem o cookie de estado do mesmo navegador (CSRF de login) ou repetindo o retorno, recusa', async () => {
    const { app } = montar((nonce) => idToken({ nonce, groups: [GRUPO_REVISORES] }));
    const { estado } = await entrar(app);
    for (const [query, doCookie] of [
      [`code=x&state=${estado}`, null],
      [`code=x&state=${estado}`, 'outro-estado'],
      ['code=x&state=inventado', 'inventado'],
    ] as const) {
      const res = await retornar(app, query, doCookie);
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/login?erro=LOGIN_ESTADO_INVALIDO');
      expect(cookie(res.headers['set-cookie'], COOKIE_SESSAO)).toBeNull();
    }
    // O estado é de uso único: depois da primeira tentativa, nem o certo serve.
    const repetido = await retornar(app, `code=x&state=${estado}`, estado);
    expect(repetido.headers.location).toBe('/login?erro=LOGIN_ESTADO_INVALIDO');
  });

  it.each([
    ['nonce de outro login', (n: string) => idToken({ nonce: `${n}x`, groups: [GRUPO_REVISORES] })],
    [
      'outra audiência',
      (n: string) => idToken({ nonce: n, groups: [GRUPO_REVISORES], aud: 'outro' }),
    ],
    [
      'outro tenant',
      (n: string) =>
        idToken({
          nonce: n,
          groups: [GRUPO_REVISORES],
          tid: '99999999-2222-4333-8444-555555555555',
        }),
    ],
    [
      'expirado',
      (n: string) => idToken({ nonce: n, groups: [GRUPO_REVISORES] }, { expira: '-5m' }),
    ],
    [
      'assinado por outra chave',
      (n: string) => idToken({ nonce: n, groups: [GRUPO_REVISORES] }, { chave: outraChave }),
    ],
    ['sem oid', (n: string) => idToken({ nonce: n, groups: [GRUPO_REVISORES], oid: undefined })],
  ])('token inválido (%s) não abre sessão', async (_caso, gerar) => {
    const { app, eventos } = montar(gerar);
    const { estado } = await entrar(app);
    const res = await retornar(app, `code=x&state=${estado}`, estado);
    expect(res.headers.location).toBe('/login?erro=LOGIN_TOKEN_INVALIDO');
    expect(cookie(res.headers['set-cookie'], COOKIE_SESSAO)).toBeNull();
    expect(eventos.at(-1)).toEqual({ evento: 'login_recusado', codigo: 'LOGIN_TOKEN_INVALIDO' });
  });

  it('token com algoritmo simétrico (troca de alg) não abre sessão', async () => {
    const segredo = new TextEncoder().encode('chave-simetrica-de-teste-com-32-bytes!!');
    const { app } = montar((nonce) =>
      new SignJWT({ tid: TENANT, oid: OID, nonce, groups: [GRUPO_REVISORES] })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(`https://login.microsoftonline.com/${TENANT}/v2.0`)
        .setAudience(CLIENTE)
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(segredo),
    );
    const { estado } = await entrar(app);
    expect((await retornar(app, `code=x&state=${estado}`, estado)).headers.location).toBe(
      '/login?erro=LOGIN_TOKEN_INVALIDO',
    );
  });

  it('pessoa sem papel do Gia: acesso negado, sem sessão; grupos demais (overage) também', async () => {
    for (const claims of [
      { roles: ['Outra.Coisa'] },
      { _claim_names: { groups: 'src1' } },
      // M1: app role ou grupo com o nome de um papel não abre sessão
      { roles: ['administradorGia', 'revisor'] },
      { groups: ['administradorGia'] },
      { groups: [GRUPO_NAO_MAPEADO] },
      { roles: [GRUPO_REVISORES] },
    ]) {
      const { app } = montar((nonce) => idToken({ nonce, ...claims }));
      const { estado } = await entrar(app);
      const res = await retornar(app, `code=x&state=${estado}`, estado);
      expect(res.headers.location).toBe('/login?erro=ACESSO_NEGADO');
      expect(cookie(res.headers['set-cookie'], COOKIE_SESSAO)).toBeNull();
    }
  });

  it('erro devolvido pelo Entra ID e troca de código recusada viram códigos estáveis', async () => {
    const { app } = montar((nonce) => idToken({ nonce, groups: [GRUPO_REVISORES] }));
    const primeiro = await entrar(app);
    expect(
      (
        await retornar(
          app,
          `error=access_denied&error_description=texto+do+provedor&state=${primeiro.estado}`,
          primeiro.estado,
        )
      ).headers.location,
    ).toBe('/login?erro=LOGIN_RECUSADO_PELO_PROVEDOR');

    const config = carregarConfiguracaoOidc(ENV_OIDC);
    const recusa = criarApp({
      ambiente: 'producao',
      autenticacao: {
        modo: 'oidc',
        cliente: criarClienteOidc(config, {
          chaves: jwks,
          lerSegredo: async () => SEGREDO,
          fetch: async () =>
            new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
        }),
      },
    });
    const segundo = await entrar(recusa);
    expect(
      (await retornar(recusa, `code=x&state=${segundo.estado}`, segundo.estado)).headers.location,
    ).toBe('/login?erro=LOGIN_TROCA_FALHOU');
  });

  it('segredo do cofre ausente: login indisponível, sem chamar o Entra ID', async () => {
    let chamadas = 0;
    const app = criarApp({
      ambiente: 'producao',
      autenticacao: {
        modo: 'oidc',
        cliente: criarClienteOidc(
          { ...carregarConfiguracaoOidc(ENV_OIDC), arquivoSegredo: '/nao/existe' },
          { chaves: jwks, fetch: async () => (chamadas++, new Response('{}')) },
        ),
      },
    });
    const { estado } = await entrar(app);
    expect((await retornar(app, `code=x&state=${estado}`, estado)).headers.location).toBe(
      '/login?erro=LOGIN_INDISPONIVEL',
    );
    expect(chamadas).toBe(0);
  });

  it('novo login descarta a sessão anterior do navegador (sem fixação de sessão)', async () => {
    const { app } = montar((nonce) => idToken({ nonce, groups: [GRUPO_REVISORES] }));
    const abrir = async () => {
      const { estado } = await entrar(app);
      return cookie(
        (await retornar(app, `code=x&state=${estado}`, estado)).headers['set-cookie'],
        COOKIE_SESSAO,
      )!.split(';')[0]!;
    };
    const antiga = await abrir();
    const { estado } = await entrar(app);
    await app.inject({
      method: 'GET',
      url: `/sessao/oidc/retorno?code=x&state=${estado}`,
      headers: { cookie: `${COOKIE_ESTADO_OIDC}=${estado}; ${antiga}` },
    });
    expect(
      (await app.inject({ method: 'GET', url: '/sessao', headers: { cookie: antiga } })).statusCode,
    ).toBe(401);
  });

  it('logout exige CSRF, encerra a sessão local e devolve o logout do Entra ID', async () => {
    const { app, eventos } = montar((nonce) => idToken({ nonce, groups: [GRUPO_EXECUTORES] }));
    const { estado } = await entrar(app);
    const sessao = cookie(
      (await retornar(app, `code=x&state=${estado}`, estado)).headers['set-cookie'],
      COOKIE_SESSAO,
    )!.split(';')[0]!;
    expect(
      (await app.inject({ method: 'POST', url: '/sessao/oidc/sair', headers: { cookie: sessao } }))
        .statusCode,
    ).toBe(403);
    const sair = await app.inject({
      method: 'POST',
      url: '/sessao/oidc/sair',
      headers: { cookie: sessao, 'x-gia-csrf': '1' },
    });
    expect(sair.statusCode).toBe(200);
    expect(sair.json()).toEqual({
      redirecionarPara: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(ENV_OIDC.GIA_OIDC_POS_LOGOUT_URI)}`,
    });
    expect(cookie(sair.headers['set-cookie'], COOKIE_SESSAO)).toMatch(/Max-Age=0$/);
    expect(
      (await app.inject({ method: 'GET', url: '/pedidos', headers: { cookie: sessao } }))
        .statusCode,
    ).toBe(401);
    expect(eventos.at(-1)).toEqual({ evento: 'logout', usuarioId: OID });
  });

  it('com OIDC não existe login simulado, e o modo é informado à interface', async () => {
    const { app } = montar((nonce) => idToken({ nonce, groups: [GRUPO_REVISORES] }));
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/sessao/simulada',
          headers: { 'x-gia-csrf': '1' },
          payload: { papel: 'administradorGia' },
        })
      ).statusCode,
    ).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/sessao/modo' })).json()).toEqual({
      modo: 'oidc',
    });
  });
});

describe('autorização: papéis do Entra ID valem na matriz do domínio', () => {
  it('auditor entra mas não pode solicitar execução; executor pode', async () => {
    const { app } = montar((nonce) =>
      idToken({ nonce, groups: [GRUPO_AUDITORES], roles: ['executor', 'administradorGia'] }),
    );
    const { estado } = await entrar(app);
    const sessao = cookie(
      (await retornar(app, `code=x&state=${estado}`, estado)).headers['set-cookie'],
      COOKIE_SESSAO,
    )!.split(';')[0]!;
    const importar = await app.inject({
      method: 'POST',
      url: '/importacoes/jira',
      headers: { cookie: sessao, 'x-gia-csrf': '1' },
      payload: {},
    });
    expect(importar.statusCode).toBe(403);
    expect(importar.json()).toMatchObject({ codigo: 'PERMISSAO_NEGADA' });
  });
});

describe('modo de login pelo ambiente', () => {
  it('desenvolvimento usa a simulada; teste só com opt-in; produção exige OIDC', () => {
    const auditar = () => undefined;
    const dev = { GIA_AMBIENTE: 'desenvolvimento' };
    const teste = { GIA_AMBIENTE: 'teste' };
    expect(autenticacaoDoAmbiente(dev, 'desenvolvimento', auditar).modo).toBe('simulada');
    expect(autenticacaoDoAmbiente(teste, 'teste', auditar).modo).toBe('indisponivel');
    expect(
      autenticacaoDoAmbiente({ ...teste, GIA_AUTH_SIMULADA: 'true' }, 'teste', auditar).modo,
    ).toBe('simulada');
    expect(autenticacaoDoAmbiente(ENV_OIDC, 'producao', auditar).modo).toBe('oidc');
    const erro = (env: Record<string, string>, ambiente: 'teste' | 'producao') => {
      try {
        autenticacaoDoAmbiente(env, ambiente, auditar);
      } catch (e) {
        return (e as ErroConfiguracao).variaveis;
      }
      return [];
    };
    expect(erro({}, 'producao')).toEqual([
      'GIA_OIDC_CLIENT_ID',
      'GIA_OIDC_CLIENT_SECRET_ARQUIVO',
      'GIA_OIDC_REDIRECT_URI',
      'GIA_OIDC_TENANT_ID',
    ]);
    expect(erro({ ...ENV_OIDC, GIA_AUTH_SIMULADA: 'true' }, 'producao')).toEqual([
      'GIA_AUTH_SIMULADA',
    ]);
    expect(erro({ GIA_OIDC_TENANT_ID: TENANT }, 'teste')).toContain('GIA_OIDC_CLIENT_ID');
  });

  it('sem GIA_AMBIENTE declarado não há login simulado (fail-closed), nem com opt-in', () => {
    const auditar = () => undefined;
    // O padrão da configuração é `desenvolvimento`; ele não abre a sessão simulada.
    expect(autenticacaoDoAmbiente({}, 'desenvolvimento', auditar).modo).toBe('indisponivel');
    expect(
      autenticacaoDoAmbiente({ GIA_AUTH_SIMULADA: 'true' }, 'desenvolvimento', auditar).modo,
    ).toBe('indisponivel');
    expect(autenticacaoDoAmbiente({ GIA_AMBIENTE: '' }, 'desenvolvimento', auditar).modo).toBe(
      'indisponivel',
    );
  });

  it('API do ambiente sem GIA_AMBIENTE recusa POST /sessao/simulada', async () => {
    const app = criarAppDoAmbiente({ GIA_LOG_NIVEL: 'erro' });
    expect((await app.inject({ method: 'GET', url: '/sessao/modo' })).json()).toEqual({
      modo: 'indisponivel',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/sessao/simulada',
      headers: { 'x-gia-csrf': '1' },
      payload: { papel: 'administrador' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['set-cookie']).toBeUndefined();
    await app.close();
  });
});

describe('limite de logins pendentes no /sessao/oidc/entrar (M8)', () => {
  const T0 = Date.parse('2026-03-02T12:00:00Z');
  const relogioFalso = () => {
    const estado = { t: T0 };
    return { estado, relogio: { agora: () => new Date(estado.t).toISOString() } };
  };
  const ENTRA_ID = 'https://login.microsoftonline.com/';
  const LOGIN_INDISPONIVEL = '/login?erro=LOGIN_INDISPONIVEL';
  const gerar = (nonce: string) => idToken({ nonce, groups: [GRUPO_REVISORES] });

  /** Um `entrar` vindo de um IP; `xff` simula o cabeçalho de um proxy ou de um cliente malicioso. */
  const entrarDe = (app: ReturnType<typeof montar>['app'], ip: string, xff?: string) =>
    app.inject({
      method: 'GET',
      url: '/sessao/oidc/entrar',
      remoteAddress: ip,
      headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
    });
  type Resposta = { statusCode: number; headers: Record<string, unknown> };
  const aceito = (res: Resposta) =>
    res.statusCode === 302 && String(res.headers['location']).startsWith(ENTRA_ID);
  const recusado = (res: Resposta) =>
    res.statusCode === 303 && res.headers['location'] === LOGIN_INDISPONIVEL;

  it('limita os inícios por origem: recusa igual para todos os motivos, sem detalhe e sem IP', async () => {
    const { estado, relogio } = relogioFalso();
    const { app, eventos } = montar(
      gerar,
      {},
      { relogio, limitesLoginOidc: { ...LIMITES_PADRAO, iniciosPorJanela: 3 } },
    );
    for (let i = 0; i < 3; i += 1) expect(aceito(await entrarDe(app, '198.51.100.7'))).toBe(true);

    const barrado = await entrarDe(app, '198.51.100.7');
    expect(recusado(barrado)).toBe(true);
    expect(barrado.body).toBe('');
    // Só o cookie de estado é zerado: nada de novo estado, e nada que revele limite ou contagem.
    expect(barrado.headers['set-cookie']).toMatch(
      new RegExp(`^${COOKIE_ESTADO_OIDC}=; .*Max-Age=0$`),
    );
    expect(Object.keys(barrado.headers).filter((h) => /retry|limit|rate/i.test(h))).toEqual([]);
    expect(eventos.filter((e) => e.evento === 'login_iniciado')).toHaveLength(3);
    expect(eventos.at(-1)).toEqual({ evento: 'login_recusado', codigo: 'LOGIN_LIMITE_ORIGEM' });
    expect(JSON.stringify(eventos)).not.toContain('198.51.100.7');

    // Outra origem segue entrando, e a barrada volta depois da janela.
    expect(aceito(await entrarDe(app, '198.51.100.8'))).toBe(true);
    estado.t += 61_000;
    expect(aceito(await entrarDe(app, '198.51.100.7'))).toBe(true);
    await app.close();
  });

  it('limita o total de estados pendentes e a vaga volta quando um login conclui', async () => {
    const { relogio } = relogioFalso();
    const { app, eventos } = montar(
      gerar,
      {},
      {
        relogio,
        limitesLoginOidc: {
          ...LIMITES_PADRAO,
          maximoPendentes: 2,
          maximoPorOrigem: 100,
          iniciosPorJanela: 100,
        },
      },
    );
    await entrar(app);
    const segundo = await entrar(app);
    const cheio = await app.inject({ method: 'GET', url: '/sessao/oidc/entrar' });
    expect(recusado(cheio)).toBe(true);
    expect(eventos.at(-1)).toEqual({ evento: 'login_recusado', codigo: 'LOGIN_LIMITE_CAPACIDADE' });

    // O fluxo permitido continua valendo com o teto cheio: o último login iniciado conclui...
    const concluido = await retornar(app, `code=x&state=${segundo.estado}`, segundo.estado);
    expect(concluido.statusCode).toBe(303);
    expect(concluido.headers.location).toBe('/pedidos');
    // ...e libera a vaga.
    expect(aceito(await app.inject({ method: 'GET', url: '/sessao/oidc/entrar' }))).toBe(true);
    await app.close();
  });

  it('limita os estados pendentes por origem, sem afetar as outras', async () => {
    const { relogio } = relogioFalso();
    const { app } = montar(
      gerar,
      {},
      {
        relogio,
        limitesLoginOidc: { ...LIMITES_PADRAO, maximoPorOrigem: 2, iniciosPorJanela: 100 },
      },
    );
    expect(aceito(await entrarDe(app, '198.51.100.7'))).toBe(true);
    expect(aceito(await entrarDe(app, '198.51.100.7'))).toBe(true);
    expect(recusado(await entrarDe(app, '198.51.100.7'))).toBe(true);
    expect(aceito(await entrarDe(app, '198.51.100.9'))).toBe(true);
    await app.close();
  });

  it('o estado expira em 5 minutos: vale até o fim da validade e depois é recusado sem trocar código', async () => {
    const { estado: relogioEstado, relogio } = relogioFalso();
    const { app, pedidosDeToken, eventos } = montar(gerar, {}, { relogio });

    const dentro = await entrar(app);
    relogioEstado.t += 299_000;
    expect((await retornar(app, `code=x&state=${dentro.estado}`, dentro.estado)).statusCode).toBe(
      303,
    );
    expect(pedidosDeToken).toHaveLength(1);

    const vencido = await entrar(app);
    relogioEstado.t += 300_000;
    const res = await retornar(app, `code=x&state=${vencido.estado}`, vencido.estado);
    expect(res.headers.location).toBe('/login?erro=LOGIN_ESTADO_INVALIDO');
    expect(pedidosDeToken).toHaveLength(1);
    expect(eventos.at(-1)).toEqual({ evento: 'login_recusado', codigo: 'LOGIN_ESTADO_INVALIDO' });
    // Vencido ou não, o estado é de uso único.
    expect(
      (await retornar(app, `code=x&state=${vencido.estado}`, vencido.estado)).headers.location,
    ).toBe('/login?erro=LOGIN_ESTADO_INVALIDO');
    await app.close();
  });

  it('estados vencidos são varridos: a vaga por origem volta sem nenhum retorno', async () => {
    const { estado, relogio } = relogioFalso();
    const { app } = montar(
      gerar,
      {},
      {
        relogio,
        limitesLoginOidc: { ...LIMITES_PADRAO, maximoPorOrigem: 2, iniciosPorJanela: 100 },
      },
    );
    await entrarDe(app, '198.51.100.7');
    await entrarDe(app, '198.51.100.7');
    expect(recusado(await entrarDe(app, '198.51.100.7'))).toBe(true);
    estado.t += 300_000;
    expect(aceito(await entrarDe(app, '198.51.100.7'))).toBe(true);
    expect(aceito(await entrarDe(app, '198.51.100.7'))).toBe(true);
    await app.close();
  });

  it('X-Forwarded-For é ignorado por padrão: forjar o cabeçalho não escapa do limite', async () => {
    const { app } = montar(
      gerar,
      {},
      { limitesLoginOidc: { ...LIMITES_PADRAO, iniciosPorJanela: 2 } },
    );
    expect(aceito(await entrarDe(app, '198.51.100.7', '203.0.113.1'))).toBe(true);
    expect(aceito(await entrarDe(app, '198.51.100.7', '203.0.113.2'))).toBe(true);
    expect(recusado(await entrarDe(app, '198.51.100.7', '203.0.113.3'))).toBe(true);
    await app.close();
  });

  it('com proxy confiável (GIA_API_PROXY_CONFIAVEL), cada cliente do proxy tem a sua origem', async () => {
    const { app } = montar(
      gerar,
      {},
      {
        proxiesConfiaveis: ['127.0.0.1'],
        limitesLoginOidc: { ...LIMITES_PADRAO, iniciosPorJanela: 2 },
      },
    );
    // Tudo chega do proxy (127.0.0.1); o cliente real vem no cabeçalho que o proxy acrescenta.
    for (let i = 0; i < 2; i += 1) {
      expect(aceito(await entrarDe(app, '127.0.0.1', '203.0.113.1'))).toBe(true);
    }
    expect(recusado(await entrarDe(app, '127.0.0.1', '203.0.113.1'))).toBe(true);
    // Outro cliente atrás do mesmo proxy não é barrado pelo abuso do primeiro.
    expect(aceito(await entrarDe(app, '127.0.0.1', '203.0.113.2'))).toBe(true);
    // Um cabeçalho forjado pelo cliente vem antes do que o proxy acrescentou e não conta.
    expect(recusado(await entrarDe(app, '127.0.0.1', '10.9.9.9, 203.0.113.1'))).toBe(true);
    await app.close();
  });

  it('com proxy confiável configurado, o cabeçalho de quem não é o proxy continua ignorado', async () => {
    const { app } = montar(
      gerar,
      {},
      {
        proxiesConfiaveis: ['127.0.0.1'],
        limitesLoginOidc: { ...LIMITES_PADRAO, iniciosPorJanela: 2 },
      },
    );
    expect(aceito(await entrarDe(app, '198.51.100.7', '203.0.113.1'))).toBe(true);
    expect(aceito(await entrarDe(app, '198.51.100.7', '203.0.113.2'))).toBe(true);
    expect(recusado(await entrarDe(app, '198.51.100.7', '203.0.113.3'))).toBe(true);
    await app.close();
  });

  describe('CIDR IPv4 mapeado em IPv6 (parser -> trustProxy -> /sessao/oidc/entrar)', () => {
    /** 31 inícios de um mesmo IP, cada um com um X-Forwarded-For diferente: quantos foram aceitos. */
    const aceitosVariandoXff = async (
      app: ReturnType<typeof montar>['app'],
      ip: string,
      total = 31,
    ) => {
      let aceitos = 0;
      for (let i = 0; i < total; i += 1) {
        if (aceito(await entrarDe(app, ip, `203.0.113.${i + 1}`))) aceitos += 1;
      }
      return aceitos;
    };

    it('::ffff:0.0.0.0/96 equivale a 0.0.0.0/0: o parser recusa e a API não sobe', () => {
      expect(proxiesConfiaveis('::ffff:0.0.0.0/96')).toBe('invalido');
      // Mesmo sem passar pelo ambiente, a montagem da API recusa a confiança larga.
      expect(() => montar(gerar, {}, { proxiesConfiaveis: ['::ffff:0.0.0.0/96'] })).toThrow(
        expect.objectContaining({ variaveis: ['GIA_API_PROXY_CONFIAVEL'] }),
      );
    });

    it('mapeado restrito: só o proxy confiável escolhe a origem; o resto não escapa do limite', async () => {
      const lista = proxiesConfiaveis('::ffff:10.0.0.0/104');
      expect(lista).toEqual(['10.0.0.0/8']);
      const { app } = montar(gerar, {}, { proxiesConfiaveis: [...(lista as string[])] });
      // Cliente de fora variando o cabeçalho: 30 aceitos e a 31ª recusada.
      expect(await aceitosVariandoXff(app, '198.51.100.7')).toBe(30);
      // O proxy da rede confiável vê cada cliente por sua origem: nenhum é barrado.
      expect(await aceitosVariandoXff(app, '10.1.2.3')).toBe(31);
      await app.close();
    });

    it('mapeado de um IP só (::ffff:127.0.0.1) vale como 127.0.0.1 e nada além', async () => {
      const lista = proxiesConfiaveis('::ffff:127.0.0.1');
      const { app } = montar(gerar, {}, { proxiesConfiaveis: [...(lista as string[])] });
      expect(await aceitosVariandoXff(app, '127.0.0.1')).toBe(31);
      expect(await aceitosVariandoXff(app, '198.51.100.7')).toBe(30);
      await app.close();
    });

    it('referência: proxy restrito a 127.0.0.1 dá o mesmo resultado (30 aceitos e 1 recusa)', async () => {
      const { app } = montar(gerar, {}, { proxiesConfiaveis: ['127.0.0.1'] });
      expect(await aceitosVariandoXff(app, '198.51.100.7')).toBe(30);
      await app.close();
    });
  });

  it('IPv6 do mesmo /64 divide a origem', async () => {
    const { app } = montar(
      gerar,
      {},
      { limitesLoginOidc: { ...LIMITES_PADRAO, iniciosPorJanela: 2 } },
    );
    expect(aceito(await entrarDe(app, '2001:db8:1:2::1'))).toBe(true);
    expect(aceito(await entrarDe(app, '2001:db8:1:2:ffff::9'))).toBe(true);
    expect(recusado(await entrarDe(app, '2001:db8:1:2:abcd::5'))).toBe(true);
    expect(aceito(await entrarDe(app, '2001:db8:1:3::1'))).toBe(true);
    await app.close();
  });

  it('com os limites padrão, o uso normal (vários logins de uma origem) não é barrado', async () => {
    const { app } = montar(gerar);
    for (let i = 0; i < 10; i += 1) {
      const { estado } = await entrar(app);
      expect((await retornar(app, `code=x&state=${estado}`, estado)).statusCode).toBe(303);
    }
    await app.close();
  });
});

describe('claims inválidos do ID token: nenhuma sessão é aberta (M9)', () => {
  const EMISSOR = `https://login.microsoftonline.com/${TENANT}/v2.0`;
  const OUTRO_TENANT = '99999999-2222-4333-8444-555555555555';
  const OUTRO_APP = '12345678-1234-4234-8234-123456789012';

  /** Ajustes que um objeto de claims não consegue expressar: `null` omite o claim registrado. */
  interface Variacao {
    readonly emissor?: string | null;
    readonly audiencia?: string | string[] | null;
    readonly exp?: string | number | null;
    readonly iat?: number | null;
    readonly nbf?: string | number;
  }

  /** Token bem formado e assinado pela chave do tenant; o teste estraga só o que quer provar. */
  async function tokenDeTeste(claims: Record<string, unknown>, v: Variacao = {}): Promise<string> {
    const jwt = new SignJWT({
      tid: TENANT,
      oid: OID,
      name: 'Pessoa Fictícia',
      groups: [GRUPO_REVISORES],
      ...claims,
    }).setProtectedHeader({ alg: 'RS256', kid: 'chave-1' });
    if (v.emissor !== null) jwt.setIssuer(v.emissor ?? EMISSOR);
    if (v.audiencia !== null) jwt.setAudience(v.audiencia ?? CLIENTE);
    if (v.iat !== null) jwt.setIssuedAt(v.iat);
    if (v.exp !== null) jwt.setExpirationTime(v.exp ?? '10m');
    if (v.nbf !== undefined) jwt.setNotBefore(v.nbf);
    return jwt.sign(chavePrivada);
  }

  /** API com um espião nas sessões: prova que `abrir` nunca foi chamado, além de não haver cookie. */
  function montarComEspiao(gerarToken: (nonce: string) => Promise<string>) {
    const abertas: unknown[] = [];
    const base = criarSessoesSimuladas({ agora: () => new Date().toISOString() });
    const sessoes: SessoesSimuladas = {
      ...base,
      abrir: (sessao) => (abertas.push(sessao), base.abrir(sessao)),
    };
    return { ...montar(gerarToken, {}, { sessoes }), abertas };
  }

  /** O que toda recusa tem em comum, sem nenhuma pista do que estava errado no token. */
  async function exigirRecusa(
    caso: ReturnType<typeof montarComEspiao>,
    estado: string,
    res: Awaited<ReturnType<typeof retornar>>,
  ) {
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/login?erro=LOGIN_TOKEN_INVALIDO');
    expect(res.body).toBe('');
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    expect(cookie(cookies, COOKIE_SESSAO)).toBeNull();
    // Só o cookie de estado, zerado: nenhuma sessão nasceu.
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(new RegExp(`^${COOKIE_ESTADO_OIDC}=; .*Max-Age=0$`));
    expect(caso.abertas).toHaveLength(0);
    expect(caso.eventos.map((e) => e.evento)).not.toContain('login_concluido');
    expect(caso.eventos.at(-1)).toEqual({
      evento: 'login_recusado',
      codigo: 'LOGIN_TOKEN_INVALIDO',
    });
    // Sem sessão no servidor, e o estado do login já foi gasto: não dá para tentar de novo.
    expect((await caso.app.inject({ method: 'GET', url: '/sessao' })).statusCode).toBe(401);
    const repetido = await retornar(caso.app, `code=x&state=${estado}`, estado);
    expect(repetido.headers.location).toBe('/login?erro=LOGIN_ESTADO_INVALIDO');
    expect(caso.abertas).toHaveLength(0);
    await caso.app.close();
  }

  const casos: Array<[string, (nonce: string) => Promise<string>]> = [
    // nonce
    ['nonce trocado', (n) => tokenDeTeste({ nonce: `${n}x` })],
    ['nonce com outra caixa', (n) => tokenDeTeste({ nonce: n.toUpperCase() })],
    ['nonce vazio', () => tokenDeTeste({ nonce: '' })],
    ['nonce ausente', () => tokenDeTeste({ nonce: undefined })],
    ['nonce que não é texto', () => tokenDeTeste({ nonce: 12345 })],
    // aud
    ['aud de outra aplicação', (n) => tokenDeTeste({ nonce: n }, { audiencia: OUTRO_APP })],
    [
      'aud com sufixo no client ID',
      (n) => tokenDeTeste({ nonce: n }, { audiencia: `${CLIENTE}x` }),
    ],
    ['aud lista sem o client ID', (n) => tokenDeTeste({ nonce: n }, { audiencia: [OUTRO_APP] })],
    ['aud ausente', (n) => tokenDeTeste({ nonce: n }, { audiencia: null })],
    // iss
    [
      'iss de outro tenant',
      (n) =>
        tokenDeTeste(
          { nonce: n },
          { emissor: `https://login.microsoftonline.com/${OUTRO_TENANT}/v2.0` },
        ),
    ],
    [
      'iss da v1.0 (sts.windows.net)',
      (n) => tokenDeTeste({ nonce: n }, { emissor: `https://sts.windows.net/${TENANT}/` }),
    ],
    [
      'iss sem o /v2.0',
      (n) => tokenDeTeste({ nonce: n }, { emissor: `https://login.microsoftonline.com/${TENANT}` }),
    ],
    ['iss com barra no fim', (n) => tokenDeTeste({ nonce: n }, { emissor: `${EMISSOR}/` })],
    [
      'iss sem HTTPS',
      (n) =>
        tokenDeTeste({ nonce: n }, { emissor: `http://login.microsoftonline.com/${TENANT}/v2.0` }),
    ],
    [
      'iss de outro domínio',
      (n) => tokenDeTeste({ nonce: n }, { emissor: `https://login.exemplo.com/${TENANT}/v2.0` }),
    ],
    ['iss ausente', (n) => tokenDeTeste({ nonce: n }, { emissor: null })],
    // tid
    ['tid de outro tenant', (n) => tokenDeTeste({ nonce: n, tid: OUTRO_TENANT })],
    ['tid vazio', (n) => tokenDeTeste({ nonce: n, tid: '' })],
    ['tid ausente', (n) => tokenDeTeste({ nonce: n, tid: undefined })],
    ['tid que não é texto', (n) => tokenDeTeste({ nonce: n, tid: 123 })],
    // exp (a tolerância de relógio é de 2 minutos)
    ['exp vencido há 5 minutos', (n) => tokenDeTeste({ nonce: n }, { exp: '-5m' })],
    ['exp vencido há 3 minutos', (n) => tokenDeTeste({ nonce: n }, { exp: '-3m' })],
    ['exp vencido há um dia', (n) => tokenDeTeste({ nonce: n }, { exp: '-1d' })],
    ['exp ausente', (n) => tokenDeTeste({ nonce: n }, { exp: null })],
    // iat e nbf
    ['iat ausente', (n) => tokenDeTeste({ nonce: n }, { iat: null })],
    ['nbf no futuro', (n) => tokenDeTeste({ nonce: n }, { nbf: '+10m' })],
  ];

  it.each(casos)('%s: LOGIN_TOKEN_INVALIDO, sem cookie nem sessão', async (_caso, gerar) => {
    const caso = montarComEspiao(gerar);
    const { estado } = await entrar(caso.app);
    await exigirRecusa(caso, estado, await retornar(caso.app, `code=x&state=${estado}`, estado));
  });

  it('token legítimo de OUTRO login (nonce de um login anterior) é recusado: sem replay', async () => {
    let nonceAntigo = '';
    const caso = montarComEspiao((_atual) => tokenDeTeste({ nonce: nonceAntigo }));
    // O primeiro login nunca volta; o atacante guarda o token amarrado ao nonce dele.
    const primeiro = await entrar(caso.app);
    nonceAntigo = primeiro.local.searchParams.get('nonce')!;
    const segundo = await entrar(caso.app);
    expect(segundo.local.searchParams.get('nonce')).not.toBe(nonceAntigo);
    await exigirRecusa(
      caso,
      segundo.estado,
      await retornar(caso.app, `code=x&state=${segundo.estado}`, segundo.estado),
    );
  });

  it('o caso positivo continua abrindo a sessão (os negativos não passam por um teste vazio)', async () => {
    const caso = montarComEspiao((nonce) => tokenDeTeste({ nonce }));
    const { estado } = await entrar(caso.app, '/pedidos/123');
    const res = await retornar(caso.app, `code=x&state=${estado}`, estado);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/pedidos/123');
    const sessao = cookie(res.headers['set-cookie'], COOKIE_SESSAO)!.split(';')[0]!;
    expect(caso.abertas).toHaveLength(1);
    expect(caso.eventos.at(-1)).toMatchObject({ evento: 'login_concluido', usuarioId: OID });
    const atual = await caso.app.inject({
      method: 'GET',
      url: '/sessao',
      headers: { cookie: sessao },
    });
    expect(atual.statusCode).toBe(200);
    await caso.app.close();
  });
});
