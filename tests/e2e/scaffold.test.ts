import { criarApp } from '@gia/api';
import { ErroConfiguracao, carregarConfiguracaoApi, saudeRespostaSchema } from '@gia/contratos';
import { iniciar } from '@gia/worker';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E2E simulado do scaffold: sobe API e worker em memória, com configuração falsa,
 * e garante que nenhuma chamada de rede externa é feita.
 */
describe('scaffold ponta a ponta (simulado)', () => {
  const fetchBloqueado = vi.fn(() => {
    throw new Error('chamada de rede externa não permitida nos testes');
  });

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchBloqueado);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchBloqueado.mockClear();
  });

  it('API e worker iniciam com a mesma configuração, com escrita externa desligada', async () => {
    const env = { GIA_AMBIENTE: 'teste', PORT: '8080' };
    const config = carregarConfiguracaoApi(env);
    expect(config).toEqual({ ambiente: 'teste', escritaExterna: false, porta: 8080 });

    const app = criarApp();
    const res = await app.inject({ method: 'GET', url: '/saude' });
    expect(saudeRespostaSchema.parse(res.json())).toEqual({ status: 'ok' });
    await app.close();

    expect(iniciar(env)).toBe('worker pronto (teste, escrita externa desligada)');
    expect(fetchBloqueado).not.toHaveBeenCalled();
  });

  it('API e worker recusam a mesma configuração inválida', () => {
    const env = { GIA_ESCRITA_EXTERNA: 'true' };
    expect(() => carregarConfiguracaoApi(env)).toThrow(ErroConfiguracao);
    expect(() => iniciar(env)).toThrow(ErroConfiguracao);
  });

  it('rota inexistente na API devolve 404 sem efeito externo', async () => {
    const app = criarApp();
    const res = await app.inject({ method: 'POST', url: '/pedidos' });
    expect(res.statusCode).toBe(404);
    await app.close();
    expect(fetchBloqueado).not.toHaveBeenCalled();
  });
});
