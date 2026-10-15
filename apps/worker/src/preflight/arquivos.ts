import { X509Certificate } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { Check } from './tipos.js';

/** Leitura limitada de arquivo regular (inclusive volume projetado do cofre). */
export async function lerArquivoControlado(caminho: string): Promise<Buffer> {
  const { stat } = await import('node:fs/promises');
  const antes = await stat(caminho);
  if (!antes.isFile()) throw new Error();
  const arquivo = await open(caminho, 'r');
  try {
    const stat = await arquivo.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 1024 * 1024 || stat.ino !== antes.ino)
      throw new Error();
    const buffer = Buffer.alloc(Number(stat.size) + 1);
    const { bytesRead } = await arquivo.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) throw new Error();
    return buffer.subarray(0, bytesRead);
  } finally {
    await arquivo.close();
  }
}

export async function verificarArquivo(
  caminho: string | undefined,
  recurso: NonNullable<Check['recurso']>,
): Promise<{ check: Check; ca?: Buffer }> {
  try {
    if (!caminho?.trim()) throw new Error();
    const bytes = await lerArquivoControlado(caminho);
    if (recurso === 'ca') {
      const pem = bytes.toString('utf8');
      const certificados = pem.match(
        /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
      );
      if (
        !certificados?.length ||
        pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g, '').trim()
      )
        throw new Error();
      for (const texto of certificados) {
        const cert = new X509Certificate(texto);
        if (Date.parse(cert.validFrom) > Date.now() || Date.parse(cert.validTo) <= Date.now())
          throw new Error();
      }
      return { check: { nome: 'cofre', estado: 'ok', codigo: 'OK', recurso }, ca: bytes };
    }
    const { stat } = await import('node:fs/promises');
    if (process.platform !== 'win32' && ((await stat(caminho)).mode & 0o007) !== 0)
      return {
        check: { nome: 'cofre', estado: 'bloqueado', codigo: 'ARQUIVO_PERMISSAO_ABERTA', recurso },
      };
    if (!bytes.toString('utf8').trim()) throw new Error();
    if (recurso === 'banco') {
      const valor = bytes.toString('utf8').replace(/\r?\n$/, '');
      const url = new URL(valor);
      if (
        !['postgres:', 'postgresql:'].includes(url.protocol) ||
        !url.hostname ||
        /[\r\n]/.test(valor)
      )
        throw new Error();
    }
    return { check: { nome: 'cofre', estado: 'ok', codigo: 'OK', recurso } };
  } catch {
    return {
      check: { nome: 'cofre', estado: 'bloqueado', codigo: 'ARQUIVO_AUSENTE_OU_INVALIDO', recurso },
    };
  }
}
