# @gia/documentos

Formulário de acessos (funcionalidade 10) em **DOCX**, sem dependências além
do Node (`node:zlib`).

- **Conteúdo:** vem do domínio (`emitirDocumentoDeAcessos`): pedido concluído,
  só itens `confirmado` pelo Gia, identidade efetiva (login, UPN, e-mail, nome
  de exibição), acessos de cada sistema, quem emitiu e quando. Não leva CPF,
  matrícula, senha nem credencial (regras 9 e 12).
- **Formato:** pacote OOXML mínimo (`[Content_Types].xml`, `_rels/.rels`,
  `word/document.xml`), texto escapado para XML, caracteres de controle
  removidos, bytes determinísticos para o mesmo documento.
- **API:** `gerarDocx(documento)`, `nomeArquivoDocumento(documento)`,
  `TIPO_DOCX`; `criarZip`/`lerZip` (o leitor serve aos testes).

O download é `GET /pedidos/:pedidoId/documento` na API: exige a permissão
`baixarDocumento`, responde `no-store` e cada emissão grava o evento
`documentoEmitido` com o ator da sessão.
