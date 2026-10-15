import { pathToFileURL } from 'node:url';
import { ErroConfiguracao, carregarConfiguracaoApi, type VariaveisAmbiente } from '@gia/contratos';
import { criarBanco, criarPersistenciaPostgres, VARIAVEL_URL_BANCO } from '@gia/persistencia';
import { criarJiraDoAmbiente } from '@gia/conectores';
import type { FastifyInstance } from 'fastify';
import { criarApp } from './app.js';

/**
 * Monta a API a partir do ambiente. Com `GIA_DATABASE_URL`, a persistência é
 * o PostgreSQL (o mesmo banco do worker; migrações aplicadas antes, com
 * `pnpm --filter @gia/persistencia migrar`); sem ela, a memória do processo,
 * como no desenvolvimento local. O banco é fechado junto com a API.
 */
export function criarAppDoAmbiente(env: VariaveisAmbiente = process.env): FastifyInstance {
  const config = carregarConfiguracaoApi(env);
  const jira = criarJiraDoAmbiente(env);
  const opcoesJira = jira === null ? {} : { fonteJira: jira.origem };
  const url = env[VARIAVEL_URL_BANCO];
  if (url === undefined || url.trim() === '')
    return criarApp({ ambiente: config.ambiente, ...opcoesJira });
  const db = criarBanco({ url });
  const app = criarApp({
    ambiente: config.ambiente,
    persistencia: criarPersistenciaPostgres(db),
    ...opcoesJira,
  });
  app.addHook('onClose', async () => {
    await db.destroy();
  });
  return app;
}

/** Valida a configuração antes de abrir a porta; falha com erro sanitizado se inválida. */
export async function iniciarApi(env: VariaveisAmbiente = process.env): Promise<FastifyInstance> {
  const config = carregarConfiguracaoApi(env);
  const app = criarAppDoAmbiente(env);
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
