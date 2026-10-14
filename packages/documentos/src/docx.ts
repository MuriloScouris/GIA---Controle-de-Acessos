import type { DocumentoDeAcessos } from '@gia/dominio';
import { criarZip } from './zip.js';

/**
 * Formulário de acessos em DOCX (WordprocessingML mínimo: um parágrafo por
 * informação e uma tabela de acessos). Todo texto vem do documento do
 * domínio, que já não tem CPF, matrícula nem credenciais; aqui ele é só
 * escapado e formatado.
 */

export const TIPO_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const ROTULO_VINCULO: Readonly<Record<DocumentoDeAcessos['tipoVinculo'], string>> = {
  celetista: 'Celetista',
  terceiro: 'Terceiro',
};

/** Escapa para XML e remove caracteres de controle que o XML 1.0 não aceita. */
export function escaparXml(texto: string): string {
  return texto
    .replace(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** `2026-10-14T12:00:00.000Z` → `14/10/2026 12:00 (UTC)`. */
export function formatarInstante(instante: string): string {
  const [data = '', hora = ''] = instante.split('T');
  return `${formatarData(data)} ${hora.slice(0, 5)} (UTC)`;
}

/** `2026-11-03` → `03/11/2026`. */
export function formatarData(data: string): string {
  const [ano, mes, dia] = data.split('-');
  return `${dia}/${mes}/${ano}`;
}

/** Nome de arquivo seguro: só letras, dígitos e hífen. */
export function nomeArquivoDocumento(documento: DocumentoDeAcessos): string {
  const origem = documento.origem.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `acessos-${origem}.docx`;
}

function texto(conteudo: string, { negrito = false, tamanho = 0 } = {}): string {
  const propriedades =
    negrito || tamanho > 0
      ? `<w:rPr>${negrito ? '<w:b/>' : ''}${tamanho > 0 ? `<w:sz w:val="${tamanho}"/>` : ''}</w:rPr>`
      : '';
  return `<w:r>${propriedades}<w:t xml:space="preserve">${escaparXml(conteudo)}</w:t></w:r>`;
}

function paragrafo(...trechos: string[]): string {
  return `<w:p>${trechos.join('')}</w:p>`;
}

function campo(rotulo: string, valor: string | null): string {
  return paragrafo(texto(`${rotulo}: `, { negrito: true }), texto(valor ?? '—'));
}

function celula(linhas: readonly string[], cabecalho = false): string {
  const conteudo = (linhas.length === 0 ? ['—'] : linhas)
    .map((linha) => paragrafo(texto(linha, { negrito: cabecalho })))
    .join('');
  return `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${conteudo}</w:tc>`;
}

function tabelaDeAcessos(documento: DocumentoDeAcessos): string {
  const borda = (lado: string) =>
    `<w:${lado} w:val="single" w:sz="4" w:space="0" w:color="808080"/>`;
  const bordas = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(borda).join('');
  const cabecalho = `<w:tr>${[
    'Sistema',
    'Acessos concedidos',
    'Referência no sistema',
    'Confirmado em',
  ]
    .map((titulo) => celula([titulo], true))
    .join('')}</w:tr>`;
  const linhas = documento.acessos.map(
    (acesso) =>
      `<w:tr>${[
        celula([acesso.nomeSistema]),
        celula(acesso.acessos),
        celula(acesso.referenciaExterna === null ? [] : [acesso.referenciaExterna]),
        celula([formatarInstante(acesso.confirmadoEm)]),
      ].join('')}</w:tr>`,
  );
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${bordas}</w:tblBorders></w:tblPr>` +
    `${cabecalho}${linhas.join('')}</w:tbl>`
  );
}

function corpo(documento: DocumentoDeAcessos): string {
  const { identidade } = documento;
  return [
    paragrafo(texto('Formulário de acessos', { negrito: true, tamanho: 32 })),
    campo('Pedido', documento.origem),
    campo('Nome', documento.nome),
    campo('Vínculo', ROTULO_VINCULO[documento.tipoVinculo]),
    campo('Data de admissão', formatarData(documento.dataAdmissao)),
    campo('Nome de exibição', identidade.nomeExibicao),
    campo('Login', identidade.login),
    campo('UPN', identidade.upn),
    campo('E-mail', identidade.email),
    paragrafo(texto('Acessos confirmados', { negrito: true, tamanho: 26 })),
    documento.acessos.length === 0
      ? paragrafo(texto('Nenhum acesso confirmado pelo Gia neste pedido.'))
      : tabelaDeAcessos(documento),
    paragrafo(
      texto(
        'Somente acessos confirmados nos sistemas de destino. ' +
          'Este documento não contém senhas nem credenciais.',
      ),
    ),
    campo('Emitido em', formatarInstante(documento.emitidoEm)),
    campo('Emitido por', documento.emitidoPor),
  ].join('');
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

export function gerarDocx(documento: DocumentoDeAcessos): Uint8Array {
  const tiposDeConteudo =
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>';
  const relacoes =
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';
  const documentoXml =
    `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${corpo(documento)}` +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/>' +
    '</w:sectPr></w:body></w:document>';
  const utf8 = (conteudo: string) => new TextEncoder().encode(conteudo);
  return criarZip([
    { nome: '[Content_Types].xml', conteudo: utf8(tiposDeConteudo) },
    { nome: '_rels/.rels', conteudo: utf8(relacoes) },
    { nome: 'word/document.xml', conteudo: utf8(documentoXml) },
  ]);
}
