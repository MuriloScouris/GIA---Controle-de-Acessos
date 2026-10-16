import { autorizar, type AcaoFuncional } from '@gia/dominio';
import type { UsuarioSessao } from './sessao/Sessao.js';

/**
 * Só decide o que MOSTRAR: a matriz é a do domínio, sobre todos os papéis da
 * sessão. O servidor revalida cada comando e é quem de fato autoriza (regra 13).
 */
export function podeFazer(usuario: UsuarioSessao | null, acao: AcaoFuncional): boolean {
  return usuario !== null && autorizar([...usuario.papeis], acao).ok;
}
