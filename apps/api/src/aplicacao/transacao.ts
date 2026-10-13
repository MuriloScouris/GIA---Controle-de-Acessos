import type { ErroDominio, Resultado } from '@gia/dominio';
import type { Persistencia, Repositorios } from './portas.js';

class RecusaNaTransacao extends Error {
  constructor(readonly erro: ErroDominio) {
    super(erro.codigo);
  }
}

/**
 * Executa o caso de uso numa unidade de trabalho. Recusa do domínio desfaz
 * tudo o que já tinha sido gravado na mesma transação: estado, eventos e
 * operações da fila entram juntos ou não entram.
 */
export async function emTransacao<T>(
  persistencia: Persistencia,
  trabalho: (tx: Repositorios) => Promise<Resultado<T>>,
): Promise<Resultado<T>> {
  try {
    return await persistencia.executar(async (tx) => {
      const resultado = await trabalho(tx);
      if (!resultado.ok) throw new RecusaNaTransacao(resultado.erro);
      return resultado;
    });
  } catch (erro) {
    if (erro instanceof RecusaNaTransacao) return { ok: false, erro: erro.erro };
    throw erro;
  }
}
