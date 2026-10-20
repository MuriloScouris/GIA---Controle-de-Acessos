import { pathToFileURL } from 'node:url';
import {
  criarJiraDoAmbiente,
  criarLeiturasDoAmbiente,
  carregarSelecaoIntegracoes,
} from '@gia/conectores';
import { ErroConfiguracao, type VariaveisAmbiente } from '@gia/contratos';
import { servirMetricas } from '@gia/contratos/observabilidade-servidor';
import { resolverSegredosDeArquivo } from '@gia/contratos/segredos';
import { criarBanco, criarPersistenciaPostgres } from '@gia/persistencia';
import type { FastifyInstance } from 'fastify';
import { exigirTlsVerificado } from '@gia/contratos';
import { criarApp } from './app.js';
import { prepararAmbienteApi, type AmbienteApi } from './producao.js';
import { autenticacaoDoAmbiente } from './sessao/autenticacao-ambiente.js';

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
  integracoes?: Awaited<ReturnType<typeof criarLeiturasDoAmbiente>>,
): FastifyInstance {
  carregarSelecaoIntegracoes(env);
  const jira = criarJiraDoAmbiente(env);
  const externo = ambiente.config.ambiente === 'producao' || ambiente.gates.escritaExterna;
  const indisponivel = async (): Promise<never> => {
    throw new Error('INTEGRACAO_REAL_INDISPONIVEL');
  };
  const fonteJira = integracoes?.jiraOrigem ?? jira?.origem;
  const comum = {
    ...(fonteJira
      ? { fonteJira }
      : externo
        ? { fonteJira: { buscarChamadosOnboarding: indisponivel } }
        : {}),
    ...(integracoes?.diretorio
      ? { diretorio: integracoes.diretorio }
      : externo
        ? { diretorio: { buscarUsos: indisponivel } }
        : {}),
    ambiente: ambiente.config.ambiente,
    gates: ambiente.gates,
    registrador: ambiente.registrador,
    metricas: ambiente.metricas,
    versao: ambiente.versao,
    // DEV-288: login OIDC em produção; sessão simulada só em desenvolvimento ou com opt-in em teste.
    autenticacao: autenticacaoDoAmbiente(env, ambiente.config.ambiente),
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
 * inválida. Em produção, verificação TLS desligada é recusada antes de tudo,
 * inclusive antes de ler o cofre. Segredos `*_ARQUIVO` (ex.:
 * `GIA_DATABASE_URL_ARQUIVO`) são lidos do cofre aqui. Com `GIA_METRICAS_PORTA`, as métricas sobem numa porta separada,
 * em loopback.
 */
export async function iniciarApi(env: VariaveisAmbiente = process.env): Promise<FastifyInstance> {
  // Nenhum segredo é aberto num processo que aceitaria qualquer certificado.
  exigirTlsVerificado(env);
  const resolvido = await resolverSegredosDeArquivo(env);
  const ambiente = prepararAmbienteApi(resolvido);
  // Valida seleção e configurações antes de abrir banco/porta. Privilégio mínimo:
  // só os segredos das leituras da API (diretório e origem Jira) são abertos;
  // conectores de escrita pertencem ao worker.
  const integracoes = await criarLeiturasDoAmbiente(resolvido);
  const app = criarAppDoAmbiente(resolvido, ambiente, integracoes);
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
