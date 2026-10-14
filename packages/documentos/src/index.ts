/**
 * Geração do formulário de acessos (funcionalidade 10) em DOCX. O conteúdo
 * vem do domínio (`emitirDocumentoDeAcessos`): só acessos confirmados, sem
 * CPF, matrícula ou credenciais. Sem dependências além do Node.
 */
export const PACOTE = '@gia/documentos';
export {
  escaparXml,
  formatarData,
  formatarInstante,
  gerarDocx,
  nomeArquivoDocumento,
  TIPO_DOCX,
} from './docx.js';
export { criarZip, lerZip } from './zip.js';
export type { ArquivoZip } from './zip.js';
