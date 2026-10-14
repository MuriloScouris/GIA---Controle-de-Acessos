// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErroApi } from './cliente.js';
import { useCarregar } from './useCarregar.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function controlada<T>() {
  let resolver!: (valor: T) => void;
  let rejeitar!: (erro: unknown) => void;
  const promessa = new Promise<T>((res, rej) => {
    resolver = res;
    rejeitar = rej;
  });
  return { promessa, resolver, rejeitar };
}

describe('useCarregar: respostas fora de ordem', () => {
  it.each([401, 403])(
    'um %s mais novo não é desfeito por um sucesso antigo que chega depois',
    async (status) => {
      vi.useFakeTimers();
      const inicial = controlada<string>();
      const pollA = controlada<string>();
      const pollB = controlada<string>();
      const fila = [inicial, pollA, pollB];
      const carregar = vi.fn(() => fila.shift()!.promessa);
      const { result } = renderHook(() =>
        useCarregar(carregar, { atualizarEnquanto: { intervaloMs: 1000, quando: () => true } }),
      );
      await act(async () => inicial.resolver('dados'));
      expect(result.current.estado).toEqual({ situacao: 'ok', dados: 'dados' });

      // Duas consultas simultâneas: A (antiga) segue em voo, B recebe 401/403 primeiro.
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      expect(carregar).toHaveBeenCalledTimes(3);
      await act(async () => pollB.rejeitar(new ErroApi('negado', status)));
      expect(result.current.estado.situacao).toBe('erro');

      await act(async () => pollA.resolver('dados antigos'));
      expect(result.current.estado.situacao).toBe('erro');

      // Sem novas consultas até uma recarga explícita.
      await act(async () => vi.advanceTimersByTimeAsync(5000));
      expect(carregar).toHaveBeenCalledTimes(3);
    },
  );

  it('uma consulta posterior ao 401 ainda em voo também não reabre a tela', async () => {
    vi.useFakeTimers();
    const inicial = controlada<string>();
    const pollA = controlada<string>();
    const pollB = controlada<string>();
    const pollC = controlada<string>();
    const fila = [inicial, pollA, pollB, pollC];
    const carregar = vi.fn(() => fila.shift()!.promessa);
    const { result } = renderHook(() =>
      useCarregar(carregar, { atualizarEnquanto: { intervaloMs: 1000, quando: () => true } }),
    );
    await act(async () => inicial.resolver('dados'));
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    await act(async () => pollA.rejeitar(new ErroApi('expirou', 401)));
    await act(async () => pollC.resolver('dados antigos'));
    await act(async () => pollB.resolver('dados antigos'));
    expect(result.current.estado.situacao).toBe('erro');
  });

  it('a recarga explícita depois do erro volta a mostrar dados novos', async () => {
    vi.useFakeTimers();
    const inicial = controlada<string>();
    const poll = controlada<string>();
    const nova = controlada<string>();
    const fila = [inicial, poll, nova];
    const carregar = vi.fn(() => fila.shift()!.promessa);
    const { result } = renderHook(() =>
      useCarregar(carregar, { atualizarEnquanto: { intervaloMs: 1000, quando: () => true } }),
    );
    await act(async () => inicial.resolver('dados'));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await act(async () => poll.rejeitar(new ErroApi('expirou', 401)));
    expect(result.current.estado.situacao).toBe('erro');

    act(() => result.current.recarregar());
    await act(async () => nova.resolver('dados novos'));
    expect(result.current.estado).toEqual({ situacao: 'ok', dados: 'dados novos' });
  });
});
