import { hostname } from 'node:os';
import {
  carregarConfiguracaoAmbiente,
  ErroConfiguracao,
  type ConfiguracaoAmbiente,
  type VariaveisAmbiente,
} from '@gia/contratos';
import {
  POLITICA_EXECUCAO_PADRAO,
  SISTEMAS,
  validarPolitica,
  type PoliticaExecucao,
  type Sistema,
} from '@gia/dominio';
import type { LimitePorSistema } from '@gia/persistencia';

/**
 * Configuração do worker (ADR-0004: "todos os parâmetros serão configuração
 * validada"). Cada parâmetro da política tem uma variável; ausente, vale o
 * default do ADR. Erros citam só o nome das variáveis, nunca os valores.
 */
export const VARIAVEIS_POLITICA = {
  timeoutConexaoMs: 'GIA_EXECUCAO_TIMEOUT_CONEXAO_MS',
  timeoutChamadaMs: 'GIA_EXECUCAO_TIMEOUT_CHAMADA_MS',
  maxRetentativas: 'GIA_EXECUCAO_MAX_RETENTATIVAS',
  backoffMs: 'GIA_EXECUCAO_BACKOFF_MS',
  jitterMaximoMs: 'GIA_EXECUCAO_JITTER_MAXIMO_MS',
  duracaoLeaseMs: 'GIA_EXECUCAO_LEASE_MS',
  renovacaoLeaseMs: 'GIA_EXECUCAO_RENOVACAO_LEASE_MS',
  lotePorWorker: 'GIA_EXECUCAO_LOTE',
  esperaSincronizacaoM365Ms: 'GIA_EXECUCAO_ESPERA_M365_MS',
} as const satisfies Record<keyof PoliticaExecucao, string>;

export const VARIAVEL_LIMITE_POR_SISTEMA = 'GIA_EXECUCAO_LIMITE_POR_SISTEMA';

/** Teto conservador de operações simultâneas por destino, somando os workers. */
export const LIMITE_POR_SISTEMA_PADRAO = 5;

export interface ConfiguracaoWorker extends ConfiguracaoAmbiente {
  readonly workerId: string;
  readonly intervaloMs: number;
  readonly politica: PoliticaExecucao;
  readonly limitePorSistema: LimitePorSistema;
}

const INTEIRO = /^\d+$/;
const POSITIVO = /^[1-9]\d*$/;

function lerPolitica(env: VariaveisAmbiente, erros: Set<string>): PoliticaExecucao {
  const inteiro = (campo: Exclude<keyof PoliticaExecucao, 'backoffMs'>): number => {
    const valor = env[VARIAVEIS_POLITICA[campo]];
    if (valor === undefined || valor === '') return POLITICA_EXECUCAO_PADRAO[campo];
    if (!INTEIRO.test(valor)) erros.add(VARIAVEIS_POLITICA[campo]);
    return Number(valor);
  };
  const backoffBruto = env[VARIAVEIS_POLITICA.backoffMs];
  let backoffMs = POLITICA_EXECUCAO_PADRAO.backoffMs;
  if (backoffBruto !== undefined && backoffBruto !== '') {
    const partes = backoffBruto.split(',').map((parte) => parte.trim());
    if (partes.some((parte) => !INTEIRO.test(parte))) erros.add(VARIAVEIS_POLITICA.backoffMs);
    backoffMs = partes.map(Number);
  }
  const politica: PoliticaExecucao = {
    timeoutConexaoMs: inteiro('timeoutConexaoMs'),
    timeoutChamadaMs: inteiro('timeoutChamadaMs'),
    maxRetentativas: inteiro('maxRetentativas'),
    backoffMs,
    jitterMaximoMs: inteiro('jitterMaximoMs'),
    duracaoLeaseMs: inteiro('duracaoLeaseMs'),
    renovacaoLeaseMs: inteiro('renovacaoLeaseMs'),
    lotePorWorker: inteiro('lotePorWorker'),
    esperaSincronizacaoM365Ms: inteiro('esperaSincronizacaoM365Ms'),
  };
  if (erros.size > 0) return politica;
  const validada = validarPolitica(politica);
  if (!validada.ok) {
    const campo = validada.erro.detalhes?.['campo'] as keyof PoliticaExecucao | undefined;
    erros.add(campo === undefined ? 'GIA_EXECUCAO' : VARIAVEIS_POLITICA[campo]);
  } else if (politica.timeoutChamadaMs >= politica.duracaoLeaseMs) {
    // Uma chamada não pode durar mais que o lease que a protege.
    erros.add(VARIAVEIS_POLITICA.timeoutChamadaMs);
  }
  return politica;
}

function lerLimites(env: VariaveisAmbiente, erros: Set<string>): LimitePorSistema {
  const todos = (n: number) =>
    Object.fromEntries(SISTEMAS.map((sistema) => [sistema, n])) as Record<Sistema, number>;
  const bruto = env[VARIAVEL_LIMITE_POR_SISTEMA]?.trim();
  if (bruto === undefined || bruto === '') return todos(LIMITE_POR_SISTEMA_PADRAO);
  if (POSITIVO.test(bruto)) return todos(Number(bruto));
  // `ad=2,m365=1`: os sistemas não citados ficam com o padrão.
  const limites = todos(LIMITE_POR_SISTEMA_PADRAO);
  for (const par of bruto.split(',')) {
    const [sistema, valor] = par.split('=').map((parte) => parte.trim());
    if (
      sistema === undefined ||
      valor === undefined ||
      !(SISTEMAS as readonly string[]).includes(sistema) ||
      !POSITIVO.test(valor)
    ) {
      erros.add(VARIAVEL_LIMITE_POR_SISTEMA);
      continue;
    }
    limites[sistema as Sistema] = Number(valor);
  }
  return limites;
}

export function carregarConfiguracaoWorker(env: VariaveisAmbiente): ConfiguracaoWorker {
  const erros = new Set<string>();
  let ambiente: ConfiguracaoAmbiente | null = null;
  try {
    ambiente = carregarConfiguracaoAmbiente(env);
  } catch (erro) {
    if (!(erro instanceof ErroConfiguracao)) throw erro;
    for (const variavel of erro.variaveis) erros.add(variavel);
  }
  const intervalo = env['GIA_WORKER_INTERVALO_MS'];
  if (intervalo !== undefined && intervalo !== '' && !POSITIVO.test(intervalo)) {
    erros.add('GIA_WORKER_INTERVALO_MS');
  }
  const politica = lerPolitica(env, erros);
  const limitePorSistema = lerLimites(env, erros);
  if (erros.size > 0 || ambiente === null) throw new ErroConfiguracao([...erros].sort());

  const workerId = env['GIA_WORKER_ID'];
  return {
    ...ambiente,
    workerId:
      workerId === undefined || workerId.trim() === ''
        ? `worker-${hostname()}-${process.pid}`
        : workerId.trim(),
    intervaloMs: intervalo === undefined || intervalo === '' ? 1_000 : Number(intervalo),
    politica,
    limitePorSistema,
  };
}
