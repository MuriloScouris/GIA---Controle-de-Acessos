import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  carregarConfiguracaoAmbiente,
  ErroConfiguracao,
  type ConfiguracaoAmbiente,
  type VariaveisAmbiente,
} from '@gia/contratos';
import { criarCatalogoSimulado } from '@gia/conectores';
import { POLITICA_EXECUCAO_PADRAO } from '@gia/dominio';
import { criarBanco, criarPersistenciaPostgres, urlDoBanco } from '@gia/persistencia';
import { executarCiclo } from './ciclo.js';
import { criarExecutor } from './executor.js';

export { executarCiclo } from './ciclo.js';
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

export interface ConfiguracaoWorker extends ConfiguracaoAmbiente {
  readonly workerId: string;
  readonly intervaloMs: number;
}

/**
 * Lê e valida a configuração do worker. A escrita externa só aceita
 * `false`: os conectores são os simulados (regras 8 e 9).
 */
export function carregarConfiguracaoWorker(env: VariaveisAmbiente): ConfiguracaoWorker {
  const ambiente = carregarConfiguracaoAmbiente(env);
  const intervalo = env['GIA_WORKER_INTERVALO_MS'];
  if (intervalo !== undefined && intervalo !== '' && !/^[1-9]\d*$/.test(intervalo)) {
    throw new ErroConfiguracao(['GIA_WORKER_INTERVALO_MS']);
  }
  const workerId = env['GIA_WORKER_ID'];
  return {
    ...ambiente,
    workerId:
      workerId === undefined || workerId.trim() === ''
        ? `worker-${hostname()}-${process.pid}`
        : workerId.trim(),
    intervaloMs: intervalo === undefined || intervalo === '' ? 1_000 : Number(intervalo),
  };
}

/** Valida a configuração e descreve como o worker vai rodar. */
export function iniciar(env: VariaveisAmbiente = process.env): string {
  const config = carregarConfiguracaoWorker(env);
  return `worker pronto (${config.ambiente}, escrita externa desligada)`;
}

/** Sobe o worker sobre o PostgreSQL até `sinal` ser abortado. */
export async function executarWorker(
  env: VariaveisAmbiente,
  sinal: AbortSignal,
  registrar: (linha: string) => void = console.log,
): Promise<void> {
  const config = carregarConfiguracaoWorker(env);
  const db = criarBanco({ url: urlDoBanco(env) });
  const politica = POLITICA_EXECUCAO_PADRAO;
  try {
    const executor = criarExecutor({
      persistencia: criarPersistenciaPostgres(db),
      conectores: criarCatalogoSimulado({ timeoutChamadaMs: politica.timeoutChamadaMs }).conectores,
      politica,
      workerId: config.workerId,
      agora: () => new Date().toISOString(),
      novoId: randomUUID,
    });
    registrar(`${iniciar(env)}: ${config.workerId}`);
    await executarCiclo(executor, {
      intervaloMs: config.intervaloMs,
      sinal,
      // Só contagens: nada de dado pessoal ou parâmetro no log.
      aoTerminarLote: (r) => {
        if (r.reservadas + r.recuperadas.reagendadas + r.recuperadas.paraReconciliacao === 0)
          return;
        const contar = (tipo: string) => r.desfechos.filter((d) => d.tipo === tipo).length;
        registrar(
          `lote: ${r.reservadas} reservadas, ${contar('registrada')} registradas, ` +
            `${contar('descartada')} descartadas, ${contar('naoGravada')} não gravadas, ` +
            `${r.recuperadas.reagendadas} reagendadas e ` +
            `${r.recuperadas.paraReconciliacao} para reconciliação por lease vencido`,
        );
      },
      aoFalhar: (erro) => registrar(`lote falhou: ${erro instanceof Error ? erro.name : 'erro'}`),
    });
  } finally {
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
