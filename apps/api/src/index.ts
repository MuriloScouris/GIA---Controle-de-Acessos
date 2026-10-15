import { pathToFileURL } from 'node:url';
import {
  ErroConfiguracao,
  resolverSegredosDeArquivo,
  servirMetricas,
  type VariaveisAmbiente,
} from '@gia/contratos';
import { criarBanco, criarPersistenciaPostgres } from '@gia/persistencia';
import type { FastifyInstance } from 'fastify';
import { criarApp } from './app.js';
import { prepararAmbienteApi, type AmbienteApi } from './producao.js';

/**
 * Monta a API a partir do ambiente. Com `GIA_DATABASE_URL`, a persistência é
 * o PostgreSQL (o mesmo banco do worker; migrações aplicadas antes, com
 * `pnpm --filter @gia/persistencia migrar`); sem ela, a memória do processo,
 * como no desenvolvimento local — nunca em produção nem com escrita real.
 * O banco é fechado junto com a API.
 */
export function criarAppDoAmbiente(
  env: VariaveisAmbiente = process.env,
  ambiente: AmbienteApi = prepararAmbienteApi(env),
): FastifyInstance {
  const comum = {
    ambiente: ambiente.config.ambiente,
    gates: ambiente.gates,
    registrador: ambiente.registrador,
    metricas: ambiente.metricas,
    versao: ambiente.versao,
  };
  if (ambiente.urlBanco === null) return criarApp(comum);
  const db = criarBanco({ url: ambiente.urlBanco });
  const app = criarApp({
    ...comum,
    persistencia: criarPersistenciaPostgres(db, { configuracao: ambiente.configuracaoSistemas }),
  });
  app.addHook('onClose', async () => {
    await db.destroy();
  });
  return app;
}

/**
 * Valida a configuração antes de abrir a porta; falha com erro sanitizado se
 * inválida. Segredos `*_ARQUIVO` (ex.: `GIA_DATABASE_URL_ARQUIVO`) são lidos do
 * cofre aqui. Com `GIA_METRICAS_PORTA`, as métricas sobem numa porta separada,
 * em loopback.
 */
export async function iniciarApi(env: VariaveisAmbiente = process.env): Promise<FastifyInstance> {
  const resolvido = await resolverSegredosDeArquivo(env);
  const ambiente = prepararAmbienteApi(resolvido);
  const app = criarAppDoAmbiente(resolvido, ambiente);
  if (ambiente.portaMetricas !== null) {
    const metricas = await servirMetricas(ambiente.metricas, { porta: ambiente.portaMetricas });
    app.addHook('onClose', async () => {
      await new Promise((resolver) => metricas.close(resolver));
    });
  }
  await app.listen({ port: ambiente.config.porta, host: '127.0.0.1' });
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
