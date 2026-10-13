import { congelarProfundo } from '../comum/imutavel.js';
import { falha, sucesso, type Resultado } from '../comum/resultado.js';
import type { Instante, Uuid } from '../comum/tipos.js';
import { autorizar, type AcaoFuncional, type NivelAcesso, type Papel } from './permissoes.js';

/**
 * Regra 13 — Ator vem da sessão. O servidor identifica quem agiu; o navegador
 * nunca informa o ator.
 *
 * `AtorAutenticado` tem uma marca de tipo que só `criarAtorDaSessao` e
 * `criarAtorDeServico` produzem. Todo comando do domínio exige o ator via
 * `ContextoComando`, nunca por campo do payload.
 */
declare const marcaAtorAutenticado: unique symbol;

/** Sessão já validada pela camada de autenticação (OIDC + cookie) no servidor. */
export interface SessaoAutenticada {
  readonly usuarioId: Uuid;
  readonly nome: string;
  readonly papeis: readonly Papel[];
}

interface DadosAtorHumano {
  readonly tipo: 'humano';
  readonly id: Uuid;
  readonly nome: string;
  readonly papeis: readonly Papel[];
}

interface DadosAtorServico {
  readonly tipo: 'servico';
  readonly id: string;
  readonly nome: string;
  readonly papeis: readonly Papel[];
  /** Humano que solicitou a operação executada pelo serviço. */
  readonly emNomeDe: Uuid | null;
}

export type AtorAutenticado = (DadosAtorHumano | DadosAtorServico) & {
  readonly [marcaAtorAutenticado]: true;
};

export function criarAtorDaSessao(sessao: SessaoAutenticada): AtorAutenticado {
  const ator: DadosAtorHumano = {
    tipo: 'humano',
    id: sessao.usuarioId,
    nome: sessao.nome,
    papeis: [...sessao.papeis],
  };
  return congelarProfundo(ator) as AtorAutenticado;
}

/** Identidade técnica do worker; age em nome do humano que pediu a operação. */
export function criarAtorDeServico(
  servico: { readonly id: string; readonly nome: string },
  emNomeDe: Uuid | null,
): AtorAutenticado {
  const ator: DadosAtorServico = {
    tipo: 'servico',
    id: servico.id,
    nome: servico.nome,
    papeis: ['servicoExecutor'],
    emNomeDe,
  };
  return congelarProfundo(ator) as AtorAutenticado;
}

/** Fotografia do ator gravada em revisões, operações e eventos. */
export type AtorRegistrado =
  | {
      readonly tipo: 'humano';
      readonly id: Uuid;
      readonly nome: string;
      readonly papeis: readonly Papel[];
    }
  | {
      readonly tipo: 'servico';
      readonly id: string;
      readonly nome: string;
      readonly papeis: readonly Papel[];
      readonly emNomeDe: Uuid | null;
    };

export function registrarAtor(ator: AtorAutenticado): AtorRegistrado {
  return ator.tipo === 'humano'
    ? { tipo: 'humano', id: ator.id, nome: ator.nome, papeis: [...ator.papeis] }
    : {
        tipo: 'servico',
        id: ator.id,
        nome: ator.nome,
        papeis: [...ator.papeis],
        emNomeDe: ator.emNomeDe,
      };
}

/** Tudo o que um comando recebe de fora além dos dados: ator, relógio, correlação e gerador de IDs. */
export interface ContextoComando {
  readonly ator: AtorAutenticado;
  readonly agora: Instante;
  readonly correlacaoId: string;
  readonly novoId: () => Uuid;
}

export function exigirPermissao(
  ator: AtorAutenticado,
  acao: AcaoFuncional,
): Resultado<NivelAcesso> {
  return autorizar(ator.papeis, acao);
}

/** Nomes de campo que identificariam o autor da ação se viessem do cliente. */
export const CAMPOS_DE_ATOR: readonly string[] = [
  'ator',
  'atorId',
  'autor',
  'autorId',
  'usuarioId',
  'operadorId',
  'aprovadoPor',
  'rejeitadoPor',
  'reabertoPor',
  'solicitadoPor',
  'solicitadaPor',
  'executadoPor',
  'registradoPor',
  'criadoPor',
  'criadaPor',
  'decididoPor',
  'emNomeDe',
];

const CAMPOS_DE_ATOR_NORMALIZADOS = new Set(CAMPOS_DE_ATOR.map((campo) => campo.toLowerCase()));

/** Recusa payloads do cliente que tentem informar o ator, em qualquer nível. */
export function rejeitarAtorNoPayload(payload: unknown): Resultado<true> {
  const campo = encontrarCampoDeAtor(payload, 0);
  return campo === null ? sucesso(true) : falha('ATOR_INFORMADO_PELO_CLIENTE', { campo });
}

function encontrarCampoDeAtor(valor: unknown, profundidade: number): string | null {
  if (valor === null || typeof valor !== 'object' || profundidade > 10) return null;
  const entradas: [string, unknown][] = Array.isArray(valor)
    ? valor.map((item: unknown, i) => [String(i), item])
    : Object.entries(valor);
  for (const [chave, item] of entradas) {
    if (CAMPOS_DE_ATOR_NORMALIZADOS.has(chave.toLowerCase())) return chave;
    const aninhado = encontrarCampoDeAtor(item, profundidade + 1);
    if (aninhado !== null) return `${chave}.${aninhado}`;
  }
  return null;
}

/**
 * Extrai do payload do cliente apenas os campos permitidos para o comando,
 * recusando campos de ator e campos desconhecidos.
 */
export function extrairDadosPermitidos<K extends string>(
  payload: unknown,
  permitidos: readonly K[],
): Resultado<Partial<Record<K, unknown>>> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return falha('DADO_INVALIDO', { motivo: 'payload deve ser um objeto' });
  }
  const semAtor = rejeitarAtorNoPayload(payload);
  if (!semAtor.ok) return semAtor;
  const desconhecidos = Object.keys(payload).filter(
    (chave) => !(permitidos as readonly string[]).includes(chave),
  );
  if (desconhecidos.length > 0)
    return falha('DADO_INVALIDO', { camposNaoPermitidos: desconhecidos });
  const dados: Partial<Record<K, unknown>> = {};
  for (const chave of permitidos) {
    if (Object.hasOwn(payload, chave)) dados[chave] = (payload as Record<string, unknown>)[chave];
  }
  return sucesso(dados);
}
