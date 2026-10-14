import {
  comandoSchema,
  importacaoJiraSchema,
  itemParamsSchema,
  loginSimuladoSchema,
  pedidoParamsSchema,
  type RespostaSucesso,
  type SessaoResposta,
} from '@gia/contratos';
import type { Resultado } from '@gia/dominio';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { executarComando } from '../aplicacao/comandos.js';
import {
  consultarItem,
  consultarItens,
  detalharPedido,
  listarPedidos,
} from '../aplicacao/consultas.js';
import type { DependenciasCasosDeUso } from '../aplicacao/dependencias.js';
import { importarChamadosJira } from '../aplicacao/importar-jira.js';
import { PESSOAS_FICTICIAS } from '../sessao/sessoes-simuladas.js';
import {
  COOKIE_SESSAO,
  contextoDaRequisicao,
  enviarErro,
  enviarFalha,
  exigirCsrf,
  lerCookie,
  sessaoDaRequisicao,
  validarEntrada,
  type DependenciasHttp,
} from './protocolo.js';

function responder<T>(reply: FastifyReply, resultado: Resultado<T>, status = 200): FastifyReply {
  return resultado.ok
    ? reply.code(status).send(resultado.valor)
    : enviarErro(reply, resultado.erro);
}

/** POST sem corpo chega como `undefined`; para o schema, é um objeto vazio. */
function corpo(valor: unknown): unknown {
  return valor ?? {};
}

function cookieSessao(valor: string, maxAgeSegundos: number): string {
  return `${COOKIE_SESSAO}=${valor}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSegundos}`;
}

/** Login simulado: só fora de produção, onde o login será OIDC com Entra ID. */
export function registrarRotasDeSessaoSimulada(app: FastifyInstance, deps: DependenciasHttp): void {
  app.post('/sessao/simulada', async (request, reply) => {
    const csrf = exigirCsrf(request);
    if (!csrf.ok) return enviarErro(reply, csrf.erro);
    const entrada = validarEntrada(loginSimuladoSchema, corpo(request.body));
    if (!entrada.ok) return enviarErro(reply, entrada.erro);
    deps.sessoes.encerrar(lerCookie(request.headers.cookie, COOKIE_SESSAO));
    const aberta = deps.sessoes.abrir(PESSOAS_FICTICIAS[entrada.valor.papel]);
    const segundos = Math.max(
      0,
      Math.floor((Date.parse(aberta.expiraEm) - Date.parse(deps.relogio.agora())) / 1000),
    );
    return reply
      .header('set-cookie', cookieSessao(aberta.id, segundos))
      .code(201)
      .send(respostaSessao(aberta));
  });
}

function respostaSessao(aberta: {
  readonly sessao: {
    readonly usuarioId: string;
    readonly nome: string;
    readonly papeis: readonly string[];
  };
  readonly expiraEm: string;
}): SessaoResposta {
  return {
    usuarioId: aberta.sessao.usuarioId,
    nome: aberta.sessao.nome,
    papeis: [...aberta.sessao.papeis] as SessaoResposta['papeis'],
    expiraEm: aberta.expiraEm,
  };
}

export function registrarRotas(
  app: FastifyInstance,
  deps: DependenciasHttp & { readonly casosDeUso: DependenciasCasosDeUso },
): void {
  const { casosDeUso } = deps;

  app.get('/sessao', async (request, reply) => {
    const aberta = sessaoDaRequisicao(request, deps);
    if (aberta === null) return enviarFalha(reply, 'NAO_AUTENTICADO');
    return reply.send(respostaSessao(aberta));
  });

  app.delete('/sessao', async (request, reply) => {
    const ctx = contextoDaRequisicao(request, deps, { escrita: true });
    if (!ctx.ok) return enviarErro(reply, ctx.erro);
    deps.sessoes.encerrar(lerCookie(request.headers.cookie, COOKIE_SESSAO));
    return reply.header('set-cookie', cookieSessao('', 0)).code(204).send();
  });

  app.post('/importacoes/jira', async (request, reply) => {
    const ctx = contextoDaRequisicao(request, deps, { escrita: true });
    if (!ctx.ok) return enviarErro(reply, ctx.erro);
    const entrada = validarEntrada(importacaoJiraSchema, corpo(request.body));
    if (!entrada.ok) return enviarErro(reply, entrada.erro);
    return responder(reply, await importarChamadosJira(casosDeUso, ctx.valor));
  });

  app.get('/pedidos', async (request, reply) => {
    const ctx = contextoDaRequisicao(request, deps, { escrita: false });
    if (!ctx.ok) return enviarErro(reply, ctx.erro);
    return responder(reply, await listarPedidos(casosDeUso, ctx.valor));
  });

  app.get('/pedidos/:pedidoId', async (request, reply) => {
    const ctx = contextoDaRequisicao(request, deps, { escrita: false });
    if (!ctx.ok) return enviarErro(reply, ctx.erro);
    const params = validarEntrada(pedidoParamsSchema, request.params);
    if (!params.ok) return enviarErro(reply, params.erro);
    return responder(reply, await detalharPedido(casosDeUso, params.valor.pedidoId, ctx.valor));
  });

  app.get('/pedidos/:pedidoId/itens', async (request, reply) => {
    const ctx = contextoDaRequisicao(request, deps, { escrita: false });
    if (!ctx.ok) return enviarErro(reply, ctx.erro);
    const params = validarEntrada(pedidoParamsSchema, request.params);
    if (!params.ok) return enviarErro(reply, params.erro);
    return responder(reply, await consultarItens(casosDeUso, params.valor.pedidoId, ctx.valor));
  });

  app.get('/pedidos/:pedidoId/itens/:itemId', async (request, reply) => {
    const ctx = contextoDaRequisicao(request, deps, { escrita: false });
    if (!ctx.ok) return enviarErro(reply, ctx.erro);
    const params = validarEntrada(itemParamsSchema, request.params);
    if (!params.ok) return enviarErro(reply, params.erro);
    const { pedidoId, itemId } = params.valor;
    return responder(reply, await consultarItem(casosDeUso, pedidoId, itemId, ctx.valor));
  });

  /** Comandos do pedido: `{ pedidoId, versaoEsperada, acao, dados }` (contrato). */
  app.post('/pedidos/:pedidoId/comandos', async (request, reply) => {
    const ctx = contextoDaRequisicao(request, deps, { escrita: true });
    if (!ctx.ok) return enviarErro(reply, ctx.erro);
    const params = validarEntrada(pedidoParamsSchema, request.params);
    if (!params.ok) return enviarErro(reply, params.erro);
    const comando = validarEntrada(comandoSchema, corpo(request.body));
    if (!comando.ok) return enviarErro(reply, comando.erro);
    if (comando.valor.pedidoId !== params.valor.pedidoId) {
      return enviarFalha(reply, 'DADO_INVALIDO', { campos: ['pedidoId'] });
    }
    const aceito = await executarComando(comando.valor, casosDeUso, ctx.valor);
    if (!aceito.ok) return enviarErro(reply, aceito.erro);
    const { status, versao, operacaoIds } = aceito.valor;
    const resposta: RespostaSucesso = {
      ok: true,
      status,
      versao,
      operacaoId: operacaoIds[0] ?? null,
      ...(operacaoIds.length > 0 ? { operacaoIds: [...operacaoIds] } : {}),
    };
    // Execução é assíncrona: a intenção foi gravada na fila e a resposta é "aceita".
    return reply.code(operacaoIds.length > 0 ? 202 : 200).send(resposta);
  });
}
