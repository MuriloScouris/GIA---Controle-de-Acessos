import { describe, expect, it } from 'vitest';
import { dentroDe, ehDn, mesmoDn, normalizarDn, valorDoPrimeiroRdn } from './dn.js';

describe('DN do AD (DEV-305)', () => {
  it('distingue DN de nome de grupo', () => {
    expect(ehDn('CN=GG-VPN,OU=TI,DC=exemplo,DC=local')).toBe(true);
    expect(ehDn(' cn = GG-VPN , ou=TI ,dc=exemplo ')).toBe(true);
    for (const nome of ['GG-VPN', 'GG VPN', 'GG=VPN', 'CN=GG-VPN', 'GG-VPN,TI', ''])
      expect(ehDn(nome), nome).toBe(false);
  });

  it('homônimos em OUs diferentes são DNs diferentes; caixa e espaços não importam', () => {
    expect(mesmoDn('CN=GG-VPN,OU=TI,DC=x', 'CN=GG-VPN,OU=RH,DC=x')).toBe(false);
    expect(mesmoDn('CN=GG-VPN,OU=TI,DC=x', 'cn=gg-vpn, ou=ti , dc=X')).toBe(true);
    expect(normalizarDn('CN=GG-VPN, OU=TI')).toBe('cn=gg-vpn,ou=ti');
  });

  it('respeita vírgula escapada no valor e devolve o cn sem escapes', () => {
    const dn = 'CN=Vendas\\, Sul,OU=Grupos,DC=x';
    expect(valorDoPrimeiroRdn(dn)).toBe('Vendas, Sul');
    expect(mesmoDn(dn, 'cn=vendas\\, sul,ou=grupos,dc=x')).toBe(true);
    expect(mesmoDn(dn, 'CN=Vendas,OU=Sul,OU=Grupos,DC=x')).toBe(false);
  });

  it('dentroDe só aceita a própria base ou descendentes', () => {
    expect(dentroDe('CN=G,OU=Grupos,DC=x', 'DC=x')).toBe(true);
    expect(dentroDe('DC=x', 'DC=x')).toBe(true);
    expect(dentroDe('CN=G,OU=Grupos,DC=outrox', 'DC=x')).toBe(false);
  });
});
