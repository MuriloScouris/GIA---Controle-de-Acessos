import { pathToFileURL } from 'node:url';
import type { VariaveisAmbiente } from '@gia/contratos';
import {
  VARIAVEL_ARQUIVO_SAUDE,
  VARIAVEL_SAUDE_MAXIMO_MS,
  verificarBatimento,
} from './observabilidade.js';

/** Padrão: três renovações de lease (ADR-0004: 30 s) sem batimento = parado. */
const MAXIMO_PADRAO_MS = 90_000;

/**
 * Sonda de vivacidade do worker para o orquestrador (exec probe):
 * `pnpm --filter @gia/worker saude`. Sai 0 se o último batimento é recente.
 */
export async function sondarWorker(
  env: VariaveisAmbiente,
): Promise<{ readonly codigo: 0 | 1; readonly linha: string }> {
  const arquivo = env[VARIAVEL_ARQUIVO_SAUDE]?.trim();
  if (!arquivo) return { codigo: 1, linha: `worker: ${VARIAVEL_ARQUIVO_SAUDE} não configurada` };
  const bruto = env[VARIAVEL_SAUDE_MAXIMO_MS]?.trim();
  const maximo = bruto !== undefined && /^\d+$/.test(bruto) ? Number(bruto) : MAXIMO_PADRAO_MS;
  const { saudavel, idadeMs } = await verificarBatimento(arquivo, maximo);
  if (saudavel) return { codigo: 0, linha: `worker: saudável (último lote há ${idadeMs} ms)` };
  return {
    codigo: 1,
    linha: `worker: sem batimento recente (${idadeMs === null ? 'sem registro' : `${idadeMs} ms`})`,
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { codigo, linha } = await sondarWorker(process.env);
  console.log(linha);
  process.exitCode = codigo;
}
