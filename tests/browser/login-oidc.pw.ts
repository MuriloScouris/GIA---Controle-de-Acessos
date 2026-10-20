import { randomUUID } from 'node:crypto';
import { criarApp, criarClienteOidc, type ConfiguracaoOidc } from '@gia/api';
import { test as base, expect, type Page } from '@playwright/test';
import { servirWeb } from './fixture.js';
import {
  subirProvedorOidcFalso,
  type DefeitoToken,
  type ProvedorOidcFalso,
} from './provedor-oidc-falso.js';

/**
 * Login de produção (Entra ID/OIDC) ponta a ponta no navegador, contra um
 * provedor falso local (DEV-303, pendência M10): SPA compilada → API → redirect
 * ao `authorize` falso → troca do código com PKCE e client secret → validação
 * do ID token pelo JWKS falso → sessão. Nenhuma requisição sai de 127.0.0.1.
 */

const TENANT = '11111111-2222-4333-8444-555555555555';
const CLIENTE = '66666666-7777-4888-9999-000000000000';
const OID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const GRUPO_REVISORES = 'cccccccc-1111-4222-8333-444444444444';
const GRUPO_NAO_MAPEADO = 'ffffffff-1111-4222-8333-444444444444';

interface EventoLogin {
  readonly evento: string;
  readonly codigo?: string;
  readonly papeis?: readonly string[];
}

interface AmbienteOidc {
  readonly url: string;
  readonly provedor: ProvedorOidcFalso;
  readonly eventos: readonly EventoLogin[];
}

const test = base.extend<{ oidc: AmbienteOidc }>({
  oidc: async ({ page }, use) => {
    // Sem rede externa: só 127.0.0.1 (SPA, API e o provedor falso).
    await page.route('**/*', (route) => {
      const host = new URL(route.request().url()).hostname;
      return host === '127.0.0.1' || host === 'localhost' ? route.continue() : route.abort();
    });
    const provedor = await subirProvedorOidcFalso({ tenant: TENANT, clientId: CLIENTE, oid: OID });
    let apiUrl = '';
    const web = await servirWeb(() => apiUrl);
    // Só o object ID mapeado dá papel (M1); o mapa não vem de app role nem de nome.
    const config: ConfiguracaoOidc = {
      tenantId: TENANT,
      clientId: CLIENTE,
      arquivoSegredo: 'nao-usado-o-segredo-vem-de-lerSegredo',
      redirectUri: `${web.url}/api/sessao/oidc/retorno`,
      posLogoutUri: `${web.url}/login`,
      mapaPapeis: { [GRUPO_REVISORES]: ['revisor'] },
    };
    const eventos: EventoLogin[] = [];
    const app = criarApp({
      ambiente: 'teste',
      autenticacao: {
        modo: 'oidc',
        cliente: criarClienteOidc(config, {
          autoridade: provedor.url,
          lerSegredo: async () => provedor.segredo,
        }),
        auditarLogin: (evento) => eventos.push(evento),
      },
    });
    apiUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      await use({ url: web.url, provedor, eventos });
    } finally {
      await web.fechar();
      await app.close();
      await provedor.fechar();
    }
  },
});

async function sessaoAtual(page: Page): Promise<{ status: number; corpo: unknown }> {
  return page.evaluate(async () => {
    const r = await fetch('/api/sessao');
    return { status: r.status, corpo: await r.json().catch(() => null) };
  });
}

async function entrarComMicrosoft(page: Page, url: string) {
  await page.goto(`${url}/login`);
  await page.getByRole('link', { name: 'Entrar com Microsoft' }).click();
}

test('login permitido: grupo mapeado por object ID abre a sessão e leva ao painel', async ({
  page,
  oidc,
}) => {
  oidc.provedor.proximoLogin({ claims: { groups: [GRUPO_REVISORES] } });
  await entrarComMicrosoft(page, oidc.url);

  await expect(page.getByRole('heading', { name: 'Painel de chamados' })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/');
  await expect(page.getByText('Pessoa Corporativa Fictícia').first()).toBeVisible();
  const sessao = await sessaoAtual(page);
  expect(sessao.status).toBe(200);
  expect(sessao.corpo).toMatchObject({ usuarioId: OID, papeis: ['revisor'] });

  // O fluxo passou pelo authorize, pela troca com PKCE e pelo JWKS do provedor.
  expect(oidc.provedor.trocasAceitas).toBe(1);
  expect(oidc.provedor.chamadas).toEqual(
    expect.arrayContaining([
      `GET /${TENANT}/oauth2/v2.0/authorize`,
      `POST /${TENANT}/oauth2/v2.0/token`,
      `GET /${TENANT}/discovery/v2.0/keys`,
    ]),
  );
  // Auditoria sem token, código nem segredo.
  expect(oidc.eventos).toContainEqual(
    expect.objectContaining({ evento: 'login_concluido', papeis: ['revisor'] }),
  );
  const auditoria = JSON.stringify(oidc.eventos);
  expect(auditoria).not.toContain(oidc.provedor.segredo);
  expect(auditoria).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
});

test('acesso negado: grupo não mapeado (e app role com nome de papel) não abre sessão', async ({
  page,
  oidc,
}) => {
  oidc.provedor.proximoLogin({
    claims: { groups: [GRUPO_NAO_MAPEADO, 'administradorGia'], roles: ['administradorGia'] },
  });
  await entrarComMicrosoft(page, oidc.url);

  await expect(page).toHaveURL(/\/login\?erro=ACESSO_NEGADO$/);
  const alerta = page.getByRole('alert');
  await expect(alerta).toContainText('Acesso negado');
  await expect(page.getByRole('link', { name: 'Entrar com Microsoft' })).toBeVisible();
  expect((await sessaoAtual(page)).status).toBe(401);
  expect(oidc.eventos).toContainEqual(
    expect.objectContaining({ evento: 'login_recusado', codigo: 'ACESSO_NEGADO' }),
  );
});

test('logout: encerra a sessão local e não segue para um logout fora do Entra ID', async ({
  page,
  oidc,
}) => {
  oidc.provedor.proximoLogin({ claims: { groups: [GRUPO_REVISORES] } });
  await entrarComMicrosoft(page, oidc.url);
  await expect(page.getByRole('heading', { name: 'Painel de chamados' })).toBeVisible();

  const saida = page.waitForResponse((r) => r.url().endsWith('/api/sessao/oidc/sair'));
  await page.getByRole('button', { name: 'Sair' }).first().click();
  const resposta = await saida;
  expect(resposta.status()).toBe(200);
  // A API indica o logout do provedor configurado...
  const { redirecionarPara } = (await resposta.json()) as { redirecionarPara: string };
  expect(redirecionarPara.startsWith(`${oidc.provedor.url}/${TENANT}/oauth2/v2.0/logout`)).toBe(
    true,
  );
  // ...mas a interface só segue para o Entra ID: aqui fica no login do GIA.
  await expect(page.getByRole('link', { name: 'Entrar com Microsoft' })).toBeVisible();
  expect(new URL(page.url()).origin).toBe(oidc.url);
  expect(oidc.provedor.chamadas).not.toContain(`GET /${TENANT}/oauth2/v2.0/logout`);
  // A sessão caiu no servidor: o cookie antigo não vale mais.
  expect((await sessaoAtual(page)).status).toBe(401);
  await page.goto(`${oidc.url}/`);
  await expect(page).toHaveURL(/\/login/);
  expect(oidc.eventos).toContainEqual(expect.objectContaining({ evento: 'logout' }));
});

const DEFEITOS: readonly DefeitoToken[] = [
  'nonceDeOutroLogin',
  'audienciaErrada',
  'emissorErrado',
  'tenantErrado',
  'expirado',
  'assinadoPorOutraChave',
];

for (const defeito of DEFEITOS) {
  test(`claims inválidos (${defeito}): token recusado, sem sessão e com mensagem própria`, async ({
    page,
    oidc,
  }) => {
    // O usuário tem papel: a recusa vem só do defeito no ID token.
    oidc.provedor.proximoLogin({ claims: { groups: [GRUPO_REVISORES] }, defeito });
    await entrarComMicrosoft(page, oidc.url);

    await expect(page).toHaveURL(/\/login\?erro=LOGIN_TOKEN_INVALIDO$/);
    await expect(page.getByRole('alert')).toContainText('confirmar sua identidade');
    expect((await sessaoAtual(page)).status).toBe(401);
    expect(oidc.provedor.trocasAceitas).toBe(1);
    expect(oidc.eventos).toContainEqual(
      expect.objectContaining({ evento: 'login_recusado', codigo: 'LOGIN_TOKEN_INVALIDO' }),
    );
    expect(oidc.eventos).not.toContainEqual(expect.objectContaining({ evento: 'login_concluido' }));
  });
}

test('estado de outro navegador: retorno sem o cookie de estado é recusado', async ({
  page,
  oidc,
}) => {
  // Um retorno forjado (código e state que este navegador nunca pediu).
  await page.goto(`${oidc.url}/api/sessao/oidc/retorno?code=${randomUUID()}&state=${randomUUID()}`);
  await expect(page).toHaveURL(/\/login\?erro=LOGIN_ESTADO_INVALIDO$/);
  expect((await sessaoAtual(page)).status).toBe(401);
  expect(oidc.provedor.trocasAceitas).toBe(0);
});
