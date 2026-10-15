import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { VariaveisAmbiente } from '@gia/contratos';
import { criarCatalogoSimulado, type CatalogoSimulado } from '@gia/conectores';
import type { PoliticaExecucao } from '@gia/dominio';
import { criarBanco, criarPersistenciaPostgres, urlDoBanco } from '@gia/persistencia';
import { executarCiclo } from './ciclo.js';
import { carregarConfiguracaoWorker } from './configuracao.js';
import {
  comDocusignReal,
  docusignRealConfigurado,
  montarDocusignReal,
  validarDocusignReal,
} from './docusign.js';
import { criarExecutor } from './executor.js';

export {
  carregarConfiguracaoWorker,
  LIMITE_POR_SISTEMA_PADRAO,
  VARIAVEIS_POLITICA,
  VARIAVEL_LIMITE_POR_SISTEMA,
} from './configuracao.js';
export type { ConfiguracaoWorker } from './configuracao.js';

export { executarCiclo } from './ciclo.js';
export {
  CODIGO_DOCUSIGN_REAL_INDISPONIVEL,
  comDocusignReal,
  docusignRealConfigurado,
  montarDocusignReal,
  validarDocusignReal,
} from './docusign.js';
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
export function montarConectores(politica: PoliticaExecucao): CatalogoSimulado {
  return criarCatalogoSimulado({
    timeoutConexaoMs: politica.timeoutConexaoMs,
    timeoutChamadaMs: politica.timeoutChamadaMs,
  });
}

/** Valida a configuração e descreve como o worker vai rodar. */
export function iniciar(env: VariaveisAmbiente = process.env): string {
  const config = carregarConfiguracaoWorker(env);
  validarDocusignReal(env);
  const docusign = docusignRealConfigurado(env) ? ', DocuSign real configurado' : '';
  return `worker pronto (${config.ambiente}, escrita externa desligada${docusign})`;
}

/** Sobe o worker sobre o PostgreSQL até `sinal` ser abortado. */
export async function executarWorker(
  env: VariaveisAmbiente,
  sinal: AbortSignal,
  registrar: (linha: string) => void = console.log,
): Promise<void> {
  const config = carregarConfiguracaoWorker(env);
  const politica = config.politica;
  validarDocusignReal(env);
  // A chave do DocuSign é lida do cofre antes de abrir o banco: falha cedo, sem conexão órfã.
  const docusignReal = await montarDocusignReal(env, politica);
  const db = criarBanco({ url: urlDoBanco(env) });
  try {
    const executor = criarExecutor({
      persistencia: criarPersistenciaPostgres(db),
      conectores: comDocusignReal(montarConectores(politica).conectores, docusignReal),
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
