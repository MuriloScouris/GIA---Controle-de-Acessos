import { exigirPermissao, type ContextoComando } from '../autorizacao/ator.js';
import { congelarProfundo } from '../comum/imutavel.js';
import { falha, sucesso, type Resultado } from '../comum/resultado.js';
import { exigirVersao, proximaVersao, VERSAO_INICIAL } from '../comum/versao.js';
import { eventoDoGia, type Evento } from '../eventos/evento.js';
import { SISTEMAS, sistemasSemDependencia, type Sistema, type TipoVinculo } from './sistemas.js';

/**
 * Regra 8 — Escrita desligada por padrão. Cada sistema e cada tipo de escrita
 * (criar, revogar) é liberado separadamente, só pelo administrador técnico.
 */
export type TipoEscrita = 'criar' | 'revogar';

export type LiberacaoEscrita = Readonly<Record<Sistema, Readonly<Record<TipoEscrita, boolean>>>>;

export type SistemasPorVinculo = Readonly<Record<TipoVinculo, readonly Sistema[]>>;

export interface ConfiguracaoSistemas {
  readonly versao: number;
  readonly sistemasPorVinculo: SistemasPorVinculo;
  readonly liberacaoEscrita: LiberacaoEscrita;
}

export const LIBERACAO_ESCRITA_PADRAO: LiberacaoEscrita = congelarProfundo(
  Object.fromEntries(
    SISTEMAS.map((sistema) => [sistema, { criar: false, revogar: false }]),
  ) as Record<Sistema, Record<TipoEscrita, boolean>>,
);

/**
 * Enquanto a regra de terceiros não for definida, nenhum sistema gera item
 * para terceiro, para que nenhum pedido gere acesso por engano.
 */
export const SISTEMAS_POR_VINCULO_PADRAO: SistemasPorVinculo = congelarProfundo({
  celetista: [...SISTEMAS],
  terceiro: [],
});

export function configuracaoPadrao(): ConfiguracaoSistemas {
  return {
    versao: VERSAO_INICIAL,
    sistemasPorVinculo: SISTEMAS_POR_VINCULO_PADRAO,
    liberacaoEscrita: LIBERACAO_ESCRITA_PADRAO,
  };
}

export function escritaLiberada(
  liberacao: LiberacaoEscrita,
  sistema: Sistema,
  tipo: TipoEscrita,
): boolean {
  return liberacao[sistema][tipo];
}

export function sistemaHabilitadoParaVinculo(
  sistemasPorVinculo: SistemasPorVinculo,
  vinculo: TipoVinculo,
  sistema: Sistema,
): boolean {
  return sistemasPorVinculo[vinculo].includes(sistema);
}

export interface ConfiguracaoAlterada {
  readonly configuracao: ConfiguracaoSistemas;
  readonly eventos: readonly Evento[];
}

/** Liberar ou bloquear escrita: gate exclusivo do administrador técnico, versionado e auditado. */
export function alterarLiberacaoEscrita(
  configuracao: ConfiguracaoSistemas,
  alteracao: { readonly sistema: Sistema; readonly tipo: TipoEscrita; readonly liberada: boolean },
  versaoEsperada: number,
  ctx: ContextoComando,
): Resultado<ConfiguracaoAlterada> {
  const permissao = exigirPermissao(ctx.ator, 'liberarEscrita');
  if (!permissao.ok) return permissao;
  const versao = exigirVersao(configuracao, versaoEsperada);
  if (!versao.ok) return versao;

  const antes = configuracao.liberacaoEscrita[alteracao.sistema];
  const depois = { ...antes, [alteracao.tipo]: alteracao.liberada };
  const nova: ConfiguracaoSistemas = {
    ...configuracao,
    versao: proximaVersao(configuracao),
    liberacaoEscrita: congelarProfundo({
      ...configuracao.liberacaoEscrita,
      [alteracao.sistema]: depois,
    }),
  };
  const evento = eventoDoGia(ctx, {
    tipo: 'liberacaoEscritaAlterada',
    sistema: alteracao.sistema,
    antes,
    depois,
    dados: { versaoConfiguracao: nova.versao },
  });
  return sucesso({ configuracao: nova, eventos: [evento] });
}

/** Define quais sistemas entram na proposta para um tipo de vínculo. */
export function alterarSistemasPorVinculo(
  configuracao: ConfiguracaoSistemas,
  alteracao: { readonly vinculo: TipoVinculo; readonly sistemas: readonly Sistema[] },
  versaoEsperada: number,
  ctx: ContextoComando,
): Resultado<ConfiguracaoAlterada> {
  const permissao = exigirPermissao(ctx.ator, 'alterarRegras');
  if (!permissao.ok) return permissao;
  const versao = exigirVersao(configuracao, versaoEsperada);
  if (!versao.ok) return versao;
  const invalidos = alteracao.sistemas.filter((sistema) => !SISTEMAS.includes(sistema));
  if (invalidos.length > 0) return falha('DADO_INVALIDO', { sistemasInvalidos: invalidos });
  const semDependencia = sistemasSemDependencia(alteracao.sistemas);
  if (semDependencia.length > 0) {
    return falha('DEPENDENCIA_DE_SISTEMA_AUSENTE', { vinculo: alteracao.vinculo, semDependencia });
  }

  const antes = configuracao.sistemasPorVinculo[alteracao.vinculo];
  const depois = [...new Set(alteracao.sistemas)];
  const nova: ConfiguracaoSistemas = {
    ...configuracao,
    versao: proximaVersao(configuracao),
    sistemasPorVinculo: congelarProfundo({
      ...configuracao.sistemasPorVinculo,
      [alteracao.vinculo]: depois,
    }),
  };
  const evento = eventoDoGia(ctx, {
    tipo: 'configuracaoAlterada',
    antes: { vinculo: alteracao.vinculo, sistemas: antes },
    depois: { vinculo: alteracao.vinculo, sistemas: depois },
    dados: { versaoConfiguracao: nova.versao },
  });
  return sucesso({ configuracao: nova, eventos: [evento] });
}
