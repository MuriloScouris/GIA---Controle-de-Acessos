import { saudeRespostaSchema, type SaudeResposta } from '@gia/contratos';

export type Fetcher = (entrada: string, init?: RequestInit) => Promise<Response>;

export class ErroApi extends Error {
  readonly status: number | undefined;

  constructor(mensagem: string, status?: number) {
    super(mensagem);
    this.name = 'ErroApi';
    this.status = status;
  }
}

/** Cliente da API do Gia: toda resposta é validada pelos esquemas de `@gia/contratos`. */
export function criarClienteApi(baseUrl = '', fetcher: Fetcher = (u, i) => fetch(u, i)) {
  async function obter<T>(caminho: string, parse: (dado: unknown) => T): Promise<T> {
    const resposta = await fetcher(`${baseUrl}${caminho}`, { credentials: 'include' });
    if (!resposta.ok) throw new ErroApi('Falha ao consultar a API', resposta.status);
    try {
      return parse(await resposta.json());
    } catch {
      throw new ErroApi('Resposta da API fora do contrato', resposta.status);
    }
  }

  return {
    saude: (): Promise<SaudeResposta> => obter('/saude', (d) => saudeRespostaSchema.parse(d)),
  };
}

export type ClienteApi = ReturnType<typeof criarClienteApi>;
