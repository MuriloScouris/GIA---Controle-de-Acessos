import { createServer, type Server } from 'node:http';
import { TIPO_METRICAS, type RegistroMetricas } from './observabilidade.js';

/** Prontidão detalhada servida na porta interna: código HTTP e corpo JSON. */
export interface ProntidaoInterna {
  readonly codigo: number;
  readonly corpo: unknown;
}

/**
 * Servidor interno de observabilidade, separado da porta pública da API e
 * ligado por padrão em `127.0.0.1`: quem consulta é o agente do ambiente ou o
 * operador no host, não a internet. Serve as métricas (`/metrics`) e, se
 * `prontidao` for informada, a prontidão detalhada (`/saude/pronta`), que a
 * porta pública não expõe (pendência M7).
 * Node-only (usa `node:http`): nunca reexportado pelo índice do pacote, para
 * não vazar para o bundle do navegador. Importe de `@gia/contratos/observabilidade-servidor`.
 */
export function servirMetricas(
  registro: RegistroMetricas,
  opcoes: {
    readonly porta: number;
    readonly host?: string;
    readonly prontidao?: () => Promise<ProntidaoInterna>;
  },
): Promise<Server> {
  const servidor = createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/metrics' || req.url === '/metricas')) {
      res.writeHead(200, { 'content-type': TIPO_METRICAS, 'cache-control': 'no-store' });
      res.end(registro.exportar());
      return;
    }
    const prontidao = opcoes.prontidao;
    if (req.method === 'GET' && req.url === '/saude/pronta' && prontidao !== undefined) {
      prontidao().then(
        ({ codigo, corpo }) => {
          res.writeHead(codigo, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          });
          res.end(JSON.stringify(corpo));
        },
        // Falha ao avaliar não vaza mensagem: só indisponível.
        () => res.writeHead(503, { 'cache-control': 'no-store' }).end(),
      );
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolver, rejeitar) => {
    servidor.once('error', rejeitar);
    servidor.listen(opcoes.porta, opcoes.host ?? '127.0.0.1', () => resolver(servidor));
  });
}
