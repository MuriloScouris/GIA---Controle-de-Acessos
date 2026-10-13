import { falha, sucesso, type CodigoErro, type Resultado } from './resultado.js';
import { contemSegredo } from './sanitizacao.js';
import { textoPreenchido } from './tipos.js';

/**
 * Texto livre digitado por uma pessoa (observação, motivo). Precisa estar
 * preenchido e não pode conter segredo: é recusado antes de virar entidade,
 * resposta ou evento (regra 12). Recusar, em vez de mascarar, obriga quem
 * digitou a tirar o segredo e não deixa um registro parcial.
 */
export function exigirTextoLivre(
  texto: string,
  codigoSeVazio: Extract<CodigoErro, 'MOTIVO_OBRIGATORIO' | 'OBSERVACAO_OBRIGATORIA'>,
): Resultado<string> {
  if (!textoPreenchido(texto)) return falha(codigoSeVazio);
  if (contemSegredo(texto)) return falha('SEGREDO_NAO_PERMITIDO');
  return sucesso(texto.trim());
}
