import { z } from 'zod';

export const saudeRespostaSchema = z.object({ status: z.literal('ok') });

export type SaudeResposta = z.infer<typeof saudeRespostaSchema>;
