import { AsyncLocalStorage } from 'node:async_hooks';
import { ErroConfiguracao } from '@gia/contratos';
import { ErroFornecedor } from '../erros.js';

export interface EventoHttpJira {
  readonly operacao: string;
  readonly metodo: string;
  readonly tentativa: number;
  readonly status: number | null;
  readonly codigo: string;
}

export interface OpcoesHttpJira {
  readonly baseUrl: string;
  readonly email: string;
  readonly apiToken: string;
  readonly timeoutMs?: number;
  readonly tentativasLeitura?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly esperar?: (ms: number) => Promise<void>;
  /** Metadados técnicos apenas; auditoria de negócio continua na transação do worker/API. */
  readonly auditar?: (evento: EventoHttpJira) => void;
}

export function objeto(valor: unknown): Record<string, unknown> {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) throw invalida();
  return valor as Record<string, unknown>;
}

export function invalida(): ErroFornecedor {
  return new ErroFornecedor('recusado', 'JIRA_RESPOSTA_INVALIDA');
}

export function texto(valor: unknown): string {
  if (typeof valor !== 'string' || valor.trim() === '') throw invalida();
  return valor;
}

export class HttpJira {
  readonly #opcoes: OpcoesHttpJira;
  readonly #base: URL;
  readonly #autorizacao: string;
  readonly #timeout: number;
  readonly #tentativas: number;
  readonly #prazo = new AsyncLocalStorage<number>();

  /** Propaga o prazo da operação a todas as chamadas, inclusive após timeout do motor. */
  comPrazo<T>(executar: () => Promise<T>, limiteMs = 29_000): Promise<T> {
    return this.#prazo.run(Date.now() + limiteMs, executar);
  }

  constructor(opcoes: OpcoesHttpJira) {
    const erros: string[] = [];
    let base: URL;
    try {
      base = new URL(opcoes.baseUrl);
      if (
        base.protocol !== 'https:' ||
        base.username ||
        base.password ||
        base.search ||
        base.hash ||
        base.pathname !== '/'
      ) {
        erros.push('GIA_JIRA_BASE_URL');
      }
    } catch {
      base = new URL('https://invalid.invalid');
      erros.push('GIA_JIRA_BASE_URL');
    }
    if (!/^[^\s:@]+@[^\s@]+$/.test(opcoes.email)) erros.push('GIA_JIRA_EMAIL');
    if (!opcoes.apiToken.trim() || /[\r\n]/.test(opcoes.apiToken)) erros.push('GIA_JIRA_API_TOKEN');
    const timeout = opcoes.timeoutMs ?? 5_000;
    const tentativas = opcoes.tentativasLeitura ?? 3;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30_000)
      erros.push('GIA_JIRA_TIMEOUT_MS');
    if (!Number.isInteger(tentativas) || tentativas < 1 || tentativas > 3)
      erros.push('GIA_JIRA_TENTATIVAS_LEITURA');
    if (erros.length) throw new ErroConfiguracao(erros);
    this.#opcoes = opcoes;
    this.#base = base;
    this.#timeout = timeout;
    this.#tentativas = tentativas;
    this.#autorizacao = `Basic ${Buffer.from(`${opcoes.email}:${opcoes.apiToken}`).toString('base64')}`;
  }

  async chamar(
    operacao: string,
    caminho: string,
    consulta: Record<string, string> = {},
    metodo = 'GET',
    corpo?: unknown,
  ): Promise<unknown> {
    const leitura = metodo === 'GET';
    const url = new URL(`/rest/api/3/${caminho}`, this.#base);
    url.search = new URLSearchParams(consulta).toString();
    for (let tentativa = 1; ; tentativa += 1) {
      const restante = (this.#prazo.getStore() ?? Infinity) - Date.now();
      if (restante <= 0) throw new ErroFornecedor('timeout', 'JIRA_TIMEOUT');
      let status: number | null = null;
      let temporizador: ReturnType<typeof setTimeout> | undefined;
      const controle = new AbortController();
      try {
        const executar = async () => {
          const resposta = await (this.#opcoes.fetch ?? globalThis.fetch)(url, {
            method: metodo,
            redirect: 'error',
            signal: controle.signal,
            headers: {
              Authorization: this.#autorizacao,
              Accept: 'application/json',
              'Content-Type': 'application/json',
            },
            ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
          });
          status = resposta.status;
          if (!resposta.ok) {
            // Nunca propagar body, URL, email ou mensagem do fornecedor.
            await resposta.body?.cancel();
            if (status === 429)
              throw new ErroFornecedor(
                'limiteDeTaxa',
                'JIRA_LIMITE_DE_TAXA',
                undefined,
                retryAfter(resposta.headers.get('retry-after')),
              );
            if (status >= 500)
              throw new ErroFornecedor(
                leitura ? 'conexaoRecusada' : 'respostaPerdida',
                'JIRA_INDISPONIVEL',
              );
            throw new ErroFornecedor(
              'recusado',
              status === 401
                ? 'JIRA_AUTENTICACAO'
                : status === 403
                  ? 'JIRA_PERMISSAO'
                  : status === 404
                    ? 'JIRA_NAO_ENCONTRADO'
                    : 'JIRA_HTTP_RECUSADO',
            );
          }
          if (status === 204) return null;
          try {
            return (await resposta.json()) as unknown;
          } catch {
            throw new ErroFornecedor(
              leitura ? 'recusado' : 'respostaPerdida',
              'JIRA_RESPOSTA_INVALIDA',
            );
          }
        };
        const limite = new Promise<never>((_, rejeitar) => {
          temporizador = setTimeout(
            () => {
              controle.abort();
              rejeitar(new ErroFornecedor('timeout', 'JIRA_TIMEOUT'));
            },
            Math.min(this.#timeout, restante),
          );
        });
        const valor = await Promise.race([executar(), limite]);
        this.#opcoes.auditar?.({ operacao, metodo, tentativa, status, codigo: 'OK' });
        return valor;
      } catch (erro) {
        const falha =
          erro instanceof ErroFornecedor
            ? erro
            : new ErroFornecedor('respostaPerdida', 'JIRA_TRANSPORTE');
        this.#opcoes.auditar?.({ operacao, metodo, tentativa, status, codigo: falha.codigo });
        const retentavel = [
          'timeout',
          'respostaPerdida',
          'conexaoRecusada',
          'limiteDeTaxa',
        ].includes(falha.tipo);
        const atraso =
          falha.tentarAposMs ?? 250 * 2 ** (tentativa - 1) + Math.floor(Math.random() * 100);
        if (!leitura || !retentavel || tentativa >= this.#tentativas || atraso > 5_000) throw falha;
        clearTimeout(temporizador);
        await (this.#opcoes.esperar ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(atraso);
      } finally {
        clearTimeout(temporizador);
      }
    }
  }
}

function retryAfter(valor: string | null): number | null {
  if (valor === null) return null;
  const ms = /^\d+(\.\d+)?$/.test(valor) ? Number(valor) * 1_000 : Date.parse(valor) - Date.now();
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 86_400_000) : null;
}
