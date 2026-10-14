import {
  falha,
  recuperarLeaseExpirado,
  renovarLease,
  reservarOperacao,
  type ContextoComando,
  type ErroDominio,
  type Operacao,
  type PoliticaExecucao,
  type Resultado,
  type Uuid,
} from '@gia/dominio';
import type { RepositoriosComFila } from '../portas.js';
import type { UnidadeDeTrabalho } from '../unidade-de-trabalho.js';

/**
 * Lease das operações (ADR-0004) sobre a fila persistida. As regras são do
 * domínio (`reservarOperacao`, `renovarLease`, `recuperarLeaseExpirado`);
 * aqui fica só a parte transacional: ler travando, aplicar e gravar operação,
 * item e eventos na mesma transação. Executar a operação no destino é do
 * worker, fora deste pacote.
 */

export interface Recusa {
  readonly operacaoId: Uuid;
  readonly erro: ErroDominio;
}

export interface ResultadoReserva {
  readonly reservadas: readonly Operacao[];
  /** Candidatas que o domínio recusou (ex.: dependência inválida); continuam na fila. */
  readonly recusadas: readonly Recusa[];
}

/**
 * Reserva até `politica.lotePorWorker` operações para o worker do contexto.
 * Consumidores concorrentes recebem lotes disjuntos (`SKIP LOCKED`).
 */
export function reservarLote(
  persistencia: UnidadeDeTrabalho<RepositoriosComFila>,
  politica: PoliticaExecucao,
  ctx: ContextoComando,
): Promise<ResultadoReserva> {
  return persistencia.executar(async (tx) => {
    const candidatas = await tx.fila.reservaveis({
      agora: ctx.agora,
      limite: politica.lotePorWorker,
    });
    const reservadas: Operacao[] = [];
    const recusadas: Recusa[] = [];
    for (const operacao of candidatas) {
      const dependencia =
        operacao.dependeDeItemId === null
          ? null
          : await tx.fila.itemPorId(operacao.dependeDeItemId);
      const reserva = reservarOperacao(operacao, { dependencia }, politica, ctx);
      if (!reserva.ok) {
        recusadas.push({ operacaoId: operacao.id, erro: reserva.erro });
        continue;
      }
      await tx.operacoes.salvar([reserva.valor.operacao]);
      await tx.eventos.anexar(reserva.valor.eventos);
      reservadas.push(reserva.valor.operacao);
    }
    return { reservadas, recusadas };
  });
}

/**
 * Renova o lease que o worker do contexto detém. Recusa se o lease venceu ou
 * passou para outro worker; se outra transação mudou a operação no meio, a
 * gravação falha com `ErroDeConcorrencia`.
 */
export function renovarLeaseDaOperacao(
  persistencia: UnidadeDeTrabalho<RepositoriosComFila>,
  operacaoId: Uuid,
  politica: PoliticaExecucao,
  ctx: ContextoComando,
): Promise<Resultado<Operacao>> {
  return persistencia.executar(async (tx) => {
    const operacao = await tx.fila.operacaoPorId(operacaoId);
    if (operacao === null) return falha('LEASE_INVALIDO', { operacaoId });
    const renovada = renovarLease(operacao, politica, ctx);
    if (renovada.ok) await tx.operacoes.salvar([renovada.valor]);
    return renovada;
  });
}

export interface ResultadoRecuperacao {
  /** Leituras e simulações: voltaram para a fila. */
  readonly reagendadas: readonly Operacao[];
  /** Escritas reais: podem ter chegado ao destino; aguardam reconciliação. */
  readonly paraReconciliacao: readonly Operacao[];
  readonly recusadas: readonly Recusa[];
}

/** Trata até `limite` operações com lease vencido (worker caiu ou travou). */
export function recuperarLeasesExpirados(
  persistencia: UnidadeDeTrabalho<RepositoriosComFila>,
  limite: number,
  ctx: ContextoComando,
): Promise<ResultadoRecuperacao> {
  return persistencia.executar(async (tx) => {
    const vencidas = await tx.fila.comLeaseExpirado({ agora: ctx.agora, limite });
    const reagendadas: Operacao[] = [];
    const paraReconciliacao: Operacao[] = [];
    const recusadas: Recusa[] = [];
    for (const operacao of vencidas) {
      const item = await tx.fila.itemPorId(operacao.itemId);
      const recuperada =
        item === null
          ? falha<never>('ITEM_FORA_DO_PEDIDO', { itemId: operacao.itemId })
          : recuperarLeaseExpirado(operacao, item, ctx);
      if (!recuperada.ok) {
        recusadas.push({ operacaoId: operacao.id, erro: recuperada.erro });
        continue;
      }
      await tx.operacoes.salvar([recuperada.valor.operacao]);
      await tx.itens.salvar([recuperada.valor.item]);
      await tx.eventos.anexar(recuperada.valor.eventos);
      (recuperada.valor.operacao.status === 'pendente' ? reagendadas : paraReconciliacao).push(
        recuperada.valor.operacao,
      );
    }
    return { reagendadas, paraReconciliacao, recusadas };
  });
}
