import type {
  ListaPedidos,
  OperacaoResumo,
  PedidoDetalhe,
  ResultadoItem,
  ResultadoItens,
} from '@gia/contratos';
import {
  exigirPermissao,
  falha,
  sucesso,
  type ContextoComando,
  type ItemAcesso,
  type Operacao,
  type PedidoAdmissao,
  type Resultado,
  type Uuid,
} from '@gia/dominio';
import { projetarParaAtor, type DadosSensiveis } from './dados-pessoais.js';
import type { DependenciasCasosDeUso } from './dependencias.js';
import type { Repositorios } from './portas.js';

/**
 * Recorte de leitura. `total` e `leitura` (auditor) veem todos os pedidos;
 * `restrito` e `proprio` (solicitante) só os que a própria pessoa importou,
 * até existir o escopo por pessoas/áreas do usuário. Fora do recorte, o
 * pedido é tratado como inexistente (não se revela que ele existe).
 */
async function recorteDeLeitura(
  tx: Repositorios,
  ctx: ContextoComando,
): Promise<Resultado<(pedido: PedidoAdmissao) => boolean>> {
  const nivel = exigirPermissao(ctx.ator, 'acompanharPedido');
  if (!nivel.ok) return nivel;
  if (nivel.valor === 'total' || nivel.valor === 'leitura') return sucesso(() => true);
  const abertosPeloAtor = new Set(
    (await tx.eventos.porTipo('pedidoRecebido'))
      .filter((evento) => evento.ator?.id === ctx.ator.id)
      .map((evento) => evento.pedidoId),
  );
  return sucesso((pedido) => abertosPeloAtor.has(pedido.id));
}

/** Matrículas da pessoa do pedido (RH e cadastro), para mascarar onde aparecerem em texto. */
async function sensiveisDoPedido(
  tx: Repositorios,
  pedido: PedidoAdmissao,
): Promise<DadosSensiveis> {
  const colaborador = await tx.colaboradores.porId(pedido.colaboradorId);
  return { matriculas: [pedido.dadosRh.matricula, colaborador?.matricula ?? null] };
}

async function carregarPedidoVisivel(
  tx: Repositorios,
  pedidoId: Uuid,
  ctx: ContextoComando,
): Promise<Resultado<PedidoAdmissao>> {
  const recorte = await recorteDeLeitura(tx, ctx);
  if (!recorte.ok) return recorte;
  const pedido = await tx.pedidos.porId(pedidoId);
  return pedido !== null && recorte.valor(pedido)
    ? sucesso(pedido)
    : falha('NAO_ENCONTRADO', { recurso: 'pedido' });
}

function resumoOperacao(operacao: Operacao): OperacaoResumo {
  return {
    id: operacao.id,
    acao: operacao.acao,
    modo: operacao.modo,
    status: operacao.status,
    efeito: operacao.efeito,
    codigo: operacao.codigo,
    mensagem: operacao.mensagem,
    tentativas: operacao.tentativas,
    criadaEm: operacao.criadaEm,
    atualizadaEm: operacao.atualizadaEm,
  };
}

function resultadoItem(item: ItemAcesso, operacoes: readonly Operacao[]): ResultadoItem {
  return {
    id: item.id,
    sistema: item.sistema,
    status: item.status,
    versao: item.versao,
    idExterno: item.idExterno,
    mensagem: item.mensagem,
    etapaAlcancada: item.etapaAlcancada,
    confirmadoEm: item.confirmadoEm,
    observacaoManual: item.observacaoManual,
    herdadoDeItemId: item.herdadoDeItemId,
    operacoes: operacoes
      .filter((operacao) => operacao.itemId === item.id)
      .sort((a, b) => a.criadaEm.localeCompare(b.criadaEm))
      .map(resumoOperacao),
  };
}

export async function listarPedidos(
  deps: DependenciasCasosDeUso,
  ctx: ContextoComando,
): Promise<Resultado<ListaPedidos>> {
  return deps.persistencia.executar(async (tx) => {
    const recorte = await recorteDeLeitura(tx, ctx);
    if (!recorte.ok) return recorte;
    const pedidos = (await tx.pedidos.todos())
      .filter(recorte.valor)
      .sort((a, b) => b.criadoEm.localeCompare(a.criadoEm) || a.id.localeCompare(b.id));
    const resumos: ListaPedidos['pedidos'] = [];
    for (const pedido of pedidos) {
      const resumo = {
        id: pedido.id,
        idExterno: pedido.origem.idExterno,
        tipoVinculo: pedido.tipoVinculo,
        status: pedido.status,
        versao: pedido.versao,
        nomeColaborador: pedido.dadosRh.nomeCompleto,
        criadoEm: pedido.criadoEm,
        atualizadoEm: pedido.atualizadoEm,
      };
      resumos.push(projetarParaAtor(ctx, resumo, await sensiveisDoPedido(tx, pedido)));
    }
    return sucesso({ pedidos: resumos });
  });
}

export async function detalharPedido(
  deps: DependenciasCasosDeUso,
  pedidoId: Uuid,
  ctx: ContextoComando,
): Promise<Resultado<PedidoDetalhe>> {
  return deps.persistencia.executar(async (tx) => {
    const carregado = await carregarPedidoVisivel(tx, pedidoId, ctx);
    if (!carregado.ok) return carregado;
    const pedido = carregado.valor;
    const revisao = await tx.revisoes.porId(pedido.revisaoCorrenteId);
    if (revisao === null) return falha('NAO_ENCONTRADO', { recurso: 'revisão' });
    const itens = (await tx.itens.doPedido(pedido.id)).filter(
      (item) => item.revisaoId === revisao.id,
    );
    const operacoes = await tx.operacoes.doPedido(pedido.id);
    const { identidade, verificacaoIdentidade, pendenciaIdentidade, aprovadaPor } = revisao;

    const detalhe: PedidoDetalhe = {
      id: pedido.id,
      origem: { sistema: pedido.origem.sistema, idExterno: pedido.origem.idExterno },
      tipoVinculo: pedido.tipoVinculo,
      status: pedido.status,
      versao: pedido.versao,
      motivoRejeicao: pedido.motivoRejeicao,
      criadoEm: pedido.criadoEm,
      atualizadoEm: pedido.atualizadoEm,
      colaboradorId: pedido.colaboradorId,
      dadosRh: { ...pedido.dadosRh },
      revisao: {
        id: revisao.id,
        numero: revisao.numero,
        situacao: revisao.situacao,
        versaoRegras: revisao.versaoRegras,
        identidade:
          identidade === null
            ? null
            : { ...identidade, proxyAddresses: [...identidade.proxyAddresses] },
        pendenciaIdentidade:
          pendenciaIdentidade === null
            ? null
            : { codigo: pendenciaIdentidade.codigo, mensagem: pendenciaIdentidade.mensagem },
        verificacaoIdentidade:
          verificacaoIdentidade === null
            ? null
            : {
                situacao: verificacaoIdentidade.situacao,
                conflitos: verificacaoIdentidade.conflitos.map((c) => ({ ...c })),
                verificadaEm: verificacaoIdentidade.verificadaEm,
              },
        itens: revisao.itens.map((item) => ({
          sistema: item.sistema,
          parametros: { ...item.parametros },
          origemSugestao: item.origemSugestao,
        })),
        aprovadaPor: aprovadaPor === null ? null : { id: aprovadaPor.id, nome: aprovadaPor.nome },
        aprovadaEm: revisao.aprovadaEm,
      },
      itens: itens.map((item) => resultadoItem(item, operacoes)),
    };
    // A projeção inteira, não só o campo `cpf`: texto livre também carrega dado pessoal.
    return sucesso(projetarParaAtor(ctx, detalhe, await sensiveisDoPedido(tx, pedido)));
  });
}

/** Resultado por item da revisão corrente, com as operações de cada um. */
export async function consultarItens(
  deps: DependenciasCasosDeUso,
  pedidoId: Uuid,
  ctx: ContextoComando,
): Promise<Resultado<ResultadoItens>> {
  return deps.persistencia.executar(async (tx) => {
    const carregado = await carregarPedidoVisivel(tx, pedidoId, ctx);
    if (!carregado.ok) return carregado;
    const pedido = carregado.valor;
    const itens = (await tx.itens.doPedido(pedido.id)).filter(
      (item) => item.revisaoId === pedido.revisaoCorrenteId,
    );
    const operacoes = await tx.operacoes.doPedido(pedido.id);
    const resultado: ResultadoItens = {
      pedidoId: pedido.id,
      status: pedido.status,
      versao: pedido.versao,
      itens: itens.map((item) => resultadoItem(item, operacoes)),
    };
    return sucesso(projetarParaAtor(ctx, resultado, await sensiveisDoPedido(tx, pedido)));
  });
}

/** Um item do pedido, de qualquer revisão (histórico). */
export async function consultarItem(
  deps: DependenciasCasosDeUso,
  pedidoId: Uuid,
  itemId: Uuid,
  ctx: ContextoComando,
): Promise<Resultado<ResultadoItem>> {
  return deps.persistencia.executar(async (tx) => {
    const carregado = await carregarPedidoVisivel(tx, pedidoId, ctx);
    if (!carregado.ok) return carregado;
    const item = (await tx.itens.doPedido(pedidoId)).find((candidato) => candidato.id === itemId);
    if (!item) return falha('NAO_ENCONTRADO', { recurso: 'item' });
    const resultado = resultadoItem(item, await tx.operacoes.doPedido(pedidoId));
    return sucesso(projetarParaAtor(ctx, resultado, await sensiveisDoPedido(tx, carregado.valor)));
  });
}
