import {
  EFEITOS,
  PAPEIS,
  TRANSICOES_ITEM,
  TRANSICOES_OPERACAO,
  ehDataCivilValida,
  type AcaoOperacao,
  type Papel,
  type StatusItem,
  type StatusOperacao,
} from '@gia/dominio';
import { z } from 'zod';
import { enumDe, instanteSchema, uuidSchema, versaoSchema } from './comum.js';
import { codigoErroSchema, statusPedidoSchema } from './resposta.js';
import { sistemaSchema, tipoVinculoSchema } from './sistemas.js';

// ---------------------------------------------------------------------------
// Sessão simulada (substituída por OIDC com Entra ID). O ator nunca vem do
// corpo de um comando; aqui só se escolhe uma das pessoas fictícias do servidor.
// ---------------------------------------------------------------------------

export type PapelHumano = Exclude<Papel, 'servicoExecutor'>;

/** O serviço executor é identidade técnica do worker; não abre sessão na API. */
export const PAPEIS_HUMANOS = PAPEIS.filter(
  (papel): papel is PapelHumano => papel !== 'servicoExecutor',
);

export const loginSimuladoSchema = z.strictObject({ papel: enumDe(PAPEIS_HUMANOS) });

export const sessaoRespostaSchema = z.strictObject({
  usuarioId: uuidSchema,
  nome: z.string().min(1),
  papeis: z.array(enumDe(PAPEIS)),
  expiraEm: instanteSchema,
});

export type LoginSimulado = z.infer<typeof loginSimuladoSchema>;
export type SessaoResposta = z.infer<typeof sessaoRespostaSchema>;

// ---------------------------------------------------------------------------
// Parâmetros de rota.
// ---------------------------------------------------------------------------

export const pedidoParamsSchema = z.strictObject({ pedidoId: uuidSchema });
export const itemParamsSchema = z.strictObject({ pedidoId: uuidSchema, itemId: uuidSchema });

// ---------------------------------------------------------------------------
// Importação do Jira (origem).
// ---------------------------------------------------------------------------

/** Corpo do pedido de importação: nada a informar; a origem e o filtro são do servidor. */
export const importacaoJiraSchema = z.strictObject({});

const textoJira = (maximo: number) => z.string().trim().min(1).max(maximo);
const textoJiraOpcional = (maximo: number) =>
  z
    .string()
    .trim()
    .max(maximo)
    .nullable()
    .transform((valor) => (valor === '' ? null : valor));

/**
 * Chamado bruto lido do Jira. Campos desconhecidos são descartados. O texto
 * não é recusado por conteúdo: dado externo é sanitizado pelo domínio na
 * ingestão (regra 12). CPF e e-mail são validados pelo domínio, que devolve
 * códigos estáveis (`CPF_INVALIDO`, pendência de identidade).
 */
export const chamadoJiraSchema = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_]*-\d+$/, 'Chave de issue inválida'),
  fields: z.object({
    tipoSolicitacao: textoJira(200),
    nomeCompleto: textoJira(300),
    cpf: z.string().trim().max(20),
    matricula: textoJiraOpcional(50),
    emailCorporativo: textoJiraOpcional(320),
    area: textoJira(200),
    cargo: textoJira(200),
    dataAdmissao: z.string().trim().refine(ehDataCivilValida, 'Data de admissão inválida'),
    gestor: textoJiraOpcional(300),
  }),
});

export type ChamadoJira = z.infer<typeof chamadoJiraSchema>;

export const resultadoImportacaoSchema = z.strictObject({
  criados: z.array(
    z.strictObject({
      chave: z.string(),
      pedidoId: uuidSchema,
      tipoVinculo: tipoVinculoSchema,
      status: statusPedidoSchema,
      versao: versaoSchema,
      sistemasPropostos: z.array(sistemaSchema),
      sistemasDescartados: z.array(sistemaSchema),
      pendenciaIdentidade: codigoErroSchema.nullable(),
    }),
  ),
  /** Regra 10: a mesma origem nunca gera dois pedidos. */
  duplicados: z.array(z.strictObject({ chave: z.string(), pedidoId: uuidSchema })),
  /** Tipos de solicitação fora do onboarding (ex.: desligamento, em standby). */
  ignorados: z.array(z.strictObject({ chave: z.string(), tipoSolicitacao: z.string() })),
  recusados: z.array(
    z.strictObject({
      chave: z.string().nullable(),
      codigo: codigoErroSchema,
      mensagem: z.string(),
      campos: z.array(z.string()),
    }),
  ),
});

export type ResultadoImportacao = z.infer<typeof resultadoImportacaoSchema>;

// ---------------------------------------------------------------------------
// Consulta: pedido, proposta e resultado por item.
// ---------------------------------------------------------------------------

const STATUS_ITEM = Object.keys(TRANSICOES_ITEM) as StatusItem[];
const STATUS_OPERACAO = Object.keys(TRANSICOES_OPERACAO) as StatusOperacao[];
const ACOES_OPERACAO: readonly AcaoOperacao[] = [
  'provisionar',
  'revogar',
  'validar',
  'conferirExistencia',
];

const atorResumoSchema = z.strictObject({ id: z.string(), nome: z.string() });

export const operacaoResumoSchema = z.strictObject({
  id: uuidSchema,
  acao: enumDe(ACOES_OPERACAO),
  modo: z.enum(['real', 'simulado']),
  status: enumDe(STATUS_OPERACAO),
  efeito: enumDe(EFEITOS).nullable(),
  codigo: z.string().nullable(),
  mensagem: z.string().nullable(),
  tentativas: z.number().int().nonnegative(),
  criadaEm: instanteSchema,
  atualizadaEm: instanteSchema,
});

export const resultadoItemSchema = z.strictObject({
  id: uuidSchema,
  sistema: sistemaSchema,
  status: enumDe(STATUS_ITEM),
  versao: versaoSchema,
  idExterno: z.string().nullable(),
  mensagem: z.string().nullable(),
  etapaAlcancada: z.string().nullable(),
  confirmadoEm: instanteSchema.nullable(),
  observacaoManual: z.string().nullable(),
  herdadoDeItemId: uuidSchema.nullable(),
  operacoes: z.array(operacaoResumoSchema),
});

export const resultadoItensSchema = z.strictObject({
  pedidoId: uuidSchema,
  status: statusPedidoSchema,
  versao: versaoSchema,
  itens: z.array(resultadoItemSchema),
});

const identidadeVisaoSchema = z.strictObject({
  login: z.string(),
  upn: z.string(),
  email: z.string(),
  proxyAddresses: z.array(z.string()),
  nomeExibicao: z.string(),
  origem: z.enum(['emailCorporativoRh', 'ajusteManual']),
});

const conflitoSchema = z.strictObject({
  fonte: z.enum(['ad', 'm365', 'gia']),
  campo: z.enum(['login', 'email', 'upn', 'proxyAddress']),
  valor: z.string(),
});

export const pedidoDetalheSchema = z.strictObject({
  id: uuidSchema,
  origem: z.strictObject({ sistema: z.literal('jira'), idExterno: z.string() }),
  tipoVinculo: tipoVinculoSchema,
  status: statusPedidoSchema,
  versao: versaoSchema,
  motivoRejeicao: z.string().nullable(),
  criadoEm: instanteSchema,
  atualizadoEm: instanteSchema,
  colaboradorId: uuidSchema,
  dadosRh: z.strictObject({
    nomeCompleto: z.string(),
    /** Completo só para quem pode consultar dados pessoais; senão, mascarado. */
    cpf: z.string(),
    matricula: z.string().nullable(),
    emailCorporativoSugerido: z.string().nullable(),
    area: z.string(),
    cargo: z.string(),
    dataAdmissao: z.string(),
    gestor: z.string().nullable(),
  }),
  revisao: z.strictObject({
    id: uuidSchema,
    numero: z.number().int().min(1),
    situacao: z.enum(['rascunho', 'aprovada']),
    versaoRegras: z.string(),
    identidade: identidadeVisaoSchema.nullable(),
    pendenciaIdentidade: z
      .strictObject({ codigo: codigoErroSchema, mensagem: z.string() })
      .nullable(),
    verificacaoIdentidade: z
      .strictObject({
        situacao: z.enum(['livre', 'emUsoPelaMesmaPessoa', 'emUsoPorOutraPessoa']),
        conflitos: z.array(conflitoSchema),
        verificadaEm: instanteSchema,
      })
      .nullable(),
    itens: z.array(
      z.strictObject({
        sistema: sistemaSchema,
        parametros: z.record(z.string(), z.unknown()),
        origemSugestao: z.string(),
      }),
    ),
    aprovadaPor: atorResumoSchema.nullable(),
    aprovadaEm: instanteSchema.nullable(),
  }),
  /** Itens da revisão aprovada corrente, com o resultado de cada sistema. */
  itens: z.array(resultadoItemSchema),
});

export const resumoPedidoSchema = z.strictObject({
  id: uuidSchema,
  idExterno: z.string(),
  tipoVinculo: tipoVinculoSchema,
  status: statusPedidoSchema,
  versao: versaoSchema,
  nomeColaborador: z.string(),
  criadoEm: instanteSchema,
  atualizadoEm: instanteSchema,
});

export const listaPedidosSchema = z.strictObject({ pedidos: z.array(resumoPedidoSchema) });

export type OperacaoResumo = z.infer<typeof operacaoResumoSchema>;
export type ResultadoItem = z.infer<typeof resultadoItemSchema>;
export type ResultadoItens = z.infer<typeof resultadoItensSchema>;
export type PedidoDetalhe = z.infer<typeof pedidoDetalheSchema>;
export type ResumoPedido = z.infer<typeof resumoPedidoSchema>;
export type ListaPedidos = z.infer<typeof listaPedidosSchema>;
