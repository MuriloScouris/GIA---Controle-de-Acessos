import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  LIMITES_PADRAO,
  LoginsPendentes,
  origemDe,
  type LimitesLoginsPendentes,
} from '../sessao/logins-pendentes.js';
import { ErroLogin, retornoLocal, type ClienteOidc } from '../sessao/oidc.js';
import {
  COOKIE_SESSAO,
  enviarErro,
  exigirCsrf,
  lerCookie,
  type DependenciasHttp,
} from './protocolo.js';

/** Cookie que liga o retorno do Entra ID ao navegador que começou o login. */
export const COOKIE_ESTADO_OIDC = 'gia_oidc_estado';
/** Página de login da interface; o erro vai como código estável, nunca como texto do provedor. */
export const PAGINA_LOGIN = '/login';

/** Evento de auditoria do login: sem token, código, e-mail ou nome. */
export interface EventoLogin {
  readonly evento: 'login_iniciado' | 'login_concluido' | 'login_recusado' | 'logout';
  readonly codigo?: string;
  readonly usuarioId?: string;
  readonly papeis?: readonly string[];
}

export interface DependenciasOidcHttp extends DependenciasHttp {
  readonly oidc: ClienteOidc;
  readonly auditarLogin: (evento: EventoLogin) => void;
  /** Limites dos logins pendentes (M8); os testes reduzem para exercitar o teto. */
  readonly limites?: LimitesLoginsPendentes;
}

function cookieEstado(valor: string, maxAge: number): string {
  // Lax, e não Strict: o retorno é uma navegação vinda do domínio da Microsoft,
  // e um cookie Strict não seria enviado nela.
  return `${COOKIE_ESTADO_OIDC}=${valor}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function cookieSessao(valor: string, maxAge: number): string {
  return `${COOKIE_SESSAO}=${valor}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function iguais(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function paraLogin(reply: FastifyReply, codigo: string): FastifyReply {
  return reply
    .header('set-cookie', cookieEstado('', 0))
    .redirect(`${PAGINA_LOGIN}?erro=${encodeURIComponent(codigo)}`, 303);
}

/** Rotas do login de produção (Entra ID/OIDC). */
export function registrarRotasOidc(app: FastifyInstance, deps: DependenciasOidcHttp): void {
  const agora = () => Date.parse(deps.relogio.agora());
  const limites = deps.limites ?? LIMITES_PADRAO;
  const pendentes = new LoginsPendentes(agora, limites);

  app.get('/sessao/oidc/entrar', async (request, reply) => {
    const origem = origemDe(request.ip);
    const reserva = pendentes.reservar(origem);
    if (!reserva.ok) {
      // Mesma resposta para qualquer motivo: nada de contagem, limite ou origem para quem abusa.
      // O motivo vai só para a auditoria, sem IP.
      deps.auditarLogin({
        evento: 'login_recusado',
        codigo: reserva.motivo === 'origem' ? 'LOGIN_LIMITE_ORIGEM' : 'LOGIN_LIMITE_CAPACIDADE',
      });
      return paraLogin(reply, 'LOGIN_INDISPONIVEL');
    }
    const retorno = retornoLocal((request.query as Record<string, unknown>)['retorno']);
    const { url, pendente } = deps.oidc.iniciar(retorno);
    pendentes.guardar(origem, pendente);
    deps.auditarLogin({ evento: 'login_iniciado' });
    return reply
      .header('set-cookie', cookieEstado(pendente.estado, limites.validadeMs / 1000))
      .redirect(url, 302);
  });

  app.get('/sessao/oidc/retorno', async (request, reply) => {
    const q = request.query as Record<string, unknown>;
    const estado = typeof q['state'] === 'string' ? q['state'] : '';
    const doCookie = lerCookie(request.headers.cookie, COOKIE_ESTADO_OIDC) ?? '';
    // Uso único: o estado sai da lista aconteça o que acontecer; vencido não vale.
    const guardado = estado === '' ? undefined : pendentes.consumir(estado);
    const recusar = (codigo: string) => {
      deps.auditarLogin({ evento: 'login_recusado', codigo });
      return paraLogin(reply, codigo);
    };
    // Sem o cookie do mesmo navegador, é login forjado (CSRF de login) ou repetido.
    if (guardado === undefined || doCookie === '' || !iguais(doCookie, estado)) {
      return recusar('LOGIN_ESTADO_INVALIDO');
    }
    if (typeof q['error'] === 'string') return recusar('LOGIN_RECUSADO_PELO_PROVEDOR');
    const codigo = typeof q['code'] === 'string' ? q['code'] : '';
    if (codigo === '' || codigo.length > 4_000) return recusar('LOGIN_ESTADO_INVALIDO');

    let sessao;
    try {
      sessao = await deps.oidc.concluir(codigo, guardado);
    } catch (erro) {
      return recusar(erro instanceof ErroLogin ? erro.codigo : 'LOGIN_INDISPONIVEL');
    }
    // Sessão nova a cada login: um identificador anterior nunca é reaproveitado.
    deps.sessoes.encerrar(lerCookie(request.headers.cookie, COOKIE_SESSAO));
    const aberta = deps.sessoes.abrir(sessao);
    const segundos = Math.max(0, Math.floor((Date.parse(aberta.expiraEm) - agora()) / 1000));
    deps.auditarLogin({
      evento: 'login_concluido',
      usuarioId: sessao.usuarioId,
      papeis: sessao.papeis,
    });
    return reply
      .header('set-cookie', [cookieEstado('', 0), cookieSessao(aberta.id, segundos)])
      .redirect(guardado.retorno, 303);
  });

  /** Logout: encerra a sessão local sempre, mesmo que o Entra ID não responda depois. */
  app.post('/sessao/oidc/sair', async (request, reply) => {
    const csrf = exigirCsrf(request);
    if (!csrf.ok) return enviarErro(reply, csrf.erro);
    const id = lerCookie(request.headers.cookie, COOKIE_SESSAO);
    const aberta = deps.sessoes.autenticar(id);
    deps.sessoes.encerrar(id);
    deps.auditarLogin({
      evento: 'logout',
      ...(aberta === null ? {} : { usuarioId: aberta.sessao.usuarioId }),
    });
    return reply
      .header('set-cookie', cookieSessao('', 0))
      .send({ redirecionarPara: deps.oidc.urlDeLogout() });
  });
}
