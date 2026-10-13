import { ErroConfiguracao, saudeRespostaSchema } from '@gia/contratos';
import { describe, expect, it } from 'vitest';
import { criarApp } from './app.js';
import { iniciarApi } from './index.js';

describe('@gia/api', () => {
  it('responde ok em /saude conforme o contrato', async () => {
    const app = criarApp();
    const res = await app.inject({ method: 'GET', url: '/saude' });
    expect(res.statusCode).toBe(200);
    expect(saudeRespostaSchema.parse(res.json())).toEqual({ status: 'ok' });
    await app.close();
  });

  it.each(['abc', '0', '-1', '1.5', '70000'])('não inicia com PORT=%j', async (porta) => {
    await expect(iniciarApi({ PORT: porta })).rejects.toBeInstanceOf(ErroConfiguracao);
  });

  it('não inicia com ambiente inválido nem com escrita externa ligada', async () => {
    await expect(iniciarApi({ GIA_AMBIENTE: 'x' })).rejects.toBeInstanceOf(ErroConfiguracao);
    await expect(iniciarApi({ GIA_ESCRITA_EXTERNA: 'true' })).rejects.toBeInstanceOf(
      ErroConfiguracao,
    );
  });
});
