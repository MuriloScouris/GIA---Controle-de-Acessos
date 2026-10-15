import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  ErroConfiguracao,
  RegistroMetricas,
  carregarGatesDeEscrita,
  criarRegistrador,
  exigirSegredosForaDoAmbiente,
  liberacaoDosGates,
  nivelDeLog,
  portaDeMetricas,
  resolverSegredosDeArquivo,
  servirMetricas,
  type GatesDeEscrita,
  type VariaveisAmbiente,
} from '@gia/contratos';
import { criarCatalogoSimulado, criarJiraDoAmbiente, type CatalogoSimulado } from '@gia/conectores';
import { configuracaoPadrao, type PoliticaExecucao } from '@gia/dominio';
import { criarBanco, criarPersistenciaPostgres, urlDoBanco } from '@gia/persistencia';
import { executarCiclo } from './ciclo.js';
import { carregarConfiguracaoWorker } from './configuracao.js';
import { criarExecutor } from './executor.js';
import { aplicarGatesDeEscrita } from './gates.js';
import {
  VARIAVEL_ARQUIVO_SAUDE,
  VARIAVEL_METRICAS_PORTA,
  criarObservabilidadeWorker,
  registrarBatimento,
} from './observabilidade.js';
import { conectoresReaisDoAmbiente } from './reais.js';

export {
  carregarConfiguracaoWorker,
  LIMITE_POR_SISTEMA_PADRAO,
  VARIAVEIS_POLITICA,
  VARIAVEL_LIMITE_POR_SISTEMA,
} from './configuracao.js';
export type { ConfiguracaoWorker } from './configuracao.js';

export { executarCiclo } from './ciclo.js';
export {
  CODIGO_CONECTOR_REAL_INDISPONIVEL,
  CODIGO_ESCRITA_NAO_LIBERADA,
  ConectorRealIndisponivel,
  aplicarGatesDeEscrita,
} from './gates.js';
export type { ConectoresReais, DecisaoGate } from './gates.js';
export { registrarBatimento, verificarBatimento } from './observabilidade.js';
export type { OpcoesCiclo } from './ciclo.js';
export {
  CODIGO_ACAO_NAO_SUPORTADA,
  CODIGO_ERRO_NO_CONECTOR,
  CODIGO_ETAPAS_JA_CONCLUIDAS,
  criarExecutor,
} from './executor.js';
export type {
  DependenciasExecutor,
  DesfechoOperacao,
  Executor,
  RelatorioLote,
} from './executor.js';

/**
 * Conectores do worker com os timeouts da política configurada (ADR-0004):
 * conexão e chamada valem para todos os sistemas, não os defaults do motor.
 */
export function montarConectores(
  politica: PoliticaExecucao,
  env: VariaveisAmbiente = {},
): CatalogoSimulado {
  const catalogo = criarCatalogoSimulado({
    timeoutConexaoMs: politica.timeoutConexaoMs,
    timeoutChamadaMs: politica.timeoutChamadaMs,
  });
  const jira = criarJiraDoAmbiente(
    env,
    {},
    { timeoutConexaoMs: politica.timeoutConexaoMs, timeoutChamadaMs: politica.timeoutChamadaMs },
  );
  if (jira === null) return catalogo;
  const simulado = catalogo.conectores.jira;
  const escolher = (modo: string) => (modo === 'real' ? jira.destino : simulado);
  return {
    ...catalogo,
    jiraOrigem: jira.origem,
    conectores: {
      ...catalogo.conectores,
      jira: {
        testarConexao: () => jira.destino.testarConexao(),
        validar: (ctx) => escolher(ctx.modo).validar(ctx),
        conferirExistencia: (ctx) => escolher(ctx.modo).conferirExistencia(ctx),
        provisionar: (ctx) => escolher(ctx.modo).provisionar(ctx),
        revogar: (ctx) => escolher(ctx.modo).revogar(ctx),
      },
    },
  };
}

function descreverEscrita(gates: GatesDeEscrita): string {
  if (!gates.escritaExterna) return 'escrita externa desligada';
  const liberadas = gates.liberadas.length === 0 ? 'nenhuma liberada' : gates.liberadas.join(', ');
  return `escrita externa LIGADA: ${liberadas}`;
}

/** Valida a configuração (inclusive gates e segredos) e descreve como o worker vai rodar. */
export function iniciar(env: VariaveisAmbiente = process.env): string {
  const config = carregarConfiguracaoWorker(env);
  exigirSegredosForaDoAmbiente(env);
  const gates = carregarGatesDeEscrita(env);
  if (portaDeMetricas(env[VARIAVEL_METRICAS_PORTA]) === 'invalida') {
    throw new ErroConfiguracao([VARIAVEL_METRICAS_PORTA]);
  }
  return `worker pronto (${config.ambiente}, ${descreverEscrita(gates)})`;
}

/** Sobe o worker sobre o PostgreSQL até `sinal` ser abortado. */
export async function executarWorker(
  envOriginal: VariaveisAmbiente,
  sinal: AbortSignal,
  registrar: (linha: string) => void = console.log,
): Promise<void> {
  // Segredos por valor são checados no ambiente recebido, antes de ler os arquivos do cofre.
  const descricao = iniciar(envOriginal);
  const env = await resolverSegredosDeArquivo(envOriginal);
  const config = carregarConfiguracaoWorker(env);
  const gates = carregarGatesDeEscrita(env);
  const db = criarBanco({ url: urlDoBanco(env) });
  const politica = config.politica;
  const log = criarRegistrador({
    servico: 'worker',
    ambiente: config.ambiente,
    nivelMinimo: nivelDeLog(env['GIA_LOG_NIVEL']),
    saida: registrar,
  }).filho({ workerId: config.workerId });
  const metricas = new RegistroMetricas();
  const obs = criarObservabilidadeWorker(log, metricas);
  const reais = conectoresReaisDoAmbiente(env, politica);
  const arquivoSaude = env[VARIAVEL_ARQUIVO_SAUDE]?.trim() || null;
  const portaMetricas = portaDeMetricas(env[VARIAVEL_METRICAS_PORTA]);
  const servidorMetricas =
    typeof portaMetricas === 'number'
      ? await servirMetricas(metricas, { porta: portaMetricas })
      : null;
  const batimento = () => {
    if (arquivoSaude === null) return;
    registrarBatimento(arquivoSaude, Date.now()).catch(() => log.aviso('batimento_falhou'));
  };
  try {
    const executor = criarExecutor({
      persistencia: criarPersistenciaPostgres(db, {
        configuracao: { ...configuracaoPadrao(), liberacaoEscrita: liberacaoDosGates(gates) },
      }),
      conectores: aplicarGatesDeEscrita(
        montarConectores(politica, env).conectores,
        reais,
        gates,
        obs.aoDecidirGate,
      ),
      politica,
      limitePorSistema: config.limitePorSistema,
      workerId: config.workerId,
      agora: () => new Date().toISOString(),
      novoId: randomUUID,
    });
    // Auditoria operacional: o estado dos gates fica registrado em toda partida.
    log.info('worker_iniciado', {
      descricao,
      escritaExterna: gates.escritaExterna,
      escritaLiberada: [...gates.liberadas],
      conectoresReais: Object.keys(reais).sort(),
      metricas: servidorMetricas !== null,
      batimento: arquivoSaude !== null,
    });
    batimento();
    await executarCiclo(executor, {
      intervaloMs: config.intervaloMs,
      sinal,
      // Só identificadores, contagens e códigos: nada de dado pessoal ou parâmetro no log.
      aoTerminarLote: (r) => {
        obs.aoTerminarLote(r, Date.now());
        batimento();
      },
      aoFalhar: (erro) => {
        obs.aoFalharLote(erro);
        batimento();
      },
    });
    log.info('worker_encerrado');
  } finally {
    if (servidorMetricas !== null) {
      await new Promise((resolver) => servidorMetricas.close(resolver));
    }
    await db.destroy();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controle = new AbortController();
  for (const sinal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sinal, () => controle.abort());
  }
  executarWorker(process.env, controle.signal).catch((erro: unknown) => {
    console.error(erro instanceof Error ? erro.message : 'falha ao iniciar o worker');
    process.exitCode = 1;
  });
}
