import { z } from 'zod';

export const PACOTE = '@gia/contratos';

/**
 * Configuração de ambiente validada no arranque.
 * A escrita nos sistemas de destino nasce desligada; nenhum segredo faz parte do esquema.
 */
export const configuracaoAmbienteSchema = z.object({
  ambiente: z.enum(['desenvolvimento', 'teste', 'producao']).default('desenvolvimento'),
  escritaExterna: z.boolean().default(false),
});

export type ConfiguracaoAmbiente = z.infer<typeof configuracaoAmbienteSchema>;
