import type { ConsultaHistorico, HistoricoPedido } from '@gia/contratos';
import {
  exigirPermissao,
  sucesso,
  type ContextoComando,
  type Resultado,
  type Uuid,
} from '@gia/dominio';
import type { DependenciasCasosDeUso } from './dependencias.js';
import { carregarPedidoVisivel } from './consultas.js';
import { projetarParaAtor } from './dados-pessoais.js';

export async function consultarHistorico(
  deps: DependenciasCasosDeUso,
  pedidoId: Uuid,
  consulta: ConsultaHistorico,
  ctx: ContextoComando,
): Promise<Resultado<HistoricoPedido>> {
  const permissao = exigirPermissao(ctx.ator, 'consultarAuditoria');
  if (!permissao.ok) return permissao;
  return deps.persistencia.executar(async (tx) => {
    const pedido = await carregarPedidoVisivel(tx, pedidoId, ctx);
    if (!pedido.ok) return pedido;
    const encontrados = await tx.eventos.doPedido(pedidoId, {
      limite: consulta.limite + 1,
      ...(consulta.cursor === undefined ? {} : { antesDe: consulta.cursor }),
    });
    const pagina = encontrados.slice(0, consulta.limite);
    const historico: HistoricoPedido = {
      pedidoId,
      eventos: pagina.map((evento) => ({
        id: evento.id,
        pedidoId,
        tipo: evento.tipo,
        origem: evento.origem,
        instante: evento.instante,
        ator: evento.ator === null ? null : { tipo: evento.ator.tipo, nome: evento.ator.nome },
        sistema: evento.sistema,
        operacaoId: evento.operacaoId,
        correlacaoId: evento.correlacaoId,
        corrigeEventoId: evento.corrigeEventoId,
      })),
      proximoCursor: encontrados.length > consulta.limite ? pagina.at(-1)!.id : null,
    };
    const colaborador = await tx.colaboradores.porId(pedido.valor.colaboradorId);
    return sucesso(
      projetarParaAtor(ctx, historico, {
        matriculas: [pedido.valor.dadosRh.matricula, colaborador?.matricula ?? null],
      }),
    );
  });
}
