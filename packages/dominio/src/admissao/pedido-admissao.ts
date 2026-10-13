import { exigirPermissao, registrarAtor, type ContextoComando } from '../autorizacao/ator.js';
import {
  aplicarIdentidadeAprovada,
  criarColaborador,
  type Colaborador,
} from '../colaborador/colaborador.js';
import {
  ajustarIdentidade,
  derivarIdentidadeDoEmail,
  exigirIdentidadeLiberada,
  verificarUsoDaIdentidade,
  type AjusteManualIdentidade,
  type IdentidadeProposta,
  type UsoIdentidade,
} from '../colaborador/identidade.js';
import { ehCpfValido, normalizarCpf } from '../comum/cpf.js';
import { exigirEstado, exigirTransicao, type TabelaTransicoes } from '../comum/maquina-estados.js';
import { falha, sucesso, type Resultado } from '../comum/resultado.js';
import {
  ehDataCivilValida,
  textoPreenchido,
  type DataCivil,
  type Instante,
  type Uuid,
} from '../comum/tipos.js';
import { exigirVersao, proximaVersao, VERSAO_INICIAL } from '../comum/versao.js';
import { eventoDoGia, type Evento } from '../eventos/evento.js';
import {
  sistemaHabilitadoParaVinculo,
  type ConfiguracaoSistemas,
} from '../sistemas/configuracao.js';
import type { Sistema, TipoVinculo } from '../sistemas/sistemas.js';
import { criarItensDaRevisao, STATUS_ITEM_EM_ANDAMENTO, type ItemAcesso } from './item-acesso.js';
import {
  alinharItensAIdentidade,
  aprovarRevisao,
  exigirRascunho,
  validarItensPropostos,
  type ItemProposto,
  type Revisao,
} from './revisao.js';

/** Status do pedido de admissão e as ações disponíveis em cada um. */
export type StatusPedido =
  'pendenteAprovacao' | 'aprovado' | 'emExecucao' | 'concluidoComErros' | 'concluido' | 'rejeitado';

export const TRANSICOES_PEDIDO: TabelaTransicoes<StatusPedido> = {
  pendenteAprovacao: ['aprovado', 'rejeitado'],
  /** `concluido` direto quando todos os itens herdaram sucesso de revisão anterior. */
  aprovado: ['emExecucao', 'pendenteAprovacao', 'concluido'],
  /** Volta a `aprovado` quando só restam itens nunca enviados (execução de um item por vez). */
  emExecucao: ['concluido', 'concluidoComErros', 'aprovado'],
  concluidoComErros: ['emExecucao', 'pendenteAprovacao', 'concluido'],
  concluido: [],
  rejeitado: ['pendenteAprovacao'],
};

export interface OrigemPedido {
  readonly sistema: 'jira';
  /** Chave da issue no Jira (ex.: `RH-123`). */
  readonly idExterno: string;
}

export interface DadosRh {
  readonly nomeCompleto: string;
  readonly cpf: string;
  readonly matricula: string | null;
  /** Base da identidade: login, UPN e endereços saem deste e-mail. */
  readonly emailCorporativoSugerido: string | null;
  readonly area: string;
  readonly cargo: string;
  readonly dataAdmissao: DataCivil;
  readonly gestor: string | null;
}

export interface PedidoAdmissao {
  readonly id: Uuid;
  readonly origem: OrigemPedido;
  readonly tipoVinculo: TipoVinculo;
  readonly dadosRh: DadosRh;
  readonly colaboradorId: Uuid;
  readonly status: StatusPedido;
  readonly revisaoCorrenteId: Uuid;
  readonly motivoRejeicao: string | null;
  readonly criadoEm: Instante;
  readonly atualizadoEm: Instante;
  readonly versao: number;
}

/** Chave canônica da origem; (sistema, ID externo) é único entre pedidos. */
export function chaveDeOrigem(origem: OrigemPedido): string {
  return `${origem.sistema}:${origem.idExterno.trim().toUpperCase()}`;
}

function exigirPedidoNaRevisao(pedido: PedidoAdmissao, revisao: Revisao): Resultado<true> {
  return revisao.id === pedido.revisaoCorrenteId && revisao.pedidoId === pedido.id
    ? sucesso(true)
    : falha('REVISAO_NAO_CORRENTE', { revisaoId: revisao.id });
}

function avancarPedido(
  pedido: PedidoAdmissao,
  mudancas: Partial<Pick<PedidoAdmissao, 'status' | 'revisaoCorrenteId' | 'motivoRejeicao'>>,
  agora: Instante,
): PedidoAdmissao {
  return { ...pedido, ...mudancas, atualizadoEm: agora, versao: proximaVersao(pedido) };
}

// ---------------------------------------------------------------------------
// Receber (ingestão) — regra 10: uma origem, um pedido.
// ---------------------------------------------------------------------------

export interface ChamadoNormalizado {
  readonly origem: OrigemPedido;
  readonly tipoVinculo: TipoVinculo;
  readonly dadosRh: DadosRh;
}

export type RecebimentoChamado =
  | { readonly tipo: 'duplicado'; readonly pedido: PedidoAdmissao; readonly eventos: readonly [] }
  | {
      readonly tipo: 'criado';
      readonly pedido: PedidoAdmissao;
      readonly revisao: Revisao;
      readonly colaborador: Colaborador;
      readonly colaboradorCriado: boolean;
      /** Sugestões descartadas por o sistema não estar habilitado para o vínculo. */
      readonly sistemasDescartados: readonly Sistema[];
      readonly eventos: readonly Evento[];
    };

/**
 * Recebe um chamado já normalizado. Se já existe pedido para a mesma origem,
 * devolve o existente sem criar outro. A pessoa é localizada pelo CPF e pode
 * ter vários pedidos. A identidade sai do e-mail corporativo do RH; a
 * proposta só leva itens de sistemas habilitados para o vínculo.
 */
export function receberChamado(
  entrada: {
    readonly chamado: ChamadoNormalizado;
    /** Pedido já gravado com a mesma origem, se houver (busca por chave de origem). */
    readonly pedidoMesmaOrigem: PedidoAdmissao | null;
    /** Colaborador com o mesmo CPF, se houver. */
    readonly colaboradorExistente: Colaborador | null;
    readonly configuracao: ConfiguracaoSistemas;
    readonly versaoRegras: string;
    readonly itensSugeridos: readonly ItemProposto[];
  },
  ctx: ContextoComando,
): Resultado<RecebimentoChamado> {
  const permissao = exigirPermissao(ctx.ator, 'criarPedido');
  if (!permissao.ok) return permissao;
  const { chamado } = entrada;

  if (entrada.pedidoMesmaOrigem !== null) {
    if (chaveDeOrigem(entrada.pedidoMesmaOrigem.origem) !== chaveDeOrigem(chamado.origem)) {
      return falha('ORIGEM_DIVERGENTE');
    }
    return sucesso({ tipo: 'duplicado', pedido: entrada.pedidoMesmaOrigem, eventos: [] });
  }

  const validacao = validarChamado(chamado);
  if (!validacao.ok) return validacao;

  const eventos: Evento[] = [];
  let colaborador: Colaborador;
  let colaboradorCriado = false;
  if (entrada.colaboradorExistente !== null) {
    if (entrada.colaboradorExistente.cpf !== normalizarCpf(chamado.dadosRh.cpf)) {
      return falha('DADO_INVALIDO', { motivo: 'colaborador informado tem outro CPF' });
    }
    colaborador = entrada.colaboradorExistente;
  } else {
    const criado = criarColaborador(
      {
        cpf: chamado.dadosRh.cpf,
        matricula: chamado.dadosRh.matricula,
        nome: chamado.dadosRh.nomeCompleto,
        tipoVinculo: chamado.tipoVinculo,
        dataAdmissao: chamado.dadosRh.dataAdmissao,
      },
      ctx,
    );
    if (!criado.ok) return criado;
    colaborador = criado.valor.colaborador;
    colaboradorCriado = true;
    eventos.push(...criado.valor.eventos);
  }

  const sistemasDescartados = entrada.itensSugeridos
    .filter(
      (item) =>
        !sistemaHabilitadoParaVinculo(
          entrada.configuracao.sistemasPorVinculo,
          chamado.tipoVinculo,
          item.sistema,
        ),
    )
    .map((item) => item.sistema);
  const habilitados = entrada.itensSugeridos.filter(
    (item) => !sistemasDescartados.includes(item.sistema),
  );
  const itensValidos = validarItensPropostos(
    habilitados,
    chamado.tipoVinculo,
    entrada.configuracao.sistemasPorVinculo,
  );
  if (!itensValidos.ok) return itensValidos;

  const identidade = derivarIdentidadeDoEmail({
    emailCorporativo: chamado.dadosRh.emailCorporativoSugerido,
    nomeCompleto: chamado.dadosRh.nomeCompleto,
  });

  const pedidoId = ctx.novoId();
  const revisao: Revisao = {
    id: ctx.novoId(),
    pedidoId,
    numero: 1,
    identidade: identidade.ok ? identidade.valor : null,
    pendenciaIdentidade: identidade.ok ? null : identidade.erro,
    verificacaoIdentidade: null,
    itens: alinharItensAIdentidade(identidade.ok ? identidade.valor : null, itensValidos.valor),
    versaoRegras: entrada.versaoRegras,
    situacao: 'rascunho',
    criadaEm: ctx.agora,
    baseadaEmRevisaoId: null,
    aprovadaPor: null,
    aprovadaEm: null,
  };
  const pedido: PedidoAdmissao = {
    id: pedidoId,
    origem: { sistema: chamado.origem.sistema, idExterno: chamado.origem.idExterno.trim() },
    tipoVinculo: chamado.tipoVinculo,
    dadosRh: { ...chamado.dadosRh, cpf: normalizarCpf(chamado.dadosRh.cpf) },
    colaboradorId: colaborador.id,
    status: 'pendenteAprovacao',
    revisaoCorrenteId: revisao.id,
    motivoRejeicao: null,
    criadoEm: ctx.agora,
    atualizadoEm: ctx.agora,
    versao: VERSAO_INICIAL,
  };
  eventos.push(
    eventoDoGia(ctx, {
      tipo: 'pedidoRecebido',
      pedidoId: pedido.id,
      colaboradorId: colaborador.id,
      depois: {
        status: pedido.status,
        origem: chaveDeOrigem(pedido.origem),
        tipoVinculo: pedido.tipoVinculo,
      },
      dados: {
        revisaoId: revisao.id,
        versaoRegras: revisao.versaoRegras,
        sistemasPropostos: revisao.itens.map((item) => item.sistema),
        sistemasDescartados,
        pendenciaIdentidade: revisao.pendenciaIdentidade?.codigo ?? null,
      },
    }),
  );
  return sucesso({
    tipo: 'criado',
    pedido,
    revisao,
    colaborador,
    colaboradorCriado,
    sistemasDescartados,
    eventos,
  });
}

function validarChamado(chamado: ChamadoNormalizado): Resultado<true> {
  if (!textoPreenchido(chamado.origem.idExterno)) {
    return falha('DADO_INVALIDO', { campo: 'origem.idExterno' });
  }
  if (!ehCpfValido(chamado.dadosRh.cpf)) return falha('CPF_INVALIDO');
  if (!textoPreenchido(chamado.dadosRh.nomeCompleto)) {
    return falha('DADO_INVALIDO', { campo: 'nomeCompleto' });
  }
  if (!ehDataCivilValida(chamado.dadosRh.dataAdmissao)) {
    return falha('DADO_INVALIDO', { campo: 'dataAdmissao' });
  }
  return sucesso(true);
}

// ---------------------------------------------------------------------------
// Pendente de aprovação: editar, recalcular e verificar identidade.
// ---------------------------------------------------------------------------

export interface PropostaAlterada {
  readonly pedido: PedidoAdmissao;
  readonly revisao: Revisao;
  readonly eventos: readonly Evento[];
}

function exigirPropostaEditavel(
  pedido: PedidoAdmissao,
  revisao: Revisao,
  versaoEsperada: number,
): Resultado<true> {
  const versao = exigirVersao(pedido, versaoEsperada);
  if (!versao.ok) return versao;
  const estado = exigirEstado(pedido.status, ['pendenteAprovacao']);
  if (!estado.ok) return estado;
  const corrente = exigirPedidoNaRevisao(pedido, revisao);
  if (!corrente.ok) return corrente;
  const rascunho = exigirRascunho(revisao);
  if (!rascunho.ok) return rascunho;
  return sucesso(true);
}

/**
 * Editar identidade e parâmetros dos itens. Mudar a identidade invalida a
 * verificação de uso anterior; é preciso verificar de novo antes de aprovar.
 */
export function editarProposta(
  entrada: {
    readonly pedido: PedidoAdmissao;
    readonly revisao: Revisao;
    readonly configuracao: ConfiguracaoSistemas;
    readonly identidade?: AjusteManualIdentidade;
    readonly itens?: readonly ItemProposto[];
  },
  versaoEsperada: number,
  ctx: ContextoComando,
): Resultado<PropostaAlterada> {
  const permissao = exigirPermissao(ctx.ator, 'editarProposta');
  if (!permissao.ok) return permissao;
  const { pedido, revisao } = entrada;
  const editavel = exigirPropostaEditavel(pedido, revisao, versaoEsperada);
  if (!editavel.ok) return editavel;

  let identidade: IdentidadeProposta | null = revisao.identidade;
  if (entrada.identidade !== undefined) {
    const ajustada = ajustarIdentidade(entrada.identidade);
    if (!ajustada.ok) return ajustada;
    identidade = ajustada.valor;
  }
  return substituirProposta(
    pedido,
    revisao,
    identidade,
    entrada.itens ?? revisao.itens,
    entrada.configuracao,
    ctx,
  );
}

/** Recalcula a identidade a partir do e-mail corporativo do RH, descartando ajustes manuais. */
export function recalcularIdentidade(
  entrada: {
    readonly pedido: PedidoAdmissao;
    readonly revisao: Revisao;
    readonly configuracao: ConfiguracaoSistemas;
  },
  versaoEsperada: number,
  ctx: ContextoComando,
): Resultado<PropostaAlterada> {
  const permissao = exigirPermissao(ctx.ator, 'editarProposta');
  if (!permissao.ok) return permissao;
  const { pedido, revisao } = entrada;
  const editavel = exigirPropostaEditavel(pedido, revisao, versaoEsperada);
  if (!editavel.ok) return editavel;
  const identidade = derivarIdentidadeDoEmail({
    emailCorporativo: pedido.dadosRh.emailCorporativoSugerido,
    nomeCompleto: pedido.dadosRh.nomeCompleto,
  });
  if (!identidade.ok) return identidade;
  return substituirProposta(
    pedido,
    revisao,
    identidade.valor,
    revisao.itens,
    entrada.configuracao,
    ctx,
  );
}

function substituirProposta(
  pedido: PedidoAdmissao,
  revisao: Revisao,
  identidade: IdentidadeProposta | null,
  itens: readonly ItemProposto[],
  configuracao: ConfiguracaoSistemas,
  ctx: ContextoComando,
): Resultado<PropostaAlterada> {
  const itensValidos = validarItensPropostos(
    itens,
    pedido.tipoVinculo,
    configuracao.sistemasPorVinculo,
  );
  if (!itensValidos.ok) return itensValidos;
  const identidadeMudou = identidade !== revisao.identidade;
  const nova: Revisao = {
    ...revisao,
    identidade,
    pendenciaIdentidade: identidade === null ? revisao.pendenciaIdentidade : null,
    verificacaoIdentidade: identidadeMudou ? null : revisao.verificacaoIdentidade,
    itens: alinharItensAIdentidade(identidade, itensValidos.valor),
  };
  const atualizado = avancarPedido(pedido, {}, ctx.agora);
  const evento = eventoDoGia(ctx, {
    tipo: 'propostaEditada',
    pedidoId: pedido.id,
    colaboradorId: pedido.colaboradorId,
    antes: { identidade: revisao.identidade, itens: revisao.itens },
    depois: { identidade: nova.identidade, itens: nova.itens },
    dados: { revisaoId: revisao.id, versaoPedido: atualizado.versao },
  });
  return sucesso({ pedido: atualizado, revisao: nova, eventos: [evento] });
}

/**
 * Verifica colisão e uso da identidade nos sistemas. Os usos são buscados
 * fora do domínio (AD, M365, Gia); aqui só se classifica. Nenhum login
 * alternativo é gerado.
 */
export function verificarIdentidade(
  entrada: {
    readonly pedido: PedidoAdmissao;
    readonly revisao: Revisao;
    readonly usos: readonly UsoIdentidade[];
  },
  versaoEsperada: number,
  ctx: ContextoComando,
): Resultado<PropostaAlterada> {
  const permissao = exigirPermissao(ctx.ator, 'validarConferirTestar');
  if (!permissao.ok) return permissao;
  const { pedido, revisao } = entrada;
  const editavel = exigirPropostaEditavel(pedido, revisao, versaoEsperada);
  if (!editavel.ok) return editavel;
  if (revisao.identidade === null) return falha('IDENTIDADE_AUSENTE');

  const verificacao = verificarUsoDaIdentidade(
    revisao.identidade,
    entrada.usos,
    pedido.dadosRh.cpf,
    ctx.agora,
  );
  const nova: Revisao = { ...revisao, verificacaoIdentidade: verificacao };
  const atualizado = avancarPedido(pedido, {}, ctx.agora);
  const evento = eventoDoGia(ctx, {
    tipo: 'identidadeVerificada',
    pedidoId: pedido.id,
    colaboradorId: pedido.colaboradorId,
    depois: { situacao: verificacao.situacao, valores: verificacao.valoresVerificados },
    dados: {
      revisaoId: revisao.id,
      conflitos: verificacao.conflitos,
      usosDaMesmaPessoa: verificacao.usosDaMesmaPessoa,
    },
  });
  return sucesso({ pedido: atualizado, revisao: nova, eventos: [evento] });
}

// ---------------------------------------------------------------------------
// Decisão: aprovar, rejeitar, reabrir.
// ---------------------------------------------------------------------------

/**
 * Resultado da aprovação. Regra 1 — Aprovar não executa: não há operação
 * aqui. Os itens nascem pendentes e só uma solicitação de execução separada,
 * feita por quem tem permissão de executar, cria operações.
 */
export interface PedidoAprovado {
  readonly pedido: PedidoAdmissao;
  readonly revisao: Revisao;
  readonly itens: readonly ItemAcesso[];
  readonly colaborador: Colaborador;
  readonly eventos: readonly Evento[];
}

export function aprovarPedido(
  entrada: {
    readonly pedido: PedidoAdmissao;
    readonly revisao: Revisao;
    readonly colaborador: Colaborador;
    /** Itens de revisões anteriores do mesmo pedido, para não repetir sucessos (regra 4). */
    readonly itensAnteriores: readonly ItemAcesso[];
  },
  versaoEsperada: number,
  ctx: ContextoComando,
): Resultado<PedidoAprovado> {
  const permissao = exigirPermissao(ctx.ator, 'decidirPedido');
  if (!permissao.ok) return permissao;
  const { pedido, revisao } = entrada;
  const versao = exigirVersao(pedido, versaoEsperada);
  if (!versao.ok) return versao;
  const transicao = exigirTransicao(TRANSICOES_PEDIDO, pedido.status, 'aprovado');
  if (!transicao.ok) return transicao;
  const corrente = exigirPedidoNaRevisao(pedido, revisao);
  if (!corrente.ok) return corrente;
  const rascunho = exigirRascunho(revisao);
  if (!rascunho.ok) return rascunho;
  if (entrada.colaborador.id !== pedido.colaboradorId) {
    return falha('DADO_INVALIDO', { motivo: 'colaborador não corresponde ao pedido' });
  }
  const identidade = exigirIdentidadeLiberada(revisao.identidade, revisao.verificacaoIdentidade);
  if (!identidade.ok) return identidade;

  const ator = registrarAtor(ctx.ator);
  const revisaoAprovada = aprovarRevisao(revisao, ator, ctx.agora);
  const itens = criarItensDaRevisao(
    {
      pedidoId: pedido.id,
      revisaoId: revisao.id,
      itensPropostos: revisaoAprovada.itens,
      itensAnteriores: entrada.itensAnteriores.filter((item) => item.pedidoId === pedido.id),
    },
    ctx.novoId,
  );
  const atualizado = avancarPedido(pedido, { status: 'aprovado', motivoRejeicao: null }, ctx.agora);
  const colaborador = aplicarIdentidadeAprovada(entrada.colaborador, identidade.valor, ctx);
  const evento = eventoDoGia(ctx, {
    tipo: 'pedidoAprovado',
    pedidoId: pedido.id,
    colaboradorId: pedido.colaboradorId,
    antes: { status: pedido.status },
    depois: { status: atualizado.status },
    dados: {
      revisaoId: revisao.id,
      numeroRevisao: revisao.numero,
      versaoRegras: revisao.versaoRegras,
      identidade: identidade.valor,
      itens: itens.map((item) => ({ itemId: item.id, sistema: item.sistema, status: item.status })),
    },
  });
  return sucesso({
    pedido: atualizado,
    revisao: revisaoAprovada,
    itens,
    colaborador: colaborador.colaborador,
    eventos: [evento, ...colaborador.eventos],
  });
}

export function rejeitarPedido(
  entrada: { readonly pedido: PedidoAdmissao; readonly motivo: string },
  versaoEsperada: number,
  ctx: ContextoComando,
): Resultado<{ readonly pedido: PedidoAdmissao; readonly eventos: readonly Evento[] }> {
  const permissao = exigirPermissao(ctx.ator, 'decidirPedido');
  if (!permissao.ok) return permissao;
  const { pedido } = entrada;
  const versao = exigirVersao(pedido, versaoEsperada);
  if (!versao.ok) return versao;
  const transicao = exigirTransicao(TRANSICOES_PEDIDO, pedido.status, 'rejeitado');
  if (!transicao.ok) return transicao;
  if (!textoPreenchido(entrada.motivo)) return falha('MOTIVO_OBRIGATORIO');

  const motivo = entrada.motivo.trim();
  const atualizado = avancarPedido(
    pedido,
    { status: 'rejeitado', motivoRejeicao: motivo },
    ctx.agora,
  );
  const evento = eventoDoGia(ctx, {
    tipo: 'pedidoRejeitado',
    pedidoId: pedido.id,
    colaboradorId: pedido.colaboradorId,
    antes: { status: pedido.status },
    depois: { status: atualizado.status },
    dados: { motivo },
  });
  return sucesso({ pedido: atualizado, eventos: [evento] });
}

/**
 * Reabre para revisão: cria nova revisão em rascunho, baseada na corrente.
 * A revisão aprovada anterior fica intacta. Não reabre com item em execução
 * ou com resultado desconhecido (conferir antes).
 */
export function reabrirPedido(
  entrada: {
    readonly pedido: PedidoAdmissao;
    readonly revisao: Revisao;
    readonly itens: readonly ItemAcesso[];
    readonly motivo: string;
  },
  versaoEsperada: number,
  ctx: ContextoComando,
): Resultado<PropostaAlterada> {
  const permissao = exigirPermissao(ctx.ator, 'decidirPedido');
  if (!permissao.ok) return permissao;
  const { pedido, revisao } = entrada;
  const versao = exigirVersao(pedido, versaoEsperada);
  if (!versao.ok) return versao;
  const transicao = exigirTransicao(TRANSICOES_PEDIDO, pedido.status, 'pendenteAprovacao');
  if (!transicao.ok) return transicao;
  const corrente = exigirPedidoNaRevisao(pedido, revisao);
  if (!corrente.ok) return corrente;
  if (!textoPreenchido(entrada.motivo)) return falha('MOTIVO_OBRIGATORIO');
  const itensDaRevisao = entrada.itens.filter((item) => item.revisaoId === revisao.id);
  const emAndamento = itensDaRevisao.find((item) => STATUS_ITEM_EM_ANDAMENTO.includes(item.status));
  if (emAndamento) return falha('ITEM_EM_EXECUCAO', { itemId: emAndamento.id });
  const desconhecido = itensDaRevisao.find((item) => item.status === 'desconhecido');
  if (desconhecido) return falha('ITEM_AGUARDANDO_CONFERENCIA', { itemId: desconhecido.id });

  const nova: Revisao = {
    id: ctx.novoId(),
    pedidoId: pedido.id,
    numero: revisao.numero + 1,
    identidade: revisao.identidade,
    pendenciaIdentidade: revisao.pendenciaIdentidade,
    verificacaoIdentidade: null,
    itens: revisao.itens,
    versaoRegras: revisao.versaoRegras,
    situacao: 'rascunho',
    criadaEm: ctx.agora,
    baseadaEmRevisaoId: revisao.id,
    aprovadaPor: null,
    aprovadaEm: null,
  };
  const atualizado = avancarPedido(
    pedido,
    { status: 'pendenteAprovacao', revisaoCorrenteId: nova.id, motivoRejeicao: null },
    ctx.agora,
  );
  const evento = eventoDoGia(ctx, {
    tipo: 'pedidoReaberto',
    pedidoId: pedido.id,
    colaboradorId: pedido.colaboradorId,
    antes: { status: pedido.status, revisaoId: revisao.id },
    depois: { status: atualizado.status, revisaoId: nova.id },
    dados: { motivo: entrada.motivo.trim() },
  });
  return sucesso({ pedido: atualizado, revisao: nova, eventos: [evento] });
}
