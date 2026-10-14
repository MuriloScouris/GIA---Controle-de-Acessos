import {
  consolidarPedido,
  falha,
  criarAtorDeServico,
  etapasDe,
  proximaEtapa,
  registrarResultadoOperacao,
  type CodigoErro,
  type Conector,
  type ContextoComando,
  type ContextoItem,
  type ErroDominio,
  type Etapa,
  type Instante,
  type ItemAcesso,
  type Operacao,
  type PoliticaExecucao,
  type ResultadoOperacao,
  type Sistema,
  type Uuid,
} from '@gia/dominio';
import {
  ErroDeConcorrencia,
  recuperarLeasesExpirados,
  renovarLeaseDaOperacao,
  reservarLote,
  type RepositoriosComFila,
  type UnidadeDeTrabalho,
} from '@gia/persistencia';

/**
 * Worker de execução (ADR-0004): consome a fila com lease, chama o conector
 * do sistema e grava resultado, estado do item, eventos e consolidação do
 * pedido na mesma transação. As regras são do domínio; aqui fica só a
 * orquestração.
 *
 * Garantias:
 * - **Lease:** só executa o que reservou; renova o lease enquanto o conector
 *   trabalha; se perdeu o lease, o resultado é descartado (o domínio recusa).
 * - **Retomada:** cada ciclo começa recuperando leases vencidos (worker que
 *   caiu): leitura/simulação volta à fila; escrita real vai para
 *   reconciliação, nunca é reenviada às cegas. Uma nova tentativa começa na
 *   etapa seguinte à última comprovada.
 * - **Idempotência:** o conector recebe a chave de idempotência da operação,
 *   que não muda entre tentativas; o resultado de uma operação é registrado
 *   uma única vez (lease + controle otimista).
 */

export interface DependenciasExecutor {
  readonly persistencia: UnidadeDeTrabalho<RepositoriosComFila>;
  readonly conectores: Readonly<Record<Sistema, Conector>>;
  readonly politica: PoliticaExecucao;
  /** Identidade técnica do worker; é o dono dos leases que reservar. */
  readonly workerId: string;
  readonly agora: () => Instante;
  readonly novoId: () => Uuid;
  /** Sorteio em [0, 1) para o jitter do backoff; o domínio não sorteia. */
  readonly sortearJitter?: () => number;
  /** Agenda `tarefa` a cada `ms`; devolve o cancelamento. Padrão: `setInterval`. */
  readonly agendar?: (tarefa: () => void, ms: number) => () => void;
}

export type DesfechoOperacao =
  | { readonly tipo: 'registrada'; readonly operacao: Operacao; readonly item: ItemAcesso }
  /** O lease venceu ou mudou de dono durante a chamada: o resultado não foi gravado. */
  | { readonly tipo: 'descartada'; readonly operacaoId: Uuid; readonly erro: ErroDominio }
  /** A gravação falhou (ex.: banco indisponível); o lease vence e a retomada trata. */
  | { readonly tipo: 'naoGravada'; readonly operacaoId: Uuid; readonly causa: string };

export interface RelatorioLote {
  readonly recuperadas: { readonly reagendadas: number; readonly paraReconciliacao: number };
  readonly reservadas: number;
  readonly desfechos: readonly DesfechoOperacao[];
}

/** Ações que o worker executa no conector. Conferência e validação ficam com quem as solicitar. */
const ACOES_EXECUTAVEIS = ['provisionar', 'revogar'] as const;

const TENTATIVAS_DE_GRAVACAO = 3;

export const CODIGO_ACAO_NAO_SUPORTADA = 'ACAO_NAO_SUPORTADA_PELO_WORKER';
export const CODIGO_ERRO_NO_CONECTOR = 'ERRO_INESPERADO_NO_CONECTOR';
export const CODIGO_ETAPAS_JA_CONCLUIDAS = 'ETAPAS_JA_CONCLUIDAS';

function agendarComIntervalo(tarefa: () => void, ms: number): () => void {
  const id = setInterval(tarefa, ms);
  return () => clearInterval(id);
}

function erroDe(codigo: CodigoErro): ErroDominio {
  const recusa = falha(codigo);
  if (recusa.ok) throw new Error('inalcançável');
  return recusa.erro;
}

function descrever(erro: unknown): string {
  return erro instanceof Error ? erro.name : 'erro desconhecido';
}

export interface Executor {
  /** Um ciclo: recupera leases vencidos, reserva um lote e executa cada operação. */
  processarLote(): Promise<RelatorioLote>;
}

export function criarExecutor(deps: DependenciasExecutor): Executor {
  const agendar = deps.agendar ?? agendarComIntervalo;
  const sortear = deps.sortearJitter ?? Math.random;

  /** Contexto do serviço executor; age em nome de quem solicitou a operação. */
  function contexto(emNomeDe: Uuid | null, correlacaoId: string): ContextoComando {
    return {
      ator: criarAtorDeServico({ id: deps.workerId, nome: 'Serviço executor' }, emNomeDe),
      agora: deps.agora(),
      correlacaoId,
      novoId: deps.novoId,
    };
  }

  /** Etapa de onde esta tentativa começa: a seguinte à última comprovada. */
  function etapaDeRetomada(
    operacao: Operacao,
    acao: 'provisionar' | 'revogar',
  ): { readonly inicio: Etapa | null; readonly concluidas: boolean } {
    if (operacao.etapaAlcancada === null)
      return { inicio: operacao.etapaInicial, concluidas: false };
    const proxima = proximaEtapa(operacao.sistema, acao, operacao.etapaAlcancada);
    return { inicio: proxima, concluidas: proxima === null };
  }

  function resultadoSemChamada(
    operacao: Operacao,
    efeito: ResultadoOperacao['efeito'],
    codigo: string,
    mensagem: string,
    etapa: Etapa | null = null,
  ): ResultadoOperacao {
    return {
      efeito,
      modo: operacao.modo,
      etapa,
      codigo,
      referenciaExterna: operacao.referenciaExterna,
      mensagem,
      transitorio: false,
      tentarAposMs: null,
    };
  }

  async function chamarConector(operacao: Operacao, item: ItemAcesso): Promise<ResultadoOperacao> {
    const acao = operacao.acao;
    if (!(ACOES_EXECUTAVEIS as readonly string[]).includes(acao)) {
      return resultadoSemChamada(
        operacao,
        'semEfeito',
        CODIGO_ACAO_NAO_SUPORTADA,
        `O worker não executa a ação ${acao}; nada foi enviado ao destino.`,
      );
    }
    const escrita = acao as 'provisionar' | 'revogar';
    const retomada = etapaDeRetomada(operacao, escrita);
    if (retomada.concluidas) {
      // Todas as etapas já foram comprovadas numa tentativa anterior: nada a reenviar.
      return resultadoSemChamada(
        operacao,
        'confirmado',
        CODIGO_ETAPAS_JA_CONCLUIDAS,
        'Todas as etapas já tinham sido concluídas numa tentativa anterior.',
        etapasDe(operacao.sistema, escrita).at(-1) ?? null,
      );
    }
    const ctxItem: ContextoItem = {
      operacaoId: operacao.id,
      itemId: item.id,
      chaveIdempotencia: operacao.chaveIdempotencia,
      modo: operacao.modo,
      parametros: item.parametros,
      etapaInicial: retomada.inicio,
    };
    const conector = deps.conectores[operacao.sistema];
    try {
      return escrita === 'provisionar'
        ? await conector.provisionar(ctxItem)
        : await conector.revogar({
            ...ctxItem,
            motivo: operacao.mensagem ?? 'Revogação solicitada no Gia.',
          });
    } catch {
      // O conector não deveria lançar; se lançou, não dá para saber o que o destino fez (regra 3).
      return resultadoSemChamada(
        operacao,
        'desconhecido',
        CODIGO_ERRO_NO_CONECTOR,
        'O conector falhou sem devolver resultado; confira no destino.',
        operacao.etapaAlcancada,
      );
    }
  }

  /** Renova o lease enquanto `trabalho` roda. */
  async function comLeaseRenovado<T>(
    operacao: Operacao,
    correlacaoId: string,
    trabalho: () => Promise<T>,
  ): Promise<T> {
    let renovando = Promise.resolve();
    const cancelar = agendar(() => {
      renovando = renovando.then(async () => {
        try {
          await renovarLeaseDaOperacao(
            deps.persistencia,
            operacao.id,
            deps.politica,
            contexto(operacao.solicitadaPor.id, correlacaoId),
          );
        } catch {
          // Falha ao renovar não interrompe a chamada; se o lease vencer, o registro é recusado.
        }
      });
    }, deps.politica.renovacaoLeaseMs);
    try {
      return await trabalho();
    } finally {
      cancelar();
      await renovando;
    }
  }

  /** Grava o resultado e consolida o pedido numa só transação. */
  async function registrar(
    operacaoId: Uuid,
    resultado: ResultadoOperacao,
    correlacaoId: string,
    emNomeDe: Uuid,
  ): Promise<DesfechoOperacao> {
    const sorteioJitter = sortear();
    for (let tentativa = 1; ; tentativa += 1) {
      try {
        return await deps.persistencia.executar(async (tx) => {
          const ctx = contexto(emNomeDe, correlacaoId);
          const operacao = await tx.fila.operacaoPorId(operacaoId);
          const item = operacao === null ? null : await tx.fila.itemPorId(operacao.itemId);
          if (operacao === null || item === null) {
            return { tipo: 'descartada', operacaoId, erro: erroDe('ITEM_FORA_DO_PEDIDO') } as const;
          }
          const registrado = registrarResultadoOperacao(
            { operacao, item, resultado, sorteioJitter },
            deps.politica,
            ctx,
          );
          if (!registrado.ok)
            return { tipo: 'descartada', operacaoId, erro: registrado.erro } as const;
          await tx.operacoes.salvar([registrado.valor.operacao]);
          await tx.itens.salvar([registrado.valor.item]);
          await tx.eventos.anexar(registrado.valor.eventos);

          const pedido = await tx.pedidos.porId(operacao.pedidoId);
          if (pedido !== null) {
            const consolidado = consolidarPedido(
              {
                pedido,
                itens: await tx.itens.doPedido(pedido.id),
                operacoes: await tx.operacoes.doPedido(pedido.id),
              },
              ctx,
            );
            // Consolidação recusada não desfaz o resultado já obtido no destino.
            if (consolidado.ok) {
              if (consolidado.valor.pedido !== pedido)
                await tx.pedidos.salvar(consolidado.valor.pedido);
              await tx.itens.salvar(consolidado.valor.itens);
              await tx.operacoes.salvar(consolidado.valor.operacoes);
              await tx.eventos.anexar(consolidado.valor.eventos);
            }
          }
          return {
            tipo: 'registrada',
            operacao: registrado.valor.operacao,
            item: registrado.valor.item,
          } as const;
        });
      } catch (erro) {
        // A API mudou o pedido no meio: relê e aplica de novo; o resultado do destino não se perde.
        if (erro instanceof ErroDeConcorrencia && tentativa < TENTATIVAS_DE_GRAVACAO) continue;
        return { tipo: 'naoGravada', operacaoId, causa: descrever(erro) };
      }
    }
  }

  async function executarOperacao(
    operacao: Operacao,
    correlacaoId: string,
  ): Promise<DesfechoOperacao> {
    const item = await deps.persistencia.executar((tx) => tx.fila.itemPorId(operacao.itemId));
    const resultado =
      item === null
        ? resultadoSemChamada(operacao, 'semEfeito', 'ITEM_INEXISTENTE', 'Item não encontrado.')
        : await comLeaseRenovado(operacao, correlacaoId, () => chamarConector(operacao, item));
    return registrar(operacao.id, resultado, correlacaoId, operacao.solicitadaPor.id);
  }

  return {
    async processarLote() {
      const correlacaoId = `worker:${deps.workerId}:${deps.novoId()}`;
      const recuperacao = await recuperarLeasesExpirados(
        deps.persistencia,
        deps.politica.lotePorWorker,
        contexto(null, correlacaoId),
      );
      const { reservadas } = await reservarLote(
        deps.persistencia,
        deps.politica,
        contexto(null, correlacaoId),
      );
      const desfechos: DesfechoOperacao[] = [];
      for (const operacao of reservadas) {
        desfechos.push(await executarOperacao(operacao, correlacaoId));
      }
      return {
        recuperadas: {
          reagendadas: recuperacao.reagendadas.length,
          paraReconciliacao: recuperacao.paraReconciliacao.length,
        },
        reservadas: reservadas.length,
        desfechos,
      };
    },
  };
}
