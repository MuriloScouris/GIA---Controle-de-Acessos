import type { AcaoComando, Comando } from '@gia/contratos';
import {
  aprovarPedido,
  editarProposta,
  exigirPermissao,
  exigirVersao,
  falha,
  reabrirPedido,
  recalcularIdentidade,
  registrarAcessoManual,
  rejeitarPedido,
  solicitarExecucao,
  sucesso,
  type AcaoFuncional,
  type AjusteManualIdentidade,
  type Colaborador,
  type ContextoComando,
  type Evento,
  type ItemAcesso,
  type ItemProposto,
  type Operacao,
  type PedidoAdmissao,
  type Resultado,
  type Revisao,
  type StatusPedido,
  type Uuid,
} from '@gia/dominio';
import type { DependenciasCasosDeUso } from './dependencias.js';
import { revalidarIdentidade } from './identidade.js';
import type { Repositorios } from './portas.js';
import { emTransacao } from './transacao.js';

/** Permissão exigida por ação, checada antes de qualquer leitura (não revela se o pedido existe). */
const PERMISSAO_DA_ACAO: Readonly<Record<AcaoComando, AcaoFuncional>> = {
  editarProposta: 'editarProposta',
  recalcularIdentidade: 'editarProposta',
  aprovar: 'decidirPedido',
  rejeitar: 'decidirPedido',
  reabrir: 'decidirPedido',
  solicitarExecucao: 'executarOperacoes',
  conferirExistencia: 'validarConferirTestar',
  registrarAcessoManual: 'registrarManualReconciliar',
  reconciliar: 'registrarManualReconciliar',
};

/** Dependem de conector (conferência no destino); chegam com o worker. */
const ACOES_INDISPONIVEIS: readonly AcaoComando[] = ['conferirExistencia', 'reconciliar'];

export interface ComandoAceito {
  readonly status: StatusPedido;
  readonly versao: number;
  /** Operações gravadas na fila por este comando (só `solicitarExecucao`). */
  readonly operacaoIds: readonly Uuid[];
}

interface Mudancas {
  readonly pedido: PedidoAdmissao;
  readonly revisao?: Revisao;
  readonly colaborador?: Colaborador;
  readonly itens?: readonly ItemAcesso[];
  readonly operacoes?: readonly Operacao[];
  readonly eventos: readonly Evento[];
}

/** Estado, fila e eventos na mesma unidade de trabalho. */
async function gravar(tx: Repositorios, mudancas: Mudancas): Promise<Resultado<ComandoAceito>> {
  await tx.pedidos.salvar(mudancas.pedido);
  if (mudancas.revisao) await tx.revisoes.salvar(mudancas.revisao);
  if (mudancas.colaborador) await tx.colaboradores.salvar(mudancas.colaborador);
  if (mudancas.itens) await tx.itens.salvar(mudancas.itens);
  if (mudancas.operacoes) await tx.operacoes.salvar(mudancas.operacoes);
  await tx.eventos.anexar(mudancas.eventos);
  return sucesso({
    status: mudancas.pedido.status,
    versao: mudancas.pedido.versao,
    operacaoIds: (mudancas.operacoes ?? []).map((operacao) => operacao.id),
  });
}

/**
 * Executa um comando sobre um pedido. O comando já chega validado pelo schema
 * de contrato e o ator vem do contexto (sessão), nunca do comando. Status,
 * versão e permissão são guardados pelo domínio; aqui só se carrega, grava e
 * encadeia a revalidação de identidade.
 */
export async function executarComando(
  comando: Comando,
  deps: DependenciasCasosDeUso,
  ctx: ContextoComando,
): Promise<Resultado<ComandoAceito>> {
  const permissao = exigirPermissao(ctx.ator, PERMISSAO_DA_ACAO[comando.acao]);
  if (!permissao.ok) return permissao;
  if (ACOES_INDISPONIVEIS.includes(comando.acao)) {
    return falha('ACAO_INDISPONIVEL', { acao: comando.acao });
  }

  return emTransacao(deps.persistencia, async (tx) => {
    const pedido = await tx.pedidos.porId(comando.pedidoId);
    if (pedido === null) return falha('NAO_ENCONTRADO', { recurso: 'pedido' });
    const revisao = await tx.revisoes.porId(pedido.revisaoCorrenteId);
    if (revisao === null) return falha('NAO_ENCONTRADO', { recurso: 'revisão' });
    const configuracao = await tx.configuracao.atual();
    const { versaoEsperada } = comando;

    switch (comando.acao) {
      case 'editarProposta': {
        const { identidade, itens } = comando.dados;
        const editado = editarProposta(
          {
            pedido,
            revisao,
            configuracao,
            ...(identidade === undefined ? {} : { identidade: paraAjuste(identidade) }),
            ...(itens === undefined ? {} : { itens: itens satisfies readonly ItemProposto[] }),
          },
          versaoEsperada,
          ctx,
        );
        if (!editado.ok) return editado;
        return revalidarEGravar(tx, deps, editado.valor, ctx);
      }
      case 'recalcularIdentidade': {
        const recalculado = recalcularIdentidade(
          { pedido, revisao, configuracao },
          versaoEsperada,
          ctx,
        );
        if (!recalculado.ok) return recalculado;
        return revalidarEGravar(tx, deps, recalculado.valor, ctx);
      }
      case 'aprovar': {
        // A aprovação exige verificação atual: revalida agora, na mesma transação.
        const verificado = await revalidarIdentidade(
          tx,
          deps.diretorio,
          { pedido, revisao },
          versaoEsperada,
          ctx,
        );
        if (!verificado.ok) return verificado;
        const colaborador = await tx.colaboradores.porId(pedido.colaboradorId);
        if (colaborador === null) return falha('NAO_ENCONTRADO', { recurso: 'colaborador' });
        const aprovado = aprovarPedido(
          {
            pedido: verificado.valor.pedido,
            revisao: verificado.valor.revisao,
            colaborador,
            itensAnteriores: await tx.itens.doPedido(pedido.id),
          },
          // Sem verificação (identidade ausente) a versão é a vista; com ela, a seguinte.
          verificado.valor.pedido.versao === pedido.versao
            ? versaoEsperada
            : verificado.valor.pedido.versao,
          ctx,
        );
        if (!aprovado.ok) return aprovado;
        return gravar(tx, {
          ...aprovado.valor,
          eventos: [...verificado.valor.eventos, ...aprovado.valor.eventos],
        });
      }
      case 'rejeitar': {
        const rejeitado = rejeitarPedido(
          { pedido, motivo: comando.dados.motivo },
          versaoEsperada,
          ctx,
        );
        if (!rejeitado.ok) return rejeitado;
        return gravar(tx, rejeitado.valor);
      }
      case 'reabrir': {
        const reaberto = reabrirPedido(
          {
            pedido,
            revisao,
            itens: await tx.itens.doPedido(pedido.id),
            motivo: comando.dados.motivo,
          },
          versaoEsperada,
          ctx,
        );
        if (!reaberto.ok) return reaberto;
        return gravar(tx, reaberto.valor);
      }
      case 'solicitarExecucao': {
        const { itemIds } = comando.dados;
        const solicitado = solicitarExecucao(
          {
            pedido,
            revisao,
            itens: await tx.itens.doPedido(pedido.id),
            operacoesExistentes: await tx.operacoes.doPedido(pedido.id),
            configuracao,
            modo: deps.modoExecucao,
            ...(itemIds === undefined ? {} : { itemIds }),
          },
          versaoEsperada,
          ctx,
        );
        if (!solicitado.ok) return solicitado;
        return gravar(tx, solicitado.valor);
      }
      case 'registrarAcessoManual': {
        // O comando traz a versão do pedido que o operador viu; a do item é conferida pelo domínio.
        const versao = exigirVersao(pedido, versaoEsperada);
        if (!versao.ok) return versao;
        const item = (await tx.itens.doPedido(pedido.id)).find(
          (candidato) => candidato.id === comando.dados.itemId,
        );
        if (!item) return falha('ITEM_FORA_DO_PEDIDO', { itemId: comando.dados.itemId });
        const registrado = registrarAcessoManual(
          { pedido, item, observacao: comando.dados.observacao },
          item.versao,
          ctx,
        );
        if (!registrado.ok) return registrado;
        return gravar(tx, {
          pedido,
          itens: [registrado.valor.item],
          eventos: registrado.valor.eventos,
        });
      }
      case 'conferirExistencia':
      case 'reconciliar':
        return falha('ACAO_INDISPONIVEL', { acao: comando.acao });
    }
  });
}

/** Editar ou recalcular invalida a verificação anterior: revalida em seguida, na mesma transação. */
async function revalidarEGravar(
  tx: Repositorios,
  deps: DependenciasCasosDeUso,
  alterada: {
    readonly pedido: PedidoAdmissao;
    readonly revisao: Revisao;
    readonly eventos: readonly Evento[];
  },
  ctx: ContextoComando,
): Promise<Resultado<ComandoAceito>> {
  const verificado = await revalidarIdentidade(
    tx,
    deps.diretorio,
    alterada,
    alterada.pedido.versao,
    ctx,
  );
  if (!verificado.ok) return verificado;
  return gravar(tx, {
    pedido: verificado.valor.pedido,
    revisao: verificado.valor.revisao,
    eventos: [...alterada.eventos, ...verificado.valor.eventos],
  });
}

function paraAjuste(identidade: {
  readonly login: string;
  readonly email: string;
  readonly nomeExibicao: string;
  readonly upn?: string | undefined;
}): AjusteManualIdentidade {
  const { login, email, nomeExibicao, upn } = identidade;
  return { login, email, nomeExibicao, ...(upn === undefined ? {} : { upn }) };
}
