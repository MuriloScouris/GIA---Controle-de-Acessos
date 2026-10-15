import { carregarConfiguracaoDocusign, criarConectorDocusignDoAmbiente } from '@gia/conectores';
import type { VariaveisAmbiente } from '@gia/contratos';
import type {
  Conector,
  ContextoItem,
  PoliticaExecucao,
  ResultadoOperacao,
  Sistema,
} from '@gia/dominio';

export const CODIGO_DOCUSIGN_REAL_INDISPONIVEL = 'DOCUSIGN_REAL_INDISPONIVEL';

/** Configurar o DocuSign real é opt-in: só com alguma `GIA_DOCUSIGN_*` presente. */
export function docusignRealConfigurado(env: VariaveisAmbiente): boolean {
  return Object.entries(env).some(
    ([nome, valor]) => nome.startsWith('GIA_DOCUSIGN_') && (valor?.trim() ?? '') !== '',
  );
}

/**
 * Valida a configuração do DocuSign real no arranque (síncrono): presente pela
 * metade, o worker não sobe — melhor falhar na partida do que na primeira operação.
 */
export function validarDocusignReal(env: VariaveisAmbiente): void {
  if (docusignRealConfigurado(env)) carregarConfiguracaoDocusign(env);
}

/**
 * Conector DocuSign real (PR #13) com os timeouts da política do worker, ou
 * `null` sem configuração. A chave privada é lida do arquivo do cofre aqui.
 */
export async function montarDocusignReal(
  env: VariaveisAmbiente,
  politica: PoliticaExecucao,
): Promise<Conector | null> {
  if (!docusignRealConfigurado(env)) return null;
  return criarConectorDocusignDoAmbiente(env, {
    timeoutChamadaMs: politica.timeoutChamadaMs,
  });
}

/**
 * Roteia o DocuSign pelo modo da operação: `simulado` vai ao simulador; `real`
 * vai ao conector real, e sem ele sai `semEfeito` sem chamar nada — nunca o
 * simulador, que devolveria resultado simulado para uma operação real (regra 9).
 * O gate de escrita do próprio transporte (`GIA_DOCUSIGN_ESCRITA_HABILITADA`)
 * e o do domínio (regra 8) continuam valendo.
 *
 * Quando o PR #16 (gates e registro de conectores reais) entrar, este roteamento
 * é substituído por registrar `montarDocusignReal` em `conectoresReaisDoAmbiente`.
 */
export function comDocusignReal(
  conectores: Readonly<Record<Sistema, Conector>>,
  real: Conector | null,
): Readonly<Record<Sistema, Conector>> {
  const simulado = conectores.docusign;
  const semReal = (ctx: ContextoItem): ResultadoOperacao => ({
    efeito: 'semEfeito',
    modo: ctx.modo,
    etapa: null,
    codigo: CODIGO_DOCUSIGN_REAL_INDISPONIVEL,
    referenciaExterna: null,
    mensagem: 'O DocuSign real não está configurado neste worker; nada foi enviado.',
    transitorio: false,
    tentarAposMs: null,
  });
  const ler = (ctx: ContextoItem): Conector => {
    if (ctx.modo !== 'real') return simulado;
    if (real === null) throw new Error(CODIGO_DOCUSIGN_REAL_INDISPONIVEL);
    return real;
  };
  return {
    ...conectores,
    docusign: {
      testarConexao: () => (real ?? simulado).testarConexao(),
      validar: (ctx) => ler(ctx).validar(ctx),
      conferirExistencia: (ctx) => ler(ctx).conferirExistencia(ctx),
      provisionar: async (ctx) => {
        if (ctx.modo !== 'real') return simulado.provisionar(ctx);
        return real === null ? semReal(ctx) : real.provisionar(ctx);
      },
      revogar: async (ctx) => {
        if (ctx.modo !== 'real') return simulado.revogar(ctx);
        return real === null ? semReal(ctx) : real.revogar(ctx);
      },
    },
  };
}
