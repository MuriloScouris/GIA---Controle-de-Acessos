import {
  emitirDocumentoDeAcessos,
  type ContextoComando,
  type DocumentoDeAcessos,
  type Resultado,
  type Uuid,
} from '@gia/dominio';
import { carregarPedidoVisivel } from './consultas.js';
import type { DependenciasCasosDeUso } from './dependencias.js';
import { emTransacao } from './transacao.js';

/**
 * Emite o documento de acessos (funcionalidade 10). O pedido precisa estar
 * no recorte de leitura do ator; a permissão, o status e o conteúdo são do
 * domínio. A emissão é registrada (evento `documentoEmitido`) na mesma
 * transação: sem registro, não há documento.
 */
export function emitirDocumento(
  deps: DependenciasCasosDeUso,
  pedidoId: Uuid,
  ctx: ContextoComando,
): Promise<Resultado<DocumentoDeAcessos>> {
  return emTransacao(deps.persistencia, async (tx) => {
    const pedido = await carregarPedidoVisivel(tx, pedidoId, ctx);
    if (!pedido.ok) return pedido;
    const emitido = emitirDocumentoDeAcessos(
      {
        pedido: pedido.valor,
        revisao: await tx.revisoes.porId(pedido.valor.revisaoCorrenteId),
        colaborador: await tx.colaboradores.porId(pedido.valor.colaboradorId),
        itens: await tx.itens.doPedido(pedido.valor.id),
        formato: 'docx',
      },
      ctx,
    );
    if (!emitido.ok) return emitido;
    await tx.eventos.anexar([emitido.valor.evento]);
    return { ok: true, valor: emitido.valor.documento };
  });
}
