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

  it.each([401, 403])(
    'recarga explícita com %s: nem consulta em voo nem a iniciada durante a recarga reativam o polling',
    async (status) => {
      vi.useFakeTimers();
      const inicial = controlada<string>();
      const pollAntigo = controlada<string>();
      const recarga = controlada<string>();
      const pollDuranteRecarga = controlada<string>();
      const fila = [inicial, pollAntigo, recarga, pollDuranteRecarga];
      const carregar = vi.fn(() => fila.shift()!.promessa);
      const { result } = renderHook(() =>
        useCarregar(carregar, { atualizarEnquanto: { intervaloMs: 1000, quando: () => true } }),
      );
      await act(async () => inicial.resolver('dados'));
      // Poll A fica em voo e, em seguida, a pessoa pede uma recarga explícita.
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      act(() => result.current.recarregar());
      expect(carregar).toHaveBeenCalledTimes(3);

      // O intervalo dispara durante a recarga: nenhuma consulta nova pode começar.
      await act(async () => vi.advanceTimersByTimeAsync(3000));
      expect(carregar).toHaveBeenCalledTimes(3);

      await act(async () => recarga.rejeitar(new ErroApi('negado', status)));
      expect(result.current.estado.situacao).toBe('erro');

      // A consulta antiga chega depois e não restaura os dados.
      await act(async () => pollAntigo.resolver('dados antigos'));
      await act(async () => pollDuranteRecarga.resolver('dados antigos'));
      expect(result.current.estado.situacao).toBe('erro');

      // E o polling não volta.
      await act(async () => vi.advanceTimersByTimeAsync(5000));
      expect(carregar).toHaveBeenCalledTimes(3);
    },
  );

  it('só a resposta válida da recarga libera o próximo ciclo de polling', async () => {
    vi.useFakeTimers();
    const inicial = controlada<string>();
    const recarga = controlada<string>();
    const poll = controlada<string>();
    const fila = [inicial, recarga, poll];
    const carregar = vi.fn(() => fila.shift()!.promessa);
    const { result } = renderHook(() =>
      useCarregar(carregar, { atualizarEnquanto: { intervaloMs: 1000, quando: () => true } }),
    );
    await act(async () => inicial.resolver('dados'));
    act(() => result.current.recarregar());
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(carregar).toHaveBeenCalledTimes(2);
    await act(async () => recarga.resolver('recarregados'));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(carregar).toHaveBeenCalledTimes(3);
    await act(async () => poll.resolver('atualizados'));
    expect(result.current.estado).toEqual({ situacao: 'ok', dados: 'atualizados' });
  });
});
