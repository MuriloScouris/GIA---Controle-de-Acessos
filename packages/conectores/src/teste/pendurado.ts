/**
 * Resposta que nunca chega: só termina quando o sinal aborta, como um `fetch` real preso num destino
 * mudo. Se o sinal já abortou antes de o transporte ser chamado (acontece sob carga: o prazo vence
 * durante o preparo da requisição), rejeita na hora; só escutar o evento deixaria o teste preso até
 * o timeout do vitest, porque `abort` não dispara de novo para quem chega depois.
 */
export function penduradoAteAbortar(
  sinal: AbortSignal | null | undefined,
  erro: (sinal: AbortSignal) => unknown = (s) => s.reason,
): Promise<Response> {
  return new Promise<Response>((_resolver, rejeitar) => {
    if (!sinal) return;
    if (sinal.aborted) return rejeitar(erro(sinal));
    sinal.addEventListener('abort', () => rejeitar(erro(sinal)), { once: true });
  });
}
