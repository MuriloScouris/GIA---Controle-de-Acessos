import type { Executor, RelatorioLote } from './executor.js';

export interface OpcoesCiclo {
  /** Espera entre lotes quando a fila está vazia. */
  readonly intervaloMs: number;
  /** Interrompe o ciclo; o lote em andamento termina antes. */
  readonly sinal: AbortSignal;
  readonly aoTerminarLote?: (relatorio: RelatorioLote) => void;
  readonly aoFalhar?: (erro: unknown) => void;
}

function esperar(ms: number, sinal: AbortSignal): Promise<void> {
  return new Promise((resolver) => {
    if (sinal.aborted) return resolver();
    const id = setTimeout(terminar, ms);
    function terminar(): void {
      clearTimeout(id);
      sinal.removeEventListener('abort', terminar);
      resolver();
    }
    sinal.addEventListener('abort', terminar, { once: true });
  });
}

/**
 * Laço do worker: processa lotes até a fila esvaziar e então espera o
 * intervalo. Falha num lote (ex.: banco indisponível) não derruba o worker:
 * espera e tenta de novo, e o que ficou reservado é retomado pelo lease.
 */
export async function executarCiclo(executor: Executor, opcoes: OpcoesCiclo): Promise<void> {
  while (!opcoes.sinal.aborted) {
    let houveTrabalho = false;
    try {
      const relatorio = await executor.processarLote();
      opcoes.aoTerminarLote?.(relatorio);
      houveTrabalho = relatorio.reservadas > 0;
    } catch (erro) {
      opcoes.aoFalhar?.(erro);
    }
    if (!houveTrabalho) await esperar(opcoes.intervaloMs, opcoes.sinal);
  }
}
