import {
  SISTEMAS,
  TIPOS_VINCULO,
  contemSegredo,
  ehCpfValido,
  type ParametrosSistema,
} from '@gia/dominio';
import { z } from 'zod';
import { emailSchema, enumDe, semSegredoNaEntrada, textoSchema } from './comum.js';

export const sistemaSchema = enumDe(SISTEMAS);
export const tipoVinculoSchema = enumDe(TIPOS_VINCULO);

/** Só o formato de CPF (com ou sem máscara): qualquer texto extra, como um segredo colado, é recusado. */
const cpfSchema = semSegredoNaEntrada.pipe(
  z
    .string()
    .regex(/^\d{3}\.?\d{3}\.?\d{3}-?\d{2}$/, 'CPF inválido')
    .refine(ehCpfValido, 'CPF inválido'),
);
const textos = z.array(textoSchema(300));
const textoOuNulo = textoSchema(300).nullable();

/** Cada schema de sistema, isolado, também recusa segredo no resultado final. */
const semSegredo = (parametros: object) => !contemSegredo(parametros);
const MSG_SEGREDO = 'Segredos não são permitidos';

/**
 * Parâmetros tipados por sistema, discriminados por `sistema`. Objetos estritos:
 * campo desconhecido (inclusive senha ou token) é recusado, nunca ignorado.
 */
export const parametrosAdSchema = z
  .strictObject({
    sistema: z.literal('ad'),
    login: textoSchema(20),
    upn: emailSchema,
    email: emailSchema,
    proxyAddresses: textos,
    nome: textoSchema(),
    sobrenome: textoSchema(),
    nomeExibicao: textoSchema(),
    ou: textoSchema(),
    grupos: textos,
    cargo: textoSchema(),
    departamento: textoSchema(),
    empresa: textoSchema(),
    escritorio: textoOuNulo,
    scriptLogon: textoOuNulo,
    gerente: textoOuNulo,
    cpf: cpfSchema,
    controleConta: z.number().int().nonnegative().nullable(),
  })
  .refine(semSegredo, MSG_SEGREDO);

/** Sem campos de criação de usuário: o M365 só licencia a identidade sincronizada (regra 7). */
export const parametrosM365Schema = z
  .strictObject({
    sistema: z.literal('m365'),
    upn: emailSchema,
    email: emailSchema,
    nome: textoSchema(),
    planosLicenca: textos,
    paisUso: semSegredoNaEntrada.pipe(
      z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z]{2}$/, 'Informe o país com 2 letras'),
    ),
    grupo: textoOuNulo,
  })
  .refine(semSegredo, MSG_SEGREDO);

export const parametrosDocusignSchema = z
  .strictObject({
    sistema: z.literal('docusign'),
    email: emailSchema,
    nome: textoSchema(),
    empresa: textoSchema(),
    cargo: textoSchema(),
    perfil: textoSchema(),
    grupo: textoSchema(),
    idioma: textoSchema(20),
    endereco: textoOuNulo,
  })
  .refine(semSegredo, MSG_SEGREDO);

export const parametrosSoftexpertSchema = z
  .strictObject({
    sistema: z.literal('softexpert'),
    /** Matrícula ou CPF. */
    identificador: textoSchema(50),
    login: textoSchema(),
    nome: textoSchema(),
    email: emailSchema,
    area: textoSchema(),
    funcao: textoSchema(),
    grupoAcesso: textoSchema(),
  })
  .refine(semSegredo, MSG_SEGREDO);

export const parametrosJiraSchema = z
  .strictObject({
    sistema: z.literal('jira'),
    email: emailSchema,
    nome: textoSchema(),
    grupos: textos,
  })
  .refine(semSegredo, MSG_SEGREDO);

export const parametrosSistemaSchema = z.discriminatedUnion('sistema', [
  parametrosAdSchema,
  parametrosM365Schema,
  parametrosDocusignSchema,
  parametrosSoftexpertSchema,
  parametrosJiraSchema,
]);

export type ParametrosAdContrato = z.infer<typeof parametrosAdSchema>;
export type ParametrosM365Contrato = z.infer<typeof parametrosM365Schema>;
export type ParametrosDocusignContrato = z.infer<typeof parametrosDocusignSchema>;
export type ParametrosSoftexpertContrato = z.infer<typeof parametrosSoftexpertSchema>;
export type ParametrosJiraContrato = z.infer<typeof parametrosJiraSchema>;
export type ParametrosSistemaContrato = z.infer<typeof parametrosSistemaSchema>;

/** Verificação de compilação: o contrato é atribuível ao tipo do domínio. */
export const comoParametrosDoDominio = (p: ParametrosSistemaContrato): ParametrosSistema => p;
