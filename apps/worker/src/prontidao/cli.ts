import { createHash, timingSafeEqual } from 'node:crypto';
import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { digest, sha } from './evidencias.js';
import { montarMatriz, type Entrada } from './matriz.js';

async function importar(caminho: string, esperado: string) {
  digest.parse(esperado);
  const arquivo = await open(caminho, 'r');
  try {
    const info = await arquivo.stat();
    if (!info.isFile() || info.size <= 0 || info.size > 1024 * 1024) throw new Error();
    const buffer = Buffer.alloc(info.size + 1);
    const { bytesRead } = await arquivo.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== info.size) throw new Error();
    const bytes = buffer.subarray(0, bytesRead);
    const calculado = createHash('sha256').update(bytes).digest('hex');
    if (!timingSafeEqual(Buffer.from(calculado), Buffer.from(esperado))) throw new Error();
    return { dados: JSON.parse(bytes.toString('utf8')) as unknown, sha256: calculado };
  } finally {
    await arquivo.close();
  }
}

export async function executarCliProntidao(
  args: readonly string[],
  publicar: (linha: string) => void = console.log,
): Promise<number> {
  try {
    const permitidos = new Set([
      '--revisao',
      '--preflight',
      '--preflight-sha256',
      '--registro',
      '--registro-sha256',
      '--saida',
    ]);
    const opcoes = new Map<string, string>();
    for (let i = 0; i < args.length; i += 2) {
      const chave = args[i]!;
      const valor = args[i + 1];
      if (!permitidos.has(chave) || opcoes.has(chave) || !valor || valor.startsWith('--'))
        throw new Error();
      opcoes.set(chave, valor);
    }
    const revisao = sha.parse(opcoes.get('--revisao'));
    for (const fonte of ['preflight', 'registro'])
      if (opcoes.has(`--${fonte}`) !== opcoes.has(`--${fonte}-sha256`)) throw new Error();
    const entrada: Entrada = {
      revisao,
      ...(opcoes.has('--preflight')
        ? {
            preflight: await importar(
              opcoes.get('--preflight')!,
              opcoes.get('--preflight-sha256')!,
            ),
          }
        : {}),
      ...(opcoes.has('--registro')
        ? { registro: await importar(opcoes.get('--registro')!, opcoes.get('--registro-sha256')!) }
        : {}),
    };
    const matriz = montarMatriz(entrada);
    const texto = `${JSON.stringify(matriz, null, 2)}\n`;
    const checksum = createHash('sha256').update(texto).digest('hex');
    if (opcoes.has('--saida')) {
      const arquivo = await open(opcoes.get('--saida')!, 'wx', 0o600);
      try {
        await arquivo.writeFile(texto);
        await arquivo.sync();
      } finally {
        await arquivo.close();
      }
    }
    publicar(JSON.stringify({ ...matriz, sha256: checksum }));
    return matriz.codigoSaida;
  } catch {
    publicar(
      JSON.stringify({
        schema: 'gia.prontidao.v1',
        erro: 'MATRIZ_NAO_VERIFICADA',
        decisao: 'NO_GO',
        producaoPronta: false,
        escritaHabilitada: false,
      }),
    );
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await executarCliProntidao(process.argv.slice(2));
