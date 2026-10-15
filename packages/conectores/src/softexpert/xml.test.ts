import { describe, expect, it } from 'vitest';
import { XmlInvalido, descendente, lerXml, textoDe } from './xml.js';

/** Formato real do `getUserData` do SE Suite (levantamento de 2026-07-29), com dados fictícios. */
const RESPOSTA_REAL = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">
  <SOAP-ENV:Body>
    <getUserDataResponse xmlns="urn:admin">
      <data><item>
        <Usuário>173</Usuário>
        <Login>pessoa.ficticia</Login>
        <Nome>Pessoa Fictícia &amp; Cia</Nome>
        <E-mail>pessoa.ficticia@exemplo.com.br</E-mail>
        <department><item><iddepartment>INFRA</iddepartment><nmdepartment>Infraestrutura</nmdepartment></item></department>
        <position><item><idposition>0104</idposition><nmposition>Especialista</nmposition></item></position>
      </item></data>
      <return>1</return><Status>SUCCESS</Status><Detail>Executado com sucesso</Detail><Code>1</Code>
    </getUserDataResponse>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;

describe('leitor XML das respostas SOAP', () => {
  it('lê o envelope real: nomes locais, acentos e hífen nos nomes de campo, entidades', () => {
    const raiz = lerXml(RESPOSTA_REAL);
    expect(raiz.nome).toBe('Envelope');
    const item = descendente(raiz, 'item')!;
    expect(textoDe(item, 'Usuário')).toBe('173');
    expect(textoDe(item, 'E-mail')).toBe('pessoa.ficticia@exemplo.com.br');
    expect(textoDe(item, 'Nome')).toBe('Pessoa Fictícia & Cia');
    expect(textoDe(item, 'iddepartment')).toBe('INFRA');
    expect(textoDe(raiz, 'Status')).toBe('SUCCESS');
    expect(textoDe(raiz, 'NaoExiste')).toBe('');
  });

  it('lê CDATA, referências numéricas, elementos vazios e comentários', () => {
    const raiz = lerXml('<a><!-- x --><b><![CDATA[<cru>]]></b><c/><d>&#65;&#x42;</d></a>');
    expect(textoDe(raiz, 'b')).toBe('<cru>');
    expect(descendente(raiz, 'c')).toMatchObject({ nome: 'c', texto: '' });
    expect(textoDe(raiz, 'd')).toBe('AB');
  });

  it('recusa DOCTYPE: sem entidade externa (XXE) nem expansão em cascata', () => {
    const xxe =
      '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>';
    expect(() => lerXml(xxe)).toThrow(XmlInvalido);
    expect(() => lerXml('<r>&naoDeclarada;</r>')).toThrow(XmlInvalido);
  });

  it('recusa XML malformado, várias raízes, HTML e aninhamento exagerado', () => {
    for (const ruim of [
      '<a><b></a></b>',
      '<a></a><b></b>',
      '<a>',
      'texto solto',
      '<html><body>login page<br></body></html>',
      `${'<x>'.repeat(100)}${'</x>'.repeat(100)}`,
    ]) {
      expect(() => lerXml(ruim)).toThrow(XmlInvalido);
    }
  });
});
