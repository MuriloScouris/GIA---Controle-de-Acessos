import {
  EFEITOS,
  ETAPAS_PROVISIONAR,
  ETAPAS_REVOGAR,
  sanitizarTexto,
  type Etapa,
  type ResultadoOperacao,
} from '@gia/dominio';
import { z } from 'zod';
import { enumDe, instanteSchema } from './comum.js';
import { sistemaSchema } from './sistemas.js';

export const efeitoSchema = enumDe(EFEITOS);
export const modoExecucaoSchema = z.enum(['real', 'simulado']);

/** Textos vindos do fornecedor são sanitizados ao entrar (regra 12); nunca rejeitados por conteúdo. */
const textoSanitizado = (maximo: number) => z.string().max(maximo).transform(sanitizarTexto);

/** Etapas conhecidas do domínio; a pertinência da etapa ao sistema é regra do domínio (`ehEtapaDoSistema`). */
export const ETAPAS: readonly Etapa[] = [
  ...new Set([
    ...Object.values(ETAPAS_PROVISIONAR).flat(),
    ...Object.values(ETAPAS_REVOGAR).flat(),
  ]),
];
const etapaSchema = enumDe(ETAPAS).nullable();

/** Resultado de `provisionar` e `revogar`. */
export const resultadoOperacaoSchema = z.strictObject({
  sistema: sistemaSchema,
  efeito: efeitoSchema,
  modo: modoExecucaoSchema,
  etapa: etapaSchema,
  codigo: textoSanitizado(100).pipe(z.string().min(1)),
  referenciaExterna: textoSanitizado(300).nullable(),
  mensagem: textoSanitizado(1000),
  transitorio: z.boolean(),
  tentarAposMs: z.number().int().nonnegative().nullable(),
});

const apontamentoSchema = z.strictObject({
  codigo: textoSanitizado(100),
  mensagem: textoSanitizado(1000),
});

export const resultadoConexaoSchema = z.strictObject({
  sistema: sistemaSchema,
  modo: modoExecucaoSchema,
  disponivel: z.boolean(),
  codigo: textoSanitizado(100),
  mensagem: textoSanitizado(1000),
});

export const resultadoValidacaoSchema = z.strictObject({
  sistema: sistemaSchema,
  modo: modoExecucaoSchema,
  impedimentos: z.array(apontamentoSchema),
  avisos: z.array(apontamentoSchema),
});

export const resultadoExistenciaSchema = z.strictObject({
  sistema: sistemaSchema,
  modo: modoExecucaoSchema,
  contaExiste: z.boolean(),
  acessosEncontrados: z.array(textoSanitizado(300)),
  etapaComprovada: etapaSchema,
  referenciaExterna: textoSanitizado(300).nullable(),
  conferidaEm: instanteSchema,
});

export type ResultadoOperacaoContrato = z.infer<typeof resultadoOperacaoSchema>;
export type ResultadoConexaoContrato = z.infer<typeof resultadoConexaoSchema>;
export type ResultadoValidacaoContrato = z.infer<typeof resultadoValidacaoSchema>;
export type ResultadoExistenciaContrato = z.infer<typeof resultadoExistenciaSchema>;

/** O resultado do contrato, sem o campo `sistema`, é o `ResultadoOperacao` do domínio. */
export function paraResultadoDoDominio(r: ResultadoOperacaoContrato): ResultadoOperacao {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { sistema: _sistema, ...resto } = r;
  return resto;
}
