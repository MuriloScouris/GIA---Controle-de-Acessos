import { pathToFileURL } from 'node:url';
import { ErroConfiguracao, carregarConfiguracaoApi, type VariaveisAmbiente } from '@gia/contratos';
import type { FastifyInstance } from 'fastify';
import { criarApp } from './app.js';

/** Valida a configuração antes de abrir a porta; falha com erro sanitizado se inválida. */
export async function iniciarApi(env: VariaveisAmbiente = process.env): Promise<FastifyInstance> {
  const config = carregarConfiguracaoApi(env);
  const app = criarApp();
  await app.listen({ port: config.porta, host: '127.0.0.1' });
  return app;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await iniciarApi();
  } catch (erro) {
    console.error(erro instanceof ErroConfiguracao ? erro.message : 'Falha ao iniciar a API');
    process.exitCode = 1;
  }
}

export { criarApp };
