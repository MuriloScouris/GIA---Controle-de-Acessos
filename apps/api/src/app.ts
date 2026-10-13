import Fastify, { type FastifyInstance } from 'fastify';
import type { SaudeResposta } from '@gia/contratos';

/** Scaffold da API: apenas verificação de saúde. Sem rotas de negócio. */
export function criarApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get('/saude', async (): Promise<SaudeResposta> => ({ status: 'ok' }));
  return app;
}
