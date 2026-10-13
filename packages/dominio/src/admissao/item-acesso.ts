import { igualdadeEstrutural } from '../comum/imutavel.js';
import type { TabelaTransicoes } from '../comum/maquina-estados.js';
import { falha, sucesso, type Resultado } from '../comum/resultado.js';
import type { Instante, Uuid } from '../comum/tipos.js';
import { VERSAO_INICIAL } from '../comum/versao.js';
import type { Efeito } from '../conectores/conector.js';
import type { Etapa, ParametrosSistema, Sistema } from '../sistemas/sistemas.js';
import type { ItemProposto } from './revisao.js';

/**
 * Item de acesso: um sistema da revisão aprovada, com o resultado da execução.
 * (revisão, sistema) é único.
 */
export type StatusItem =
  | 'pendente'
  | 'aguardandoDependencia'
  | 'emExecucao'
  | 'confirmado'
  | 'parcial'
  | 'falhou'
  | 'desconhecido'
  | 'registradoManual';

export const TRANSICOES_ITEM: TabelaTransicoes<StatusItem> = {
  pendente: ['emExecucao', 'aguardandoDependencia', 'registradoManual'],
  aguardandoDependencia: [
    'emExecucao',
    'confirmado',
    'parcial',
    'falhou',
    'desconhecido',
    'pendente',
  ],
  /** `pendente` só quando a operação é cancelada antes de ser reservada (nada foi enviado). */
  emExecucao: [
    'confirmado',
    'parcial',
    'falhou',
    'desconhecido',
    'aguardandoDependencia',
    'pendente',
  ],
  parcial: ['emExecucao', 'aguardandoDependencia', 'registradoManual'],
  falhou: ['emExecucao', 'aguardandoDependencia', 'registradoManual'],
  /** Só sai daqui pela reconciliação, com conferência no destino (regra 3). */
  desconhecido: ['confirmado', 'parcial', 'falhou'],
  /** Regra 4: sucesso confirmado não se repete. */
  confirmado: [],
  /** Só por `comprovarAcessoManual`, com conferência real completa (regra 6). */
  registradoManual: ['confirmado'],
};

export const STATUS_ITEM_CONCLUIDO: readonly StatusItem[] = ['confirmado', 'registradoManual'];
export const STATUS_ITEM_EM_ANDAMENTO: readonly StatusItem[] = [
  'emExecucao',
  'aguardandoDependencia',
];
export const STATUS_ITEM_COM_PROBLEMA: readonly StatusItem[] = [
  'falhou',
  'parcial',
  'desconhecido',
];
/** Itens que podem receber nova operação: nunca os confirmados (regra 4) nem os desconhecidos (regra 3). */
export const STATUS_ITEM_EXECUTAVEL: readonly StatusItem[] = ['pendente', 'falhou', 'parcial'];

export interface ItemAcesso {
  readonly id: Uuid;
  readonly pedidoId: Uuid;
  readonly revisaoId: Uuid;
  readonly sistema: Sistema;
  readonly parametros: ParametrosSistema;
  readonly status: StatusItem;
  readonly idExterno: string | null;
  readonly mensagem: string | null;
  /** Última etapa concluída no destino; uma reexecução começa da seguinte. */
  readonly etapaAlcancada: Etapa | null;
  /** Quantas vezes o item já foi enviado para execução real; compõe a chave de idempotência. */
  readonly geracao: number;
  readonly ultimaOperacaoId: Uuid | null;
  /** Item de revisão anterior cujo sucesso foi reaproveitado sem nova execução. */
  readonly herdadoDeItemId: Uuid | null;
  readonly confirmadoEm: Instante | null;
  readonly observacaoManual: string | null;
  readonly versao: number;
}

/** Status do item a partir do efeito real de uma operação de escrita. */
export function statusItemPorEfeito(efeito: Efeito): StatusItem {
  switch (efeito) {
    case 'confirmado':
      return 'confirmado';
    case 'parcial':
      return 'parcial';
    case 'semEfeito':
      return 'falhou';
    case 'desconhecido':
      return 'desconhecido';
  }
}

/**
 * Cria os itens da revisão aprovada. Um sistema já concluído em revisão
 * anterior, com os mesmos parâmetros, herda o sucesso e não é executado de
 * novo (regra 4). Parâmetros diferentes exigem execução.
 */
export function criarItensDaRevisao(
  entrada: {
    readonly pedidoId: Uuid;
    readonly revisaoId: Uuid;
    readonly itensPropostos: readonly ItemProposto[];
    readonly itensAnteriores: readonly ItemAcesso[];
  },
  novoId: () => Uuid,
): readonly ItemAcesso[] {
  return entrada.itensPropostos.map((proposto) => {
    const anterior = entrada.itensAnteriores.find(
      (item) =>
        item.sistema === proposto.sistema &&
        STATUS_ITEM_CONCLUIDO.includes(item.status) &&
        igualdadeEstrutural(item.parametros, proposto.parametros),
    );
    return {
      id: novoId(),
      pedidoId: entrada.pedidoId,
      revisaoId: entrada.revisaoId,
      sistema: proposto.sistema,
      parametros: proposto.parametros,
      status: anterior?.status ?? 'pendente',
      idExterno: anterior?.idExterno ?? null,
      mensagem: anterior ? 'Concluído em revisão anterior; não será executado de novo.' : null,
      etapaAlcancada: anterior?.etapaAlcancada ?? null,
      geracao: 0,
      ultimaOperacaoId: null,
      herdadoDeItemId: anterior?.id ?? null,
      confirmadoEm: anterior?.confirmadoEm ?? null,
      observacaoManual: anterior?.observacaoManual ?? null,
      versao: VERSAO_INICIAL,
    };
  });
}

/** Explica por que um item não pode receber nova operação. */
export function exigirItemExecutavel(item: ItemAcesso): Resultado<ItemAcesso> {
  if (STATUS_ITEM_EXECUTAVEL.includes(item.status)) return sucesso(item);
  if (STATUS_ITEM_CONCLUIDO.includes(item.status)) {
    return falha('ITEM_JA_CONFIRMADO', { itemId: item.id, sistema: item.sistema });
  }
  if (item.status === 'desconhecido') {
    return falha('ITEM_AGUARDANDO_CONFERENCIA', { itemId: item.id, sistema: item.sistema });
  }
  return falha('ITEM_EM_EXECUCAO', { itemId: item.id, sistema: item.sistema });
}
