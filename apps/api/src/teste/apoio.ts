import type { PapelHumano } from '@gia/contratos';
import { somarMs, type Instante } from '@gia/dominio';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { criarApp, type OpcoesApp } from '../app.js';
import { criarPersistenciaEmMemoria, type PersistenciaMemoria } from '../persistencia/memoria.js';
import { criarJiraSimulado } from '../simuladores/jira-simulado.js';

export const INICIO: Instante = '2026-10-13T12:00:00.000Z';
export const CSRF = { 'x-gia-csrf': '1' } as const;

export interface ApiDeTeste {
  readonly app: FastifyInstance;
  readonly persistencia: PersistenciaMemoria;
  readonly leiturasJira: () => number;
  avancar(ms: number): void;
  entrar(papel: PapelHumano): Promise<string>;
  get(cookie: string | null, url: string): Promise<LightMyRequestResponse>;
  post(
    cookie: string | null,
    url: string,
    corpo?: unknown,
    cabecalhos?: Record<string, string>,
  ): Promise<LightMyRequestResponse>;
  importar(cookie: string): Promise<LightMyRequestResponse>;
  comando(cookie: string, pedidoId: string, comando: unknown): Promise<LightMyRequestResponse>;
}

/** API em memória com Jira e diretório simulados e relógio controlado. */
export function montarApi(
  opcoes: OpcoesApp & { readonly chamados?: readonly unknown[] } = {},
): ApiDeTeste {
  let agora = INICIO;
  const persistencia = criarPersistenciaEmMemoria();
  const jira = criarJiraSimulado(opcoes.chamados);
  const app = criarApp({
    ambiente: 'teste',
    persistencia,
    fonteJira: jira.fonte,
    relogio: { agora: () => agora },
    ...opcoes,
  });

  const post: ApiDeTeste['post'] = (cookie, url, corpo, cabecalhos = CSRF) =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...cabecalhos, ...(cookie === null ? {} : { cookie }) },
      ...(corpo === undefined ? {} : { payload: corpo as object }),
    });

  return {
    app,
    persistencia,
    leiturasJira: jira.leituras,
    avancar(ms) {
      agora = somarMs(agora, ms);
    },
    async entrar(papel) {
      const res = await post(null, '/sessao/simulada', { papel });
      if (res.statusCode !== 201) throw new Error(`login simulado falhou: ${res.body}`);
      const cookie = String(res.headers['set-cookie']).split(';')[0];
      if (cookie === undefined) throw new Error('login simulado sem cookie');
      return cookie;
    },
    get: (cookie, url) =>
      app.inject({ method: 'GET', url, headers: cookie === null ? {} : { cookie } }),
    post,
    importar: (cookie) => post(cookie, '/importacoes/jira', {}),
    comando: (cookie, pedidoId, comando) => post(cookie, `/pedidos/${pedidoId}/comandos`, comando),
  };
}
