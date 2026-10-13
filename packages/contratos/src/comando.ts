import { rejeitarAtorNoPayload } from '@gia/dominio';
import { z } from 'zod';
import { emailSchema, enumDe, textoSchema, uuidSchema, versaoSchema } from './comum.js';
import { parametrosSistemaSchema, sistemaSchema } from './sistemas.js';

const DESFECHOS = ['confirmado', 'parcial', 'falhou'] as const;

const identidadeSchema = z.strictObject({
  login: textoSchema(20),
  email: emailSchema,
  nomeExibicao: textoSchema(),
  upn: emailSchema.optional(),
});

const itemPropostoSchema = z.strictObject({
  sistema: sistemaSchema,
  parametros: parametrosSistemaSchema,
  origemSugestao: textoSchema(),
});

const vazio = z.strictObject({});
const itemIds = z.array(uuidSchema).min(1).optional();

/**
 * Dados permitidos por ação. O ator nunca faz parte do comando: vem da sessão
 * no servidor (regra 13), e qualquer campo de autoria enviado é recusado.
 */
const comandos = [
  [
    'editarProposta',
    z.strictObject({
      identidade: identidadeSchema.optional(),
      itens: z.array(itemPropostoSchema).optional(),
    }),
  ],
  ['recalcularIdentidade', vazio],
  ['aprovar', vazio],
  ['rejeitar', z.strictObject({ motivo: textoSchema() })],
  ['reabrir', z.strictObject({ motivo: textoSchema() })],
  ['solicitarExecucao', z.strictObject({ itemIds })],
  ['conferirExistencia', z.strictObject({ itemIds })],
  ['registrarAcessoManual', z.strictObject({ itemId: uuidSchema, observacao: textoSchema() })],
  ['reconciliar', z.strictObject({ itemId: uuidSchema, desfecho: enumDe(DESFECHOS) })],
] as const;

export const ACOES_COMANDO = comandos.map(([acao]) => acao);
export type AcaoComando = (typeof comandos)[number][0];

const opcoes = comandos.map(([acao, dados]) =>
  z.strictObject({
    pedidoId: uuidSchema,
    versaoEsperada: versaoSchema,
    acao: z.literal(acao),
    dados,
  }),
);

export const comandoSchema = z
  .discriminatedUnion(
    'acao',
    opcoes as unknown as [(typeof opcoes)[number], ...(typeof opcoes)[number][]],
  )
  .superRefine((comando, ctx) => {
    const ator = rejeitarAtorNoPayload(comando);
    if (!ator.ok) ctx.addIssue({ code: 'custom', message: ator.erro.mensagem });
  });

export type Comando = z.infer<typeof comandoSchema>;
