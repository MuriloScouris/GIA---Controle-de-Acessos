import { falha, sucesso, type Resultado } from '../comum/resultado.js';
import {
  ehOperacaoDeEscrita,
  type ModoExecucao,
  type OperacaoConector,
  type ResultadoOperacao,
} from '../conectores/conector.js';

/**
 * Parâmetros da fila de operações (ADR-0004). São configuração validada,
 * passada aos comandos; os valores padrão abaixo são os defaults do ADR.
 */
export interface PoliticaExecucao {
  readonly timeoutConexaoMs: number;
  readonly timeoutChamadaMs: number;
  /** Retentativas automáticas depois da primeira tentativa; só leituras e erros transitórios. */
  readonly maxRetentativas: number;
  /** Espera antes de cada retentativa (1ª, 2ª, 3ª...). */
  readonly backoffMs: readonly number[];
  readonly jitterMaximoMs: number;
  readonly duracaoLeaseMs: number;
  readonly renovacaoLeaseMs: number;
  readonly lotePorWorker: number;
  /** Intervalo para tentar de novo quando o M365 ainda não recebeu a identidade do AD. */
  readonly esperaSincronizacaoM365Ms: number;
}

export const POLITICA_EXECUCAO_PADRAO: PoliticaExecucao = Object.freeze({
  timeoutConexaoMs: 5_000,
  timeoutChamadaMs: 30_000,
  maxRetentativas: 3,
  backoffMs: Object.freeze([5_000, 15_000, 45_000]),
  jitterMaximoMs: 1_000,
  duracaoLeaseMs: 120_000,
  renovacaoLeaseMs: 30_000,
  lotePorWorker: 10,
  esperaSincronizacaoM365Ms: 300_000,
});

export function validarPolitica(politica: PoliticaExecucao): Resultado<PoliticaExecucao> {
  const inteirosPositivos: (keyof PoliticaExecucao)[] = [
    'timeoutConexaoMs',
    'timeoutChamadaMs',
    'duracaoLeaseMs',
    'renovacaoLeaseMs',
    'lotePorWorker',
    'esperaSincronizacaoM365Ms',
  ];
  for (const campo of inteirosPositivos) {
    const valor = politica[campo];
    if (typeof valor !== 'number' || !Number.isInteger(valor) || valor <= 0) {
      return falha('DADO_INVALIDO', { campo });
    }
  }
  if (!Number.isInteger(politica.maxRetentativas) || politica.maxRetentativas < 0) {
    return falha('DADO_INVALIDO', { campo: 'maxRetentativas' });
  }
  if (!Number.isInteger(politica.jitterMaximoMs) || politica.jitterMaximoMs < 0) {
    return falha('DADO_INVALIDO', { campo: 'jitterMaximoMs' });
  }
  if (
    politica.backoffMs.length < politica.maxRetentativas ||
    politica.backoffMs.some((ms) => !Number.isInteger(ms) || ms < 0)
  ) {
    return falha('DADO_INVALIDO', { campo: 'backoffMs' });
  }
  if (politica.timeoutConexaoMs > politica.timeoutChamadaMs) {
    return falha('DADO_INVALIDO', { campo: 'timeoutConexaoMs' });
  }
  if (politica.renovacaoLeaseMs >= politica.duracaoLeaseMs) {
    return falha('DADO_INVALIDO', { campo: 'renovacaoLeaseMs' });
  }
  return sucesso(politica);
}

/** Código que o adaptador do M365 devolve enquanto a identidade não chegou ao Entra ID. */
export const CODIGO_IDENTIDADE_NAO_SINCRONIZADA = 'IDENTIDADE_NAO_SINCRONIZADA';

export type ProximoPasso =
  | { readonly tipo: 'finalizar' }
  | { readonly tipo: 'retentar'; readonly aguardarMs: number }
  | { readonly tipo: 'aguardarDependencia'; readonly aguardarMs: number }
  | { readonly tipo: 'reconciliar' };

/**
 * Decide o que fazer com o resultado de uma tentativa.
 * - Escrita real com efeito desconhecido: zero retentativas; vai para
 *   reconciliação (regra 3). Nada é reenviado às cegas.
 * - Leituras e erros transitórios comprovadamente sem efeito: retentativa
 *   automática com backoff, até o limite.
 *
 * `sorteioJitter` em [0, 1) vem de fora; o domínio não sorteia.
 */
export function decidirProximoPasso(
  entrada: {
    readonly acao: OperacaoConector;
    readonly modo: ModoExecucao;
    readonly resultado: ResultadoOperacao;
    /** Tentativas já feitas, contando a atual. */
    readonly tentativas: number;
    readonly sorteioJitter?: number;
  },
  politica: PoliticaExecucao,
): ProximoPasso {
  const { acao, modo, resultado, tentativas } = entrada;
  const retentativasFeitas = Math.max(0, tentativas - 1);
  const podeRetentar = retentativasFeitas < politica.maxRetentativas;
  const espera = (): number => {
    const base = politica.backoffMs[retentativasFeitas] ?? politica.backoffMs.at(-1) ?? 0;
    const jitter = Math.floor(
      Math.min(Math.max(entrada.sorteioJitter ?? 0, 0), 0.999_999) * politica.jitterMaximoMs,
    );
    return Math.max(base + jitter, resultado.tentarAposMs ?? 0);
  };

  switch (resultado.efeito) {
    case 'confirmado':
    case 'parcial':
      return { tipo: 'finalizar' };
    case 'desconhecido':
      if (ehOperacaoDeEscrita(acao) && modo === 'real') return { tipo: 'reconciliar' };
      return !ehOperacaoDeEscrita(acao) && podeRetentar
        ? { tipo: 'retentar', aguardarMs: espera() }
        : { tipo: 'finalizar' };
    case 'semEfeito':
      if (resultado.codigo === CODIGO_IDENTIDADE_NAO_SINCRONIZADA) {
        return { tipo: 'aguardarDependencia', aguardarMs: politica.esperaSincronizacaoM365Ms };
      }
      return resultado.transitorio && podeRetentar
        ? { tipo: 'retentar', aguardarMs: espera() }
        : { tipo: 'finalizar' };
  }
}
