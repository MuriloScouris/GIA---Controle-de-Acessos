import { createServer, type Server } from 'node:http';
import { RegistroMetricas, TIPO_METRICAS } from './observabilidade.js';

/**
 * Servidor só de métricas, separado da porta pública da API e ligado por
 * padrão em `127.0.0.1`: quem raspa é o agente do ambiente, não a internet.
 * Node-only (usa `node:http`): nunca reexportado pelo índice do pacote, para
 * não vazar para o bundle do navegador. Importe de `@gia/contratos/observabilidade-servidor`.
 */
export function servirMetricas(
  registro: RegistroMetricas,
  opcoes: { readonly porta: number; readonly host?: string },
): Promise<Server> {
  const servidor = createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/metrics' || req.url === '/metricas')) {
      res.writeHead(200, { 'content-type': TIPO_METRICAS, 'cache-control': 'no-store' });
      res.end(registro.exportar());
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolver, rejeitar) => {
    servidor.once('error', rejeitar);
    servidor.listen(opcoes.porta, opcoes.host ?? '127.0.0.1', () => resolver(servidor));
  });
}
