import { SISTEMAS } from '@gia/dominio';
import { describe, expect, it } from 'vitest';
import { criarCatalogoSimulado, type CatalogoSimulado } from './catalogo.js';

/** Todo simulador de destino demora `ms` para aceitar a conexão. */
function conexaoLenta(catalogo: CatalogoSimulado, ms: number): void {
  for (const sistema of SISTEMAS) {
    catalogo.simuladores[sistema].testar = () => new Promise((r) => setTimeout(r, ms));
  }
}

describe('catálogo simulado: timeouts da política (ADR-0004)', () => {
  it('o timeout de conexão configurado chega a todos os conectores', async () => {
    const catalogo = criarCatalogoSimulado({ timeoutConexaoMs: 50 });
    conexaoLenta(catalogo, 200);
    for (const sistema of SISTEMAS) {
      expect(await catalogo.conectores[sistema].testarConexao(), sistema).toMatchObject({
        disponivel: false,
        codigo: 'TIMEOUT',
      });
    }
  });

  it('sem configuração vale o padrão do motor (5 s): a mesma conexão lenta é aceita', async () => {
    const catalogo = criarCatalogoSimulado();
    conexaoLenta(catalogo, 200);
    for (const sistema of SISTEMAS) {
      expect(await catalogo.conectores[sistema].testarConexao(), sistema).toMatchObject({
        disponivel: true,
        codigo: 'OK',
      });
    }
  });
});
