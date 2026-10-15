import { z } from 'zod';
import { instanteSchema, uuidSchema } from './comum.js';
import { sistemaSchema } from './sistemas.js';

/** Cursor é um evento do próprio pedido; paginação segue ordem imutável de inserção. */
export const consultaHistoricoSchema = z.strictObject({
  cursor: uuidSchema.optional(),
  limite: z.coerce.number().int().min(1).max(100).default(25),
});

/** Metadados de auditoria: snapshots, payloads e identificadores de pessoas não saem aqui. */
export const historicoPedidoSchema = z.strictObject({
  pedidoId: uuidSchema,
  eventos: z.array(
    z.strictObject({
      id: uuidSchema,
      pedidoId: uuidSchema,
      tipo: z.string().min(1).max(100),
      origem: z.enum(['gia', 'sincronizacaoAd', 'sincronizacaoM365']),
      instante: instanteSchema,
      ator: z.strictObject({ tipo: z.enum(['humano', 'servico']), nome: z.string() }).nullable(),
      sistema: sistemaSchema.nullable(),
      operacaoId: uuidSchema.nullable(),
      correlacaoId: z.string().nullable(),
      corrigeEventoId: uuidSchema.nullable(),
    }),
  ),
  proximoCursor: uuidSchema.nullable(),
});

export type ConsultaHistorico = z.infer<typeof consultaHistoricoSchema>;
export type HistoricoPedido = z.infer<typeof historicoPedidoSchema>;
