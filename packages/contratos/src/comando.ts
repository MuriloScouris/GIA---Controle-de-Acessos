import { rejeitarAtorNoPayload } from '@gia/dominio';
import { z } from 'zod';
import { emailSchema, enumDe, textoSchema, uuidSchema, versaoSchema } from './comum.js';
import {
  parametrosAdSchema,
  parametrosDocusignSchema,
  parametrosJiraSchema,
  parametrosM365Schema,
  parametrosSoftexpertSchema,
} from './sistemas.js';

const DESFECHOS = ['confirmado', 'parcial', 'falhou'] as const;

const identidadeSchema = z.strictObject({
  login: textoSchema(20),
  email: emailSchema,
  nomeExibicao: textoSchema(),
  upn: emailSchema.optional(),
});

/**
 * Item proposto: o discriminante `sistema` do item e o de `parametros` são o mesmo literal em
 * cada ramo da união, então `sistema: 'ad'` com parâmetros de Jira é recusado aqui (e no tipo).
 */
const itemPropostoSchema = z.discriminatedUnion('sistema', [
  z.strictObject({
    sistema: z.literal('ad'),
    parametros: parametrosAdSchema,
    origemSugestao: textoSchema(),
  }),
  z.strictObject({
    sistema: z.literal('m365'),
    parametros: parametrosM365Schema,
    origemSugestao: textoSchema(),
  }),
  z.strictObject({
    sistema: z.literal('docusign'),
    parametros: parametrosDocusignSchema,
    origemSugestao: textoSchema(),
  }),
  z.strictObject({
    sistema: z.literal('softexpert'),
    parametros: parametrosSoftexpertSchema,
    origemSugestao: textoSchema(),
  }),
  z.strictObject({
    sistema: z.literal('jira'),
    parametros: parametrosJiraSchema,
    origemSugestao: textoSchema(),
  }),
]);

const itemIds = z.array(uuidSchema).min(1).optional();

/** Cabeçalho comum; o ator nunca faz parte do comando, vem da sessão (regra 13). */
const cabecalho = { pedidoId: uuidSchema, versaoEsperada: versaoSchema };

/** União discriminada por `acao`: o tipo de `dados` acompanha a ação. */
const comandoBase = z.discriminatedUnion('acao', [
  z.strictObject({
    ...cabecalho,
    acao: z.literal('editarProposta'),
    dados: z.strictObject({
      identidade: identidadeSchema.optional(),
      itens: z.array(itemPropostoSchema).optional(),
    }),
  }),
  z.strictObject({
    ...cabecalho,
    acao: z.literal('recalcularIdentidade'),
    dados: z.strictObject({}),
  }),
  z.strictObject({ ...cabecalho, acao: z.literal('aprovar'), dados: z.strictObject({}) }),
  z.strictObject({
    ...cabecalho,
    acao: z.literal('rejeitar'),
    dados: z.strictObject({ motivo: textoSchema() }),
  }),
  z.strictObject({
    ...cabecalho,
    acao: z.literal('reabrir'),
    dados: z.strictObject({ motivo: textoSchema() }),
  }),
  z.strictObject({
    ...cabecalho,
    acao: z.literal('solicitarExecucao'),
    dados: z.strictObject({ itemIds }),
  }),
  z.strictObject({
    ...cabecalho,
    acao: z.literal('conferirExistencia'),
    dados: z.strictObject({ itemIds }),
  }),
  z.strictObject({
    ...cabecalho,
    acao: z.literal('registrarAcessoManual'),
    dados: z.strictObject({ itemId: uuidSchema, observacao: textoSchema() }),
  }),
  z.strictObject({
    ...cabecalho,
    acao: z.literal('reconciliar'),
    dados: z.strictObject({ itemId: uuidSchema, desfecho: enumDe(DESFECHOS) }),
  }),
]);

export const ACOES_COMANDO = comandoBase.options.map((opcao) => opcao.shape.acao.value);
export type AcaoComando = (typeof ACOES_COMANDO)[number];

export const comandoSchema = comandoBase.superRefine((comando, ctx) => {
  const ator = rejeitarAtorNoPayload(comando);
  if (!ator.ok) ctx.addIssue({ code: 'custom', message: ator.erro.mensagem });
});

export type Comando = z.infer<typeof comandoSchema>;
