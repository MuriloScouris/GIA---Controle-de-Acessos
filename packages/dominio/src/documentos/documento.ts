import type { ItemAcesso } from '../admissao/item-acesso.js';
import { chaveDeOrigem, type PedidoAdmissao } from '../admissao/pedido-admissao.js';
import type { Revisao } from '../admissao/revisao.js';
import { exigirPermissao, type ContextoComando } from '../autorizacao/ator.js';
import type { Colaborador } from '../colaborador/colaborador.js';
import { falha, sucesso, type Resultado } from '../comum/resultado.js';
import { mascararCpfEmTexto } from '../comum/sanitizacao.js';
import type { DataCivil, Instante } from '../comum/tipos.js';
import { eventoDoGia, type Evento } from '../eventos/evento.js';
import { itensDoDocumento } from '../execucao/execucao.js';
import {
  acessosEsperados,
  NOMES_SISTEMA,
  type Sistema,
  type TipoVinculo,
} from '../sistemas/sistemas.js';

/**
 * Funcionalidade 10 — documento de acessos. Só para pedido concluído, só com
 * os acessos confirmados pelo Gia (regra 9: simulado nunca confirma) e a
 * identidade efetiva. Não leva CPF, matrícula nem credenciais (regra 12): o
 * documento diz o que foi concedido, não como entrar.
 *
 * Duas camadas: (1) só campos permitidos — a referência externa do destino
 * fica de fora, porque o fornecedor pode usar CPF ou matrícula como
 * identificador (ex.: SoftExpert); (2) todo texto que entra passa pela
 * máscara de CPF e pela troca dos CPFs e matrículas conhecidos da pessoa.
 */

export interface AcessoDoDocumento {
  readonly sistema: Sistema;
  readonly nomeSistema: string;
  /** No formato de `acessosEsperados` (ex.: `conta`, `grupo:GG_Todos`). */
  readonly acessos: readonly string[];
  readonly confirmadoEm: Instante;
}

export interface DocumentoDeAcessos {
  /** Chave canônica da origem (ex.: `jira:RH-1001`). */
  readonly origem: string;
  readonly nome: string;
  readonly tipoVinculo: TipoVinculo;
  readonly dataAdmissao: DataCivil;
  readonly identidade: {
    readonly login: string | null;
    readonly upn: string | null;
    readonly email: string | null;
    readonly nomeExibicao: string;
  };
  readonly acessos: readonly AcessoDoDocumento[];
  readonly emitidoEm: Instante;
  readonly emitidoPor: string;
}

export type FormatoDocumento = 'docx';

/**
 * Monta o documento e o evento que registra a emissão (download auditado).
 * Exige a ação `baixarDocumento` (revisor, executor ou Administrador do Gia).
 */
export function emitirDocumentoDeAcessos(
  entrada: {
    readonly pedido: PedidoAdmissao;
    readonly revisao: Revisao | null;
    readonly colaborador: Colaborador | null;
    readonly itens: readonly ItemAcesso[];
    readonly formato: FormatoDocumento;
  },
  ctx: ContextoComando,
): Resultado<{ readonly documento: DocumentoDeAcessos; readonly evento: Evento }> {
  const permissao = exigirPermissao(ctx.ator, 'baixarDocumento');
  if (!permissao.ok) return permissao;
  const { pedido, revisao, colaborador } = entrada;
  const confirmados = itensDoDocumento(pedido, entrada.itens);
  if (!confirmados.ok) return confirmados;
  if (revisao?.id !== pedido.revisaoCorrenteId || revisao.situacao !== 'aprovada') {
    return falha('DOCUMENTO_INDISPONIVEL');
  }

  // Identidade efetiva: a do colaborador (gravada na execução) e, na falta, a aprovada.
  const aprovada = revisao.identidade;
  const documento: DocumentoDeAcessos = {
    origem: chaveDeOrigem(pedido.origem),
    nome: pedido.dadosRh.nomeCompleto,
    tipoVinculo: pedido.tipoVinculo,
    dataAdmissao: pedido.dadosRh.dataAdmissao,
    identidade: {
      login: colaborador?.login ?? aprovada?.login ?? null,
      upn: colaborador?.upn ?? aprovada?.upn ?? null,
      email: colaborador?.email ?? aprovada?.email ?? null,
      nomeExibicao: aprovada?.nomeExibicao ?? pedido.dadosRh.nomeCompleto,
    },
    acessos: confirmados.valor.map((item) => ({
      sistema: item.sistema,
      nomeSistema: NOMES_SISTEMA[item.sistema],
      acessos: acessosEsperados(item.parametros),
      // Item confirmado sempre tem `confirmadoEm`; o instante do pedido é só salvaguarda.
      confirmadoEm: item.confirmadoEm ?? pedido.atualizadoEm,
    })),
    emitidoEm: ctx.agora,
    emitidoPor: ctx.ator.nome,
  };
  const protegido = protegerDocumento(documento, [
    pedido.dadosRh.cpf,
    colaborador?.cpf ?? null,
    pedido.dadosRh.matricula,
    colaborador?.matricula ?? null,
  ]);
  const evento = eventoDoGia(ctx, {
    tipo: 'documentoEmitido',
    pedidoId: pedido.id,
    colaboradorId: pedido.colaboradorId,
    // Só o que identifica a emissão; nada de dado pessoal no evento.
    dados: {
      formato: entrada.formato,
      sistemas: documento.acessos.map((acesso) => acesso.sistema),
      versaoPedido: pedido.versao,
    },
  });
  return sucesso({ documento: protegido, evento });
}

/** Identificadores mais curtos que isto casariam com pedaços de outros textos. */
const TAMANHO_MINIMO_IDENTIFICADOR = 3;

function escaparRegex(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Aplica a máscara a todo texto do documento: CPF válido em qualquer formato
 * e, literalmente, os CPFs e matrículas conhecidos da pessoa (também só
 * dígitos e formatado), qualquer que seja o campo de onde vieram.
 */
function protegerDocumento(
  documento: DocumentoDeAcessos,
  conhecidos: readonly (string | null)[],
): DocumentoDeAcessos {
  const variantes = conhecidos
    .filter((valor): valor is string => valor !== null)
    .map((valor) => valor.trim())
    .flatMap((valor) => {
      const digitos = valor.replace(/\D/g, '');
      return digitos.length === 11
        ? [
            valor,
            digitos,
            `${digitos.slice(0, 3)}.${digitos.slice(3, 6)}.${digitos.slice(6, 9)}-${digitos.slice(9)}`,
          ]
        : [valor];
    })
    .filter((valor) => valor.length >= TAMANHO_MINIMO_IDENTIFICADOR);
  const padroes = [...new Set(variantes)]
    .sort((a, b) => b.length - a.length)
    .map((valor) => new RegExp(escaparRegex(valor), 'gi'));
  const proteger = (texto: string): string =>
    padroes.reduce((acc, padrao) => acc.replace(padrao, () => '***'), mascararCpfEmTexto(texto));
  const opcional = (texto: string | null): string | null =>
    texto === null ? null : proteger(texto);
  return {
    ...documento,
    origem: proteger(documento.origem),
    nome: proteger(documento.nome),
    identidade: {
      login: opcional(documento.identidade.login),
      upn: opcional(documento.identidade.upn),
      email: opcional(documento.identidade.email),
      nomeExibicao: proteger(documento.identidade.nomeExibicao),
    },
    acessos: documento.acessos.map((acesso) => ({
      ...acesso,
      acessos: acesso.acessos.map(proteger),
    })),
    emitidoPor: proteger(documento.emitidoPor),
  };
}
