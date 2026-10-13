import { falha, sucesso, type Resultado } from './resultado.js';

/** Tabela de transições permitidas: para cada estado, os estados de destino. */
export type TabelaTransicoes<S extends string> = Readonly<Record<S, readonly S[]>>;

export function podeTransicionar<S extends string>(
  tabela: TabelaTransicoes<S>,
  de: S,
  para: S,
): boolean {
  return tabela[de].includes(para);
}

export function exigirTransicao<S extends string>(
  tabela: TabelaTransicoes<S>,
  de: S,
  para: S,
): Resultado<true> {
  return podeTransicionar(tabela, de, para)
    ? sucesso(true)
    : falha('TRANSICAO_INVALIDA', { de, para });
}

/** Exige que o estado atual esteja entre os permitidos para a ação. */
export function exigirEstado<S extends string>(
  atual: S,
  permitidos: readonly S[],
): Resultado<true> {
  return permitidos.includes(atual)
    ? sucesso(true)
    : falha('TRANSICAO_INVALIDA', { statusAtual: atual, statusPermitidos: permitidos });
}
