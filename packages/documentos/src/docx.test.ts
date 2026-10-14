import type { DocumentoDeAcessos } from '@gia/dominio';
import { describe, expect, it } from 'vitest';
import {
  criarZip,
  escaparXml,
  formatarInstante,
  gerarDocx,
  lerZip,
  nomeArquivoDocumento,
} from './index.js';

const DOCUMENTO: DocumentoDeAcessos = {
  origem: 'jira:RH-1001',
  nome: 'Bia Ficticia Lopes',
  tipoVinculo: 'celetista',
  dataAdmissao: '2026-11-03',
  identidade: {
    login: 'bia.lopes',
    upn: 'bia.lopes@exemplo.com.br',
    email: 'bia.lopes@exemplo.com.br',
    nomeExibicao: 'Bia Lopes',
  },
  acessos: [
    {
      sistema: 'ad',
      nomeSistema: 'Active Directory',
      acessos: ['conta', 'grupo:GG_Todos', 'grupo:GG_Tecnologia'],
      confirmadoEm: '2026-10-14T12:05:00.000Z',
    },
    {
      sistema: 'jira',
      nomeSistema: 'Jira',
      acessos: ['conta', 'grupo:jira-usuarios'],
      confirmadoEm: '2026-10-14T12:06:00.000Z',
    },
  ],
  emitidoEm: '2026-10-14T13:00:00.000Z',
  emitidoPor: 'Pessoa executor',
};

function documentoXml(bytes: Uint8Array): string {
  const parte = lerZip(bytes).get('word/document.xml');
  if (parte === undefined) throw new Error('DOCX sem word/document.xml');
  return new TextDecoder().decode(parte);
}

describe('formulário de acessos em DOCX', () => {
  it('é um pacote OOXML com tipos de conteúdo, relação e corpo do documento', () => {
    const partes = lerZip(gerarDocx(DOCUMENTO));
    expect([...partes.keys()]).toEqual(['[Content_Types].xml', '_rels/.rels', 'word/document.xml']);
    const tipos = new TextDecoder().decode(partes.get('[Content_Types].xml'));
    expect(tipos).toContain('wordprocessingml.document.main+xml');
    const relacoes = new TextDecoder().decode(partes.get('_rels/.rels'));
    expect(relacoes).toContain('Target="word/document.xml"');
  });

  it('traz a identidade efetiva e uma linha por acesso confirmado', () => {
    const xml = documentoXml(gerarDocx(DOCUMENTO));
    for (const esperado of [
      'Formulário de acessos',
      'jira:RH-1001',
      'Bia Ficticia Lopes',
      'Celetista',
      '03/11/2026',
      'bia.lopes@exemplo.com.br',
      'Active Directory',
      'grupo:GG_Tecnologia',
      '14/10/2026 12:05 (UTC)',
      'grupo:jira-usuarios',
      'Emitido por',
      'Pessoa executor',
      'não contém senhas',
    ]) {
      expect(xml, esperado).toContain(esperado);
    }
    expect(xml.match(/<w:tr>/g)).toHaveLength(3); // cabeçalho + 2 acessos
  });

  it('sem acesso confirmado, diz isso em vez de uma tabela vazia', () => {
    const xml = documentoXml(gerarDocx({ ...DOCUMENTO, acessos: [] }));
    expect(xml).toContain('Nenhum acesso confirmado');
    expect(xml).not.toContain('<w:tbl>');
  });

  it('escapa texto vindo de dados (XML) e descarta caracteres de controle', () => {
    const xml = documentoXml(gerarDocx({ ...DOCUMENTO, nome: `Ana <b>&"Souza"</b> 'X'\u0001` }));
    expect(xml).toContain('Ana &lt;b&gt;&amp;&quot;Souza&quot;&lt;/b&gt; &apos;X&apos;');
    expect(xml).not.toContain('<b>');
    expect(xml).not.toContain('\u0001');
    expect(escaparXml('a\u0000b\u000bc\td')).toBe('abc\td');
  });

  it('é determinístico e tem nome de arquivo seguro', () => {
    expect(gerarDocx(DOCUMENTO)).toEqual(gerarDocx(DOCUMENTO));
    expect(nomeArquivoDocumento(DOCUMENTO)).toBe('acessos-jira-RH-1001.docx');
    expect(nomeArquivoDocumento({ ...DOCUMENTO, origem: 'jira:../"RH 9"' })).toBe(
      'acessos-jira-RH-9.docx',
    );
    expect(formatarInstante('2026-01-02T03:04:05.000Z')).toBe('02/01/2026 03:04 (UTC)');
  });

  it('ZIP: ida e volta preserva o conteúdo e detecta corrupção', () => {
    const conteudo = new TextEncoder().encode('ação '.repeat(100));
    const zip = criarZip([{ nome: 'pasta/arquivo.txt', conteudo }]);
    expect(lerZip(zip).get('pasta/arquivo.txt')).toEqual(conteudo);
    // Primeiro byte dos dados comprimidos: cabeçalho local (30) + nome (17).
    const corrompido = new Uint8Array(zip);
    corrompido[47] = corrompido[47]! ^ 0xff;
    expect(() => lerZip(corrompido)).toThrow();
  });
});
