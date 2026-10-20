import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErroFornecedor } from './erros.js';
import { criarFetchComPrazo, dentroDoPrazo, limitarAoPrazo } from './prazo.js';

const esperar = (ms: number) => new Promise((resolver) => setTimeout(resolver, ms));

/** Resposta cujo corpo registra o cancelamento, para provar que nada fica preso. */
function respostaComCorpo(status = 200) {
  let cancelado = false;
  const corpo = new ReadableStream<Uint8Array>({
    pull(controle) {
      controle.enqueue(new TextEncoder().encode('{"ok":true}'));
      controle.close();
    },
    cancel() {
      cancelado = true;
    },
  });
  return { resposta: new Response(corpo, { status }), cancelado: () => cancelado };
}

/** Transporte que responde `depoisMs` depois; ignora o cancelamento, como uma resposta já a caminho. */
function transporteQueResponde(depoisMs: number, status = 200) {
  const ultima: { corpo?: ReturnType<typeof respostaComCorpo> } = {};
  const enviar = vi.fn(async () => {
    await esperar(depoisMs);
    ultima.corpo = respostaComCorpo(status);
    return ultima.corpo.resposta;
  });
  return { enviar: enviar as unknown as typeof fetch, chamadas: enviar, ultima };
}

describe('criarFetchComPrazo: resposta antes e depois do prazo (M3)', () => {
  it('resposta dentro do prazo chega intacta, com o corpo legível', async () => {
    const { enviar } = transporteQueResponde(5);
    const resposta = await dentroDoPrazo(500, () =>
      criarFetchComPrazo(enviar)('https://destino.example/usuarios', { method: 'POST' }),
    );
    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toEqual({ ok: true });
  });

  it('sem prazo ativo, a resposta nunca é descartada', async () => {
    const { enviar } = transporteQueResponde(5);
    const resposta = await criarFetchComPrazo(enviar)('https://destino.example/x', {
      method: 'POST',
    });
    expect(resposta.status).toBe(200);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'post'])(
    'escrita (%s) com 2xx recebida depois do prazo vira resposta perdida, não timeout limpo',
    async (method) => {
      const { enviar, ultima } = transporteQueResponde(60, 201);
      const falha = await dentroDoPrazo(20, () =>
        criarFetchComPrazo(enviar)('https://destino.example/usuarios', { method }),
      ).catch((erro: unknown) => erro);
      expect(falha).toBeInstanceOf(ErroFornecedor);
      expect(falha).toMatchObject({
        tipo: 'respostaPerdida',
        codigo: 'INTEGRACAO_RESPOSTA_APOS_PRAZO',
      });
      // A resposta foi recebida: o corpo é cancelado, sem deixar a conexão presa.
      expect(ultima.corpo?.cancelado()).toBe(true);
    },
  );

  it('escrita feita por um Request também é tratada como escrita', async () => {
    const { enviar } = transporteQueResponde(60);
    const falha = await dentroDoPrazo(20, () =>
      criarFetchComPrazo(enviar)(new Request('https://destino.example/x', { method: 'POST' })),
    ).catch((erro: unknown) => erro);
    expect(falha).toMatchObject({ tipo: 'respostaPerdida' });
  });

  it.each([undefined, 'GET', 'HEAD', 'OPTIONS'])(
    'leitura (%s) recebida depois do prazo continua sendo timeout, com o corpo cancelado',
    async (method) => {
      const { enviar, ultima } = transporteQueResponde(60);
      const falha = await dentroDoPrazo(20, () =>
        criarFetchComPrazo(enviar)(
          'https://destino.example/usuarios',
          method === undefined ? {} : { method },
        ),
      ).catch((erro: unknown) => erro);
      expect(falha).toMatchObject({ tipo: 'timeout', codigo: 'INTEGRACAO_TIMEOUT' });
      expect(ultima.corpo?.cancelado()).toBe(true);
    },
  );

  it('com o prazo já vencido, nada é enviado', async () => {
    const { enviar, chamadas } = transporteQueResponde(0);
    await esperar(5);
    const falha = await dentroDoPrazo(-1, () =>
      criarFetchComPrazo(enviar)('https://destino.example/x', { method: 'POST' }),
    ).catch((erro: unknown) => erro);
    expect(falha).toMatchObject({ tipo: 'timeout', codigo: 'INTEGRACAO_TIMEOUT' });
    expect(chamadas).not.toHaveBeenCalled();
  });
});

describe('limitarAoPrazo: menor entre o timeout próprio e o prazo restante (M4)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function comRelogio(prazoMs: number, executar: (avancar: (ms: number) => void) => void) {
    vi.useFakeTimers({ toFake: ['Date'] });
    return dentroDoPrazo(prazoMs, async () => executar((ms) => vi.setSystemTime(Date.now() + ms)));
  }

  it('prazo restante menor: devolve o que resta', async () => {
    await comRelogio(1_000, (avancar) => {
      avancar(400);
      expect(limitarAoPrazo(10_000)).toBe(600);
    });
  });

  it('prazo restante maior: devolve o timeout próprio', async () => {
    await comRelogio(60_000, (avancar) => {
      avancar(1_000);
      expect(limitarAoPrazo(300)).toBe(300);
    });
  });

  it('prazo igual ao timeout: devolve o mesmo valor', async () => {
    await comRelogio(500, () => {
      expect(limitarAoPrazo(500)).toBe(500);
    });
  });

  it('prazo vencido (inclusive no último milissegundo): lança timeout do motor', async () => {
    await comRelogio(300, (avancar) => {
      avancar(300);
      expect(() => limitarAoPrazo(10_000)).toThrow(ErroFornecedor);
      avancar(5_000);
      expect(() => limitarAoPrazo(10_000)).toThrowError(
        expect.objectContaining({ tipo: 'timeout', codigo: 'INTEGRACAO_TIMEOUT' }),
      );
    });
  });

  it('fora de dentroDoPrazo: só o timeout próprio; nunca zero nem fracionário', () => {
    expect(limitarAoPrazo(250)).toBe(250);
    expect(limitarAoPrazo(0.2)).toBe(1);
    expect(limitarAoPrazo(100.4)).toBe(101);
  });
});
