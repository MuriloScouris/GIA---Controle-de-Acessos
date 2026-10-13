import { falha, sucesso, type Resultado } from '../comum/resultado.js';

/**
 * Papéis do Gia. `administradorGia` (ADR-0007) executa o conjunto completo de
 * ações funcionais, mas não configura segredos nem libera escrita: esses gates
 * continuam exclusivos do administrador técnico.
 */
export type Papel =
  | 'solicitante'
  | 'revisor'
  | 'executor'
  | 'auditor'
  | 'administradorTecnico'
  | 'administradorGia'
  | 'servicoExecutor';

export const PAPEIS: readonly Papel[] = [
  'solicitante',
  'revisor',
  'executor',
  'auditor',
  'administradorTecnico',
  'administradorGia',
  'servicoExecutor',
];

/** Ações funcionais, uma por linha da matriz de permissões do documento de estrutura. */
export type AcaoFuncional =
  | 'criarPedido'
  | 'acompanharPedido'
  | 'consultarDadosPessoais'
  | 'editarProposta'
  /** Aprovar, rejeitar e reabrir. */
  | 'decidirPedido'
  /** Validar, testar conexão e conferir existência. */
  | 'validarConferirTestar'
  /** Provisionar, revogar e reprocessar. */
  | 'executarOperacoes'
  | 'registrarManualReconciliar'
  | 'baixarDocumento'
  | 'consultarAuditoria'
  | 'exportarAuditoria'
  | 'consultarRegras'
  | 'alterarRegras'
  | 'configurarSegredos'
  | 'liberarEscrita'
  /** Exclusiva do serviço executor (worker): grava o resultado devolvido pelo conector. */
  | 'registrarResultadoOperacao';

export const ACOES_FUNCIONAIS: readonly AcaoFuncional[] = [
  'criarPedido',
  'acompanharPedido',
  'consultarDadosPessoais',
  'editarProposta',
  'decidirPedido',
  'validarConferirTestar',
  'executarOperacoes',
  'registrarManualReconciliar',
  'baixarDocumento',
  'consultarAuditoria',
  'exportarAuditoria',
  'consultarRegras',
  'alterarRegras',
  'configurarSegredos',
  'liberarEscrita',
  'registrarResultadoOperacao',
];

/**
 * `total`: sem restrição de escopo. `restrito`: limitado às pessoas ou áreas
 * do usuário. `proprio`: só o que o próprio usuário abriu. `leitura`: só consulta.
 * O recorte de escopo é aplicado pelo caso de uso, que conhece os dados.
 */
export type NivelAcesso = 'total' | 'restrito' | 'proprio' | 'leitura';

const ORDEM_NIVEL: Readonly<Record<NivelAcesso, number>> = {
  total: 4,
  restrito: 3,
  proprio: 2,
  leitura: 1,
};

type Matriz = Readonly<Record<Papel, Partial<Readonly<Record<AcaoFuncional, NivelAcesso>>>>>;

/** Ações que o Administrador do Gia nunca recebe (ADR-0007). */
export const ACOES_FORA_DO_ADMINISTRADOR_GIA: readonly AcaoFuncional[] = [
  'configurarSegredos',
  'liberarEscrita',
  'registrarResultadoOperacao',
];

const TOTAL_FUNCIONAL = Object.fromEntries(
  ACOES_FUNCIONAIS.filter((acao) => !ACOES_FORA_DO_ADMINISTRADOR_GIA.includes(acao)).map((acao) => [
    acao,
    'total',
  ]),
) as Partial<Record<AcaoFuncional, NivelAcesso>>;

export const MATRIZ_PERMISSOES: Matriz = {
  solicitante: {
    criarPedido: 'restrito',
    acompanharPedido: 'restrito',
    consultarDadosPessoais: 'proprio',
  },
  revisor: {
    criarPedido: 'total',
    acompanharPedido: 'total',
    consultarDadosPessoais: 'restrito',
    editarProposta: 'total',
    decidirPedido: 'total',
    validarConferirTestar: 'total',
    baixarDocumento: 'restrito',
    consultarRegras: 'total',
    alterarRegras: 'total',
  },
  executor: {
    criarPedido: 'total',
    acompanharPedido: 'total',
    consultarDadosPessoais: 'restrito',
    validarConferirTestar: 'total',
    executarOperacoes: 'total',
    registrarManualReconciliar: 'total',
    baixarDocumento: 'restrito',
  },
  auditor: {
    acompanharPedido: 'leitura',
    consultarDadosPessoais: 'restrito',
    consultarAuditoria: 'total',
    exportarAuditoria: 'total',
    consultarRegras: 'leitura',
  },
  administradorTecnico: {
    validarConferirTestar: 'total',
    consultarRegras: 'total',
    alterarRegras: 'total',
    configurarSegredos: 'total',
    liberarEscrita: 'total',
  },
  administradorGia: TOTAL_FUNCIONAL,
  servicoExecutor: {
    criarPedido: 'total',
    registrarResultadoOperacao: 'total',
  },
};

/** Ações de consulta: o nível `leitura` basta. Nas demais, `leitura` não autoriza. */
const ACOES_DE_CONSULTA: readonly AcaoFuncional[] = [
  'acompanharPedido',
  'consultarDadosPessoais',
  'consultarAuditoria',
  'consultarRegras',
];

export function ehAcaoDeConsulta(acao: AcaoFuncional): boolean {
  return ACOES_DE_CONSULTA.includes(acao);
}

/** Maior nível concedido por qualquer um dos papéis, ou `null` se nenhum concede. */
export function nivelDeAcesso(papeis: readonly Papel[], acao: AcaoFuncional): NivelAcesso | null {
  let melhor: NivelAcesso | null = null;
  for (const papel of papeis) {
    const nivel = MATRIZ_PERMISSOES[papel][acao];
    if (nivel !== undefined && (melhor === null || ORDEM_NIVEL[nivel] > ORDEM_NIVEL[melhor])) {
      melhor = nivel;
    }
  }
  return melhor;
}

export function autorizar(papeis: readonly Papel[], acao: AcaoFuncional): Resultado<NivelAcesso> {
  const nivel = nivelDeAcesso(papeis, acao);
  if (nivel === null || (nivel === 'leitura' && !ehAcaoDeConsulta(acao))) {
    return falha('PERMISSAO_NEGADA', { acao });
  }
  return sucesso(nivel);
}
