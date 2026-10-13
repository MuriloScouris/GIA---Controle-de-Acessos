import { describe, expect, it } from 'vitest';
import { NOME_PRODUTO, TITULO_APLICACAO } from './titulo.js';

describe('@gia/web', () => {
  it('define o nome e o título da aplicação', () => {
    expect(NOME_PRODUTO).toBe('Gia');
    expect(TITULO_APLICACAO).toBe('Gia - Controle de Acessos');
  });
});
