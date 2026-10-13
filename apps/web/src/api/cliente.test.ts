import { describe, expect, it } from 'vitest';
import { ErroApi, criarClienteApi } from './cliente.js';

const json = (corpo: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(corpo), { status }));

describe('cliente da API', () => {
  it('devolve a saúde validada pelo contrato', async () => {
    const cliente = criarClienteApi('http://api.teste', () => json({ status: 'ok' }));
    await expect(cliente.saude()).resolves.toEqual({ status: 'ok' });
  });

  it('rejeita resposta fora do contrato', async () => {
    const cliente = criarClienteApi('', () => json({ status: 'quebrado' }));
    await expect(cliente.saude()).rejects.toBeInstanceOf(ErroApi);
  });

  it('propaga o status HTTP de erro', async () => {
    const cliente = criarClienteApi('', () => json({}, 503));
    await expect(cliente.saude()).rejects.toMatchObject({ status: 503 });
  });
});
