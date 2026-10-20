import { describe, expect, it } from 'vitest';
import { criarClienteOidc, type ConfiguracaoOidc } from './sessao/oidc.js';

/**
 * A autoridade do OIDC só muda por injeção programática, para os testes ponta
 * a ponta com provedor falso (DEV-303). Produção usa sempre o Entra ID, e um
 * valor fora de loopback HTTP é recusado ao montar o cliente.
 */
const CONFIG: ConfiguracaoOidc = {
  tenantId: '11111111-2222-4333-8444-555555555555',
  clientId: '66666666-7777-4888-9999-000000000000',
  arquivoSegredo: '/run/secrets/oidc',
  redirectUri: 'https://gia.exemplo.com.br/api/sessao/oidc/retorno',
  posLogoutUri: null,
  mapaPapeis: {},
};

describe('autoridade do OIDC', () => {
  it('sem injeção é o Entra ID do tenant', () => {
    const cliente = criarClienteOidc(CONFIG, { lerSegredo: async () => 'x' });
    const { url } = cliente.iniciar('/');
    expect(
      url.startsWith(`https://login.microsoftonline.com/${CONFIG.tenantId}/oauth2/v2.0/authorize?`),
    ).toBe(true);
    expect(cliente.urlDeLogout()).toBe(
      `https://login.microsoftonline.com/${CONFIG.tenantId}/oauth2/v2.0/logout`,
    );
  });

  it('provedor falso só em HTTP de loopback (127.0.0.1, localhost, [::1])', () => {
    for (const autoridade of [
      'http://127.0.0.1:9100',
      'http://localhost:9100',
      'http://[::1]:9100',
    ]) {
      const { url } = criarClienteOidc(CONFIG, { autoridade, lerSegredo: async () => 'x' }).iniciar(
        '/',
      );
      expect(url.startsWith(`${autoridade}/${CONFIG.tenantId}/oauth2/v2.0/authorize?`)).toBe(true);
    }
  });

  it.each([
    'https://login.microsoftonline.com.atacante.exemplo',
    'https://atacante.exemplo',
    'https://127.0.0.1:9100',
    'http://10.0.0.5:9100',
    'http://api.interna:9100',
    'http://127.0.0.1:9100/caminho',
    'http://usuario:senha@127.0.0.1:9100',
    'http://127.0.0.1:9100/?x=1',
    'nao-e-url',
  ])('recusa autoridade %s', (autoridade) => {
    expect(() => criarClienteOidc(CONFIG, { autoridade })).toThrow(/Autoridade OIDC/);
  });
});
