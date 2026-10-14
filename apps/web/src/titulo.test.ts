import { describe, expect, it } from 'vitest';
import { NOME_PRODUTO, TITULO_APLICACAO } from './titulo.js';

describe('@gia/web', () => {
  it('define o nome e o título da aplicação', () => {
    expect(NOME_PRODUTO).toBe('GIA');
    expect(TITULO_APLICACAO).toBe('GIA - Controle de Acessos');
  });
});
