import { describe, expect, it } from 'vitest';
import { criarApp } from './app.js';

describe('@gia/api', () => {
  it('responde ok em /saude', async () => {
    const app = criarApp();
    const res = await app.inject({ method: 'GET', url: '/saude' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});
