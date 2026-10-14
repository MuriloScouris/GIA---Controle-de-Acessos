import { describe, expect, it } from 'vitest';
import { escaparValorDn, escaparValorFiltroLdap, escaparXml } from './escape.js';

describe('escape nas fronteiras', () => {
  it('filtro LDAP (RFC 4515): neutraliza curingas, parênteses, barra, NUL e não ASCII', () => {
    expect(escaparValorFiltroLdap('maria.souza')).toBe('maria.souza');
    expect(escaparValorFiltroLdap('*)(uid=*))(|(uid=*')).toBe(
      '\\2a\\29\\28uid=\\2a\\29\\29\\28|\\28uid=\\2a',
    );
    expect(escaparValorFiltroLdap('a\\b')).toBe('a\\5cb');
    expect(escaparValorFiltroLdap('a\0b')).toBe('a\\00b');
    expect(escaparValorFiltroLdap('José')).toBe('Jos\\c3\\a9');
  });

  it('DN (RFC 4514): escapa separadores e as pontas', () => {
    expect(escaparValorDn('Maria Souza')).toBe('Maria Souza');
    expect(escaparValorDn('Souza, Maria+Teste')).toBe('Souza\\, Maria\\+Teste');
    expect(escaparValorDn('x,OU=Admins')).toBe('x\\,OU\\=Admins');
    expect(escaparValorDn('#Maria')).toBe('\\#Maria');
    expect(escaparValorDn(' Maria ')).toBe('\\ Maria\\ ');
    expect(escaparValorDn('a"b<c>d;e\\f')).toBe('a\\"b\\<c\\>d\\;e\\\\f');
  });

  it('XML: escapa os cinco caracteres e remove controles proibidos', () => {
    expect(escaparXml(`<a href="x">Tom & 'Jerry'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;Tom &amp; &apos;Jerry&apos;&lt;/a&gt;',
    );
    expect(escaparXml('a\u0000b\u0008c\td\ne')).toBe('abc\td\ne');
  });
});
