import type { AtorRegistrado } from '../autorizacao/ator.js';
import type { IdentidadeProposta, VerificacaoIdentidade } from '../colaborador/identidade.js';
import { congelarProfundo } from '../comum/imutavel.js';
import { falha, sucesso, type ErroDominio, type Resultado } from '../comum/resultado.js';
import { contemSegredo } from '../comum/sanitizacao.js';
import type { Instante, Uuid } from '../comum/tipos.js';
import { sistemaHabilitadoParaVinculo, type SistemasPorVinculo } from '../sistemas/configuracao.js';
import {
  sistemasSemDependencia,
  type ParametrosSistema,
  type Sistema,
  type TipoVinculo,
} from '../sistemas/sistemas.js';

/**
 * Revisão: a proposta (identidade + itens) que o operador ajusta e aprova.
 * Depois de aprovada é imutável e guarda a versão das regras usada; mudar
 * regras depois não altera o que já foi aprovado. Mudanças pedem nova revisão.
 */
export type SituacaoRevisao = 'rascunho' | 'aprovada';

export interface ItemProposto {
  readonly sistema: Sistema;
  readonly parametros: ParametrosSistema;
  /** Explica de onde veio a sugestão (regra de área/cargo, ajuste manual...). */
  readonly origemSugestao: string;
}

export interface Revisao {
  readonly id: Uuid;
  readonly pedidoId: Uuid;
  readonly numero: number;
  readonly identidade: IdentidadeProposta | null;
  /** Por que não foi possível derivar a identidade do e-mail do RH, se for o caso. */
  readonly pendenciaIdentidade: ErroDominio | null;
  readonly verificacaoIdentidade: VerificacaoIdentidade | null;
  readonly itens: readonly ItemProposto[];
  readonly versaoRegras: string;
  readonly situacao: SituacaoRevisao;
  readonly criadaEm: Instante;
  readonly baseadaEmRevisaoId: Uuid | null;
  readonly aprovadaPor: AtorRegistrado | null;
  readonly aprovadaEm: Instante | null;
}

/**
 * Valida os itens propostos: um item por sistema, parâmetros do próprio
 * sistema, sistema habilitado para o vínculo e nenhum segredo.
 */
export function validarItensPropostos(
  itens: readonly ItemProposto[],
  vinculo: TipoVinculo,
  sistemasPorVinculo: SistemasPorVinculo,
): Resultado<readonly ItemProposto[]> {
  const vistos = new Set<Sistema>();
  for (const item of itens) {
    if (vistos.has(item.sistema)) {
      return falha('SISTEMA_DUPLICADO_NA_REVISAO', { sistema: item.sistema });
    }
    vistos.add(item.sistema);
    if (item.parametros.sistema !== item.sistema) {
      return falha('PARAMETROS_DE_OUTRO_SISTEMA', {
        sistema: item.sistema,
        sistemaDosParametros: item.parametros.sistema,
      });
    }
    if (!sistemaHabilitadoParaVinculo(sistemasPorVinculo, vinculo, item.sistema)) {
      return falha('SISTEMA_NAO_HABILITADO_PARA_VINCULO', { sistema: item.sistema, vinculo });
    }
    if (contemSegredo(item)) {
      return falha('SEGREDO_NAO_PERMITIDO', { sistema: item.sistema });
    }
  }
  const dependencias = exigirDependenciasNaRevisao(itens);
  if (!dependencias.ok) return dependencias;
  return sucesso(itens);
}

/** Regra 7: M365 só entra numa revisão que também tem o item do AD. */
export function exigirDependenciasNaRevisao(itens: readonly ItemProposto[]): Resultado<true> {
  const semDependencia = sistemasSemDependencia(itens.map((item) => item.sistema));
  return semDependencia.length === 0
    ? sucesso(true)
    : falha('DEPENDENCIA_DE_SISTEMA_AUSENTE', { semDependencia });
}

/** Mantém os campos de identidade dos parâmetros iguais à identidade da revisão. */
export function aplicarIdentidadeAosParametros(
  identidade: IdentidadeProposta,
  parametros: ParametrosSistema,
): ParametrosSistema {
  switch (parametros.sistema) {
    case 'ad':
      return {
        ...parametros,
        login: identidade.login,
        upn: identidade.upn,
        email: identidade.email,
        proxyAddresses: identidade.proxyAddresses,
        nomeExibicao: identidade.nomeExibicao,
      };
    case 'm365':
      return { ...parametros, upn: identidade.upn, email: identidade.email };
    case 'docusign':
      return { ...parametros, email: identidade.email };
    case 'softexpert':
      return { ...parametros, login: identidade.login, email: identidade.email };
    case 'jira':
      return { ...parametros, email: identidade.email };
  }
}

export function alinharItensAIdentidade(
  identidade: IdentidadeProposta | null,
  itens: readonly ItemProposto[],
): readonly ItemProposto[] {
  if (identidade === null) return itens;
  return itens.map((item) => ({
    ...item,
    parametros: aplicarIdentidadeAosParametros(identidade, item.parametros),
  }));
}

export function exigirRascunho(revisao: Revisao): Resultado<Revisao> {
  return revisao.situacao === 'rascunho' ? sucesso(revisao) : falha('REVISAO_IMUTAVEL');
}

/** Congela a revisão aprovada: a partir daqui ela é evidência. */
export function aprovarRevisao(revisao: Revisao, ator: AtorRegistrado, agora: Instante): Revisao {
  return congelarProfundo({
    ...revisao,
    situacao: 'aprovada',
    aprovadaPor: ator,
    aprovadaEm: agora,
  });
}
