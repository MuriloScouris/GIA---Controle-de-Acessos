import type { RespostaErro } from '@gia/contratos';
import {
  contemSegredo,
  criarAtorDaSessao,
  falha,
  mascararCpfs,
  rejeitarAtorNoPayload,
  sucesso,
  type CodigoErro,
  type ContextoComando,
  type ErroDominio,
  type Resultado,
  type Uuid,
} from '@gia/dominio';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Relogio } from '../aplicacao/portas.js';
import type { SessaoAberta, SessoesSimuladas } from '../sessao/sessoes-simuladas.js';

export const COOKIE_SESSAO = 'gia_sessao';

/**
 * Proteção CSRF das escritas: cabeçalho próprio, que um site de terceiros não
 * consegue enviar sem CORS (a API não habilita CORS), somado ao cookie
 * `SameSite=Strict`.
 */
export const CABECALHO_CSRF = 'x-gia-csrf';
export const VALOR_CSRF = '1';

const STATUS_HTTP: Partial<Readonly<Record<CodigoErro, number>>> = {
  DADO_INVALIDO: 400,
  ATOR_INFORMADO_PELO_CLIENTE: 400,
  SEGREDO_NAO_PERMITIDO: 400,
  CPF_INVALIDO: 400,
  MOTIVO_OBRIGATORIO: 400,
  OBSERVACAO_OBRIGATORIA: 400,
  NAO_AUTENTICADO: 401,
  PERMISSAO_NEGADA: 403,
  CSRF_INVALIDO: 403,
  NAO_ENCONTRADO: 404,
  CONFLITO_DE_VERSAO: 409,
  ERRO_INTERNO: 500,
  ACAO_INDISPONIVEL: 501,
};

/** Demais recusas do domínio são regras de negócio: 422. */
export function statusHttp(codigo: CodigoErro): number {
  return STATUS_HTTP[codigo] ?? 422;
}

/** Corpo de erro do contrato; detalhes já sanitizados pelo domínio e com CPF mascarado. */
export function corpoErro(erro: ErroDominio): RespostaErro {
  return {
    ok: false,
    codigo: erro.codigo,
    mensagem: erro.mensagem,
    ...(erro.detalhes === undefined ? {} : { detalhes: mascararCpfs({ ...erro.detalhes }) }),
  };
}

export function enviarErro(reply: FastifyReply, erro: ErroDominio): FastifyReply {
  return reply.code(statusHttp(erro.codigo)).send(corpoErro(erro));
}

export function enviarFalha(
  reply: FastifyReply,
  codigo: CodigoErro,
  detalhes?: Readonly<Record<string, unknown>>,
): FastifyReply {
  const recusa = falha(codigo, detalhes);
  return recusa.ok ? reply : enviarErro(reply, recusa.erro);
}

/** Forma mínima de um schema Zod de `@gia/contratos`. */
interface Esquema<T> {
  safeParse(valor: unknown):
    | { readonly success: true; readonly data: T }
    | {
        readonly success: false;
        readonly error: { readonly issues: readonly { readonly path: readonly PropertyKey[] }[] };
      };
}

/**
 * Valida a entrada no schema de contrato. Antes do formato, recusa ator no
 * corpo (regra 13) e segredo (regra 12), com o código estável de cada caso.
 * Os detalhes listam só os campos, nunca os valores recebidos.
 */
export function validarEntrada<T>(esquema: Esquema<T>, valor: unknown): Resultado<T> {
  const semAtor = rejeitarAtorNoPayload(valor);
  if (!semAtor.ok) return semAtor;
  if (contemSegredo(valor)) return falha('SEGREDO_NAO_PERMITIDO');
  const lido = esquema.safeParse(valor);
  if (lido.success) return sucesso(lido.data);
  const campos = [
    ...new Set(lido.error.issues.map((issue) => issue.path.map(String).join('.') || '(raiz)')),
  ];
  return falha('DADO_INVALIDO', { campos });
}

export function lerCookie(cabecalho: string | undefined, nome: string): string | undefined {
  if (cabecalho === undefined) return undefined;
  for (const parte of cabecalho.split(';')) {
    const separador = parte.indexOf('=');
    if (separador > 0 && parte.slice(0, separador).trim() === nome) {
      return parte.slice(separador + 1).trim();
    }
  }
  return undefined;
}

export interface DependenciasHttp {
  readonly sessoes: SessoesSimuladas;
  readonly relogio: Relogio;
  readonly gerarId: () => Uuid;
}

export function sessaoDaRequisicao(
  request: FastifyRequest,
  deps: DependenciasHttp,
): SessaoAberta | null {
  return deps.sessoes.autenticar(lerCookie(request.headers.cookie, COOKIE_SESSAO));
}

export function exigirCsrf(request: FastifyRequest): Resultado<true> {
  return request.headers[CABECALHO_CSRF] === VALOR_CSRF ? sucesso(true) : falha('CSRF_INVALIDO');
}

/**
 * Contexto do comando a partir da sessão do servidor. O ator nunca vem do
 * corpo, de cabeçalho ou de parâmetro (regra 13). Escritas exigem CSRF.
 */
export function contextoDaRequisicao(
  request: FastifyRequest,
  deps: DependenciasHttp,
  opcoes: { readonly escrita: boolean },
): Resultado<ContextoComando> {
  const aberta = sessaoDaRequisicao(request, deps);
  if (aberta === null) return falha('NAO_AUTENTICADO');
  if (opcoes.escrita) {
    const csrf = exigirCsrf(request);
    if (!csrf.ok) return csrf;
  }
  return sucesso({
    ator: criarAtorDaSessao(aberta.sessao),
    agora: deps.relogio.agora(),
    correlacaoId: request.id,
    novoId: deps.gerarId,
  });
}
