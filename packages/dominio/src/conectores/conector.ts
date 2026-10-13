import { sanitizarTexto } from '../comum/sanitizacao.js';
import type { Instante, Uuid } from '../comum/tipos.js';
import {
  acessosEsperados,
  normalizarAcesso,
  type Etapa,
  type ParametrosSistema,
} from '../sistemas/sistemas.js';

/**
 * Efeito de uma operação no destino:
 * - `confirmado`: o destino comprovou que tudo foi feito;
 * - `parcial`: parte das etapas foi feita (ex.: conta criada, grupo não);
 * - `semEfeito`: comprovadamente nada foi feito (falha);
 * - `desconhecido`: não dá para saber (timeout, resposta perdida). Vai para conferência.
 */
export type Efeito = 'confirmado' | 'parcial' | 'semEfeito' | 'desconhecido';

export const EFEITOS: readonly Efeito[] = ['confirmado', 'parcial', 'semEfeito', 'desconhecido'];

/** Regra 9: `simulado` nunca vira sucesso nem gera documento. */
export type ModoExecucao = 'real' | 'simulado';

/** Regra 2 — cinco operações distintas por conector. */
export type OperacaoConector =
  'testarConexao' | 'validar' | 'conferirExistencia' | 'provisionar' | 'revogar';

export const OPERACOES_CONECTOR = [
  'testarConexao',
  'validar',
  'conferirExistencia',
  'provisionar',
  'revogar',
] as const satisfies readonly OperacaoConector[];

/** Só estas escrevem no destino; as demais são leituras e nunca alteram nada. */
export const OPERACOES_DE_ESCRITA = [
  'provisionar',
  'revogar',
] as const satisfies readonly OperacaoConector[];

export function ehOperacaoDeEscrita(
  operacao: OperacaoConector,
): operacao is 'provisionar' | 'revogar' {
  return (OPERACOES_DE_ESCRITA as readonly OperacaoConector[]).includes(operacao);
}

// ---------------------------------------------------------------------------
// Resultados devolvidos pelos adaptadores (já validados na fronteira).
// ---------------------------------------------------------------------------

export interface ResultadoOperacao {
  readonly efeito: Efeito;
  readonly modo: ModoExecucao;
  /** Última etapa concluída, para retomar só o que falta. */
  readonly etapa: Etapa | null;
  /** Código estável do adaptador (ex.: `TIMEOUT`, `CONTA_AUSENTE`, `JA_REVOGADO`). */
  readonly codigo: string;
  readonly referenciaExterna: string | null;
  /** Mensagem já sanitizada pelo adaptador; o domínio sanitiza de novo. */
  readonly mensagem: string;
  /** Erro transitório: pode ser tentado de novo automaticamente, se a política permitir. */
  readonly transitorio: boolean;
  /** `Retry-After` informado pelo fornecedor, em milissegundos. */
  readonly tentarAposMs: number | null;
}

export interface ResultadoConexao {
  readonly modo: ModoExecucao;
  readonly disponivel: boolean;
  readonly codigo: string;
  readonly mensagem: string;
}

export interface Apontamento {
  readonly codigo: string;
  readonly mensagem: string;
}

/** Validar ensaia a criação e lista impedimentos e avisos, sem gravar nada no destino. */
export interface ResultadoValidacao {
  readonly modo: ModoExecucao;
  readonly impedimentos: readonly Apontamento[];
  readonly avisos: readonly Apontamento[];
}

/** Conferir existência consulta o estado atual, sem alterar o resultado registrado. */
export interface ResultadoExistencia {
  readonly modo: ModoExecucao;
  readonly contaExiste: boolean;
  /** Acessos encontrados no destino, no mesmo formato de `acessosEsperados`. */
  readonly acessosEncontrados: readonly string[];
  /**
   * Última etapa que o destino comprova como feita (ex.: AD com conta criada e
   * habilitada → `habilitarConta`), ou `null` se não comprova nenhuma. É o
   * ponto seguro de retomada após reconciliação parcial.
   */
  readonly etapaComprovada: Etapa | null;
  readonly referenciaExterna: string | null;
  readonly conferidaEm: Instante;
}

export interface ContextoItem {
  readonly operacaoId: Uuid;
  readonly itemId: Uuid;
  readonly chaveIdempotencia: string;
  readonly modo: ModoExecucao;
  readonly parametros: ParametrosSistema;
  /** Etapa a partir da qual retomar; `null` começa do início. */
  readonly etapaInicial: Etapa | null;
}

export interface ContextoRevogacao extends ContextoItem {
  readonly motivo: string;
}

/**
 * Contrato que cada adaptador (AD, M365, DocuSign, SoftExpert, Jira)
 * implementa. O domínio só define a interface; nenhuma implementação vive aqui.
 */
export interface Conector {
  testarConexao(): Promise<ResultadoConexao>;
  validar(ctx: ContextoItem): Promise<ResultadoValidacao>;
  conferirExistencia(ctx: ContextoItem): Promise<ResultadoExistencia>;
  provisionar(ctx: ContextoItem): Promise<ResultadoOperacao>;
  revogar(ctx: ContextoRevogacao): Promise<ResultadoOperacao>;
}

// ---------------------------------------------------------------------------
// Interpretação de falhas técnicas (regra 3).
// ---------------------------------------------------------------------------

export type FalhaTecnica =
  /** O tempo acabou depois de a requisição sair: o destino pode ter feito ou não. */
  | { readonly tipo: 'timeout'; readonly etapa: Etapa | null }
  /** A requisição foi enviada e a resposta se perdeu. */
  | { readonly tipo: 'respostaPerdida'; readonly etapa: Etapa | null }
  /** A conexão nem foi aberta: comprovadamente nada chegou ao destino. */
  | { readonly tipo: 'conexaoRecusada'; readonly etapa: Etapa | null }
  /** O fornecedor recusou por limite de taxa antes de processar. */
  | {
      readonly tipo: 'limiteDeTaxa';
      readonly etapa: Etapa | null;
      readonly tentarAposMs: number | null;
    };

/**
 * Regra 3 — Timeout é resultado desconhecido: nunca sucesso, nunca falha.
 * Só falhas que comprovadamente não alcançaram o destino viram `semEfeito`.
 */
export function resultadoDeFalhaTecnica(
  falha: FalhaTecnica,
  modo: ModoExecucao,
): ResultadoOperacao {
  switch (falha.tipo) {
    case 'timeout':
      return resultadoTecnico(
        'desconhecido',
        modo,
        falha.etapa,
        'TIMEOUT',
        'Tempo esgotado aguardando o destino; confira antes de tentar de novo.',
        false,
        null,
      );
    case 'respostaPerdida':
      return resultadoTecnico(
        'desconhecido',
        modo,
        falha.etapa,
        'RESPOSTA_PERDIDA',
        'A resposta do destino se perdeu; confira antes de tentar de novo.',
        false,
        null,
      );
    case 'conexaoRecusada':
      return resultadoTecnico(
        'semEfeito',
        modo,
        falha.etapa,
        'CONEXAO_RECUSADA',
        'Não foi possível conectar ao destino.',
        true,
        null,
      );
    case 'limiteDeTaxa':
      return resultadoTecnico(
        'semEfeito',
        modo,
        falha.etapa,
        'LIMITE_DE_TAXA',
        'O destino pediu para aguardar antes de nova chamada.',
        true,
        falha.tentarAposMs,
      );
  }
}

function resultadoTecnico(
  efeito: Efeito,
  modo: ModoExecucao,
  etapa: Etapa | null,
  codigo: string,
  mensagem: string,
  transitorio: boolean,
  tentarAposMs: number | null,
): ResultadoOperacao {
  return {
    efeito,
    modo,
    etapa,
    codigo,
    referenciaExterna: null,
    mensagem,
    transitorio,
    tentarAposMs,
  };
}

/** Sanitiza textos vindos do fornecedor antes de qualquer gravação (regra 12). */
export function sanitizarResultado(resultado: ResultadoOperacao): ResultadoOperacao {
  return {
    ...resultado,
    codigo: sanitizarTexto(resultado.codigo),
    mensagem: sanitizarTexto(resultado.mensagem),
    referenciaExterna:
      resultado.referenciaExterna === null ? null : sanitizarTexto(resultado.referenciaExterna),
  };
}

// ---------------------------------------------------------------------------
// Revogação (regra 5).
// ---------------------------------------------------------------------------

/** Código do adaptador para "acesso já estava revogado" (só faz sentido em `revogar`). */
export const CODIGO_JA_REVOGADO = 'JA_REVOGADO';

export interface EstadoParaRevogacao {
  readonly contaExiste: boolean;
  readonly acessoAtivo: boolean;
}

/**
 * Regra 5 — Conta ausente na revogação é falha; acesso já revogado é sucesso.
 * Devolve o resultado quando o estado atual já decide a revogação, ou `null`
 * quando ainda é preciso revogar de fato.
 */
export function interpretarEstadoParaRevogacao(
  estado: EstadoParaRevogacao,
  modo: ModoExecucao,
): ResultadoOperacao | null {
  if (!estado.contaExiste) {
    return resultadoTecnico(
      'semEfeito',
      modo,
      null,
      'CONTA_AUSENTE',
      'Conta não encontrada no destino; a revogação não pode ser comprovada.',
      false,
      null,
    );
  }
  if (!estado.acessoAtivo) {
    return resultadoTecnico(
      'confirmado',
      modo,
      null,
      CODIGO_JA_REVOGADO,
      'O acesso já estava revogado no destino.',
      false,
      null,
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Existência (regra 6).
// ---------------------------------------------------------------------------

export type SituacaoExistencia = 'ausente' | 'incompleto' | 'completo';

export interface AvaliacaoExistencia {
  readonly situacao: SituacaoExistencia;
  readonly faltantes: readonly string[];
}

/**
 * Regra 6 — Existir não é sucesso. Encontrar a conta não prova que todos os
 * acessos foram concedidos: é preciso achar cada acesso esperado.
 */
export function avaliarExistencia(
  existencia: Pick<ResultadoExistencia, 'contaExiste' | 'acessosEncontrados'>,
  parametros: ParametrosSistema,
): AvaliacaoExistencia {
  const esperados = acessosEsperados(parametros);
  if (!existencia.contaExiste) return { situacao: 'ausente', faltantes: esperados };
  const encontrados = new Set(['conta', ...existencia.acessosEncontrados.map(normalizarAcesso)]);
  const faltantes = esperados.filter((acesso) => !encontrados.has(acesso));
  return { situacao: faltantes.length === 0 ? 'completo' : 'incompleto', faltantes };
}
