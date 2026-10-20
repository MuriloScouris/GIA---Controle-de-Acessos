import { z } from 'zod';

/** Vivacidade (`/saude`): o processo responde. Não consulta dependências. */
export const saudeRespostaSchema = z.object({ status: z.literal('ok') });

export type SaudeResposta = z.infer<typeof saudeRespostaSchema>;

/**
 * Prontidão na porta PÚBLICA (`/saude/pronta` da API): só o status, para o
 * balanceador e as sondas. Detalhes operacionais (ambiente, versão, verificações
 * e gates de escrita) não saem por aqui (pendência M7).
 */
export const prontidaoPublicaRespostaSchema = z.strictObject({
  status: z.enum(['pronta', 'indisponivel']),
});

export type ProntidaoPublicaResposta = z.infer<typeof prontidaoPublicaRespostaSchema>;

/**
 * Prontidão detalhada, só na porta INTERNA de métricas (`GIA_METRICAS_PORTA`,
 * em loopback): o processo consegue atender, com o estado dos gates de escrita
 * (sem segredo) para o operador conferir o que está ligado.
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
