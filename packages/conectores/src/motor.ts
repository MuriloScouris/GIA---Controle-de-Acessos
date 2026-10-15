import {
  CODIGO_IDENTIDADE_NAO_SINCRONIZADA,
  POLITICA_EXECUCAO_PADRAO,
  etapasDe,
  interpretarEstadoParaRevogacao,
  type Apontamento,
  type Conector,
  type ContextoItem,
  type ContextoRevogacao,
  type Efeito,
  type EstadoParaRevogacao,
  type Etapa,
  type Instante,
  type ModoExecucao,
  type ParametrosDe,
  type ResultadoConexao,
  type ResultadoExistencia,
  type ResultadoOperacao,
  type ResultadoValidacao,
  type Sistema,
} from '@gia/dominio';
import {
  paraResultadoDoDominio,
  resultadoConexaoSchema,
  resultadoExistenciaSchema,
  resultadoOperacaoSchema,
  resultadoValidacaoSchema,
} from '@gia/contratos';
import { ErroFornecedor } from './erros.js';

/** Um passo de escrita no destino, identificado pela etapa do domínio. */
export interface PassoFornecedor {
  readonly etapa: Etapa;
  /** Devolve a referência externa do que foi criado (ID no destino), se houver. */
  executar(): Promise<string | null>;
}

/** Retrato do destino, lido sem alterar nada. */
export interface EstadoNoDestino {
  readonly contaExiste: boolean;
  /** No mesmo formato de `acessosEsperados` do domínio (ex.: `grupo:ti`). */
  readonly acessosEncontrados: readonly string[];
  /** Última etapa de provisionamento que o destino comprova como feita. */
  readonly etapaComprovada: Etapa | null;
  readonly referenciaExterna: string | null;
}

/**
 * O que cada sistema sabe fazer. O motor cuida do que é comum a todos:
 * ordem das etapas, retomada, tradução de falhas (regra 3), timeouts,
 * revogação (regra 5) e validação dos resultados na fronteira.
 */
export interface Fornecedor<S extends Sistema> {
  readonly sistema: S;
  testar(): Promise<void>;
  validar(parametros: ParametrosDe<S>): Promise<{
    readonly impedimentos: readonly Apontamento[];
    readonly avisos: readonly Apontamento[];
  }>;
  consultar(parametros: ParametrosDe<S>): Promise<EstadoNoDestino>;
  /** Todas as etapas da ação, cobrindo as de `ETAPAS_PROVISIONAR` / `ETAPAS_REVOGAR`. */
  passos(acao: 'provisionar' | 'revogar', parametros: ParametrosDe<S>): readonly PassoFornecedor[];
  estadoParaRevogacao(parametros: ParametrosDe<S>): Promise<EstadoParaRevogacao>;
}

export interface OpcoesConector {
  /** Conectores simulados devolvem sempre `simulado` (regra 9). */
  readonly modo: ModoExecucao;
  readonly timeoutConexaoMs?: number;
  readonly timeoutChamadaMs?: number;
  readonly agora?: () => Instante;
}

/** Uso incorreto do conector (parâmetros de outro sistema); não é falha do destino. */
export class ErroDeUso extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'ErroDeUso';
  }
}

const MENSAGEM_INVALIDA = 'A resposta do fornecedor não segue o contrato; confira no destino.';
const MENSAGEM_PARAMETROS = 'Os parâmetros do item não pertencem a este sistema.';

export function criarConector<S extends Sistema>(
  fornecedor: Fornecedor<S>,
  opcoes: OpcoesConector,
): Conector {
  const { sistema } = fornecedor;
  const { modo } = opcoes;
  const timeoutConexaoMs = opcoes.timeoutConexaoMs ?? POLITICA_EXECUCAO_PADRAO.timeoutConexaoMs;
  const timeoutChamadaMs = opcoes.timeoutChamadaMs ?? POLITICA_EXECUCAO_PADRAO.timeoutChamadaMs;
  const agora = opcoes.agora ?? ((): Instante => new Date().toISOString());

  const parametrosDe = (ctx: ContextoItem): ParametrosDe<S> => {
    if (ctx.parametros.sistema !== sistema) throw new ErroDeUso(MENSAGEM_PARAMETROS);
    return ctx.parametros as ParametrosDe<S>;
  };
  const resultado = (
    efeito: Efeito,
    etapa: Etapa | null,
    codigo: string,
    extra: ExtraResultado,
  ): ResultadoOperacao => resultadoOperacao(sistema, modo, efeito, etapa, codigo, extra);

  async function escrever(
    acao: 'provisionar' | 'revogar',
    ctx: ContextoItem,
  ): Promise<ResultadoOperacao> {
    let parametros: ParametrosDe<S>;
    try {
      parametros = parametrosDe(ctx);
    } catch {
      return resultado('semEfeito', null, 'PARAMETROS_INCOMPATIVEIS', {
        mensagem: MENSAGEM_PARAMETROS,
      });
    }
    const etapas = etapasDe(sistema, acao);
    const inicio = ctx.etapaInicial === null ? 0 : etapas.indexOf(ctx.etapaInicial);
    if (inicio < 0) {
      return resultado('semEfeito', null, 'ETAPA_INICIAL_INVALIDA', {
        mensagem: 'A etapa de retomada não pertence a este sistema.',
      });
    }
    const anterior: Etapa | null = etapas[inicio - 1] ?? null;
    let ultimaConcluida = anterior;
    let referencia: string | null = null;
    const passos = fornecedor.passos(acao, parametros);
    for (const etapa of etapas.slice(inicio)) {
      const passo = passos.find((candidato) => candidato.etapa === etapa);
      if (passo === undefined) {
        return resultado('semEfeito', ultimaConcluida, 'ETAPA_NAO_IMPLEMENTADA', {
          mensagem: 'O adaptador não implementa a etapa.',
        });
      }
      try {
        referencia = (await comLimite(() => passo.executar(), timeoutChamadaMs)) ?? referencia;
        ultimaConcluida = etapa;
      } catch (erro) {
        return resultadoDeFalha(
          sistema,
          modo,
          ultimaConcluida,
          ultimaConcluida !== anterior ||
            (erro instanceof ErroFornecedor && erro.progressoConfirmado),
          erro,
        );
      }
    }
    return resultado('confirmado', ultimaConcluida, 'OK', {
      referenciaExterna: referencia,
      mensagem: 'Todas as etapas foram concluídas no destino.',
    });
  }

  return {
    async testarConexao(): Promise<ResultadoConexao> {
      let bruto: unknown;
      try {
        await comLimite(() => fornecedor.testar(), timeoutConexaoMs);
        bruto = {
          sistema,
          modo,
          disponivel: true,
          codigo: 'OK',
          mensagem: 'Conexão estabelecida.',
        };
      } catch (erro) {
        const t = traduzirErro(erro);
        bruto = { sistema, modo, disponivel: false, codigo: t.codigo, mensagem: t.mensagem };
      }
      const lido = resultadoConexaoSchema.safeParse(bruto);
      if (lido.success) return semSistema(lido.data);
      return { modo, disponivel: false, codigo: 'RESPOSTA_INVALIDA', mensagem: MENSAGEM_INVALIDA };
    },

    async validar(ctx: ContextoItem): Promise<ResultadoValidacao> {
      let bruto: unknown;
      try {
        const parametros = parametrosDe(ctx);
        const { impedimentos, avisos } = await comLimite(
          () => fornecedor.validar(parametros),
          timeoutChamadaMs,
        );
        bruto = { sistema, modo, impedimentos, avisos };
      } catch (erro) {
        bruto =
          erro instanceof ErroDeUso
            ? {
                sistema,
                modo,
                impedimentos: [{ codigo: 'PARAMETROS_INCOMPATIVEIS', mensagem: erro.message }],
                avisos: [],
              }
            : {
                // Não conseguir validar não é erro nos dados: avisa, sem bloquear.
                sistema,
                modo,
                impedimentos: [],
                avisos: [
                  { codigo: 'VALIDACAO_INDISPONIVEL', mensagem: traduzirErro(erro).mensagem },
                ],
              };
      }
      const lido = resultadoValidacaoSchema.safeParse(bruto);
      if (lido.success) return semSistema(lido.data);
      return {
        modo,
        impedimentos: [],
        avisos: [{ codigo: 'RESPOSTA_INVALIDA', mensagem: MENSAGEM_INVALIDA }],
      };
    },

    /** Leitura: falhas técnicas são lançadas para o worker retentar (só leituras são retentadas). */
    async conferirExistencia(ctx: ContextoItem): Promise<ResultadoExistencia> {
      const parametros = parametrosDe(ctx);
      const estado = await comLimite(() => fornecedor.consultar(parametros), timeoutChamadaMs);
      const lido = resultadoExistenciaSchema.safeParse({
        sistema,
        modo,
        ...estado,
        conferidaEm: agora(),
      });
      if (!lido.success)
        throw new ErroFornecedor('recusado', 'RESPOSTA_INVALIDA', MENSAGEM_INVALIDA);
      return semSistema(lido.data);
    },

    provisionar: (ctx: ContextoItem) => escrever('provisionar', ctx),

    async revogar(ctx: ContextoRevogacao): Promise<ResultadoOperacao> {
      let estado: EstadoParaRevogacao;
      try {
        const parametros = parametrosDe(ctx);
        estado = await comLimite(
          () => fornecedor.estadoParaRevogacao(parametros),
          timeoutChamadaMs,
        );
      } catch (erro) {
        if (erro instanceof ErroDeUso) {
          return resultado('semEfeito', null, 'PARAMETROS_INCOMPATIVEIS', {
            mensagem: MENSAGEM_PARAMETROS,
          });
        }
        // Só leu: se a leitura falhou, nada foi revogado.
        return resultadoDeFalha(sistema, modo, null, false, erro);
      }
      // Regra 5: conta ausente é falha; acesso já revogado é sucesso.
      const decidido = interpretarEstadoParaRevogacao(estado, modo);
      if (decidido !== null) {
        return resultado(decidido.efeito, decidido.etapa, decidido.codigo, {
          mensagem: decidido.mensagem,
        });
      }
      return escrever('revogar', ctx);
    },
  };
}

function semSistema<T extends { sistema: Sistema }>(valor: T): Omit<T, 'sistema'> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { sistema: _sistema, ...resto } = valor;
  return resto;
}

interface ExtraResultado {
  readonly mensagem: string;
  readonly referenciaExterna?: string | null;
  readonly transitorio?: boolean;
  readonly tentarAposMs?: number | null;
}

/** Monta o resultado e o valida pelo contrato; resposta fora do contrato vira `desconhecido`. */
function resultadoOperacao(
  sistema: Sistema,
  modo: ModoExecucao,
  efeito: Efeito,
  etapa: Etapa | null,
  codigo: string,
  extra: ExtraResultado,
): ResultadoOperacao {
  const lido = resultadoOperacaoSchema.safeParse({
    sistema,
    efeito,
    modo,
    etapa,
    codigo,
    referenciaExterna: extra.referenciaExterna ?? null,
    mensagem: extra.mensagem,
    transitorio: extra.transitorio ?? false,
    tentarAposMs: extra.tentarAposMs ?? null,
  });
  if (lido.success) return paraResultadoDoDominio(lido.data);
  return {
    efeito: 'desconhecido',
    modo,
    etapa,
    codigo: 'RESPOSTA_INVALIDA',
    referenciaExterna: null,
    mensagem: MENSAGEM_INVALIDA,
    transitorio: false,
    tentarAposMs: null,
  };
}

interface Traduzido {
  readonly tipo: ErroFornecedor['tipo'];
  readonly codigo: string;
  readonly mensagem: string;
  readonly tentarAposMs: number | null;
}

function traduzirErro(erro: unknown): Traduzido {
  if (erro instanceof ErroFornecedor) {
    return {
      tipo: erro.tipo,
      codigo: erro.codigo,
      mensagem: erro.message,
      tentarAposMs: erro.tentarAposMs,
    };
  }
  // Erro que não sabemos classificar: depois do envio o destino pode ter agido (regra 3).
  return {
    tipo: 'respostaPerdida',
    codigo: 'ERRO_INESPERADO',
    mensagem: 'Erro inesperado ao falar com o destino; confira antes de tentar de novo.',
    tentarAposMs: null,
  };
}

/**
 * Traduz uma falha numa etapa (regra 3). `houveProgresso` diz que esta
 * chamada concluiu etapas antes de falhar: o que foi feito não se perde, então
 * uma falha comprovada vira `parcial` com a última etapa concluída.
 */
function resultadoDeFalha(
  sistema: Sistema,
  modo: ModoExecucao,
  etapa: Etapa | null,
  houveProgresso: boolean,
  erro: unknown,
): ResultadoOperacao {
  const t = traduzirErro(erro);
  const comprovada: Efeito = houveProgresso ? 'parcial' : 'semEfeito';
  switch (t.tipo) {
    case 'timeout':
      return resultadoOperacao(sistema, modo, 'desconhecido', etapa, t.codigo, {
        mensagem: 'Tempo esgotado aguardando o destino; confira antes de tentar de novo.',
      });
    case 'respostaPerdida':
      return resultadoOperacao(sistema, modo, 'desconhecido', etapa, t.codigo, {
        mensagem: 'A resposta do destino se perdeu; confira antes de tentar de novo.',
      });
    case 'identidadeNaoSincronizada':
      return resultadoOperacao(
        sistema,
        modo,
        'semEfeito',
        etapa,
        CODIGO_IDENTIDADE_NAO_SINCRONIZADA,
        {
          mensagem: 'A identidade ainda não chegou ao Entra ID; aguarde a sincronização do AD.',
          transitorio: true,
        },
      );
    case 'conexaoRecusada':
      return resultadoOperacao(sistema, modo, comprovada, etapa, t.codigo, {
        mensagem: 'Não foi possível conectar ao destino.',
        transitorio: true,
      });
    case 'limiteDeTaxa':
      return resultadoOperacao(sistema, modo, comprovada, etapa, t.codigo, {
        mensagem: 'O destino pediu para aguardar antes de nova chamada.',
        transitorio: true,
        tentarAposMs: t.tentarAposMs,
      });
    case 'recusado':
      return resultadoOperacao(sistema, modo, comprovada, etapa, t.codigo, {
        mensagem: t.mensagem,
      });
  }
}

/** Limita o tempo de uma chamada (ADR-0004); o estouro é `timeout`, ou seja, resultado desconhecido. */
export async function comLimite<T>(chamada: () => Promise<T>, limiteMs: number): Promise<T> {
  let temporizador: ReturnType<typeof setTimeout> | undefined;
  const estouro = new Promise<never>((_, rejeitar) => {
    temporizador = setTimeout(() => {
      rejeitar(new ErroFornecedor('timeout'));
    }, limiteMs);
  });
  try {
    return await Promise.race([chamada(), estouro]);
  } finally {
    clearTimeout(temporizador);
  }
}
