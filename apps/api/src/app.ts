import Fastify, { type FastifyInstance } from 'fastify';

/** Scaffold da API: apenas verificação de saúde. Sem rotas de negócio. */
export function criarApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get('/saude', async () => ({ status: 'ok' }));
  return app;
}
