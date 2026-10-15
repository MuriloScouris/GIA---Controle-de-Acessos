import { z } from 'zod';

/** Vivacidade (`/saude`): o processo responde. Não consulta dependências. */
export const saudeRespostaSchema = z.object({ status: z.literal('ok') });

export type SaudeResposta = z.infer<typeof saudeRespostaSchema>;

/**
 * Prontidão (`/saude/pronta`): o processo consegue atender. Expõe o estado dos
 * gates de escrita (sem segredo) para o operador conferir o que está ligado.
 */
export const prontidaoRespostaSchema = z.strictObject({
  status: z.enum(['pronta', 'indisponivel']),
  ambiente: z.enum(['desenvolvimento', 'teste', 'producao']),
  versao: z.string().min(1).max(100),
  verificacoes: z.record(z.string(), z.enum(['ok', 'falha'])),
  escrita: z.strictObject({
    modo: z.enum(['real', 'simulado']),
    liberadas: z.array(z.string()),
  }),
});

export type ProntidaoResposta = z.infer<typeof prontidaoRespostaSchema>;
