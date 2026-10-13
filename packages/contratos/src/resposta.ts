import { MENSAGENS_ERRO, type CodigoErro, type StatusPedido } from '@gia/dominio';
import { z } from 'zod';
import { enumDe, textoSchema, uuidSchema, versaoSchema } from './comum.js';

/** Mesmos status do domínio (`StatusPedido`). */
const STATUS_PEDIDO = [
  'pendenteAprovacao',
  'aprovado',
  'emExecucao',
  'concluidoComErros',
  'concluido',
  'rejeitado',
] as const satisfies readonly StatusPedido[];

export const statusPedidoSchema = enumDe<StatusPedido>(STATUS_PEDIDO);

/** Códigos estáveis de recusa: exatamente as chaves de `MENSAGENS_ERRO` do domínio. */
export const CODIGOS_ERRO = Object.keys(MENSAGENS_ERRO) as CodigoErro[];
export const codigoErroSchema = enumDe(CODIGOS_ERRO);

export const respostaSucessoSchema = z.strictObject({
  ok: z.literal(true),
  status: statusPedidoSchema,
  versao: versaoSchema,
  /** Presente quando o comando enfileirou uma operação ("aceita"). */
  operacaoId: uuidSchema.nullable(),
});

export const respostaErroSchema = z.strictObject({
  ok: z.literal(false),
  codigo: codigoErroSchema,
  mensagem: textoSchema(1000),
});

export const respostaSchema = z.discriminatedUnion('ok', [
  respostaSucessoSchema,
  respostaErroSchema,
]);

export type RespostaSucesso = z.infer<typeof respostaSucessoSchema>;
export type RespostaErro = z.infer<typeof respostaErroSchema>;
export type Resposta = z.infer<typeof respostaSchema>;
