import {
  exigirItemExecutavel,
  statusAoLiberarItem,
  statusItemPorEfeito,
  STATUS_ITEM_COM_PROBLEMA,
  STATUS_ITEM_CONCLUIDO,
  STATUS_ITEM_EM_ANDAMENTO,
  TRANSICOES_ITEM,
  type ItemAcesso,
  type StatusItem,
} from '../admissao/item-acesso.js';
import {
  TRANSICOES_PEDIDO,
  type PedidoAdmissao,
  type StatusPedido,
} from '../admissao/pedido-admissao.js';
import type { Revisao } from '../admissao/revisao.js';
import { exigirPermissao, registrarAtor, type ContextoComando } from '../autorizacao/ator.js';
import { exigirEstado, exigirTransicao } from '../comum/maquina-estados.js';
import { sanitizarTexto } from '../comum/sanitizacao.js';
import { exigirTextoLivre } from '../comum/texto-livre.js';
import { falha, sucesso, type Resultado } from '../comum/resultado.js';
import { compararInstantes, somarMs } from '../comum/tipos.js';
import { exigirVersao, proximaVersao, VERSAO_INICIAL } from '../comum/versao.js';
import {
  avaliarExistencia,
  CODIGO_JA_REVOGADO,
  sanitizarResultado,
  type AvaliacaoExistencia,
  type ModoExecucao,
  type ResultadoExistencia,
  type ResultadoOperacao,
} from '../conectores/conector.js';
import { eventoDoGia, type Evento } from '../eventos/evento.js';
import { escritaLiberada, type ConfiguracaoSistemas } from '../sistemas/configuracao.js';
import {
  DEPENDENCIA_DE_SISTEMA,
  ehEtapaDoSistema,
  etapasDe,
  ETAPAS_DE_CRIACAO_DE_USUARIO,
  proximaEtapa,
  type Etapa,
  type Sistema,
} from '../sistemas/sistemas.js';
import {
  exigirLeaseValido,
  gerarChaveIdempotencia,
  STATUS_OPERACAO_ATIVA,
  type Operacao,
} from './operacao.js';
import { decidirProximoPasso, type PoliticaExecucao, type ProximoPasso } from './politica.js';

const STATUS_PEDIDO_EXECUTAVEL: readonly StatusPedido[] = [
  'aprovado',
  'emExecucao',
  'concluidoComErros',
];

function exigirRevisaoAprovadaCorrente(pedido: PedidoAdmissao, revisao: Revisao): Resultado<true> {
  if (revisao.id !== pedido.revisaoCorrenteId || revisao.pedidoId !== pedido.id) {
    return falha('REVISAO_NAO_CORRENTE', { revisaoId: revisao.id });
  }
  return revisao.situacao === 'aprovada'
    ? sucesso(true)
    : falha('TRANSICAO_INVALIDA', { motivo: 'revisão ainda não aprovada' });
}

function exigirItemDaRevisao(item: ItemAcesso, pedido: PedidoAdmissao): Resultado<true> {
  return item.pedidoId === pedido.id && item.revisaoId === pedido.revisaoCorrenteId
    ? sucesso(true)
    : falha('ITEM_FORA_DO_PEDIDO', { itemId: item.id });
}

function mudarStatusItem(
  item: ItemAcesso,
  status: StatusItem,
  mudancas: Partial<ItemAcesso>,
): Resultado<ItemAcesso> {
  if (status !== item.status) {
    const transicao = exigirTransicao(TRANSICOES_ITEM, item.status, status);
    if (!transicao.ok) return transicao;
  }
  return sucesso({ ...item, ...mudancas, status, versao: proximaVersao(item) });
}

// ---------------------------------------------------------------------------
// Solicitar execução (provisionar todos ou alguns itens; reprocessar).
// ---------------------------------------------------------------------------

export interface ExecucaoSolicitada {
  readonly pedido: PedidoAdmissao;
  /** Itens alterados (no modo simulado, nenhum). */
  readonly itens: readonly ItemAcesso[];
  readonly operacoes: readonly Operacao[];
  readonly eventos: readonly Evento[];
}

/**
 * Grava a intenção de executar: cria uma operação por item elegível, para o
 * worker consumir. Itens confirmados nunca entram (regra 4); itens com
 * resultado desconhecido exigem conferência antes (regra 3). No modo real,
 * cada sistema precisa ter a escrita de criação liberada (regra 8). No modo
 * simulado nada muda nos itens nem no pedido (regra 9).
 */
export function solicitarExecucao(
  entrada: {
    readonly pedido: PedidoAdmissao;
    readonly revisao: Revisao;
    readonly itens: readonly ItemAcesso[];
    /** Operações já existentes dos itens, para não duplicar. */
    readonly operacoesExistentes: readonly Operacao[];
    readonly configuracao: ConfiguracaoSistemas;
    readonly modo: ModoExecucao;
    /** Itens escolhidos; ausente = todos os elegíveis. */
    readonly itemIds?: readonly string[];
  },
  versaoEsperada: number,
  ctx: ContextoComando,
): Resultado<ExecucaoSolicitada> {
  const permissao = exigirPermissao(ctx.ator, 'executarOperacoes');
  if (!permissao.ok) return permissao;
  const { pedido, revisao, modo } = entrada;
  const versao = exigirVersao(pedido, versaoEsperada);
  if (!versao.ok) return versao;
  const estado = exigirEstado(pedido.status, STATUS_PEDIDO_EXECUTAVEL);
  if (!estado.ok) return estado;
  const corrente = exigirRevisaoAprovadaCorrente(pedido, revisao);
  if (!corrente.ok) return corrente;

  const itensDaRevisao = entrada.itens.filter(
    (item) => item.revisaoId === revisao.id && item.pedidoId === pedido.id,
  );
  let candidatos: readonly ItemAcesso[];
  if (entrada.itemIds === undefined) {
    candidatos = itensDaRevisao.filter((item) => exigirItemExecutavel(item).ok);
  } else {
    const escolhidos: ItemAcesso[] = [];
    for (const id of new Set(entrada.itemIds)) {
      const item = itensDaRevisao.find((candidato) => candidato.id === id);
      if (!item) return falha('ITEM_FORA_DO_PEDIDO', { itemId: id });
      const executavel = exigirItemExecutavel(item);
      if (!executavel.ok) return executavel;
      escolhidos.push(item);
    }
    candidatos = escolhidos;
  }
  if (candidatos.length === 0) return falha('NENHUM_ITEM_ELEGIVEL');

  const ocupado = candidatos.find((item) =>
    entrada.operacoesExistentes.some(
      (op) =>
        op.itemId === item.id && op.modo === modo && STATUS_OPERACAO_ATIVA.includes(op.status),
    ),
  );
  if (ocupado) return falha('ITEM_EM_EXECUCAO', { itemId: ocupado.id });

  if (modo === 'real') {
    const bloqueados = candidatos
      .filter(
        (item) => !escritaLiberada(entrada.configuracao.liberacaoEscrita, item.sistema, 'criar'),
      )
      .map((item) => item.sistema);
    if (bloqueados.length > 0) return falha('ESCRITA_NAO_LIBERADA', { sistemas: bloqueados });
  }

  const idsNoLote = new Set(candidatos.map((item) => item.id));
  const solicitante = registrarAtor(ctx.ator);
  const operacoes: Operacao[] = [];
  const itensAlterados: ItemAcesso[] = [];

  for (const item of candidatos) {
    let dependeDeItemId: string | null = null;
    const sistemaDependencia = DEPENDENCIA_DE_SISTEMA[item.sistema];
    let aguardaDependencia = false;
    if (sistemaDependencia !== undefined) {
      const dependencia = itensDaRevisao.find((outro) => outro.sistema === sistemaDependencia);
      // Regra 7: sem item AD rastreável no pedido não há M365, nem simulado.
      if (!dependencia) {
        return falha('DEPENDENCIA_DE_SISTEMA_AUSENTE', {
          itemId: item.id,
          sistema: item.sistema,
          exige: sistemaDependencia,
        });
      }
      if (modo === 'real') {
        // Regra 7: só AD `confirmado` pelo Gia (ou no mesmo lote) libera o M365.
        // A operação sempre aponta para o item real, que a reserva confere de novo.
        if (dependencia.status === 'registradoManual') {
          return falha('DEPENDENCIA_NAO_COMPROVADA', {
            itemId: item.id,
            dependeDe: sistemaDependencia,
          });
        }
        if (dependencia.status !== 'confirmado' && !idsNoLote.has(dependencia.id)) {
          return falha('DEPENDENCIA_PENDENTE', {
            itemId: item.id,
            dependeDe: sistemaDependencia,
            statusDependencia: dependencia.status,
          });
        }
        dependeDeItemId = dependencia.id;
        aguardaDependencia = dependencia.status !== 'confirmado';
      }
    }

    const geracao = modo === 'real' ? item.geracao + 1 : item.geracao;
    const operacaoId = ctx.novoId();
    const operacao: Operacao = {
      id: operacaoId,
      pedidoId: pedido.id,
      revisaoId: revisao.id,
      itemId: item.id,
      sistema: item.sistema,
      acao: 'provisionar',
      chaveIdempotencia:
        modo === 'real'
          ? gerarChaveIdempotencia({
              pedidoId: pedido.id,
              revisaoId: revisao.id,
              itemId: item.id,
              acao: 'provisionar',
              modo,
              geracao,
            })
          : `gia:simulado:${operacaoId}`,
      modo,
      status: 'pendente',
      lease: null,
      tentativas: 0,
      disponivelEm: ctx.agora,
      // Retoma do ponto comprovado, qualquer que seja o status (parcial, falhou ou
      // pendente depois de cancelamento): etapas já feitas não são repetidas.
      etapaInicial:
        item.etapaAlcancada !== null
          ? proximaEtapa(item.sistema, 'provisionar', item.etapaAlcancada)
          : null,
      etapaAlcancada: null,
      efeito: null,
      codigo: null,
      referenciaExterna: null,
      mensagem: null,
      dependeDeItemId,
      solicitadaPor: solicitante,
      criadaEm: ctx.agora,
      atualizadaEm: ctx.agora,
      versao: VERSAO_INICIAL,
    };
    operacoes.push(operacao);

    if (modo === 'real') {
      const alterado = mudarStatusItem(
        item,
        aguardaDependencia ? 'aguardandoDependencia' : 'emExecucao',
        {
          geracao,
          ultimaOperacaoId: operacao.id,
          mensagem: null,
        },
      );
      if (!alterado.ok) return alterado;
      itensAlterados.push(alterado.valor);
    }
  }

  const pedidoAtualizado: PedidoAdmissao =
    modo === 'real'
      ? { ...pedido, status: 'emExecucao', atualizadoEm: ctx.agora, versao: proximaVersao(pedido) }
      : pedido;
  if (modo === 'real' && pedido.status !== 'emExecucao') {
    const transicao = exigirTransicao(TRANSICOES_PEDIDO, pedido.status, 'emExecucao');
    if (!transicao.ok) return transicao;
  }

  const evento = eventoDoGia(ctx, {
    tipo: modo === 'real' ? 'execucaoSolicitada' : 'simulacaoSolicitada',
    pedidoId: pedido.id,
    colaboradorId: pedido.colaboradorId,
    antes: { status: pedido.status },
    depois: { status: pedidoAtualizado.status },
    dados: {
      modo,
      operacoes: operacoes.map((op) => ({
        operacaoId: op.id,
        itemId: op.itemId,
        sistema: op.sistema,
        chaveIdempotencia: op.chaveIdempotencia,
        dependeDeItemId: op.dependeDeItemId,
      })),
    },
  });
  return sucesso({ pedido: pedidoAtualizado, itens: itensAlterados, operacoes, eventos: [evento] });
}

// ---------------------------------------------------------------------------
// Registrar o resultado devolvido pelo conector (worker).
// ---------------------------------------------------------------------------

export interface ResultadoRegistrado {
  readonly operacao: Operacao;
  readonly item: ItemAcesso;
  readonly proximoPasso: ProximoPasso;
  readonly eventos: readonly Evento[];
}

/**
 * Grava efeito, estado e evento de uma tentativa. Só o worker que detém o
 * lease registra. Resultado simulado nunca altera o item (regra 9). Timeout
 * de escrita vai para reconciliação (regra 3). Confirmado só quando a última
 * etapa foi alcançada; caso contrário é parcial (regra 6).
 */
export function registrarResultadoOperacao(
  entrada: {
    readonly operacao: Operacao;
    readonly item: ItemAcesso;
    readonly resultado: ResultadoOperacao;
    readonly sorteioJitter?: number;
  },
  politica: PoliticaExecucao,
  ctx: ContextoComando,
): Resultado<ResultadoRegistrado> {
  const permissao = exigirPermissao(ctx.ator, 'registrarResultadoOperacao');
  if (!permissao.ok) return permissao;
  const { operacao, item } = entrada;
  const lease = exigirLeaseValido(operacao, ctx);
  if (!lease.ok) return lease;
  if (item.id !== operacao.itemId) return falha('ITEM_FORA_DO_PEDIDO', { itemId: item.id });
  const sistemaExigido = DEPENDENCIA_DE_SISTEMA[operacao.sistema];
  // Regra 7, defesa em profundidade: resultado real de M365 sem âncora no AD não é gravado.
  if (
    sistemaExigido !== undefined &&
    operacao.modo === 'real' &&
    operacao.dependeDeItemId === null
  ) {
    return falha('DEPENDENCIA_DE_SISTEMA_AUSENTE', {
      operacaoId: operacao.id,
      sistema: operacao.sistema,
      exige: sistemaExigido,
    });
  }
  if (operacao.modo === 'real' && STATUS_ITEM_CONCLUIDO.includes(item.status)) {
    return falha('ITEM_JA_CONFIRMADO', { itemId: item.id });
  }

  const normalizado = normalizarResultado(operacao, sanitizarResultado(entrada.resultado));
  if (!normalizado.ok) return normalizado;
  const resultado = normalizado.valor;
  const modoEfetivo: ModoExecucao =
    resultado.modo === 'real' || operacao.modo === 'real' ? 'real' : 'simulado';
  const proximoPasso = decidirProximoPasso(
    {
      acao: operacao.acao,
      modo: modoEfetivo,
      resultado,
      tentativas: operacao.tentativas,
      ...(entrada.sorteioJitter === undefined ? {} : { sorteioJitter: entrada.sorteioJitter }),
    },
    politica,
  );

  const registro = {
    efeito: resultado.efeito,
    codigo: resultado.codigo,
    mensagem: resultado.mensagem,
    referenciaExterna: resultado.referenciaExterna,
    etapaAlcancada: resultado.etapa ?? operacao.etapaAlcancada,
    lease: null,
    atualizadaEm: ctx.agora,
    versao: proximaVersao(operacao),
  } as const;
  let novaOperacao: Operacao;
  switch (proximoPasso.tipo) {
    case 'finalizar':
      novaOperacao = { ...operacao, ...registro, status: 'concluida' };
      break;
    case 'retentar':
      novaOperacao = {
        ...operacao,
        ...registro,
        status: 'pendente',
        disponivelEm: somarMs(ctx.agora, proximoPasso.aguardarMs),
      };
      break;
    case 'aguardarDependencia':
      // Esperar a sincronização AD → Entra não consome tentativa.
      novaOperacao = {
        ...operacao,
        ...registro,
        status: 'pendente',
        tentativas: Math.max(0, operacao.tentativas - 1),
        disponivelEm: somarMs(ctx.agora, proximoPasso.aguardarMs),
      };
      break;
    case 'reconciliar':
      novaOperacao = { ...operacao, ...registro, status: 'aguardandoReconciliacao' };
      break;
  }

  // Só escrita real altera o item. Operação simulada nunca altera (regra 9); um
  // resultado simulado numa operação real já chega aqui como `desconhecido`.
  let novoItem = item;
  const afetaItem =
    operacao.modo === 'real' && (operacao.acao === 'provisionar' || operacao.acao === 'revogar');
  if (afetaItem) {
    const statusItem: StatusItem | null =
      proximoPasso.tipo === 'retentar'
        ? null
        : proximoPasso.tipo === 'aguardarDependencia'
          ? 'aguardandoDependencia'
          : statusItemPorEfeito(resultado.efeito);
    if (statusItem !== null) {
      const alterado = mudarStatusItem(item, statusItem, {
        mensagem: resultado.mensagem,
        idExterno: resultado.referenciaExterna ?? item.idExterno,
        etapaAlcancada: resultado.etapa ?? item.etapaAlcancada,
        ultimaOperacaoId: operacao.id,
        confirmadoEm: statusItem === 'confirmado' ? ctx.agora : item.confirmadoEm,
      });
      if (!alterado.ok) return alterado;
      novoItem = alterado.valor;
    }
  }

  const eventos: Evento[] = [
    eventoDoGia(ctx, {
      tipo: 'operacaoResultadoRegistrado',
      sistema: operacao.sistema,
      pedidoId: operacao.pedidoId,
      operacaoId: operacao.id,
      antes: { statusOperacao: operacao.status, statusItem: item.status },
      depois: { statusOperacao: novaOperacao.status, statusItem: novoItem.status },
      dados: {
        tentativa: operacao.tentativas,
        efeito: resultado.efeito,
        modo: resultado.modo,
        etapa: resultado.etapa,
        codigo: resultado.codigo,
        referenciaExterna: resultado.referenciaExterna,
        mensagem: resultado.mensagem,
        proximoPasso: proximoPasso.tipo,
      },
    }),
  ];
  if (proximoPasso.tipo === 'reconciliar') {
    eventos.push(
      eventoDoGia(ctx, {
        tipo: 'operacaoEncaminhadaParaReconciliacao',
        sistema: operacao.sistema,
        pedidoId: operacao.pedidoId,
        operacaoId: operacao.id,
        dados: { codigo: resultado.codigo },
      }),
    );
  } else if (proximoPasso.tipo !== 'finalizar') {
    eventos.push(
      eventoDoGia(ctx, {
        tipo: 'operacaoReagendada',
        sistema: operacao.sistema,
        pedidoId: operacao.pedidoId,
        operacaoId: operacao.id,
        dados: { motivo: proximoPasso.tipo, disponivelEm: novaOperacao.disponivelEm },
      }),
    );
  }
  return sucesso({ operacao: novaOperacao, item: novoItem, proximoPasso, eventos });
}

/**
 * Valida o resultado contra o sistema e a ação e corrige o que não pode ser
 * aceito como veio:
 * - M365 nunca cria usuário (regra 7);
 * - etapa precisa pertencer ao sistema;
 * - `confirmado` sem a última etapa vira `parcial`;
 * - modo divergente do pedido vira `desconhecido`, para conferência humana.
 */
function normalizarResultado(
  operacao: Operacao,
  resultado: ResultadoOperacao,
): Resultado<ResultadoOperacao> {
  if (operacao.acao !== 'provisionar' && operacao.acao !== 'revogar') return sucesso(resultado);
  if (
    operacao.sistema === 'm365' &&
    resultado.etapa !== null &&
    ETAPAS_DE_CRIACAO_DE_USUARIO.includes(resultado.etapa)
  ) {
    return falha('M365_NAO_CRIA_USUARIO', { etapa: resultado.etapa });
  }
  if (
    resultado.etapa !== null &&
    !ehEtapaDoSistema(operacao.sistema, operacao.acao, resultado.etapa)
  ) {
    return falha('ETAPA_DESCONHECIDA', { sistema: operacao.sistema, etapa: resultado.etapa });
  }
  if (resultado.modo !== operacao.modo) {
    return sucesso({
      ...resultado,
      efeito: 'desconhecido',
      codigo: 'MODO_DIVERGENTE',
      mensagem: `Resultado em modo ${resultado.modo} para operação em modo ${operacao.modo}; confira no destino.`,
      transitorio: false,
    });
  }
  // Regra 5: `JA_REVOGADO` só vale para revogação. Em provisionamento é
  // incoerente e não prova concessão nenhuma: vai para conferência.
  if (operacao.acao === 'provisionar' && resultado.codigo === CODIGO_JA_REVOGADO) {
    return sucesso({
      ...resultado,
      efeito: 'desconhecido',
      codigo: 'CODIGO_INCOERENTE_COM_ACAO',
      mensagem: 'O destino respondeu JA_REVOGADO a um provisionamento; confira no destino.',
      transitorio: false,
    });
  }
  let normalizado = resultado;
  const jaRevogado = operacao.acao === 'revogar' && resultado.codigo === CODIGO_JA_REVOGADO;
  if (normalizado.efeito === 'confirmado' && !jaRevogado) {
    const ultima = etapasDe(operacao.sistema, operacao.acao).at(-1) ?? null;
    if (normalizado.etapa !== ultima) normalizado = { ...normalizado, efeito: 'parcial' };
  }
  // Parcial sem etapa não diz o que já foi feito: retomar seria às cegas (regra 4).
  if (normalizado.efeito === 'parcial' && normalizado.etapa === null) {
    return sucesso({
      ...normalizado,
      efeito: 'desconhecido',
      codigo: 'PARCIAL_SEM_ETAPA',
      mensagem: 'Resultado parcial sem etapa alcançada; confira no destino antes de retomar.',
      transitorio: false,
    });
  }
  return sucesso(normalizado);
}

// ---------------------------------------------------------------------------
// Consolidação do pedido a partir dos itens.
// ---------------------------------------------------------------------------

/** Status do pedido que os itens da revisão corrente implicam. */
export function statusPedidoPelosItens(itens: readonly ItemAcesso[]): StatusPedido {
  if (itens.some((item) => STATUS_ITEM_EM_ANDAMENTO.includes(item.status))) return 'emExecucao';
  if (itens.every((item) => STATUS_ITEM_CONCLUIDO.includes(item.status))) return 'concluido';
  if (itens.some((item) => STATUS_ITEM_COM_PROBLEMA.includes(item.status)))
    return 'concluidoComErros';
  return 'aprovado';
}

export interface PedidoConsolidado {
  readonly pedido: PedidoAdmissao;
  readonly itens: readonly ItemAcesso[];
  readonly operacoes: readonly Operacao[];
  readonly eventos: readonly Evento[];
}

/**
 * Recalcula o status do pedido depois de resultados, registros manuais ou
 * reconciliações. Também libera itens que esperavam uma dependência que não
 * vai mais se confirmar (ex.: AD falhou, então o M365 volta a pendente e sua
 * operação é cancelada). Sucesso parcial nunca aparece como concluído.
 * Exclusivo do serviço executor (ação `consolidarExecucao`): nenhum papel
 * humano, nem o Administrador do Gia, altera o status por aqui.
 */
export function consolidarPedido(
  entrada: {
    readonly pedido: PedidoAdmissao;
    readonly itens: readonly ItemAcesso[];
    readonly operacoes: readonly Operacao[];
  },
  ctx: ContextoComando,
): Resultado<PedidoConsolidado> {
  const permissao = exigirPermissao(ctx.ator, 'consolidarExecucao');
  if (!permissao.ok) return permissao;
  const { pedido } = entrada;
  if (!STATUS_PEDIDO_EXECUTAVEL.includes(pedido.status)) {
    return sucesso({ pedido, itens: [], operacoes: [], eventos: [] });
  }
  const itens = new Map(
    entrada.itens
      .filter((item) => item.pedidoId === pedido.id && item.revisaoId === pedido.revisaoCorrenteId)
      .map((item) => [item.id, item]),
  );
  const eventos: Evento[] = [];
  const itensAlterados = new Map<string, ItemAcesso>();
  const operacoesAlteradas: Operacao[] = [];

  for (const operacao of entrada.operacoes) {
    if (operacao.status !== 'pendente' || operacao.dependeDeItemId === null) continue;
    const dependencia = itens.get(operacao.dependeDeItemId);
    const dependente = itens.get(operacao.itemId);
    if (!dependencia || !dependente) continue;
    // Só `confirmado` libera o dependente; fora de andamento, ele não vai se confirmar.
    const dependenciaSemSaida =
      dependencia.status !== 'confirmado' && !STATUS_ITEM_EM_ANDAMENTO.includes(dependencia.status);
    if (!dependenciaSemSaida || dependente.status !== 'aguardandoDependencia') continue;

    const motivo = `Dependência ${dependencia.sistema} terminou como ${dependencia.status}.`;
    operacoesAlteradas.push({
      ...operacao,
      status: 'cancelada',
      mensagem: motivo,
      atualizadaEm: ctx.agora,
      versao: proximaVersao(operacao),
    });
    const liberado = mudarStatusItem(dependente, statusAoLiberarItem(dependente), {
      mensagem: motivo,
    });
    if (!liberado.ok) return liberado;
    itens.set(dependente.id, liberado.valor);
    itensAlterados.set(dependente.id, liberado.valor);
    eventos.push(
      eventoDoGia(ctx, {
        tipo: 'operacaoResultadoRegistrado',
        sistema: operacao.sistema,
        pedidoId: pedido.id,
        operacaoId: operacao.id,
        antes: { statusOperacao: operacao.status, statusItem: dependente.status },
        depois: { statusOperacao: 'cancelada', statusItem: liberado.valor.status },
        dados: { motivo },
      }),
    );
  }

  const novoStatus = statusPedidoPelosItens([...itens.values()]);
  let pedidoAtualizado = pedido;
  if (novoStatus !== pedido.status) {
    const transicao = exigirTransicao(TRANSICOES_PEDIDO, pedido.status, novoStatus);
    if (!transicao.ok) return transicao;
    pedidoAtualizado = {
      ...pedido,
      status: novoStatus,
      atualizadoEm: ctx.agora,
      versao: proximaVersao(pedido),
    };
    eventos.push(
      eventoDoGia(ctx, {
        tipo: 'statusPedidoAlterado',
        pedidoId: pedido.id,
        colaboradorId: pedido.colaboradorId,
        antes: { status: pedido.status },
        depois: { status: novoStatus },
      }),
    );
  }
  return sucesso({
    pedido: pedidoAtualizado,
    itens: [...itensAlterados.values()],
    operacoes: operacoesAlteradas,
    eventos,
  });
}

// ---------------------------------------------------------------------------
// Registro manual e reconciliação.
// ---------------------------------------------------------------------------

/** O operador declara um acesso feito fora do Gia, com observação; fica auditado. */
export function registrarAcessoManual(
  entrada: {
    readonly pedido: PedidoAdmissao;
    readonly item: ItemAcesso;
    readonly observacao: string;
  },
  versaoEsperadaItem: number,
  ctx: ContextoComando,
): Resultado<{ readonly item: ItemAcesso; readonly eventos: readonly Evento[] }> {
  const permissao = exigirPermissao(ctx.ator, 'registrarManualReconciliar');
  if (!permissao.ok) return permissao;
  const { pedido, item } = entrada;
  const estado = exigirEstado(pedido.status, STATUS_PEDIDO_EXECUTAVEL);
  if (!estado.ok) return estado;
  const daRevisao = exigirItemDaRevisao(item, pedido);
  if (!daRevisao.ok) return daRevisao;
  const versao = exigirVersao(item, versaoEsperadaItem);
  if (!versao.ok) return versao;
  const executavel = exigirItemExecutavel(item);
  if (!executavel.ok) return executavel;
  const textoObservacao = exigirTextoLivre(entrada.observacao, 'OBSERVACAO_OBRIGATORIA');
  if (!textoObservacao.ok) return textoObservacao;
  const observacao = textoObservacao.valor;
  const alterado = mudarStatusItem(item, 'registradoManual', {
    observacaoManual: observacao,
    mensagem: 'Acesso registrado manualmente; nenhum conector foi acionado.',
  });
  if (!alterado.ok) return alterado;
  const evento = eventoDoGia(ctx, {
    tipo: 'acessoManualRegistrado',
    sistema: item.sistema,
    pedidoId: pedido.id,
    colaboradorId: pedido.colaboradorId,
    antes: { statusItem: item.status },
    depois: { statusItem: alterado.valor.status },
    dados: { itemId: item.id, observacao },
  });
  return sucesso({ item: alterado.valor, eventos: [evento] });
}

/** Referência externa vinda do destino, sem segredos (regra 12). */
function referenciaSanitizada(conferencia: ResultadoExistencia): string | null {
  return conferencia.referenciaExterna === null
    ? null
    : sanitizarTexto(conferencia.referenciaExterna);
}

export type DesfechoReconciliacao = 'confirmado' | 'parcial' | 'falhou';

const DESFECHO_POR_SITUACAO: Readonly<
  Record<AvaliacaoExistencia['situacao'], DesfechoReconciliacao>
> = {
  completo: 'confirmado',
  incompleto: 'parcial',
  ausente: 'falhou',
};

/**
 * Resolve um item com resultado desconhecido. O operador confirma o desfecho
 * com a versão que viu; o sistema já consultou o destino de novo
 * (`conferencia`, posterior à operação). Encontrar a conta não basta: o
 * desfecho precisa bater com a avaliação de todos os acessos (regra 6).
 */
export function reconciliarItem(
  entrada: {
    readonly pedido: PedidoAdmissao;
    readonly item: ItemAcesso;
    readonly operacao: Operacao;
    readonly conferencia: ResultadoExistencia;
    readonly desfecho: DesfechoReconciliacao;
  },
  versaoEsperadaItem: number,
  ctx: ContextoComando,
): Resultado<{
  readonly item: ItemAcesso;
  readonly operacao: Operacao;
  readonly avaliacao: AvaliacaoExistencia;
  readonly eventos: readonly Evento[];
}> {
  const permissao = exigirPermissao(ctx.ator, 'registrarManualReconciliar');
  if (!permissao.ok) return permissao;
  const { pedido, item, operacao, conferencia } = entrada;
  const daRevisao = exigirItemDaRevisao(item, pedido);
  if (!daRevisao.ok) return daRevisao;
  const versao = exigirVersao(item, versaoEsperadaItem);
  if (!versao.ok) return versao;
  if (item.status !== 'desconhecido') {
    return falha('TRANSICAO_INVALIDA', {
      statusAtual: item.status,
      statusPermitidos: ['desconhecido'],
    });
  }
  if (operacao.itemId !== item.id || operacao.status !== 'aguardandoReconciliacao') {
    return falha('TRANSICAO_INVALIDA', { operacaoId: operacao.id, status: operacao.status });
  }
  if (conferencia.modo !== 'real') return falha('CONFERENCIA_SIMULADA');
  if (compararInstantes(conferencia.conferidaEm, operacao.atualizadaEm) < 0) {
    return falha('DADO_INVALIDO', {
      motivo: 'conferência anterior ao último registro da operação',
    });
  }

  const avaliacao = avaliarExistencia(conferencia, item.parametros);
  const esperado = DESFECHO_POR_SITUACAO[avaliacao.situacao];
  if (entrada.desfecho !== esperado) {
    return falha('DESFECHO_DIVERGE_DA_CONFERENCIA', {
      desfechoInformado: entrada.desfecho,
      situacaoConferida: avaliacao.situacao,
      faltantes: avaliacao.faltantes,
    });
  }

  const acaoEscrita = operacao.acao === 'revogar' ? 'revogar' : 'provisionar';
  const etapas = etapasDe(item.sistema, acaoEscrita);
  let etapaAlcancada: Etapa | null;
  if (esperado === 'confirmado') {
    etapaAlcancada = etapas.at(-1) ?? null;
  } else if (esperado === 'falhou') {
    // Conta ausente: nada comprovado no destino; recomeçar do início é seguro.
    etapaAlcancada = null;
  } else {
    // Parcial: a retomada precisa de um ponto comprovado pela conferência.
    const comprovada = conferencia.etapaComprovada;
    if (
      comprovada === null ||
      !ehEtapaDoSistema(item.sistema, acaoEscrita, comprovada) ||
      comprovada === etapas.at(-1)
    ) {
      return falha('ETAPA_DE_RETOMADA_NAO_COMPROVADA', {
        sistema: item.sistema,
        etapaComprovada: comprovada,
      });
    }
    etapaAlcancada = comprovada;
  }

  const alterado = mudarStatusItem(item, esperado, {
    mensagem: `Reconciliado: ${avaliacao.situacao}.`,
    idExterno: referenciaSanitizada(conferencia) ?? item.idExterno,
    etapaAlcancada,
    confirmadoEm: esperado === 'confirmado' ? ctx.agora : item.confirmadoEm,
  });
  if (!alterado.ok) return alterado;
  const operacaoReconciliada: Operacao = {
    ...operacao,
    status: 'reconciliada',
    efeito:
      esperado === 'confirmado' ? 'confirmado' : esperado === 'parcial' ? 'parcial' : 'semEfeito',
    atualizadaEm: ctx.agora,
    versao: proximaVersao(operacao),
  };
  const evento = eventoDoGia(ctx, {
    tipo: 'itemReconciliado',
    sistema: item.sistema,
    pedidoId: pedido.id,
    operacaoId: operacao.id,
    colaboradorId: pedido.colaboradorId,
    antes: { statusItem: item.status, statusOperacao: operacao.status },
    depois: { statusItem: alterado.valor.status, statusOperacao: operacaoReconciliada.status },
    dados: { avaliacao, conferidaEm: conferencia.conferidaEm },
  });
  return sucesso({
    item: alterado.valor,
    operacao: operacaoReconciliada,
    avaliacao,
    eventos: [evento],
  });
}

/**
 * Comprova por conferência um acesso registrado manualmente, tornando-o
 * `confirmado`. É o único caminho para um AD feito fora do Gia liberar o
 * M365 (regra 7). A conferência precisa ser real e encontrar todos os
 * acessos esperados (regra 6); só existir a conta não basta.
 */
export function comprovarAcessoManual(
  entrada: {
    readonly pedido: PedidoAdmissao;
    readonly item: ItemAcesso;
    readonly conferencia: ResultadoExistencia;
  },
  versaoEsperadaItem: number,
  ctx: ContextoComando,
): Resultado<{
  readonly item: ItemAcesso;
  readonly avaliacao: AvaliacaoExistencia;
  readonly eventos: readonly Evento[];
}> {
  const permissao = exigirPermissao(ctx.ator, 'registrarManualReconciliar');
  if (!permissao.ok) return permissao;
  const { pedido, item, conferencia } = entrada;
  const daRevisao = exigirItemDaRevisao(item, pedido);
  if (!daRevisao.ok) return daRevisao;
  const versao = exigirVersao(item, versaoEsperadaItem);
  if (!versao.ok) return versao;
  if (item.status !== 'registradoManual') {
    return falha('TRANSICAO_INVALIDA', {
      statusAtual: item.status,
      statusPermitidos: ['registradoManual'],
    });
  }
  if (conferencia.modo !== 'real') return falha('CONFERENCIA_SIMULADA');
  const avaliacao = avaliarExistencia(conferencia, item.parametros);
  if (avaliacao.situacao !== 'completo') {
    return falha('EXISTENCIA_INCOMPLETA', {
      situacaoConferida: avaliacao.situacao,
      faltantes: avaliacao.faltantes,
    });
  }
  const alterado = mudarStatusItem(item, 'confirmado', {
    mensagem: 'Acesso manual comprovado por conferência no destino.',
    idExterno: referenciaSanitizada(conferencia) ?? item.idExterno,
    etapaAlcancada: etapasDe(item.sistema, 'provisionar').at(-1) ?? null,
    confirmadoEm: ctx.agora,
  });
  if (!alterado.ok) return alterado;
  const evento = eventoDoGia(ctx, {
    tipo: 'acessoManualComprovado',
    sistema: item.sistema,
    pedidoId: pedido.id,
    colaboradorId: pedido.colaboradorId,
    antes: { statusItem: item.status },
    depois: { statusItem: alterado.valor.status },
    dados: { itemId: item.id, avaliacao, conferidaEm: conferencia.conferidaEm },
  });
  return sucesso({ item: alterado.valor, avaliacao, eventos: [evento] });
}

// ---------------------------------------------------------------------------
// Documento de acessos.
// ---------------------------------------------------------------------------

/**
 * Itens que entram no documento de acessos: apenas os confirmados de um
 * pedido concluído. Resultado simulado nunca confirma item, então nunca entra
 * (regra 9).
 */
export function itensDoDocumento(
  pedido: PedidoAdmissao,
  itens: readonly ItemAcesso[],
): Resultado<readonly ItemAcesso[]> {
  if (pedido.status !== 'concluido') return falha('DOCUMENTO_INDISPONIVEL');
  return sucesso(
    itens.filter(
      (item) =>
        item.pedidoId === pedido.id &&
        item.revisaoId === pedido.revisaoCorrenteId &&
        item.status === 'confirmado',
    ),
  );
}

/** Sistemas da revisão ainda sem desfecho (útil para a interface e para reprocessar). */
export function sistemasPendentes(itens: readonly ItemAcesso[]): readonly Sistema[] {
  return itens
    .filter((item) => !STATUS_ITEM_CONCLUIDO.includes(item.status))
    .map((item) => item.sistema);
}
