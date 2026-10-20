import { AsyncLocalStorage } from 'node:async_hooks';
import { ErroFornecedor } from './erros.js';

const prazo = new AsyncLocalStorage<number>();

/** Prazo da chamada inteira do motor, incluindo paginação e autenticação. */
export function dentroDoPrazo<T>(ms: number, executar: () => Promise<T>): Promise<T> {
  return prazo.run(Date.now() + ms, executar);
}

function restantePrazo(): number {
  return (prazo.getStore() ?? Infinity) - Date.now();
}

export function exigirPrazo(): number {
  const restante = restantePrazo();
  if (restante <= 0) throw new ErroFornecedor('timeout', 'INTEGRACAO_TIMEOUT');
  return restante;
}

/**
 * Limite de uma operação: o menor entre o seu timeout próprio e o prazo restante do motor (M4),
 * em ms inteiros e nunca abaixo de 1 (para as bibliotecas que tratam 0 como "sem timeout").
 * Prazo já vencido lança `timeout` sem enviar nada; fora de `dentroDoPrazo` vale só o timeout próprio.
 */
export function limitarAoPrazo(timeoutMs: number): number {
  return Math.max(1, Math.ceil(Math.min(timeoutMs, exigirPrazo())));
}

const METODOS_DE_LEITURA = new Set(['GET', 'HEAD', 'OPTIONS']);

function ehLeitura(entrada: Parameters<typeof fetch>[0], init?: RequestInit): boolean {
  const metodo = init?.method ?? (entrada instanceof Request ? entrada.method : 'GET');
  return METODOS_DE_LEITURA.has(metodo.toUpperCase());
}

/**
 * Nunca inicia outro HTTP depois de o motor desistir; cancela a chamada em voo.
 *
 * Resposta que chega depois do prazo (M3) não é um timeout "limpo": o destino já respondeu. Numa
 * leitura isso é só `timeout`; numa escrita a resposta é descartada, mas a escrita pode ter sido
 * feita, então vira `respostaPerdida` (efeito desconhecido, segue para reconciliação) e nunca
 * `semEfeito`. Nos dois casos o corpo é cancelado para não deixar a conexão presa.
 */
export function criarFetchComPrazo(enviar: typeof fetch): typeof fetch {
  return async (url, init) => {
    const restante = exigirPrazo();
    const signal = Number.isFinite(restante)
      ? AbortSignal.timeout(Math.max(1, Math.ceil(restante)))
      : undefined;
    const sinais = [init?.signal, signal].filter((s): s is AbortSignal => s != null);
    const resposta = await enviar(url, {
      ...init,
      ...(sinais.length ? { signal: AbortSignal.any(sinais) } : {}),
    });
    if (restantePrazo() > 0) return resposta;
    await resposta.body?.cancel().catch(() => undefined);
    throw ehLeitura(url, init)
      ? new ErroFornecedor('timeout', 'INTEGRACAO_TIMEOUT')
      : new ErroFornecedor(
          'respostaPerdida',
          'INTEGRACAO_RESPOSTA_APOS_PRAZO',
          'A resposta chegou depois do prazo; a escrita pode ter sido feita no destino.',
        );
  };
}

export const fetchComPrazo: typeof fetch = (...args) =>
  criarFetchComPrazo(globalThis.fetch)(...args);
