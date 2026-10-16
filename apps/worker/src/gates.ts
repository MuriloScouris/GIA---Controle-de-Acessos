import { escritaPermitida, type GatesDeEscrita } from '@gia/contratos';
import {
  SISTEMAS,
  type Conector,
  type ContextoItem,
  type ResultadoOperacao,
  type Sistema,
  type TipoEscrita,
} from '@gia/dominio';

export const CODIGO_ESCRITA_NAO_LIBERADA = 'ESCRITA_NAO_LIBERADA';
export const CODIGO_CONECTOR_REAL_INDISPONIVEL = 'CONECTOR_REAL_INDISPONIVEL';

/** Conectores de produção já montados, por sistema. Ausente = o sistema não tem transporte real. */
export type ConectoresReais = Partial<Readonly<Record<Sistema, Conector>>>;

export interface DecisaoGate {
  readonly sistema: Sistema;
  readonly tipo: TipoEscrita;
  readonly operacaoId: string;
  readonly decisao: 'liberada' | 'bloqueada' | 'semConectorReal';
}

/** Conector real ausente numa leitura `real`: não há como ler o destino de verdade. */
export class ConectorRealIndisponivel extends Error {
  constructor(readonly sistema: Sistema) {
    super(`Não há conector real para ${sistema}.`);
    this.name = 'ConectorRealIndisponivel';
  }
}

function semEfeito(ctx: ContextoItem, codigo: string, mensagem: string): ResultadoOperacao {
  return {
    efeito: 'semEfeito',
    modo: ctx.modo,
    etapa: null,
    codigo,
    referenciaExterna: null,
    mensagem,
    transitorio: false,
    tentarAposMs: null,
  };
}

/**
 * Segundo cadeado da escrita externa, no worker (o primeiro é o domínio, na
 * API). Toda operação `real` passa por aqui antes de chegar ao conector:
 *
 * - sistema/operação fora de `GIA_ESCRITA_LIBERADA` (ou chave mestra
 *   desligada) → `semEfeito` sem chamar nada. Desligar a chave e reiniciar o
 *   worker para a escrita real na hora, inclusive do que já estava na fila;
 * - sistema sem conector real → `semEfeito`, nunca o simulador (regra 9).
 *
 * Operações `simulado` seguem sempre para o simulador.
 */
export function aplicarGatesDeEscrita(
  simulados: Readonly<Record<Sistema, Conector>>,
  reais: ConectoresReais,
  gates: GatesDeEscrita,
  aoDecidir: (decisao: DecisaoGate) => void = () => undefined,
): Readonly<Record<Sistema, Conector>> {
  const protegido = (sistema: Sistema): Conector => {
    const simulado = simulados[sistema];
    const real = reais[sistema];
    const escrever = <C extends ContextoItem>(
      tipo: TipoEscrita,
      ctx: C,
      chamar: (conector: Conector) => Promise<ResultadoOperacao>,
    ): Promise<ResultadoOperacao> => {
      if (ctx.modo !== 'real') return chamar(simulado);
      const decidir = (decisao: DecisaoGate['decisao']) =>
        aoDecidir({ sistema, tipo, operacaoId: ctx.operacaoId, decisao });
      if (!escritaPermitida(gates, sistema, tipo)) {
        decidir('bloqueada');
        return Promise.resolve(
          semEfeito(
            ctx,
            CODIGO_ESCRITA_NAO_LIBERADA,
            `A escrita real (${sistema}:${tipo}) não está liberada neste ambiente; nada foi enviado.`,
          ),
        );
      }
      if (real === undefined) {
        decidir('semConectorReal');
        return Promise.resolve(
          semEfeito(
            ctx,
            CODIGO_CONECTOR_REAL_INDISPONIVEL,
            `Não há conector real de ${sistema} neste worker; nada foi enviado.`,
          ),
        );
      }
      decidir('liberada');
      return chamar(real);
    };
    const ler = (ctx: ContextoItem): Conector => {
      if (ctx.modo !== 'real') return simulado;
      if (real === undefined) throw new ConectorRealIndisponivel(sistema);
      return real;
    };
    return {
      testarConexao: () => (real ?? simulado).testarConexao(),
      validar: (ctx) => ler(ctx).validar(ctx),
      conferirExistencia: (ctx) => ler(ctx).conferirExistencia(ctx),
      provisionar: (ctx) => escrever('criar', ctx, (c) => c.provisionar(ctx)),
      revogar: (ctx) => escrever('revogar', ctx, (c) => c.revogar(ctx)),
    };
  };
  return Object.fromEntries(SISTEMAS.map((s) => [s, protegido(s)])) as Record<Sistema, Conector>;
}
