import { z } from 'zod';
import { requisitos } from './catalogo.js';

export const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
const instante = z.iso.datetime();
const referencia = z
  .string()
  .regex(/^EV-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const check = z.strictObject({
  nome: z.enum([
    'ambiente',
    'gates',
    'cofreBanco',
    'segredosInline',
    'configuracao',
    'cofre',
    'dns',
    'tcp',
    'tls',
    'autenticacaoLeitura',
    'camposOrigem',
    'vivacidadeApi',
    'prontidaoApi',
    'autorizacaoApi',
    'batimentoWorker',
    'contaServico',
    'permissoesEscrita',
    'consentimentos',
    'homologacao',
    'rollback',
  ]),
  estado: z.enum(['ok', 'bloqueado', 'pendente', 'naoExecutado']),
  // O codigo original e as variaveis nao sao copiados para a matriz.
  codigo: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  destino: z.number().int().min(0).max(64).optional(),
  recurso: z.enum(['credencial', 'ca', 'chavePrivada', 'banco']).optional(),
  variaveis: z
    .array(z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/))
    .max(40)
    .optional(),
});
function unicos(checks: readonly z.infer<typeof check>[]): boolean {
  return (
    new Set(checks.map((c) => `${c.nome}:${c.destino ?? ''}:${c.recurso ?? ''}`)).size ===
    checks.length
  );
}
export const preflightSchema = z
  .strictObject({
    schema: z.literal('gia.preflight.v1'),
    execucaoId: z.uuid(),
    geradoEm: instante,
    revisao: sha.nullable(),
    ambiente: z.enum(['producao', 'teste', 'invalido']),
    somenteLeitura: z.literal(true),
    escritaHabilitada: z.literal(false),
    producaoPronta: z.literal(false),
    leiturasValidadas: z.boolean(),
    gatesObservados: z.strictObject({
      configuracao: z.enum(['desligada', 'insegura']),
      api: z.enum(['desligada', 'ligada', 'naoConfirmada']),
    }),
    codigoSaida: z.union([z.literal(1), z.literal(2)]),
    checks: z.array(check).max(100).refine(unicos),
    sistemas: z
      .array(
        z.strictObject({
          sistema: z.enum(['ad', 'm365', 'docusign', 'softexpert', 'jira']),
          checks: z.array(check).max(300).refine(unicos),
        }),
      )
      .length(5),
  })
  .refine((p) => new Set(p.sistemas.map((s) => s.sistema)).size === 5);
export type Preflight = z.infer<typeof preflightSchema>;

const comprovante = z
  .strictObject({
    referencia,
    sha256: digest,
    tipo: z.enum(['administrativa', 'ensaioRealAutorizado']),
    autorizacao: referencia.nullable(),
    ocorridoEm: instante,
  })
  .refine((e) => e.tipo !== 'ensaioRealAutorizado' || e.autorizacao !== null);
export const registroSchema = z
  .strictObject({
    schema: z.literal('gia.decisoes.v1'),
    revisao: sha,
    ambiente: z.literal('producao'),
    geradoEm: instante,
    itens: z
      .array(
        z
          .strictObject({
            id: z.string().refine((id) => requisitos.some((r) => r.id === id)),
            responsavelConfirmado: z.boolean(),
            estado: z.enum(['pendente', 'bloqueado', 'declarado']),
            evidencia: comprovante.nullable(),
          })
          .refine(
            (i) => i.estado !== 'declarado' || (i.responsavelConfirmado && i.evidencia !== null),
          )
          .refine(
            (i) =>
              i.estado !== 'declarado' ||
              !['ensaio', 'rollback'].includes(i.id.split('.')[1]!) ||
              i.evidencia?.tipo === 'ensaioRealAutorizado',
          ),
      )
      .max(100),
  })
  .refine((r) => new Set(r.itens.map((i) => i.id)).size === r.itens.length);
export type Registro = z.infer<typeof registroSchema>;

/** O checksum vincula bytes; nao prova origem nem substitui assinatura/aprovacao administrativa. */
export function conferirContexto(
  evidencia: { revisao: string | null; geradoEm: string },
  revisao: string,
  agora: Date,
): void {
  const idade = agora.getTime() - Date.parse(evidencia.geradoEm);
  if (
    evidencia.revisao !== revisao ||
    !Number.isFinite(idade) ||
    idade < 0 ||
    idade > 24 * 60 * 60 * 1000
  )
    throw new Error('EVIDENCIA_CONTEXTO_INVALIDO');
}
