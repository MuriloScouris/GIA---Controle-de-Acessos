import { sign, type KeyObject } from 'node:crypto';
import { setTimeout as esperar } from 'node:timers/promises';
import { ErroFornecedor } from '../erros.js';
import type { ConfiguracaoDocusign } from './configuracao.js';

export type Objeto = Record<string, unknown>;

export function invalida(escrita = false): never {
  throw new ErroFornecedor(escrita ? 'respostaPerdida' : 'recusado', 'DOCUSIGN_RESPOSTA_INVALIDA');
}

export function objeto(valor: unknown): Objeto {
  if (valor === null || typeof valor !== 'object' || Array.isArray(valor)) invalida();
  return valor as Objeto;
}

export function texto(valor: unknown): string {
  if (typeof valor !== 'string' || !valor.trim()) invalida();
  return valor;
}

export function lista(valor: unknown): Objeto[] {
  if (!Array.isArray(valor)) invalida();
  return valor.map(objeto);
}

export interface SessaoDocusign {
  readonly base: string;
  readonly token: string;
  readonly expira: number;
}

/** Transporte injetável para testes; URLs públicas são fixadas/validadas pelo cliente. */
export interface DependenciasHttpDocusign {
  readonly fetch?: typeof fetch;
  readonly agora?: () => number;
}

export function criarHttpDocusign(
  config: ConfiguracaoDocusign,
  chave: KeyObject,
  dependencias: DependenciasHttpDocusign = {},
) {
  const enviar = dependencias.fetch ?? fetch;
  const agora = dependencias.agora ?? Date.now;
  const host = config.ambiente === 'producao' ? 'account.docusign.com' : 'account-d.docusign.com';
  let cache: SessaoDocusign | undefined;

  function retryApos(resposta: Response): number | null {
    const valor = resposta.headers.get('retry-after');
    if (valor === null) return null;
    const ms = /^\d+$/.test(valor) ? Number(valor) * 1000 : Date.parse(valor) - agora();
    return Number.isSafeInteger(ms) ? Math.max(0, ms) : null;
  }

  async function requisitar(
    url: string,
    init: RequestInit,
    sinal: AbortSignal,
    leitura: boolean,
    oauth = false,
  ): Promise<Objeto> {
    const tentativas = leitura ? config.tentativasLeitura : 1;
    for (let tentativa = 0; tentativa < tentativas; tentativa++) {
      try {
        sinal.throwIfAborted();
        const resposta = await enviar(url, { ...init, signal: sinal, redirect: 'error' });
        const prazo = retryApos(resposta);
        if (
          leitura &&
          (resposta.status === 429 || resposta.status >= 500) &&
          tentativa + 1 < tentativas &&
          (prazo === null || prazo < config.timeoutMs)
        ) {
          await resposta.body?.cancel();
          await esperar(prazo ?? 250 * 3 ** tentativa, undefined, { signal: sinal });
          continue;
        }
        if (!resposta.ok) {
          let erroOauth: unknown;
          if (oauth) {
            try {
              erroOauth = objeto(await resposta.json())['error'];
            } catch {
              /* Mantém o código HTTP sanitizado. */
            }
          } else await resposta.body?.cancel();
          if (resposta.status === 401) cache = undefined;
          const codigo =
            resposta.status === 401
              ? 'DOCUSIGN_AUTENTICACAO'
              : resposta.status === 403
                ? 'DOCUSIGN_PERMISSAO_INSUFICIENTE'
                : resposta.status === 429
                  ? 'DOCUSIGN_LIMITE_DE_TAXA'
                  : oauth
                    ? erroOauth === 'consent_required'
                      ? 'DOCUSIGN_CONSENTIMENTO_NECESSARIO'
                      : erroOauth === 'invalid_grant'
                        ? 'DOCUSIGN_JWT_RECUSADO'
                        : 'DOCUSIGN_OAUTH_RECUSADO'
                    : 'DOCUSIGN_HTTP_RECUSADO';
          throw new ErroFornecedor(
            resposta.status === 429
              ? 'limiteDeTaxa'
              : resposta.status >= 500 || resposta.status === 408
                ? 'respostaPerdida'
                : 'recusado',
            codigo,
            'Falha ao acessar o DocuSign.',
            prazo,
          );
        }
        let bruto: unknown;
        try {
          bruto = await resposta.json();
        } catch {
          invalida(!leitura && !oauth);
        }
        if (bruto === null || typeof bruto !== 'object' || Array.isArray(bruto))
          invalida(!leitura && !oauth);
        const dados = objeto(bruto);
        if (dados['errorDetails'] || dados['errorCode'] || dados['error'])
          throw new ErroFornecedor(
            'recusado',
            oauth ? 'DOCUSIGN_OAUTH_RECUSADO' : 'DOCUSIGN_ERRO_INTERNO',
          );
        return dados;
      } catch (erro) {
        // Prazo único: vale o do cliente (`sinal`) e também o do motor, que o fetch compartilhado
        // propaga como `TimeoutError`; nos dois casos o efeito é desconhecido, nunca "resposta perdida".
        if (sinal.aborted || (erro instanceof Error && erro.name === 'TimeoutError'))
          throw new ErroFornecedor('timeout', 'DOCUSIGN_TIMEOUT');
        if (erro instanceof ErroFornecedor) throw erro;
        // Não repetimos nem expomos mensagens do fetch: podem conter URLs e dados pessoais.
        throw new ErroFornecedor('respostaPerdida', 'DOCUSIGN_RESPOSTA_PERDIDA');
      }
    }
    return invalida();
  }

  async function sessao(sinal: AbortSignal): Promise<SessaoDocusign> {
    if (cache && cache.expira > agora() + 60_000) return cache;
    const iat = Math.floor(agora() / 1000);
    const codificar = (valor: unknown) => Buffer.from(JSON.stringify(valor)).toString('base64url');
    const conteudo = `${codificar({ alg: 'RS256', typ: 'JWT' })}.${codificar({
      iss: config.integracaoId,
      sub: config.usuarioId,
      aud: host,
      iat,
      exp: iat + 3600,
      scope: 'signature impersonation',
    })}`;
    const assertion = `${conteudo}.${sign('RSA-SHA256', Buffer.from(conteudo), chave).toString('base64url')}`;
    const inicio = agora();
    const token = await requisitar(
      `https://${host}/oauth/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }).toString(),
      },
      sinal,
      false,
      true,
    );
    const acesso = texto(token['access_token']);
    if (
      token['token_type'] !== 'Bearer' ||
      typeof token['expires_in'] !== 'number' ||
      !Number.isFinite(token['expires_in']) ||
      token['expires_in'] <= 60
    )
      invalida();
    const info = await requisitar(
      `https://${host}/oauth/userinfo`,
      {
        headers: { authorization: `Bearer ${acesso}` },
      },
      sinal,
      true,
    );
    const contas = lista(info['accounts']).filter((c) => c['account_id'] === config.contaId);
    if (contas.length !== 1) throw new ErroFornecedor('recusado', 'DOCUSIGN_CONTA_NAO_AUTORIZADA');
    let base: URL;
    try {
      base = new URL(texto(contas[0]?.['base_uri']));
    } catch {
      return invalida();
    }
    const ambienteOk =
      config.ambiente === 'demo'
        ? base.hostname === 'demo.docusign.net'
        : base.hostname !== 'demo.docusign.net' &&
          /^(?:[a-z0-9-]+\.)?docusign\.net$/.test(base.hostname);
    if (
      !ambienteOk ||
      base.protocol !== 'https:' ||
      base.port ||
      base.username ||
      base.password ||
      base.pathname !== '/' ||
      base.search ||
      base.hash
    )
      invalida();
    cache = {
      token: acesso,
      base: `${base.origin}/restapi/v2.1/accounts/${encodeURIComponent(config.contaId)}`,
      expira: inicio + token['expires_in'] * 1000,
    };
    return cache;
  }

  return {
    async chamar(
      caminho: string,
      sinal: AbortSignal,
      method = 'GET',
      body?: unknown,
    ): Promise<Objeto> {
      const credencial = await sessao(sinal);
      return requisitar(
        `${credencial.base}${caminho}`,
        {
          method,
          headers: {
            authorization: `Bearer ${credencial.token}`,
            'content-type': 'application/json',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        sinal,
        method === 'GET',
      );
    },
  };
}
