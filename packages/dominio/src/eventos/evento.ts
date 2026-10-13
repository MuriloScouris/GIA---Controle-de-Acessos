import {
  exigirPermissao,
  registrarAtor,
  type AtorRegistrado,
  type ContextoComando,
} from '../autorizacao/ator.js';
import { congelarProfundo } from '../comum/imutavel.js';
import { falha, sucesso, type Resultado } from '../comum/resultado.js';
import { mascararCpfs, sanitizar } from '../comum/sanitizacao.js';
import { textoPreenchido, type Instante, type Uuid } from '../comum/tipos.js';
import type { Sistema } from '../sistemas/sistemas.js';

/**
 * Regra 11 — Evidência imutável. Eventos de auditoria só são inseridos;
 * correções entram como novo evento que referencia o original.
 */

export type OrigemEvento = 'gia' | 'sincronizacaoAd' | 'sincronizacaoM365';

export type TipoEvento =
  | 'pedidoRecebido'
  | 'colaboradorCriado'
  | 'colaboradorIdentidadeAtualizada'
  | 'colaboradorStatusAlterado'
  | 'propostaEditada'
  | 'identidadeVerificada'
  | 'pedidoAprovado'
  | 'pedidoRejeitado'
  | 'pedidoReaberto'
  | 'execucaoSolicitada'
  | 'simulacaoSolicitada'
  | 'statusPedidoAlterado'
  | 'operacaoReservada'
  | 'operacaoResultadoRegistrado'
  | 'operacaoReagendada'
  | 'operacaoEncaminhadaParaReconciliacao'
  | 'acessoManualRegistrado'
  | 'acessoManualComprovado'
  | 'itemReconciliado'
  | 'configuracaoAlterada'
  | 'liberacaoEscritaAlterada'
  | 'estadoInicialSincronizado'
  | 'alteracaoDetectadaNaSincronizacao'
  | 'correcaoRegistrada';

export interface Evento {
  readonly id: Uuid;
  readonly tipo: TipoEvento;
  readonly origem: OrigemEvento;
  /** `null` apenas para mudanças detectadas na sincronização, que não têm ator do Gia. */
  readonly ator: AtorRegistrado | null;
  readonly instante: Instante;
  readonly sistema: Sistema | null;
  readonly antes: unknown;
  readonly depois: unknown;
  readonly dados: Readonly<Record<string, unknown>> | null;
  readonly pedidoId: Uuid | null;
  readonly operacaoId: Uuid | null;
  readonly colaboradorId: Uuid | null;
  readonly correlacaoId: string | null;
  readonly corrigeEventoId: Uuid | null;
}

export interface DadosEvento {
  readonly tipo: TipoEvento;
  readonly sistema?: Sistema | null;
  readonly antes?: unknown;
  readonly depois?: unknown;
  readonly dados?: Readonly<Record<string, unknown>> | null;
  readonly pedidoId?: Uuid | null;
  readonly operacaoId?: Uuid | null;
  readonly colaboradorId?: Uuid | null;
  readonly corrigeEventoId?: Uuid | null;
}

export interface EntradaEvento extends DadosEvento {
  readonly id: Uuid;
  readonly origem: OrigemEvento;
  readonly ator: AtorRegistrado | null;
  readonly instante: Instante;
  readonly correlacaoId?: string | null;
}

/** Sem segredos (regra 12) e com CPF mascarado. */
function protegerConteudo<T>(valor: T): T {
  return mascararCpfs(sanitizar(valor));
}

/**
 * Cria um evento sanitizado (regra 12) e congelado (regra 11). Eventos do
 * Gia exigem ator; eventos de sincronização não têm ator.
 */
export function criarEvento(entrada: EntradaEvento): Resultado<Evento> {
  if (entrada.origem === 'gia' && entrada.ator === null) return falha('EVENTO_SEM_ATOR');
  if (entrada.origem !== 'gia' && entrada.ator !== null) {
    return falha('DADO_INVALIDO', {
      motivo: 'mudança detectada na sincronização não tem ator do Gia',
    });
  }
  const evento: Evento = {
    id: entrada.id,
    tipo: entrada.tipo,
    origem: entrada.origem,
    ator: entrada.ator,
    instante: entrada.instante,
    sistema: entrada.sistema ?? null,
    antes: protegerConteudo(entrada.antes ?? null),
    depois: protegerConteudo(entrada.depois ?? null),
    dados: entrada.dados ? protegerConteudo(entrada.dados) : null,
    pedidoId: entrada.pedidoId ?? null,
    operacaoId: entrada.operacaoId ?? null,
    colaboradorId: entrada.colaboradorId ?? null,
    correlacaoId: entrada.correlacaoId ?? null,
    corrigeEventoId: entrada.corrigeEventoId ?? null,
  };
  return sucesso(congelarProfundo(evento));
}

/** Evento originado por um comando no Gia; ator e instante vêm do contexto (sessão). */
export function eventoDoGia(ctx: ContextoComando, dados: DadosEvento): Evento {
  const resultado = criarEvento({
    ...dados,
    id: ctx.novoId(),
    origem: 'gia',
    ator: registrarAtor(ctx.ator),
    instante: ctx.agora,
    correlacaoId: ctx.correlacaoId,
  });
  // Inalcançável: origem `gia` com o ator do contexto é sempre válida.
  if (!resultado.ok) throw new Error(resultado.erro.mensagem);
  return resultado.valor;
}

// ---------------------------------------------------------------------------
// Registro somente inserção.
// ---------------------------------------------------------------------------

export type RegistroEventos = readonly Evento[];

export const REGISTRO_VAZIO: RegistroEventos = Object.freeze([]);

/**
 * Anexa eventos ao registro, devolvendo um novo registro congelado. Não há
 * operação de alteração ou remoção: um ID já gravado não pode ser regravado.
 */
export function anexarEventos(
  registro: RegistroEventos,
  novos: readonly Evento[],
): Resultado<RegistroEventos> {
  const ids = new Set(registro.map((evento) => evento.id));
  for (const evento of novos) {
    if (ids.has(evento.id)) return falha('EVENTO_DUPLICADO', { eventoId: evento.id });
    ids.add(evento.id);
  }
  return sucesso(Object.freeze([...registro, ...novos.map((evento) => congelarProfundo(evento))]));
}

/**
 * Correção de um evento: grava um novo evento `correcaoRegistrada` que
 * aponta para o original. O original permanece intacto. Exige a ação
 * `corrigirEvidencia` (revisor ou Administrador do Gia).
 */
export function registrarCorrecao(
  registro: RegistroEventos,
  entrada: { readonly eventoOriginalId: Uuid; readonly motivo: string; readonly correcao: unknown },
  ctx: ContextoComando,
): Resultado<{ readonly registro: RegistroEventos; readonly evento: Evento }> {
  const permissao = exigirPermissao(ctx.ator, 'corrigirEvidencia');
  if (!permissao.ok) return permissao;
  const original = registro.find((evento) => evento.id === entrada.eventoOriginalId);
  if (!original) return falha('EVENTO_INEXISTENTE', { eventoId: entrada.eventoOriginalId });
  if (!textoPreenchido(entrada.motivo)) return falha('MOTIVO_OBRIGATORIO');
  const evento = eventoDoGia(ctx, {
    tipo: 'correcaoRegistrada',
    sistema: original.sistema,
    antes: original.depois,
    depois: entrada.correcao,
    dados: { motivo: entrada.motivo.trim(), tipoOriginal: original.tipo },
    pedidoId: original.pedidoId,
    operacaoId: original.operacaoId,
    colaboradorId: original.colaboradorId,
    corrigeEventoId: original.id,
  });
  const anexado = anexarEventos(registro, [evento]);
  if (!anexado.ok) return anexado;
  return sucesso({ registro: anexado.valor, evento });
}
