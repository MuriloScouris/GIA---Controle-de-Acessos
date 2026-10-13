import { pathToFileURL } from 'node:url';
import { configuracaoAmbienteSchema } from '@gia/contratos';

/** Scaffold do worker: valida a configuração e encerra. Sem fila, ingestão ou conectores reais. */
export function iniciar(env: Record<string, string | undefined> = process.env): string {
  const config = configuracaoAmbienteSchema.parse({
    ...(env['GIA_AMBIENTE'] ? { ambiente: env['GIA_AMBIENTE'] } : {}),
    escritaExterna: false,
  });
  return `worker pronto (${config.ambiente}, escrita externa desligada)`;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(iniciar());
}
