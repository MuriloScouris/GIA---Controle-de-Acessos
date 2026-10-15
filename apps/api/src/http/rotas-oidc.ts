import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { ErroLogin, retornoLocal, type ClienteOidc, type LoginPendente } from '../sessao/oidc.js';
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

const VALIDADE_PENDENTE_MS = 10 * 60 * 1000;
/** Teto de logins pendentes: abrir o fluxo em massa não esgota a memória do processo. */
const MAXIMO_PENDENTES = 5_000;

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
  const pendentes = new Map<string, { pendente: LoginPendente; expiraEm: number }>();
  const agora = () => Date.parse(deps.relogio.agora());
  const limpar = () => {
    const t = agora();
    for (const [estado, { expiraEm }] of pendentes) if (expiraEm <= t) pendentes.delete(estado);
  };

  app.get('/sessao/oidc/entrar', async (request, reply) => {
    limpar();
    if (pendentes.size >= MAXIMO_PENDENTES) return paraLogin(reply, 'LOGIN_INDISPONIVEL');
    const retorno = retornoLocal((request.query as Record<string, unknown>)['retorno']);
    const { url, pendente } = deps.oidc.iniciar(retorno);
    pendentes.set(pendente.estado, { pendente, expiraEm: agora() + VALIDADE_PENDENTE_MS });
    deps.auditarLogin({ evento: 'login_iniciado' });
    return reply
      .header('set-cookie', cookieEstado(pendente.estado, VALIDADE_PENDENTE_MS / 1000))
      .redirect(url, 302);
  });

  app.get('/sessao/oidc/retorno', async (request, reply) => {
    const q = request.query as Record<string, unknown>;
    const estado = typeof q['state'] === 'string' ? q['state'] : '';
    const doCookie = lerCookie(request.headers.cookie, COOKIE_ESTADO_OIDC) ?? '';
    limpar();
    const guardado = estado === '' ? undefined : pendentes.get(estado);
    // Uso único: o estado sai da lista aconteça o que acontecer.
    if (estado !== '') pendentes.delete(estado);
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
      sessao = await deps.oidc.concluir(codigo, guardado.pendente);
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
      .redirect(guardado.pendente.retorno, 303);
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
