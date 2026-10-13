import { describe, expect, it } from 'vitest';
import { TITULO_APLICACAO } from './titulo.js';

describe('@gia/web', () => {
  it('define o título da aplicação', () => {
    expect(TITULO_APLICACAO).toBe('New GIA - Controle de Acessos');
  });
});
