import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  ErroConfiguracao,
  PAPEIS_HUMANOS,
  type PapelHumano,
  type VariaveisAmbiente,
} from '@gia/contratos';
import type { SessaoAutenticada } from '@gia/dominio';
import {
  createRemoteJWKSet,
  errors as errosJose,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';

/**
 * Login de produção com Entra ID (OIDC, Authorization Code + PKCE, cliente
 * confidencial). O servidor faz todo o fluxo: o navegador só vê o redirect e,
 * no fim, um cookie opaco de sessão. Nenhum token chega ao navegador nem é
 * guardado depois da validação.
 */
export const VARIAVEIS_OIDC = {
  tenantId: 'GIA_OIDC_TENANT_ID',
  clientId: 'GIA_OIDC_CLIENT_ID',
  arquivoSegredo: 'GIA_OIDC_CLIENT_SECRET_ARQUIVO',
  redirectUri: 'GIA_OIDC_REDIRECT_URI',
  posLogoutUri: 'GIA_OIDC_POS_LOGOUT_URI',
  mapaPapeis: 'GIA_OIDC_MAPA_PAPEIS',
} as const;

const AUTORIDADE = 'https://login.microsoftonline.com';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ConfiguracaoOidc {
  /** GUID do tenant: o `iss` do token é conferido exatamente contra ele. */
  readonly tenantId: string;
  readonly clientId: string;
  readonly arquivoSegredo: string;
  /** URL de retorno registrada no app (HTTPS), que cai em `/sessao/oidc/retorno`. */
  readonly redirectUri: string;
  readonly posLogoutUri: string | null;
  /**
   * Object ID de grupo de segurança (GUID, em minúsculas) → papéis humanos do
   * Gia. É a ÚNICA fonte de papel (pendência M1): nome de grupo, valor de app
   * role ou qualquer texto igual ao nome de um papel nunca concede nada.
   */
  readonly mapaPapeis: Readonly<Record<string, readonly PapelHumano[]>>;
}

function urlHttps(valor: string): boolean {
  try {
    const url = new URL(valor);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

export function carregarConfiguracaoOidc(env: VariaveisAmbiente): ConfiguracaoOidc {
  const erros = new Set<string>();
  const V = VARIAVEIS_OIDC;
  const texto = (nome: string) => env[nome]?.trim() ?? '';
  const tenantId = texto(V.tenantId);
  if (!GUID.test(tenantId)) erros.add(V.tenantId);
  const clientId = texto(V.clientId);
  if (!GUID.test(clientId)) erros.add(V.clientId);
  const arquivoSegredo = texto(V.arquivoSegredo);
  if (arquivoSegredo === '') erros.add(V.arquivoSegredo);
  const redirectUri = texto(V.redirectUri);
  if (!urlHttps(redirectUri)) erros.add(V.redirectUri);
  const posLogout = texto(V.posLogoutUri);
  if (posLogout !== '' && !urlHttps(posLogout)) erros.add(V.posLogoutUri);
  // Só `objectIdDoGrupo=papel`: chave GUID e papel humano (nunca servicoExecutor).
  // O mesmo grupo pode aparecer de novo para acumular papéis.
  const mapaPapeis: Record<string, PapelHumano[]> = {};
  for (const par of texto(V.mapaPapeis) === '' ? [] : texto(V.mapaPapeis).split(',')) {
    const [chave, papel, ...resto] = par.split('=').map((p) => p.trim());
    if (
      resto.length > 0 ||
      chave === undefined ||
      !GUID.test(chave) ||
      !(PAPEIS_HUMANOS as readonly string[]).includes(papel ?? '')
    ) {
      erros.add(V.mapaPapeis);
      continue;
    }
    const papeis = (mapaPapeis[chave.toLowerCase()] ??= []);
    if (!papeis.includes(papel as PapelHumano)) papeis.push(papel as PapelHumano);
  }
  if (erros.size > 0) throw new ErroConfiguracao([...erros].sort());
  return Object.freeze({
    tenantId: tenantId.toLowerCase(),
    clientId: clientId.toLowerCase(),
    arquivoSegredo,
    redirectUri,
    posLogoutUri: posLogout === '' ? null : posLogout,
    mapaPapeis: Object.freeze(
      Object.fromEntries(
        Object.entries(mapaPapeis).map(([grupo, papeis]) => [grupo, Object.freeze(papeis)]),
      ),
    ),
  });
}

/** Login pendente: o que liga o retorno do Entra ID ao navegador que começou o fluxo. */
export interface LoginPendente {
  readonly estado: string;
  readonly nonce: string;
  readonly verificador: string;
  readonly retorno: string;
}

/** Falha do login, com código estável para a tela e para o log. Nunca carrega o token. */
export class ErroLogin extends Error {
  constructor(
    readonly codigo:
      | 'LOGIN_ESTADO_INVALIDO'
      | 'LOGIN_RECUSADO_PELO_PROVEDOR'
      | 'LOGIN_TROCA_FALHOU'
      | 'LOGIN_TOKEN_INVALIDO'
      | 'ACESSO_NEGADO'
      | 'LOGIN_INDISPONIVEL',
  ) {
    super(codigo);
    this.name = 'ErroLogin';
  }
}

export interface DependenciasOidc {
  readonly fetch?: typeof fetch;
  /** Chaves de assinatura do Entra ID; padrão: JWKS remoto do tenant. */
  readonly chaves?: JWTVerifyGetKey;
  /** Leitura do segredo; padrão: arquivo do cofre. */
  readonly lerSegredo?: () => Promise<string>;
  readonly agora?: () => Date;
}

export interface ClienteOidc {
  /** Começa o login: devolve a URL do Entra ID e o pendente que o servidor guarda. */
  iniciar(retorno: string): { readonly url: string; readonly pendente: LoginPendente };
  /** Troca o código, valida o ID token e mapeia os papéis. */
  concluir(codigo: string, pendente: LoginPendente): Promise<SessaoAutenticada>;
  /** URL de logout do Entra ID (encerra a sessão lá também). */
  urlDeLogout(): string;
}

const base64url = (bytes: Buffer) => bytes.toString('base64url');

/**
 * Caminho de retorno depois do login: só caminho local absoluto. Recusa
 * `//host`, `/\\host`, esquemas e caracteres de controle — senão o login
 * viraria um trampolim para endereço de fora.
 */
export function retornoLocal(valor: unknown): string {
  if (typeof valor !== 'string' || valor.length === 0 || valor.length > 2_000) return '/';
  // eslint-disable-next-line no-control-regex
  if (!valor.startsWith('/') || /^\/[\\/]/.test(valor) || /[\u0000-\u001f\\]/.test(valor)) {
    return '/';
  }
  try {
    // Base fictícia: se o caminho tentar mudar de origem, ela muda e é recusado.
    const url = new URL(valor, 'https://gia.local');
    return url.origin === 'https://gia.local' ? `${url.pathname}${url.search}${url.hash}` : '/';
  } catch {
    return '/';
  }
}

/**
 * Papéis do Gia a partir dos object IDs da claim `groups` mapeados em
 * `GIA_OIDC_MAPA_PAPEIS` (sem duplicar). A claim `roles` (valores de app role)
 * e qualquer texto igual ao nome de um papel são ignorados: grupo ou app role
 * não mapeado nunca eleva privilégio.
 */
export function papeisDoToken(
  payload: JWTPayload,
  mapa: Readonly<Record<string, readonly PapelHumano[]>>,
): PapelHumano[] {
  const grupos = Array.isArray(payload['groups']) ? payload['groups'] : [];
  const papeis = new Set<PapelHumano>();
  for (const grupo of grupos) {
    if (typeof grupo !== 'string' || !GUID.test(grupo)) continue;
    // `hasOwn`: chaves herdadas do protótipo (`__proto__`, `constructor`) nunca valem.
    const chave = grupo.toLowerCase();
    if (!Object.hasOwn(mapa, chave)) continue;
    for (const papel of mapa[chave]!) papeis.add(papel);
  }
  return [...papeis].sort();
}

export function criarClienteOidc(
  config: ConfiguracaoOidc,
  dependencias: DependenciasOidc = {},
): ClienteOidc {
  const enviar = dependencias.fetch ?? fetch;
  const lerSegredo =
    dependencias.lerSegredo ??
    (async () => {
      try {
        const valor = (await readFile(config.arquivoSegredo, 'utf8')).replace(/\r?\n$/, '');
        if (valor === '' || /[\r\n]/.test(valor)) throw new Error();
        return valor;
      } catch {
        throw new ErroConfiguracao([VARIAVEIS_OIDC.arquivoSegredo]);
      }
    });
  const raiz = `${AUTORIDADE}/${config.tenantId}`;
  const emissor = `${raiz}/v2.0`;
  const chaves =
    dependencias.chaves ??
    createRemoteJWKSet(new URL(`${raiz}/discovery/v2.0/keys`), {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
    });

  return {
    iniciar(retorno) {
      const verificador = base64url(randomBytes(32));
      const pendente: LoginPendente = {
        estado: base64url(randomBytes(32)),
        nonce: base64url(randomBytes(32)),
        verificador,
        retorno: retornoLocal(retorno),
      };
      const url = new URL(`${raiz}/oauth2/v2.0/authorize`);
      url.search = new URLSearchParams({
        client_id: config.clientId,
        response_type: 'code',
        response_mode: 'query',
        redirect_uri: config.redirectUri,
        scope: 'openid profile email',
        state: pendente.estado,
        nonce: pendente.nonce,
        code_challenge: base64url(createHash('sha256').update(verificador).digest()),
        code_challenge_method: 'S256',
        prompt: 'select_account',
      }).toString();
      return { url: url.toString(), pendente };
    },

    async concluir(codigo, pendente) {
      let segredo: string;
      try {
        segredo = await lerSegredo();
      } catch {
        throw new ErroLogin('LOGIN_INDISPONIVEL');
      }
      let resposta: Response;
      try {
        resposta = await enviar(`${raiz}/oauth2/v2.0/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: config.clientId,
            client_secret: segredo,
            grant_type: 'authorization_code',
            code: codigo,
            redirect_uri: config.redirectUri,
            code_verifier: pendente.verificador,
            scope: 'openid profile email',
          }).toString(),
          signal: AbortSignal.timeout(10_000),
          redirect: 'error',
        });
      } catch {
        throw new ErroLogin('LOGIN_INDISPONIVEL');
      }
      let corpo: unknown;
      try {
        corpo = await resposta.json();
      } catch {
        corpo = null;
      }
      const idToken =
        corpo !== null && typeof corpo === 'object'
          ? (corpo as Record<string, unknown>)['id_token']
          : undefined;
      if (!resposta.ok || typeof idToken !== 'string') throw new ErroLogin('LOGIN_TROCA_FALHOU');

      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(idToken, chaves, {
          issuer: emissor,
          audience: config.clientId,
          algorithms: ['RS256'],
          clockTolerance: 120,
          requiredClaims: ['exp', 'iat', 'nonce', 'oid', 'tid'],
          ...(dependencias.agora === undefined ? {} : { currentDate: dependencias.agora() }),
        }));
      } catch (erro) {
        if (erro instanceof errosJose.JOSEError) throw new ErroLogin('LOGIN_TOKEN_INVALIDO');
        throw new ErroLogin('LOGIN_INDISPONIVEL');
      }
      // O nonce prova que este token responde a ESTE login (anti-replay).
      if (payload['nonce'] !== pendente.nonce) throw new ErroLogin('LOGIN_TOKEN_INVALIDO');
      if (String(payload['tid']).toLowerCase() !== config.tenantId) {
        throw new ErroLogin('LOGIN_TOKEN_INVALIDO');
      }
      const oid = typeof payload['oid'] === 'string' ? payload['oid'].toLowerCase() : '';
      if (!GUID.test(oid)) throw new ErroLogin('LOGIN_TOKEN_INVALIDO');
      // Grupos demais não cabem no token (overage): sem a lista não dá para autorizar.
      if (payload['_claim_names'] !== undefined && payload['groups'] === undefined) {
        throw new ErroLogin('ACESSO_NEGADO');
      }
      const papeis = papeisDoToken(payload, config.mapaPapeis);
      if (papeis.length === 0) throw new ErroLogin('ACESSO_NEGADO');
      const nome =
        (typeof payload['name'] === 'string' && payload['name'].trim()) ||
        (typeof payload['preferred_username'] === 'string' && payload['preferred_username']) ||
        'Usuário do Entra ID';
      return { usuarioId: oid, nome: nome.slice(0, 200), papeis };
    },

    urlDeLogout() {
      const url = new URL(`${raiz}/oauth2/v2.0/logout`);
      if (config.posLogoutUri !== null) {
        url.searchParams.set('post_logout_redirect_uri', config.posLogoutUri);
      }
      return url.toString();
    },
  };
}
