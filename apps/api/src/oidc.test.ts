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
import { criarApp, type Autenticacao } from './app.js';
import { COOKIE_ESTADO_OIDC, type EventoLogin } from './http/rotas-oidc.js';
import { COOKIE_SESSAO } from './http/protocolo.js';
import { autenticacaoDoAmbiente } from './sessao/autenticacao-ambiente.js';
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
const SEGREDO = 'segredo-ficticio-do-app';
const ENV_OIDC = {
  GIA_OIDC_TENANT_ID: TENANT,
  GIA_OIDC_CLIENT_ID: CLIENTE,
  GIA_OIDC_CLIENT_SECRET_ARQUIVO: '/run/secrets/oidc',
  GIA_OIDC_REDIRECT_URI: 'https://gia.exemplo.com.br/api/sessao/oidc/retorno',
  GIA_OIDC_POS_LOGOUT_URI: 'https://gia.exemplo.com.br/login',
  GIA_OIDC_MAPA_PAPEIS: `${GRUPO_REVISORES}=revisor,Gia.Auditoria=auditor`,
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
  const app = criarApp({ ambiente: 'producao', autenticacao });
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
      mapaPapeis: { [GRUPO_REVISORES]: 'revisor', 'gia.auditoria': 'auditor' },
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

  it('papéis vêm das app roles com o nome do papel ou do mapa (roles e grupos)', () => {
    const mapa = carregarConfiguracaoOidc(ENV_OIDC).mapaPapeis;
    expect(
      papeisDoToken(
        { roles: ['executor', 'Gia.Auditoria', 'root'], groups: [GRUPO_REVISORES] },
        mapa,
      ),
    ).toEqual(['auditor', 'executor', 'revisor']);
    expect(papeisDoToken({ roles: ['Administrador'] }, mapa)).toEqual([]);
  });
});

describe('login de produção com Entra ID (Authorization Code + PKCE)', () => {
  it('entrar redireciona ao Entra ID do tenant com PKCE S256, state e nonce, e liga o estado ao navegador', async () => {
    const { app } = montar((nonce) => idToken({ nonce, roles: ['revisor'] }));
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
    expect(linhaEstado).toMatch(/HttpOnly; Secure; SameSite=Lax; Max-Age=600$/);
  });

  it('retorno válido troca o código com o verificador PKCE, valida o token e abre a sessão', async () => {
    const { app, pedidosDeToken, eventos } = montar((nonce) =>
      idToken({
        nonce,
        roles: ['revisor'],
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
    const { app } = montar((nonce) => idToken({ nonce, roles: ['revisor'] }));
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
    ['nonce de outro login', (n: string) => idToken({ nonce: `${n}x`, roles: ['revisor'] })],
    ['outra audiência', (n: string) => idToken({ nonce: n, roles: ['revisor'], aud: 'outro' })],
    [
      'outro tenant',
      (n: string) =>
        idToken({ nonce: n, roles: ['revisor'], tid: '99999999-2222-4333-8444-555555555555' }),
    ],
    ['expirado', (n: string) => idToken({ nonce: n, roles: ['revisor'] }, { expira: '-5m' })],
    [
      'assinado por outra chave',
      (n: string) => idToken({ nonce: n, roles: ['revisor'] }, { chave: outraChave }),
    ],
    ['sem oid', (n: string) => idToken({ nonce: n, roles: ['revisor'], oid: undefined })],
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
      new SignJWT({ tid: TENANT, oid: OID, nonce, roles: ['revisor'] })
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
    for (const claims of [{ roles: ['Outra.Coisa'] }, { _claim_names: { groups: 'src1' } }]) {
      const { app } = montar((nonce) => idToken({ nonce, ...claims }));
      const { estado } = await entrar(app);
      const res = await retornar(app, `code=x&state=${estado}`, estado);
      expect(res.headers.location).toBe('/login?erro=ACESSO_NEGADO');
      expect(cookie(res.headers['set-cookie'], COOKIE_SESSAO)).toBeNull();
    }
  });

  it('erro devolvido pelo Entra ID e troca de código recusada viram códigos estáveis', async () => {
    const { app } = montar((nonce) => idToken({ nonce, roles: ['revisor'] }));
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
    const { app } = montar((nonce) => idToken({ nonce, roles: ['revisor'] }));
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
    const { app, eventos } = montar((nonce) => idToken({ nonce, roles: ['executor'] }));
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
    const { app } = montar((nonce) => idToken({ nonce, roles: ['revisor'] }));
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
    const { app } = montar((nonce) => idToken({ nonce, roles: ['Gia.Auditoria'] }));
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
    expect(autenticacaoDoAmbiente({}, 'desenvolvimento', auditar).modo).toBe('simulada');
    expect(autenticacaoDoAmbiente({}, 'teste', auditar).modo).toBe('indisponivel');
    expect(autenticacaoDoAmbiente({ GIA_AUTH_SIMULADA: 'true' }, 'teste', auditar).modo).toBe(
      'simulada',
    );
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
});
