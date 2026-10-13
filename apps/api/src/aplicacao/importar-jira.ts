import { chamadoJiraSchema, type ResultadoImportacao } from '@gia/contratos';
import {
  chaveDeOrigem,
  exigirPermissao,
  normalizarCpf,
  receberChamado,
  sanitizar,
  sanitizarTexto,
  sucesso,
  MENSAGENS_ERRO,
  type ChamadoNormalizado,
  type ContextoComando,
  type Evento,
  type PedidoAdmissao,
  type Resultado,
  type Revisao,
  type TipoVinculo,
} from '@gia/dominio';
import { projetarParaAtor } from './dados-pessoais.js';
import type { DependenciasCasosDeUso } from './dependencias.js';
import { revalidarIdentidade } from './identidade.js';
import type { Repositorios } from './portas.js';
import { proporItens } from './regras-proposta.js';
import { emTransacao } from './transacao.js';

/** Request types do Jira que abrem onboarding, por vínculo. Os demais são ignorados. */
export const TIPOS_SOLICITACAO_ONBOARDING: Readonly<Record<string, TipoVinculo>> = {
  'Admissão - Celetista': 'celetista',
  'Admissão - Terceiro': 'terceiro',
};

type Recebimento =
  | { readonly tipo: 'duplicado'; readonly pedido: PedidoAdmissao }
  | {
      readonly tipo: 'criado';
      readonly pedido: PedidoAdmissao;
      readonly revisao: Revisao;
      readonly sistemasDescartados: ResultadoImportacao['criados'][number]['sistemasDescartados'];
    };

const PADRAO_CHAVE = /^[A-Z][A-Z0-9_]*-\d+$/;

/** Chave da issue para o relatório, só se tiver o formato esperado (nunca texto livre). */
function chaveLegivel(bruto: unknown): string | null {
  if (bruto === null || typeof bruto !== 'object' || !('key' in bruto)) return null;
  const chave = bruto.key;
  return typeof chave === 'string' && PADRAO_CHAVE.test(chave.trim()) ? chave.trim() : null;
}

/**
 * Importa os chamados de onboarding do Jira (simulado): valida cada chamado
 * no schema de contrato, normaliza, separa por vínculo e deduplica pela
 * origem (regra 10). Cada chamado é uma transação: um chamado recusado não
 * desfaz os outros. Nada é aprovado aqui; a proposta nasce pendente.
 */
export async function importarChamadosJira(
  deps: DependenciasCasosDeUso,
  ctx: ContextoComando,
): Promise<Resultado<ResultadoImportacao>> {
  const permissao = exigirPermissao(ctx.ator, 'criarPedido');
  if (!permissao.ok) return permissao;
  // Quem pode validar já sai com a identidade verificada; os demais deixam para o revisor.
  const podeVerificar = exigirPermissao(ctx.ator, 'validarConferirTestar').ok;

  const relatorio: {
    criados: ResultadoImportacao['criados'];
    duplicados: ResultadoImportacao['duplicados'];
    ignorados: ResultadoImportacao['ignorados'];
    recusados: ResultadoImportacao['recusados'];
  } = { criados: [], duplicados: [], ignorados: [], recusados: [] };

  for (const bruto of await deps.fonteJira.buscarChamadosOnboarding()) {
    const lido = chamadoJiraSchema.safeParse(bruto);
    if (!lido.success) {
      relatorio.recusados.push({
        chave: chaveLegivel(bruto),
        codigo: 'DADO_INVALIDO',
        mensagem: MENSAGENS_ERRO.DADO_INVALIDO,
        campos: [...new Set(lido.error.issues.map((issue) => issue.path.join('.')))],
      });
      continue;
    }
    const { key: chave, fields } = lido.data;
    const tipoVinculo = Object.hasOwn(TIPOS_SOLICITACAO_ONBOARDING, fields.tipoSolicitacao)
      ? TIPOS_SOLICITACAO_ONBOARDING[fields.tipoSolicitacao]
      : undefined;
    if (tipoVinculo === undefined) {
      relatorio.ignorados.push({ chave, tipoSolicitacao: sanitizarTexto(fields.tipoSolicitacao) });
      continue;
    }
    const chamado: ChamadoNormalizado = {
      origem: { sistema: 'jira', idExterno: chave },
      tipoVinculo,
      dadosRh: {
        nomeCompleto: fields.nomeCompleto,
        cpf: fields.cpf,
        matricula: fields.matricula,
        emailCorporativoSugerido: fields.emailCorporativo,
        area: fields.area,
        cargo: fields.cargo,
        dataAdmissao: fields.dataAdmissao,
        gestor: fields.gestor,
      },
    };

    const recebido = await emTransacao(deps.persistencia, (tx) =>
      receberUm(tx, chamado, podeVerificar, deps, ctx),
    );
    if (!recebido.ok) {
      const campo = recebido.erro.detalhes?.['campo'];
      relatorio.recusados.push({
        chave,
        codigo: recebido.erro.codigo,
        mensagem: recebido.erro.mensagem,
        campos: typeof campo === 'string' ? [campo] : [],
      });
    } else if (recebido.valor.tipo === 'duplicado') {
      relatorio.duplicados.push({ chave, pedidoId: recebido.valor.pedido.id });
    } else {
      const { pedido, revisao, sistemasDescartados } = recebido.valor;
      relatorio.criados.push({
        chave: pedido.origem.idExterno,
        pedidoId: pedido.id,
        tipoVinculo: pedido.tipoVinculo,
        status: pedido.status,
        versao: pedido.versao,
        sistemasPropostos: revisao.itens.map((item) => item.sistema),
        sistemasDescartados,
        pendenciaIdentidade: revisao.pendenciaIdentidade?.codigo ?? null,
      });
    }
  }
  // Chaves e tipos vêm do Jira: CPF colado neles também sai mascarado para quem não tem permissão plena.
  return sucesso(projetarParaAtor(ctx, relatorio));
}

async function receberUm(
  tx: Repositorios,
  chamado: ChamadoNormalizado,
  podeVerificar: boolean,
  deps: DependenciasCasosDeUso,
  ctx: ContextoComando,
): Promise<Resultado<Recebimento>> {
  const pedidoMesmaOrigem = await tx.pedidos.porOrigem(chaveDeOrigem(chamado.origem));
  const colaboradorExistente =
    pedidoMesmaOrigem === null
      ? await tx.colaboradores.porCpf(normalizarCpf(chamado.dadosRh.cpf))
      : null;
  // As sugestões viram parâmetros, eventos e resposta: partem dos dados já sanitizados.
  const itensSugeridos =
    pedidoMesmaOrigem === null ? proporItens(sanitizar(chamado.dadosRh), deps.regras) : [];
  const recebido = receberChamado(
    {
      chamado,
      pedidoMesmaOrigem,
      colaboradorExistente,
      configuracao: await tx.configuracao.atual(),
      versaoRegras: deps.regras.versao,
      itensSugeridos,
    },
    ctx,
  );
  if (!recebido.ok) return recebido;
  if (recebido.valor.tipo === 'duplicado') {
    return sucesso({ tipo: 'duplicado', pedido: recebido.valor.pedido });
  }

  let { pedido, revisao } = recebido.valor;
  const eventos: Evento[] = [...recebido.valor.eventos];
  if (podeVerificar) {
    const verificado = await revalidarIdentidade(
      tx,
      deps.diretorio,
      { pedido, revisao },
      pedido.versao,
      ctx,
    );
    if (!verificado.ok) return verificado;
    ({ pedido, revisao } = verificado.valor);
    eventos.push(...verificado.valor.eventos);
  }

  if (recebido.valor.colaboradorCriado) await tx.colaboradores.salvar(recebido.valor.colaborador);
  await tx.pedidos.salvar(pedido);
  await tx.revisoes.salvar(revisao);
  await tx.eventos.anexar(eventos);
  return sucesso({
    tipo: 'criado',
    pedido,
    revisao,
    sistemasDescartados: [...recebido.valor.sistemasDescartados],
  });
}
