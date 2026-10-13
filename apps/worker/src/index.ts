import { pathToFileURL } from 'node:url';
import { carregarConfiguracaoAmbiente, type VariaveisAmbiente } from '@gia/contratos';

/** Scaffold do worker: valida a configuração e encerra. Sem fila, ingestão ou conectores reais. */
export function iniciar(env: VariaveisAmbiente = process.env): string {
  const config = carregarConfiguracaoAmbiente(env);
  return `worker pronto (${config.ambiente}, escrita externa desligada)`;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(iniciar());
}
