import type { VariaveisAmbiente } from '@gia/contratos';
import type { Sistema } from '@gia/dominio';
import { ErroFornecedor } from './erros.js';
import { NUVENS_M365 } from './m365/configuracao.js';
import { envelopeSoftexpert } from './softexpert/cliente.js';
import { CAMINHO_ADM_WS } from './softexpert/configuracao.js';

/** Limita o corpo antes do parser; não mantém erro/payload do fornecedor em evidências. */
export async function respostaLimitada(
  resposta: Response,
  sinal?: AbortSignal | null,
): Promise<Response> {
  if (!resposta.body) return resposta;
  const leitor = resposta.body.getReader();
  const partes: Uint8Array[] = [];
  let tamanho = 0;
  const cancelar = () => {
    void leitor.cancel().catch(() => undefined);
  };
  sinal?.addEventListener('abort', cancelar, { once: true });
  try {
    for (;;) {
      sinal?.throwIfAborted();
      const { done, value } = await leitor.read();
      sinal?.throwIfAborted();
      if (done) break;
      tamanho += value.length;
      if (tamanho > 2 * 1024 * 1024) {
        await leitor.cancel();
        throw new ErroFornecedor('recusado', 'PREFLIGHT_RESPOSTA_INVALIDA');
      }
      partes.push(value);
    }
  } finally {
    sinal?.removeEventListener('abort', cancelar);
    leitor.releaseLock();
  }
  return new Response(Buffer.concat(partes), {
    status: resposta.status,
    headers: resposta.headers,
  });
}

/** Defesa adicional: nem um erro futuro no smoke pode enviar uma operação de escrita. */
export function transporteSomenteLeitura(
  sistema: Sistema,
  env: VariaveisAmbiente,
  enviar: typeof fetch = globalThis.fetch,
): typeof fetch {
  return async (destino, init) => {
    const url = new URL(destino instanceof Request ? destino.url : String(destino));
    const metodo = (
      init?.method ?? (destino instanceof Request ? destino.method : 'GET')
    ).toUpperCase();
    let permitido = false;
    if (url.protocol === 'https:' && !url.username && !url.password && !url.hash) {
      if (sistema === 'jira')
        permitido =
          url.origin === new URL(env['GIA_JIRA_BASE_URL']!).origin &&
          metodo === 'GET' &&
          url.pathname.startsWith('/rest/api/3/');
      if (sistema === 'm365') {
        const hosts = NUVENS_M365[env['GIA_M365_NUVEM'] === 'usgov' ? 'usgov' : 'global'];
        permitido =
          (url.origin === hosts.graph && metodo === 'GET' && url.pathname.startsWith('/v1.0/')) ||
          (url.origin === hosts.login &&
            metodo === 'POST' &&
            url.pathname ===
              `/${encodeURIComponent(env['GIA_M365_TENANT_ID']!)}/oauth2/v2.0/token`);
      }
      if (sistema === 'docusign') {
        const host =
          env['GIA_DOCUSIGN_AMBIENTE'] === 'producao'
            ? 'account.docusign.com'
            : 'account-d.docusign.com';
        const regional =
          env['GIA_DOCUSIGN_AMBIENTE'] === 'demo'
            ? url.hostname === 'demo.docusign.net'
            : url.hostname !== 'demo.docusign.net' &&
              /^(?:[a-z0-9-]+\.)?docusign\.net$/.test(url.hostname);
        permitido =
          !url.port &&
          ((url.hostname === host &&
            ((metodo === 'POST' && url.pathname === '/oauth/token') ||
              (metodo === 'GET' && url.pathname === '/oauth/userinfo'))) ||
            (regional &&
              metodo === 'GET' &&
              url.pathname.startsWith(`/restapi/v2.1/accounts/${env['GIA_DOCUSIGN_CONTA_ID']}/`)));
      }
      if (sistema === 'softexpert')
        permitido =
          url.origin === new URL(env['GIA_SOFTEXPERT_URL']!).origin &&
          url.pathname === CAMINHO_ADM_WS &&
          metodo === 'POST' &&
          new Headers(init?.headers).get('SOAPAction') === 'urn:admin#getUserData' &&
          init?.body === envelopeSoftexpert('getUserData', [['iduser', '__gia_teste_conexao__']]);
    }
    if (!permitido) throw new ErroFornecedor('recusado', 'PREFLIGHT_ESCRITA_BLOQUEADA');
    return respostaLimitada(await enviar(destino, { ...init, redirect: 'error' }), init?.signal);
  };
}
