import { exigirPermissao, type AtorRegistrado, type ContextoComando } from '../autorizacao/ator.js';
import { TRANSICOES_ITEM, type ItemAcesso } from '../admissao/item-acesso.js';
import {
  exigirTransicao,
  podeTransicionar,
  type TabelaTransicoes,
} from '../comum/maquina-estados.js';
import { falha, sucesso, type Resultado } from '../comum/resultado.js';
import {
  compararInstantes,
  somarMs,
  textoPreenchido,
  type Instante,
  type Uuid,
} from '../comum/tipos.js';
import { proximaVersao } from '../comum/versao.js';
import { ehOperacaoDeEscrita, type Efeito, type ModoExecucao } from '../conectores/conector.js';
import { eventoDoGia, type Evento } from '../eventos/evento.js';
import { DEPENDENCIA_DE_SISTEMA, type Etapa, type Sistema } from '../sistemas/sistemas.js';
import type { PoliticaExecucao } from './politica.js';

/** Ações que viram operação na fila (ligadas a um item). */
export type AcaoOperacao = 'provisionar' | 'revogar' | 'validar' | 'conferirExistencia';

export type StatusOperacao =
  'pendente' | 'reservada' | 'concluida' | 'aguardandoReconciliacao' | 'reconciliada' | 'cancelada';

export const TRANSICOES_OPERACAO: TabelaTransicoes<StatusOperacao> = {
  pendente: ['reservada', 'cancelada'],
  /** `pendente` = retentativa agendada ou leitura com lease expirado. */
  reservada: ['pendente', 'concluida', 'aguardandoReconciliacao'],
  aguardandoReconciliacao: ['reconciliada'],
  concluida: [],
  reconciliada: [],
  cancelada: [],
};

/** Operações que ainda ocupam o item: não se cria outra para ele enquanto existirem. */
export const STATUS_OPERACAO_ATIVA: readonly StatusOperacao[] = [
  'pendente',
  'reservada',
  'aguardandoReconciliacao',
];

export interface Lease {
  readonly workerId: string;
  readonly reservadaEm: Instante;
  readonly expiraEm: Instante;
}

export interface Operacao {
  readonly id: Uuid;
  readonly pedidoId: Uuid;
  readonly revisaoId: Uuid;
  readonly itemId: Uuid;
  readonly sistema: Sistema;
  readonly acao: AcaoOperacao;
  /** Única; reprocessar ou reiniciar um worker nunca cria outra operação com a mesma chave. */
  readonly chaveIdempotencia: string;
  readonly modo: ModoExecucao;
  readonly status: StatusOperacao;
  readonly lease: Lease | null;
  readonly tentativas: number;
  readonly disponivelEm: Instante;
  readonly etapaInicial: Etapa | null;
  readonly etapaAlcancada: Etapa | null;
  readonly efeito: Efeito | null;
  readonly codigo: string | null;
  readonly referenciaExterna: string | null;
  readonly mensagem: string | null;
  /** Item que precisa estar confirmado antes desta operação rodar (M365 depende do AD). */
  readonly dependeDeItemId: Uuid | null;
  /** Humano que solicitou; o serviço executor age em nome dele. */
  readonly solicitadaPor: AtorRegistrado;
  readonly criadaEm: Instante;
  readonly atualizadaEm: Instante;
  readonly versao: number;
}

/**
 * Chave determinística: o mesmo pedido, revisão, item, ação e geração sempre
 * produzem a mesma chave. A geração só avança quando um humano pede nova
 * execução do item, então repetir o mesmo comando não duplica a operação.
 */
export function gerarChaveIdempotencia(dados: {
  readonly pedidoId: Uuid;
  readonly revisaoId: Uuid;
  readonly itemId: Uuid;
  readonly acao: AcaoOperacao;
  readonly modo: ModoExecucao;
  readonly geracao: number;
}): string {
  return [
    'gia',
    dados.modo,
    dados.pedidoId,
    dados.revisaoId,
    dados.itemId,
    dados.acao,
    `g${dados.geracao}`,
  ].join(':');
}

/**
 * Inserção idempotente: se já existe operação com a mesma chave, devolve a
 * existente e não cria outra.
 */
export function garantirOperacaoUnica(
  existentes: readonly Operacao[],
  nova: Operacao,
): { readonly operacao: Operacao; readonly criada: boolean } {
  const existente = existentes.find((op) => op.chaveIdempotencia === nova.chaveIdempotencia);
  return existente ? { operacao: existente, criada: false } : { operacao: nova, criada: true };
}

export function leaseExpirado(operacao: Operacao, agora: Instante): boolean {
  return operacao.lease !== null && compararInstantes(agora, operacao.lease.expiraEm) >= 0;
}

/** O worker do contexto detém um lease válido desta operação? */
export function exigirLeaseValido(operacao: Operacao, ctx: ContextoComando): Resultado<true> {
  if (operacao.status !== 'reservada') {
    return falha(
      podeTransicionar(TRANSICOES_OPERACAO, operacao.status, 'reservada')
        ? 'LEASE_INVALIDO'
        : 'OPERACAO_JA_FINALIZADA',
      { operacaoId: operacao.id, status: operacao.status },
    );
  }
  if (operacao.lease?.workerId !== ctx.ator.id || leaseExpirado(operacao, ctx.agora)) {
    return falha('LEASE_INVALIDO', { operacaoId: operacao.id });
  }
  return sucesso(true);
}

function atualizar(operacao: Operacao, mudancas: Partial<Operacao>, agora: Instante): Operacao {
  return { ...operacao, ...mudancas, atualizadaEm: agora, versao: proximaVersao(operacao) };
}

/**
 * Guarda de dependência (regra 7): a operação só roda se o item do qual
 * depende — carregado do registro, não um booleano informado — é o item
 * esperado (mesmo pedido, mesma revisão, sistema da dependência) e está
 * `confirmado` pelo Gia. `registradoManual` não basta: não comprova que a
 * identidade existe no AD nem que foi sincronizada para o Entra ID.
 */
export function exigirDependenciaConfirmada(
  operacao: Operacao,
  dependencia: ItemAcesso | null,
): Resultado<true> {
  if (operacao.dependeDeItemId === null) return sucesso(true);
  // `!dependencia` também recusa chamadas antigas que passavam só um booleano.
  if (!dependencia) {
    return falha('DEPENDENCIA_PENDENTE', {
      operacaoId: operacao.id,
      dependeDeItemId: operacao.dependeDeItemId,
    });
  }
  if (
    dependencia.id !== operacao.dependeDeItemId ||
    dependencia.pedidoId !== operacao.pedidoId ||
    dependencia.revisaoId !== operacao.revisaoId ||
    dependencia.sistema !== DEPENDENCIA_DE_SISTEMA[operacao.sistema]
  ) {
    return falha('DEPENDENCIA_INVALIDA', {
      operacaoId: operacao.id,
      dependeDeItemId: operacao.dependeDeItemId,
      itemInformadoId: dependencia.id,
    });
  }
  if (dependencia.status !== 'confirmado') {
    return falha(
      dependencia.status === 'registradoManual'
        ? 'DEPENDENCIA_NAO_COMPROVADA'
        : 'DEPENDENCIA_PENDENTE',
      {
        operacaoId: operacao.id,
        dependeDeItemId: dependencia.id,
        statusDependencia: dependencia.status,
      },
    );
  }
  return sucesso(true);
}

/**
 * Reserva com lease: dois workers nunca executam a mesma operação. Só
 * operações pendentes, já disponíveis e cuja dependência (item real) está
 * confirmada.
 */
export function reservarOperacao(
  operacao: Operacao,
  entrada: {
    /** Item do qual a operação depende, lido do registro; `null` se não houver. */
    readonly dependencia: ItemAcesso | null;
  },
  politica: PoliticaExecucao,
  ctx: ContextoComando,
): Resultado<{ readonly operacao: Operacao; readonly eventos: readonly Evento[] }> {
  const permissao = exigirPermissao(ctx.ator, 'registrarResultadoOperacao');
  if (!permissao.ok) return permissao;
  if (operacao.status !== 'pendente') {
    return falha('LEASE_INDISPONIVEL', { operacaoId: operacao.id, status: operacao.status });
  }
  if (compararInstantes(ctx.agora, operacao.disponivelEm) < 0) {
    return falha('LEASE_INDISPONIVEL', {
      operacaoId: operacao.id,
      disponivelEm: operacao.disponivelEm,
    });
  }
  const dependencia = exigirDependenciaConfirmada(operacao, entrada.dependencia);
  if (!dependencia.ok) return dependencia;
  const reservada = atualizar(
    operacao,
    {
      status: 'reservada',
      tentativas: operacao.tentativas + 1,
      lease: {
        workerId: ctx.ator.id,
        reservadaEm: ctx.agora,
        expiraEm: somarMs(ctx.agora, politica.duracaoLeaseMs),
      },
    },
    ctx.agora,
  );
  const evento = eventoDoGia(ctx, {
    tipo: 'operacaoReservada',
    sistema: operacao.sistema,
    pedidoId: operacao.pedidoId,
    operacaoId: operacao.id,
    dados: { tentativa: reservada.tentativas, modo: operacao.modo, acao: operacao.acao },
  });
  return sucesso({ operacao: reservada, eventos: [evento] });
}

export function renovarLease(
  operacao: Operacao,
  politica: PoliticaExecucao,
  ctx: ContextoComando,
): Resultado<Operacao> {
  const valido = exigirLeaseValido(operacao, ctx);
  if (!valido.ok) return valido;
  if (operacao.lease === null) return falha('LEASE_INVALIDO', { operacaoId: operacao.id });
  return sucesso(
    atualizar(
      operacao,
      { lease: { ...operacao.lease, expiraEm: somarMs(ctx.agora, politica.duracaoLeaseMs) } },
      ctx.agora,
    ),
  );
}

/**
 * Lease expirado (worker caiu ou travou). Leitura ou simulação volta para a
 * fila. Escrita real pode ter chegado ao destino: vai para reconciliação e o
 * item fica desconhecido. Nada é reenviado às cegas.
 */
export function recuperarLeaseExpirado(
  operacao: Operacao,
  item: ItemAcesso,
  ctx: ContextoComando,
): Resultado<{
  readonly operacao: Operacao;
  readonly item: ItemAcesso;
  readonly eventos: readonly Evento[];
}> {
  const permissao = exigirPermissao(ctx.ator, 'registrarResultadoOperacao');
  if (!permissao.ok) return permissao;
  if (operacao.status !== 'reservada' || !leaseExpirado(operacao, ctx.agora)) {
    return falha('LEASE_INDISPONIVEL', { operacaoId: operacao.id });
  }
  if (item.id !== operacao.itemId) return falha('ITEM_FORA_DO_PEDIDO', { itemId: item.id });

  if (!ehOperacaoDeEscrita(operacao.acao) || operacao.modo === 'simulado') {
    const devolvida = atualizar(
      operacao,
      { status: 'pendente', lease: null, disponivelEm: ctx.agora },
      ctx.agora,
    );
    const evento = eventoDoGia(ctx, {
      tipo: 'operacaoReagendada',
      sistema: operacao.sistema,
      pedidoId: operacao.pedidoId,
      operacaoId: operacao.id,
      dados: { motivo: 'leaseExpirado' },
    });
    return sucesso({ operacao: devolvida, item, eventos: [evento] });
  }

  const transicaoItem = exigirTransicao(TRANSICOES_ITEM, item.status, 'desconhecido');
  if (!transicaoItem.ok) return transicaoItem;
  const encaminhada = atualizar(
    operacao,
    {
      status: 'aguardandoReconciliacao',
      lease: null,
      efeito: 'desconhecido',
      codigo: 'LEASE_EXPIRADO',
      mensagem: 'O executor parou sem registrar o resultado; confira no destino.',
    },
    ctx.agora,
  );
  const itemDesconhecido: ItemAcesso = {
    ...item,
    status: 'desconhecido',
    mensagem: encaminhada.mensagem,
    versao: proximaVersao(item),
  };
  const evento = eventoDoGia(ctx, {
    tipo: 'operacaoEncaminhadaParaReconciliacao',
    sistema: operacao.sistema,
    pedidoId: operacao.pedidoId,
    operacaoId: operacao.id,
    antes: { statusItem: item.status },
    depois: { statusItem: itemDesconhecido.status },
    dados: { motivo: 'leaseExpirado' },
  });
  return sucesso({ operacao: encaminhada, item: itemDesconhecido, eventos: [evento] });
}

/**
 * Cancela uma operação que ainda não foi reservada e devolve o item a
 * `pendente`. Exige a ação `executarOperacoes` (executor ou Administrador do Gia).
 */
export function cancelarOperacao(
  entrada: { readonly operacao: Operacao; readonly item: ItemAcesso; readonly motivo: string },
  ctx: ContextoComando,
): Resultado<{
  readonly operacao: Operacao;
  readonly item: ItemAcesso;
  readonly eventos: readonly Evento[];
}> {
  const permissao = exigirPermissao(ctx.ator, 'executarOperacoes');
  if (!permissao.ok) return permissao;
  const { operacao, item, motivo } = entrada;
  if (item.id !== operacao.itemId) return falha('ITEM_FORA_DO_PEDIDO', { itemId: item.id });
  const transicao = exigirTransicao(TRANSICOES_OPERACAO, operacao.status, 'cancelada');
  if (!transicao.ok) return transicao;
  if (!textoPreenchido(motivo)) return falha('MOTIVO_OBRIGATORIO');

  const cancelada = atualizar(
    operacao,
    { status: 'cancelada', mensagem: motivo.trim() },
    ctx.agora,
  );
  // Operação simulada nunca alterou o item; a real o deixou em andamento.
  let itemLiberado = item;
  if (
    operacao.modo === 'real' &&
    item.ultimaOperacaoId === operacao.id &&
    item.status !== 'pendente'
  ) {
    const transicaoItem = exigirTransicao(TRANSICOES_ITEM, item.status, 'pendente');
    if (!transicaoItem.ok) return transicaoItem;
    itemLiberado = {
      ...item,
      status: 'pendente',
      mensagem: motivo.trim(),
      versao: proximaVersao(item),
    };
  }
  const evento = eventoDoGia(ctx, {
    tipo: 'operacaoResultadoRegistrado',
    sistema: operacao.sistema,
    pedidoId: operacao.pedidoId,
    operacaoId: operacao.id,
    antes: { statusOperacao: operacao.status, statusItem: item.status },
    depois: { statusOperacao: cancelada.status, statusItem: itemLiberado.status },
    dados: { motivo: motivo.trim() },
  });
  return sucesso({ operacao: cancelada, item: itemLiberado, eventos: [evento] });
}
