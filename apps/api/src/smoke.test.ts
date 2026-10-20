import type { AddressInfo } from 'node:net';
import { RegistroMetricas, carregarGatesDeEscrita, prontidaoRespostaSchema } from '@gia/contratos';
import { servirMetricas } from '@gia/contratos/observabilidade-servidor';
import { afterEach, describe, expect, it } from 'vitest';
import { criarApp } from './app.js';
import { prontidaoDetalhadaDe } from './http/observabilidade.js';
import { executarSmoke } from './smoke.js';

const abertos: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (abertos.length > 0) await abertos.pop()!();
});

/**
 * API real escutando numa porta local, com a porta interna montada como em
 * `iniciarApi` (métricas + prontidão detalhada): o smoke fala HTTP de verdade.
 */
async function subir(opcoes: Parameters<typeof criarApp>[0] = {}) {
  const metricas = new RegistroMetricas();
  const app = criarApp({ versao: 'smoke-1', metricas, ...opcoes });
  await app.listen({ port: 0, host: '127.0.0.1' });
  abertos.push(() => app.close());
  const servidor = await servirMetricas(metricas, {
    porta: 0,
    prontidao: prontidaoDetalhadaDe(app)!,
  });
  abertos.push(() => new Promise((resolver) => servidor.close(resolver)));
  const { port } = app.server.address() as AddressInfo;
  const portaMetricas = (servidor.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    urlMetricas: `http://127.0.0.1:${portaMetricas}/metrics`,
  };
}

/**
 * API falsa que responde saudável em qualquer origem (pública e interna) e
 * registra cada chamada: se o smoke aceitasse uma origem remota, tudo passaria.
 */
function apiFalsaSaudavel(opcoes: { readonly redirectInterno?: boolean } = {}) {
  const chamadas: string[] = [];
  const cabecalhos = {
    'x-correlacao-id': '00000000-0000-4000-8000-000000000001',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
  const enviar: typeof fetch = async (alvo) => {
    const u = new URL(String(alvo));
    chamadas.push(u.href);
    const interna = u.port === '9199' || u.hostname !== 'api.publica.invalid';
    if (interna && opcoes.redirectInterno)
      return new Response(null, { status: 302, headers: { location: 'http://192.0.2.10/' } });
    if (u.pathname === '/saude') return Response.json({ status: 'ok' }, { headers: cabecalhos });
    if (u.pathname === '/pedidos') return new Response(null, { status: 401 });
    if (u.pathname === '/saude/pronta')
      return interna
        ? Response.json({
            status: 'pronta',
            ambiente: 'producao',
            versao: 'v1',
            verificacoes: { persistencia: 'ok' },
            escrita: { modo: 'simulado', liberadas: [] },
          })
        : Response.json({ status: 'pronta' });
    if (u.pathname === '/metrics' || u.pathname === '/metricas')
      return new Response('gia_api_requisicoes_total 1\n');
    return new Response(null, { status: 404 });
  };
  return { enviar, chamadas };
}

const PUBLICA = 'https://api.publica.invalid';

describe('smoke test pós-deploy', () => {
  it('passa contra uma API saudável, com escrita no modo esperado e métricas', async () => {
    const { url, urlMetricas } = await subir();
    const resultado = await executarSmoke({ url, urlMetricas, modoEsperado: 'simulado' });
    expect(resultado.filter((v) => !v.ok)).toEqual([]);
    expect(resultado.map((v) => v.nome)).toEqual([
      'vivacidade',
      'prontidao',
      'prontidao_interna',
      'cabecalhos',
      'autenticacao',
      'metricas',
    ]);
    expect(resultado.find((v) => v.nome === 'prontidao')?.detalhe).toBe(
      '/saude/pronta 200, só o status',
    );
  });

  it('falha (critério de rollback) se a escrita está num modo diferente do esperado', async () => {
    const gates = carregarGatesDeEscrita({
      GIA_AMBIENTE: 'teste',
      GIA_ESCRITA_EXTERNA: 'true',
      GIA_ESCRITA_LIBERADA: 'ad:criar',
    });
    const { url, urlMetricas } = await subir({ ambiente: 'teste', gates });
    const resultado = await executarSmoke({ url, urlMetricas, modoEsperado: 'simulado' });
    // A pública continua mínima e pronta; a divergência só aparece na porta interna.
    expect(resultado.find((v) => v.nome === 'prontidao')).toMatchObject({ ok: true });
    expect(resultado.find((v) => v.nome === 'prontidao_interna')).toMatchObject({
      ok: false,
      detalhe: 'escrita em modo real, esperado simulado',
    });
  });

  it('modo esperado sem a porta interna falha: a pública não informa a escrita', async () => {
    const { url } = await subir();
    const interna = (await executarSmoke({ url, modoEsperado: 'simulado' })).find(
      (v) => v.nome === 'prontidao_interna',
    );
    expect(interna).toMatchObject({
      ok: false,
      detalhe: 'porta interna obrigatória: informe GIA_SMOKE_METRICAS_URL',
    });
  });

  it('sem a porta interna o smoke nunca passa, mesmo sem modo esperado (revisão #31)', async () => {
    // Reprodução: antes, só as checagens públicas rodavam e todas davam OK (saída 0).
    const { enviar, chamadas } = apiFalsaSaudavel();
    const resultado = await executarSmoke({ url: PUBLICA, fetch: enviar });
    const falhas = resultado.filter((v) => !v.ok);
    expect(falhas.map((v) => v.nome)).toEqual(['prontidao_interna', 'metricas']);
    for (const falha of falhas)
      expect(falha.detalhe).toBe('porta interna obrigatória: informe GIA_SMOKE_METRICAS_URL');
    // As públicas continuam passando e nada além delas foi chamado.
    expect(chamadas.every((c) => c.startsWith(`${PUBLICA}/`))).toBe(true);
  });

  it.each([
    'http://192.0.2.10:9199/metrics',
    'https://api.example.invalid/metrics',
    'https://127.0.0.1:9199/metrics',
    'http://usuario:senha@127.0.0.1:9199/metrics',
    'http://127.0.0.1:9199/outro',
    'http://127.0.0.1:9199/metrics?alvo=x',
    'http://127.0.0.1:9199/metrics#x',
    'nao-e-url',
  ])(
    'porta interna fora de HTTP loopback com /metrics é recusada sem chamar: %s',
    async (urlMetricas) => {
      // Reprodução: antes, uma origem remota que respondesse os corpos certos passava.
      const { enviar, chamadas } = apiFalsaSaudavel();
      const resultado = await executarSmoke({
        url: PUBLICA,
        urlMetricas,
        modoEsperado: 'simulado',
        fetch: enviar,
      });
      for (const nome of ['prontidao_interna', 'metricas']) {
        const v = resultado.find((r) => r.nome === nome);
        expect(v?.ok).toBe(false);
        expect(v?.detalhe).toMatch(
          /^GIA_SMOKE_METRICAS_URL (deve ser http:\/\/ de loopback|inválida)/,
        );
        expect(v?.detalhe).not.toContain('senha');
      }
      expect(chamadas.filter((c) => !c.startsWith(`${PUBLICA}/`))).toEqual([]);
    },
  );

  it('porta interna válida em loopback (127.0.0.1, localhost, [::1]) com /metrics ou /metricas passa', async () => {
    for (const urlMetricas of [
      'http://127.0.0.1:9199/metrics',
      'http://localhost:9199/metricas',
      'http://[::1]:9199/metrics',
    ]) {
      const { enviar } = apiFalsaSaudavel();
      const resultado = await executarSmoke({
        url: PUBLICA,
        urlMetricas,
        modoEsperado: 'simulado',
        fetch: enviar,
      });
      expect(resultado.filter((v) => !v.ok)).toEqual([]);
    }
  });

  it('redirect na porta interna é recusado, sem seguir o destino', async () => {
    const { enviar, chamadas } = apiFalsaSaudavel({ redirectInterno: true });
    const resultado = await executarSmoke({
      url: PUBLICA,
      urlMetricas: 'http://127.0.0.1:9199/metrics',
      fetch: enviar,
    });
    for (const nome of ['prontidao_interna', 'metricas'])
      expect(resultado.find((r) => r.nome === nome)).toMatchObject({
        ok: false,
        detalhe: 'redirect recusado',
      });
    expect(chamadas.some((c) => c.includes('192.0.2.10'))).toBe(false);
  });

  it('falha se uma dependência não está pronta', async () => {
    const { url, urlMetricas } = await subir({
      verificacoes: { banco: () => Promise.reject(new Error('fora')) },
    });
    const resultado = await executarSmoke({ url, urlMetricas });
    expect(resultado.find((v) => v.nome === 'prontidao')).toMatchObject({
      ok: false,
      detalhe: '/saude/pronta respondeu 503',
    });
    expect(resultado.find((v) => v.nome === 'prontidao_interna')).toMatchObject({
      ok: false,
      detalhe: 'indisponível: banco',
    });
  });

  it('falha se a porta pública expõe detalhes operacionais (M7)', async () => {
    const { url } = await subir();
    const vazando: typeof fetch = async (alvo, init) =>
      String(alvo).endsWith('/saude/pronta')
        ? Response.json({ status: 'pronta', versao: 'v1', ambiente: 'producao' })
        : fetch(alvo, init);
    const prontidao = (await executarSmoke({ url, fetch: vazando })).find(
      (v) => v.nome === 'prontidao',
    );
    expect(prontidao).toMatchObject({
      ok: false,
      detalhe: '/saude/pronta pública expõe mais que o status',
    });
  });

  it('em produção exige que o login simulado não exista', async () => {
    // DEV-288: fora de produção a sessão simulada só existe com opt-in explícito.
    const naoProducao = await subir({ ambiente: 'teste', autenticacao: { modo: 'simulada' } });
    const login = (await executarSmoke({ url: naoProducao.url, producao: true })).find(
      (v) => v.nome === 'login_simulado_ausente',
    );
    expect(login).toMatchObject({ ok: false });

    const producao = await subir({ ambiente: 'producao' });
    const ok = (await executarSmoke({ url: producao.url, producao: true })).find(
      (v) => v.nome === 'login_simulado_ausente',
    );
    expect(ok).toMatchObject({ ok: true });
  });

  it('porta interna: só em loopback, detalhe com no-store, 404 sem provedor e 503 sem mensagem', async () => {
    const { urlMetricas } = await subir({ versao: 'interna-1' });
    const interna = new URL('/saude/pronta', urlMetricas);
    expect(interna.hostname).toBe('127.0.0.1');
    const res = await fetch(interna);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(prontidaoRespostaSchema.parse(await res.json())).toMatchObject({
      status: 'pronta',
      versao: 'interna-1',
      escrita: { modo: 'simulado', liberadas: [] },
    });

    const semProvedor = await servirMetricas(new RegistroMetricas(), { porta: 0 });
    abertos.push(() => new Promise((resolver) => semProvedor.close(resolver)));
    const enderecoSem = semProvedor.address() as AddressInfo;
    expect(enderecoSem.address).toBe('127.0.0.1');
    expect((await fetch(`http://127.0.0.1:${enderecoSem.port}/saude/pronta`)).status).toBe(404);

    const quebrado = await servirMetricas(new RegistroMetricas(), {
      porta: 0,
      prontidao: () => Promise.reject(new Error('detalhe interno postgres://gia:x@db')),
    });
    abertos.push(() => new Promise((resolver) => quebrado.close(resolver)));
    const porta = (quebrado.address() as AddressInfo).port;
    const falha = await fetch(`http://127.0.0.1:${porta}/saude/pronta`);
    expect(falha.status).toBe(503);
    expect(await falha.text()).toBe('');
  });

  it('API fora do ar: todas as verificações falham, sem lançar', async () => {
    const resultado = await executarSmoke({ url: 'http://127.0.0.1:1', timeoutMs: 500 });
    expect(resultado.every((v) => !v.ok)).toBe(true);
  });
});
