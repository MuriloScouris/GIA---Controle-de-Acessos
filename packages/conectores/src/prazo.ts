import { AsyncLocalStorage } from 'node:async_hooks';
import { ErroFornecedor } from './erros.js';

const prazo = new AsyncLocalStorage<number>();

/** Prazo da chamada inteira do motor, incluindo paginação e autenticação. */
export function dentroDoPrazo<T>(ms: number, executar: () => Promise<T>): Promise<T> {
  return prazo.run(Date.now() + ms, executar);
}

export function exigirPrazo(): number {
  const restante = (prazo.getStore() ?? Infinity) - Date.now();
  if (restante <= 0) throw new ErroFornecedor('timeout', 'INTEGRACAO_TIMEOUT');
  return restante;
}

/** Nunca inicia outro HTTP depois de o motor desistir; cancela a chamada em voo. */
export const fetchComPrazo: typeof fetch = async (url, init) => {
  const restante = exigirPrazo();
  const signal = Number.isFinite(restante)
    ? AbortSignal.timeout(Math.max(1, Math.ceil(restante)))
    : undefined;
  const sinais = [init?.signal, signal].filter((s): s is AbortSignal => s != null);
  const resposta = await globalThis.fetch(url, {
    ...init,
    ...(sinais.length ? { signal: AbortSignal.any(sinais) } : {}),
  });
  exigirPrazo();
  return resposta;
};
