import { exigirPermissao, type ContextoComando } from '../autorizacao/ator.js';
import { ehCpfValido, normalizarCpf } from '../comum/cpf.js';
import { exigirTransicao, type TabelaTransicoes } from '../comum/maquina-estados.js';
import { falha, sucesso, type Resultado } from '../comum/resultado.js';
import { contemSegredo } from '../comum/sanitizacao.js';
import { ehDataCivilValida, textoPreenchido, type DataCivil, type Uuid } from '../comum/tipos.js';
import { exigirVersao, proximaVersao, VERSAO_INICIAL } from '../comum/versao.js';
import { eventoDoGia, type Evento } from '../eventos/evento.js';
import type { TipoVinculo } from '../sistemas/sistemas.js';
import type { IdentidadeProposta } from './identidade.js';

/** Identidade perene da pessoa; uma pessoa pode ter vários pedidos. */
export type StatusColaborador = 'ativo' | 'afastado' | 'desligado';

export const TRANSICOES_COLABORADOR: TabelaTransicoes<StatusColaborador> = {
  ativo: ['afastado', 'desligado'],
  afastado: ['ativo', 'desligado'],
  /** Readmissão. */
  desligado: ['ativo'],
};

export interface Colaborador {
  readonly id: Uuid;
  /** Somente dígitos; único. */
  readonly cpf: string;
  readonly matricula: string | null;
  readonly nome: string;
  /** Identidade efetiva: preenchida quando uma revisão é aprovada. */
  readonly login: string | null;
  readonly upn: string | null;
  readonly email: string | null;
  readonly tipoVinculo: TipoVinculo;
  readonly status: StatusColaborador;
  readonly dataAdmissao: DataCivil;
  readonly dataDesligamento: DataCivil | null;
  readonly versao: number;
}

export interface DadosNovoColaborador {
  readonly cpf: string;
  readonly matricula: string | null;
  readonly nome: string;
  readonly tipoVinculo: TipoVinculo;
  readonly dataAdmissao: DataCivil;
}

export function criarColaborador(
  dados: DadosNovoColaborador,
  ctx: ContextoComando,
): Resultado<{ readonly colaborador: Colaborador; readonly eventos: readonly Evento[] }> {
  if (!ehCpfValido(dados.cpf)) return falha('CPF_INVALIDO');
  if (!textoPreenchido(dados.nome)) return falha('DADO_INVALIDO', { campo: 'nome' });
  // Regra 12: nome e matrícula vão para a entidade, a resposta e o evento.
  if (contemSegredo([dados.nome, dados.matricula])) return falha('SEGREDO_NAO_PERMITIDO');
  if (!ehDataCivilValida(dados.dataAdmissao)) {
    return falha('DADO_INVALIDO', { campo: 'dataAdmissao' });
  }
  const colaborador: Colaborador = {
    id: ctx.novoId(),
    cpf: normalizarCpf(dados.cpf),
    matricula: textoPreenchido(dados.matricula) ? dados.matricula.trim() : null,
    nome: dados.nome.trim().replace(/\s+/g, ' '),
    login: null,
    upn: null,
    email: null,
    tipoVinculo: dados.tipoVinculo,
    status: 'ativo',
    dataAdmissao: dados.dataAdmissao,
    dataDesligamento: null,
    versao: VERSAO_INICIAL,
  };
  const evento = eventoDoGia(ctx, {
    tipo: 'colaboradorCriado',
    colaboradorId: colaborador.id,
    depois: colaborador,
  });
  return sucesso({ colaborador, eventos: [evento] });
}

/** Grava no colaborador a identidade aprovada. Usado pela aprovação do pedido. */
export function aplicarIdentidadeAprovada(
  colaborador: Colaborador,
  identidade: IdentidadeProposta,
  ctx: ContextoComando,
): { readonly colaborador: Colaborador; readonly eventos: readonly Evento[] } {
  if (
    colaborador.login === identidade.login &&
    colaborador.upn === identidade.upn &&
    colaborador.email === identidade.email
  ) {
    return { colaborador, eventos: [] };
  }
  const atualizado: Colaborador = {
    ...colaborador,
    login: identidade.login,
    upn: identidade.upn,
    email: identidade.email,
    versao: proximaVersao(colaborador),
  };
  const evento = eventoDoGia(ctx, {
    tipo: 'colaboradorIdentidadeAtualizada',
    colaboradorId: colaborador.id,
    antes: { login: colaborador.login, upn: colaborador.upn, email: colaborador.email },
    depois: { login: atualizado.login, upn: atualizado.upn, email: atualizado.email },
  });
  return { colaborador: atualizado, eventos: [evento] };
}

/**
 * Afastar, desligar ou reativar a pessoa. O desligamento (offboarding) está em
 * standby; a transição existe para que a estrutura já o preveja.
 */
export function alterarStatusColaborador(
  colaborador: Colaborador,
  alteracao: { readonly status: StatusColaborador; readonly data: DataCivil },
  versaoEsperada: number,
  ctx: ContextoComando,
): Resultado<{ readonly colaborador: Colaborador; readonly eventos: readonly Evento[] }> {
  const permissao = exigirPermissao(ctx.ator, 'executarOperacoes');
  if (!permissao.ok) return permissao;
  const versao = exigirVersao(colaborador, versaoEsperada);
  if (!versao.ok) return versao;
  const transicao = exigirTransicao(TRANSICOES_COLABORADOR, colaborador.status, alteracao.status);
  if (!transicao.ok) return transicao;
  if (!ehDataCivilValida(alteracao.data)) return falha('DADO_INVALIDO', { campo: 'data' });

  const atualizado: Colaborador = {
    ...colaborador,
    status: alteracao.status,
    ...(alteracao.status === 'desligado' ? { dataDesligamento: alteracao.data } : {}),
    ...(colaborador.status === 'desligado' && alteracao.status === 'ativo'
      ? { dataAdmissao: alteracao.data, dataDesligamento: null }
      : {}),
    versao: proximaVersao(colaborador),
  };
  const evento = eventoDoGia(ctx, {
    tipo: 'colaboradorStatusAlterado',
    colaboradorId: colaborador.id,
    antes: { status: colaborador.status },
    depois: { status: atualizado.status, data: alteracao.data },
  });
  return sucesso({ colaborador: atualizado, eventos: [evento] });
}
