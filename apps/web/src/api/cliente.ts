import {
  listaPedidosSchema,
  pedidoDetalheSchema,
  respostaErroSchema,
  respostaSucessoSchema,
  resultadoImportacaoSchema,
  saudeRespostaSchema,
  sessaoRespostaSchema,
  type Comando,
  type ListaPedidos,
  type PapelHumano,
  type PedidoDetalhe,
  type RespostaSucesso,
  type ResultadoImportacao,
  type SaudeResposta,
  type SessaoResposta,
} from '@gia/contratos';

export type Fetcher = (entrada: string, init?: RequestInit) => Promise<Response>;

/** Cabeçalho CSRF exigido pela API em toda escrita (ver `apps/api/src/http/protocolo.ts`). */
const CABECALHO_CSRF = { 'x-gia-csrf': '1' } as const;

export class ErroApi extends Error {
  readonly status: number | undefined;
  /** Código estável de recusa devolvido pela API (ex.: `CONFLITO_DE_VERSAO`), quando houver. */
  readonly codigo: string | undefined;

  constructor(mensagem: string, status?: number, codigo?: string) {
    super(mensagem);
    this.name = 'ErroApi';
    this.status = status;
    this.codigo = codigo;
  }
}

/** Comando sem o `pedidoId` e a versão: o cliente os preenche a partir do pedido visto. */
export type ComandoDoPedido = Comando extends infer C
  ? C extends Comando
    ? Omit<C, 'pedidoId' | 'versaoEsperada'>
    : never
  : never;

/** Cliente da API do GIA: toda resposta é validada pelos esquemas de `@gia/contratos`. */
export function criarClienteApi(baseUrl = '', fetcher: Fetcher = (u, i) => fetch(u, i)) {
  async function pedir(caminho: string, init: RequestInit): Promise<Response> {
    try {
      return await fetcher(`${baseUrl}${caminho}`, { credentials: 'include', ...init });
    } catch {
      throw new ErroApi('API indisponível');
    }
  }

  /** Recusa da API: usa o código estável e a mensagem do contrato; senão, uma mensagem genérica. */
  async function erroDe(resposta: Response, padrao: string): Promise<ErroApi> {
    try {
      const lido = respostaErroSchema.safeParse(await resposta.json());
      if (lido.success) return new ErroApi(lido.data.mensagem, resposta.status, lido.data.codigo);
    } catch {
      // Corpo ausente ou que não é JSON.
    }
    return new ErroApi(padrao, resposta.status);
  }

  async function ler<T>(
    resposta: Response,
    parse: (dado: unknown) => T,
    padrao: string,
  ): Promise<T> {
    if (!resposta.ok) throw await erroDe(resposta, padrao);
    try {
      return parse(await resposta.json());
    } catch {
      throw new ErroApi('Resposta da API fora do contrato', resposta.status);
    }
  }

  const obter = async <T>(caminho: string, parse: (dado: unknown) => T): Promise<T> =>
    ler(await pedir(caminho, {}), parse, 'Falha ao consultar a API');

  const enviar = async <T>(
    caminho: string,
    corpo: unknown,
    parse: (dado: unknown) => T,
    padrao: string,
  ): Promise<T> =>
    ler(
      await pedir(caminho, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...CABECALHO_CSRF },
        body: JSON.stringify(corpo),
      }),
      parse,
      padrao,
    );

  return {
    saude: (): Promise<SaudeResposta> => obter('/saude', (d) => saudeRespostaSchema.parse(d)),

    /** Sessão SIMULADA: o servidor abre a sessão de uma pessoa fictícia do papel escolhido. */
    abrirSessaoSimulada: (papel: PapelHumano): Promise<SessaoResposta> =>
      enviar(
        '/sessao/simulada',
        { papel },
        (d) => sessaoRespostaSchema.parse(d),
        'Não foi possível abrir a sessão',
      ),

    encerrarSessao: async (): Promise<void> => {
      await pedir('/sessao', { method: 'DELETE', headers: { ...CABECALHO_CSRF } });
    },

    listarPedidos: (): Promise<ListaPedidos> =>
      obter('/pedidos', (d) => listaPedidosSchema.parse(d)),

    detalharPedido: (pedidoId: string): Promise<PedidoDetalhe> =>
      obter(`/pedidos/${encodeURIComponent(pedidoId)}`, (d) => pedidoDetalheSchema.parse(d)),

    importarDoJira: (): Promise<ResultadoImportacao> =>
      enviar(
        '/importacoes/jira',
        {},
        (d) => resultadoImportacaoSchema.parse(d),
        'Não foi possível importar do Jira',
      ),

    /** O ator vem da sessão no servidor; o comando leva só o pedido, a versão vista e os dados. */
    executarComando: (
      pedidoId: string,
      versaoEsperada: number,
      comando: ComandoDoPedido,
    ): Promise<RespostaSucesso> =>
      enviar(
        `/pedidos/${encodeURIComponent(pedidoId)}/comandos`,
        { ...comando, pedidoId, versaoEsperada },
        (d) => respostaSucessoSchema.parse(d),
        'Não foi possível executar a ação',
      ),
  };
}

export type ClienteApi = ReturnType<typeof criarClienteApi>;
