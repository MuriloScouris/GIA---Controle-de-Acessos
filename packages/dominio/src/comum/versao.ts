import { falha, sucesso, type Resultado } from './resultado.js';

/**
 * Controle otimista de concorrência: toda entidade mutável carrega `versao`.
 * O comando informa a versão que o operador viu; se mudou, a ação é recusada
 * e a interface recarrega para revisar.
 */
export interface Versionado {
  readonly versao: number;
}

export const VERSAO_INICIAL = 1;

export function exigirVersao(entidade: Versionado, versaoEsperada: number): Resultado<true> {
  if (!Number.isInteger(versaoEsperada) || entidade.versao !== versaoEsperada) {
    return falha('CONFLITO_DE_VERSAO', { versaoAtual: entidade.versao, versaoEsperada });
  }
  return sucesso(true);
}

export function proximaVersao(entidade: Versionado): number {
  return entidade.versao + 1;
}
