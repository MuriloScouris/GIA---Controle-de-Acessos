import { describe, expect, it } from 'vitest';
import { executarCiclo } from './ciclo.js';
import type { Executor, RelatorioLote } from './executor.js';

function relatorio(reservadas: number): RelatorioLote {
  return { recuperadas: { reagendadas: 0, paraReconciliacao: 0 }, reservadas, desfechos: [] };
}

describe('ciclo do worker', () => {
  it('processa lotes seguidos enquanto há trabalho e para quando o sinal é abortado', async () => {
    const controle = new AbortController();
    const filas = [3, 2, 0, 0];
    let lotes = 0;
    const executor: Executor = {
      async processarLote() {
        lotes += 1;
        if (lotes === filas.length) controle.abort();
        return relatorio(filas[lotes - 1] ?? 0);
      },
    };
    const vistos: number[] = [];
    await executarCiclo(executor, {
      intervaloMs: 1,
      sinal: controle.signal,
      aoTerminarLote: (r) => vistos.push(r.reservadas),
    });
    expect(vistos).toEqual(filas);
  });

  it('falha num lote não derruba o worker: avisa e tenta de novo', async () => {
    const controle = new AbortController();
    let lotes = 0;
    const executor: Executor = {
      async processarLote() {
        lotes += 1;
        if (lotes === 1) throw new Error('banco indisponível');
        controle.abort();
        return relatorio(0);
      },
    };
    const falhas: unknown[] = [];
    await executarCiclo(executor, {
      intervaloMs: 1,
      sinal: controle.signal,
      aoFalhar: (erro) => falhas.push(erro),
    });
    expect(lotes).toBe(2);
    expect(falhas).toHaveLength(1);
  });

  it('abortar durante a espera encerra sem esperar o intervalo inteiro', async () => {
    const controle = new AbortController();
    const executor: Executor = {
      async processarLote() {
        setTimeout(() => controle.abort(), 5);
        return relatorio(0);
      },
    };
    const inicio = Date.now();
    await executarCiclo(executor, { intervaloMs: 60_000, sinal: controle.signal });
    expect(Date.now() - inicio).toBeLessThan(5_000);
  });
});
