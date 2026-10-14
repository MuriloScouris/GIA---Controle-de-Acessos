import { autorizar, type AcaoFuncional } from '@gia/dominio';
import type { PerfilDemo } from './sessao/perfis.js';

/**
 * Só decide o que MOSTRAR: a matriz é a do domínio. O servidor revalida cada
 * comando e é quem de fato autoriza (regra 13).
 */
export function podeFazer(perfil: PerfilDemo | null, acao: AcaoFuncional): boolean {
  return perfil !== null && autorizar([perfil.id], acao).ok;
}
