import { deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * ZIP mínimo (PKWARE APPNOTE): só o necessário para empacotar um DOCX —
 * entradas comprimidas com deflate, sem criptografia, sem ZIP64. Datas fixas
 * (1980-01-01) para o mesmo documento gerar sempre os mesmos bytes.
 */

export interface ArquivoZip {
  readonly nome: string;
  readonly conteudo: Uint8Array;
}

const TABELA_CRC = (() => {
  const tabela = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabela[n] = c >>> 0;
  }
  return tabela;
})();

function crc32(dados: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of dados) crc = TABELA_CRC[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const DATA_DOS = (1 << 5) | 1; // 1980-01-01
const HORA_DOS = 0;
const UTF8 = 1 << 11;

export function criarZip(arquivos: readonly ArquivoZip[]): Uint8Array {
  const locais: Buffer[] = [];
  const centrais: Buffer[] = [];
  let deslocamento = 0;
  for (const arquivo of arquivos) {
    const nome = Buffer.from(arquivo.nome, 'utf8');
    const comprimido = deflateRawSync(arquivo.conteudo);
    const crc = crc32(arquivo.conteudo);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // versão necessária
    local.writeUInt16LE(UTF8, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(HORA_DOS, 10);
    local.writeUInt16LE(DATA_DOS, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comprimido.length, 18);
    local.writeUInt32LE(arquivo.conteudo.length, 22);
    local.writeUInt16LE(nome.length, 26);
    local.writeUInt16LE(0, 28);
    locais.push(local, nome, comprimido);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // versão que gerou
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(HORA_DOS, 12);
    central.writeUInt16LE(DATA_DOS, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comprimido.length, 20);
    central.writeUInt32LE(arquivo.conteudo.length, 24);
    central.writeUInt16LE(nome.length, 28);
    central.writeUInt32LE(deslocamento, 42);
    centrais.push(central, nome);

    deslocamento += local.length + nome.length + comprimido.length;
  }
  const diretorio = Buffer.concat(centrais);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(arquivos.length, 8);
  fim.writeUInt16LE(arquivos.length, 10);
  fim.writeUInt32LE(diretorio.length, 12);
  fim.writeUInt32LE(deslocamento, 16);
  return new Uint8Array(Buffer.concat([...locais, diretorio, fim]));
}

/** Lê um ZIP gerado por `criarZip` (ou equivalente simples); confere o CRC de cada entrada. */
export function lerZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const zip = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fim = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (fim < 0) throw new Error('ZIP sem diretório central');
  const total = zip.readUInt16LE(fim + 10);
  let posicao = zip.readUInt32LE(fim + 16);
  const arquivos = new Map<string, Uint8Array>();
  for (let i = 0; i < total; i += 1) {
    if (zip.readUInt32LE(posicao) !== 0x02014b50) throw new Error('entrada central inválida');
    const metodo = zip.readUInt16LE(posicao + 10);
    const crc = zip.readUInt32LE(posicao + 16);
    const tamanhoComprimido = zip.readUInt32LE(posicao + 20);
    const tamanhoNome = zip.readUInt16LE(posicao + 28);
    const tamanhoExtra = zip.readUInt16LE(posicao + 30);
    const tamanhoComentario = zip.readUInt16LE(posicao + 32);
    const local = zip.readUInt32LE(posicao + 42);
    const nome = zip.toString('utf8', posicao + 46, posicao + 46 + tamanhoNome);
    const inicioDados = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const dados = zip.subarray(inicioDados, inicioDados + tamanhoComprimido);
    const conteudo = new Uint8Array(metodo === 8 ? inflateRawSync(dados) : dados);
    if (crc32(conteudo) !== crc) throw new Error(`CRC inválido em ${nome}`);
    arquivos.set(nome, conteudo);
    posicao += 46 + tamanhoNome + tamanhoExtra + tamanhoComentario;
  }
  return arquivos;
}
