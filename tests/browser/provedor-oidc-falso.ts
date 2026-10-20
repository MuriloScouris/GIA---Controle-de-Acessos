import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/**
 * Provedor OIDC falso para os testes de navegador (DEV-303, pendência M10).
 * Imita, em `http://127.0.0.1:<porta>`, os quatro pontos do Entra ID que o GIA
 * usa: `authorize` (o navegador é redirecionado até aqui), `token` (a API troca
 * o código com PKCE e o client secret), `discovery/v2.0/keys` (JWKS para validar
 * o ID token) e `logout`. Sem rede externa e sem segredo fixo: as chaves RSA
 * são geradas a cada execução e o client secret é aleatório.
 */

/** Defeitos no ID token que a API precisa recusar. */
export type DefeitoToken =
  | 'nonceDeOutroLogin'
  | 'audienciaErrada'
  | 'emissorErrado'
  | 'tenantErrado'
  | 'expirado'
  | 'assinadoPorOutraChave';

export interface ProximoLogin {
  /** Claims do usuário que o "Entra ID" autentica (ex.: `groups`, `roles`, `name`). */
  readonly claims: Readonly<Record<string, unknown>>;
  readonly defeito?: DefeitoToken;
}

export interface ProvedorOidcFalso {
  /** Raiz do provedor (`http://127.0.0.1:<porta>`), passada à API como autoridade. */
  readonly url: string;
  readonly tenant: string;
  readonly clientId: string;
  readonly segredo: string;
  /** Usuário e defeito do próximo login autorizado. */
  proximoLogin(login: ProximoLogin): void;
  /** Caminhos chamados (sem query), para conferir o fluxo. */
  readonly chamadas: readonly string[];
  /** Trocas de código aceitas (PKCE e segredo conferidos). */
  readonly trocasAceitas: number;
  fechar(): Promise<void>;
}

interface CodigoEmitido {
  readonly nonce: string;
  readonly desafio: string;
  readonly redirectUri: string;
  readonly login: ProximoLogin;
}

const base64url = (dados: Buffer | string) => Buffer.from(dados).toString('base64url');

function assinarJwt(
  cabecalho: Record<string, unknown>,
  carga: Record<string, unknown>,
  chave: KeyObject,
): string {
  const entrada = `${base64url(JSON.stringify(cabecalho))}.${base64url(JSON.stringify(carga))}`;
  return `${entrada}.${base64url(sign('RSA-SHA256', Buffer.from(entrada), chave))}`;
}

async function corpoForm(req: IncomingMessage): Promise<URLSearchParams> {
  const partes: Buffer[] = [];
  for await (const parte of req) partes.push(Buffer.from(parte));
  return new URLSearchParams(Buffer.concat(partes).toString('utf8'));
}

function json(res: ServerResponse, status: number, corpo: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(corpo));
}

export async function subirProvedorOidcFalso(opcoes: {
  readonly tenant: string;
  readonly clientId: string;
  readonly oid: string;
}): Promise<ProvedorOidcFalso> {
  const { tenant, clientId } = opcoes;
  const segredo = base64url(randomBytes(24));
  const chave = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const outraChave = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = {
    ...chave.publicKey.export({ format: 'jwk' }),
    kid: 'chave-1',
    alg: 'RS256',
    use: 'sig',
  };
  const codigos = new Map<string, CodigoEmitido>();
  const chamadas: string[] = [];
  let trocasAceitas = 0;
  let proximo: ProximoLogin = { claims: {} };
  let url = '';

  const emitirIdToken = (emitido: CodigoEmitido): string => {
    const { claims, defeito } = emitido.login;
    const agora = Math.floor(Date.now() / 1000);
    const carga: Record<string, unknown> = {
      iss: `${url}/${tenant}/v2.0`,
      aud: clientId,
      tid: tenant,
      oid: opcoes.oid,
      nonce: emitido.nonce,
      iat: agora,
      nbf: agora,
      exp: agora + 600,
      name: 'Pessoa Corporativa Fictícia',
      ...claims,
    };
    if (defeito === 'nonceDeOutroLogin') carga['nonce'] = base64url(randomBytes(32));
    if (defeito === 'audienciaErrada') carga['aud'] = '99999999-9999-4999-8999-999999999999';
    if (defeito === 'emissorErrado')
      carga['iss'] = `https://login.microsoftonline.com/${tenant}/v2.0`;
    if (defeito === 'tenantErrado') carga['tid'] = '88888888-8888-4888-8888-888888888888';
    if (defeito === 'expirado') {
      carga['iat'] = agora - 3600;
      carga['nbf'] = agora - 3600;
      carga['exp'] = agora - 1800;
    }
    const assinante = defeito === 'assinadoPorOutraChave' ? outraChave : chave;
    return assinarJwt({ alg: 'RS256', typ: 'JWT', kid: 'chave-1' }, carga, assinante.privateKey);
  };

  const servidor = createServer((req, res) => {
    void (async () => {
      const pedido = new URL(req.url ?? '/', 'http://127.0.0.1');
      chamadas.push(`${req.method} ${pedido.pathname}`);
      const prefixo = `/${tenant}`;

      if (req.method === 'GET' && pedido.pathname === `${prefixo}/discovery/v2.0/keys`) {
        return json(res, 200, { keys: [jwk] });
      }

      if (req.method === 'GET' && pedido.pathname === `${prefixo}/oauth2/v2.0/authorize`) {
        const q = pedido.searchParams;
        const redirectUri = q.get('redirect_uri') ?? '';
        const valido =
          q.get('client_id') === clientId &&
          q.get('response_type') === 'code' &&
          (q.get('scope') ?? '').split(' ').includes('openid') &&
          q.get('code_challenge_method') === 'S256' &&
          (q.get('code_challenge') ?? '') !== '' &&
          (q.get('state') ?? '') !== '' &&
          (q.get('nonce') ?? '') !== '' &&
          redirectUri.startsWith('http://127.0.0.1:');
        if (!valido) return json(res, 400, { error: 'invalid_request' });
        const codigo = base64url(randomBytes(24));
        codigos.set(codigo, {
          nonce: q.get('nonce')!,
          desafio: q.get('code_challenge')!,
          redirectUri,
          login: proximo,
        });
        const destino = new URL(redirectUri);
        destino.searchParams.set('code', codigo);
        destino.searchParams.set('state', q.get('state')!);
        res.writeHead(302, { location: destino.toString() });
        return res.end();
      }

      if (req.method === 'POST' && pedido.pathname === `${prefixo}/oauth2/v2.0/token`) {
        const corpo = await corpoForm(req);
        const codigo = corpo.get('code') ?? '';
        const emitido = codigos.get(codigo);
        // Código de uso único: some na primeira troca, aceita ou não.
        codigos.delete(codigo);
        const verificador = corpo.get('code_verifier') ?? '';
        const pkce = base64url(createHash('sha256').update(verificador).digest());
        if (
          emitido === undefined ||
          corpo.get('grant_type') !== 'authorization_code' ||
          corpo.get('client_id') !== clientId ||
          corpo.get('client_secret') !== segredo ||
          corpo.get('redirect_uri') !== emitido.redirectUri ||
          pkce !== emitido.desafio
        ) {
          return json(res, 400, { error: 'invalid_grant' });
        }
        trocasAceitas += 1;
        return json(res, 200, { token_type: 'Bearer', id_token: emitirIdToken(emitido) });
      }

      if (req.method === 'GET' && pedido.pathname === `${prefixo}/oauth2/v2.0/logout`) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(
          '<!doctype html><title>Logout</title><p>Sessão encerrada no provedor falso.</p>',
        );
      }

      return json(res, 404, { error: 'not_found' });
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  servidor.listen(0, '127.0.0.1');
  await once(servidor, 'listening');
  const endereco = servidor.address();
  if (typeof endereco !== 'object' || endereco === null) throw new Error('Provedor sem porta');
  url = `http://127.0.0.1:${endereco.port}`;

  return {
    url,
    tenant,
    clientId,
    segredo,
    proximoLogin(login) {
      proximo = login;
    },
    get chamadas() {
      return chamadas;
    },
    get trocasAceitas() {
      return trocasAceitas;
    },
    async fechar() {
      servidor.closeAllConnections();
      await new Promise<void>((resolver) => servidor.close(() => resolver()));
    },
  };
}
