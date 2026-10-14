import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { VariaveisAmbiente } from '@gia/contratos';
import { criarCatalogoSimulado } from '@gia/conectores';
import { criarBanco, criarPersistenciaPostgres, urlDoBanco } from '@gia/persistencia';
import { executarCiclo } from './ciclo.js';
import { carregarConfiguracaoWorker } from './configuracao.js';
import { criarExecutor } from './executor.js';

export {
  carregarConfiguracaoWorker,
  LIMITE_POR_SISTEMA_PADRAO,
  VARIAVEIS_POLITICA,
  VARIAVEL_LIMITE_POR_SISTEMA,
} from './configuracao.js';
export type { ConfiguracaoWorker } from './configuracao.js';

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
  const politica = config.politica;
  try {
    const executor = criarExecutor({
      persistencia: criarPersistenciaPostgres(db),
      conectores: criarCatalogoSimulado({ timeoutChamadaMs: politica.timeoutChamadaMs }).conectores,
      politica,
      limitePorSistema: config.limitePorSistema,
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
            `${contar('naoExecutada')} não executadas (lease perdido), ` +
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
