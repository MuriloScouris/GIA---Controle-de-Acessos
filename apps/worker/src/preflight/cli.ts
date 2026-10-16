import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { VariaveisAmbiente } from '@gia/contratos';
import { executarPreflight } from './preflight.js';
import type { EvidenciaPreflight } from './tipos.js';

/** Cria arquivo novo, privado; nunca sobrescreve evidência anterior nem segue symlink final. */
export async function gravarEvidencia(
  caminho: string,
  evidencia: EvidenciaPreflight,
): Promise<string> {
  const texto = `${JSON.stringify(evidencia, null, 2)}\n`;
  const arquivo = await open(caminho, 'wx', 0o600);
  try {
    await arquivo.writeFile(texto);
    await arquivo.sync();
  } finally {
    await arquivo.close();
  }
  return createHash('sha256').update(texto).digest('hex');
}

export async function executarCli(
  args: readonly string[],
  env: VariaveisAmbiente,
  publicar: (linha: string) => void = console.log,
): Promise<number> {
  let saida: string | undefined;
  let offline = false;
  try {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--offline') offline = true;
      else if (args[i] === '--saida' && !saida && args[i + 1] && !args[i + 1]!.startsWith('--'))
        saida = args[++i];
      else throw new Error();
    }
  } catch {
    publicar(
      JSON.stringify({
        schema: 'gia.preflight.v1',
        erro: 'ARGUMENTOS_INVALIDOS',
        escritaHabilitada: false,
        producaoPronta: false,
      }),
    );
    return 1;
  }
  try {
    const evidencia = await executarPreflight(env, { offline });
    let sha256: string | undefined;
    if (saida) {
      try {
        sha256 = await gravarEvidencia(saida, evidencia);
      } catch {
        publicar(
          JSON.stringify({
            schema: 'gia.preflight.v1',
            erro: 'EVIDENCIA_NAO_GRAVADA',
            escritaHabilitada: false,
            producaoPronta: false,
          }),
        );
        return 1;
      }
    }
    publicar(JSON.stringify({ ...evidencia, ...(sha256 ? { sha256 } : {}) }));
    return evidencia.codigoSaida;
  } catch {
    publicar(
      JSON.stringify({
        schema: 'gia.preflight.v1',
        erro: 'PREFLIGHT_FALHOU',
        escritaHabilitada: false,
        producaoPronta: false,
      }),
    );
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await executarCli(process.argv.slice(2), process.env);
