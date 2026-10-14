import type { ModoExecucao, ResultadoConexao } from '@gia/dominio';
import { ErroFornecedor } from '../erros.js';
import { comLimite } from '../motor.js';

export interface PaginaChamados {
  /** Chamados no formato cru do Jira; a normalização é da API (`importar-jira`). */
  readonly chamados: readonly unknown[];
  /** Total de chamados que a busca encontrou, em todas as páginas. */
  readonly total: number;
}

/** Transporte REST + JQL do Jira como origem (somente leitura). */
export interface ClienteJiraOrigem {
  testar(): Promise<void>;
  buscarPagina(consulta: {
    readonly tiposSolicitacao: readonly string[];
    readonly inicio: number;
    readonly tamanho: number;
  }): Promise<PaginaChamados>;
}

/** Mesma forma da porta `FonteChamadosJira` da API, para que ela a use sem adaptação. */
export interface FonteChamados {
  buscarChamadosOnboarding(): Promise<readonly unknown[]>;
}

export interface OpcoesJiraOrigem {
  /** Cliente simulado informa `simulado` (regra 9). */
  readonly modo: ModoExecucao;
  /** Request types de onboarding (celetista e terceiro). */
  readonly tiposSolicitacao: readonly string[];
  readonly tamanhoPagina?: number;
  /** Trava contra paginação sem fim (total que nunca fecha). */
  readonly maxPaginas?: number;
  readonly timeoutChamadaMs?: number;
}

export interface JiraOrigem extends FonteChamados {
  testarConexao(): Promise<ResultadoConexao>;
}

/**
 * Lê os chamados de onboarding com paginação e deduplica pela chave da issue.
 * É leitura: falhas técnicas são lançadas para o worker retentar com backoff.
 * Nunca aprova nem cria pedido sozinha.
 */
export function criarJiraOrigem(cliente: ClienteJiraOrigem, opcoes: OpcoesJiraOrigem): JiraOrigem {
  const tamanho = opcoes.tamanhoPagina ?? 50;
  const maxPaginas = opcoes.maxPaginas ?? 200;
  const timeoutMs = opcoes.timeoutChamadaMs ?? 30_000;
  return {
    async testarConexao() {
      try {
        await comLimite(() => cliente.testar(), timeoutMs);
        return {
          modo: opcoes.modo,
          disponivel: true,
          codigo: 'OK',
          mensagem: 'Conexão estabelecida.',
        };
      } catch (erro) {
        const codigo = erro instanceof ErroFornecedor ? erro.codigo : 'ERRO_INESPERADO';
        return {
          modo: opcoes.modo,
          disponivel: false,
          codigo,
          mensagem: 'Não foi possível conectar ao Jira.',
        };
      }
    },

    async buscarChamadosOnboarding() {
      const vistos = new Set<string>();
      const unicos: unknown[] = [];
      let inicio = 0;
      for (let pagina = 0; pagina < maxPaginas; pagina += 1) {
        const { chamados, total } = await comLimite(
          () =>
            cliente.buscarPagina({ tiposSolicitacao: opcoes.tiposSolicitacao, inicio, tamanho }),
          timeoutMs,
        );
        for (const chamado of chamados) {
          const chave = chaveDe(chamado);
          // Sem chave não dá para deduplicar: segue adiante e a API recusa na normalização.
          if (chave !== null && vistos.has(chave)) continue;
          if (chave !== null) vistos.add(chave);
          unicos.push(chamado);
        }
        inicio += chamados.length;
        if (chamados.length === 0 || inicio >= total) return unicos;
      }
      throw new ErroFornecedor(
        'recusado',
        'PAGINACAO_EXCEDIDA',
        'A busca do Jira excedeu o limite de páginas.',
      );
    },
  };
}

function chaveDe(chamado: unknown): string | null {
  if (typeof chamado !== 'object' || chamado === null) return null;
  const { key } = chamado as { key?: unknown };
  return typeof key === 'string' && key.trim() !== '' ? key.trim() : null;
}
