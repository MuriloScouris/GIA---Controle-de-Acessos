import type { AddressInfo } from 'node:net';
import { RegistroMetricas, carregarGatesDeEscrita, servirMetricas } from '@gia/contratos';
import { afterEach, describe, expect, it } from 'vitest';
import { criarApp } from './app.js';
import { executarSmoke } from './smoke.js';

const abertos: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (abertos.length > 0) await abertos.pop()!();
});

/** API real escutando numa porta local: o smoke fala HTTP de verdade, como no deploy. */
async function subir(opcoes: Parameters<typeof criarApp>[0] = {}) {
  const metricas = new RegistroMetricas();
  const app = criarApp({ versao: 'smoke-1', metricas, ...opcoes });
  await app.listen({ port: 0, host: '127.0.0.1' });
  abertos.push(() => app.close());
  const servidor = await servirMetricas(metricas, { porta: 0 });
  abertos.push(() => new Promise((resolver) => servidor.close(resolver)));
  const { port } = app.server.address() as AddressInfo;
  const portaMetricas = (servidor.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    urlMetricas: `http://127.0.0.1:${portaMetricas}/metrics`,
  };
}

describe('smoke test pós-deploy', () => {
  it('passa contra uma API saudável, com escrita no modo esperado e métricas', async () => {
    const { url, urlMetricas } = await subir();
    const resultado = await executarSmoke({ url, urlMetricas, modoEsperado: 'simulado' });
    expect(resultado.filter((v) => !v.ok)).toEqual([]);
    expect(resultado.map((v) => v.nome)).toEqual([
      'vivacidade',
      'prontidao',
      'cabecalhos',
      'autenticacao',
      'metricas',
    ]);
  });

  it('falha (critério de rollback) se a escrita está num modo diferente do esperado', async () => {
    const gates = carregarGatesDeEscrita({
      GIA_AMBIENTE: 'teste',
      GIA_ESCRITA_EXTERNA: 'true',
      GIA_ESCRITA_LIBERADA: 'ad:criar',
    });
    const { url } = await subir({ ambiente: 'teste', gates });
    const prontidao = (await executarSmoke({ url, modoEsperado: 'simulado' })).find(
      (v) => v.nome === 'prontidao',
    );
    expect(prontidao).toMatchObject({
      ok: false,
      detalhe: 'escrita em modo real, esperado simulado',
    });
  });

  it('falha se uma dependência não está pronta', async () => {
    const { url } = await subir({
      verificacoes: { banco: () => Promise.reject(new Error('fora')) },
    });
    const prontidao = (await executarSmoke({ url })).find((v) => v.nome === 'prontidao');
    expect(prontidao).toMatchObject({ ok: false, detalhe: 'indisponível: banco' });
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

  it('API fora do ar: todas as verificações falham, sem lançar', async () => {
    const resultado = await executarSmoke({ url: 'http://127.0.0.1:1', timeoutMs: 500 });
    expect(resultado.every((v) => !v.ok)).toBe(true);
  });
});
