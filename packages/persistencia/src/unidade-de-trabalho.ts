/**
 * Fronteira transacional que os casos de uso enxergam: tudo o que o trabalho grava é confirmado
 * junto ou desfeito junto. Implementações: PostgreSQL (`criarPersistenciaPostgres`) e em memória.
 */
export interface UnidadeDeTrabalho<Tx> {
  executar<T>(trabalho: (tx: Tx) => Promise<T>): Promise<T>;
}

/** Fake em memória: aplica as mudanças só se o trabalho terminar sem erro (tudo ou nada). */
export function criarUnidadeDeTrabalhoEmMemoria<E>(): {
  uow: UnidadeDeTrabalho<E[]>;
  confirmados: () => readonly E[];
} {
  let confirmados: E[] = [];
  const uow: UnidadeDeTrabalho<E[]> = {
    async executar(trabalho) {
      const staging = [...confirmados];
      const resultado = await trabalho(staging);
      confirmados = staging;
      return resultado;
    },
  };
  return { uow, confirmados: () => confirmados };
}
