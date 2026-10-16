import {
  listaPedidosSchema,
  historicoPedidoSchema,
  pedidoDetalheSchema,
  respostaErroSchema,
  respostaSucessoSchema,
  resultadoImportacaoSchema,
  saudeRespostaSchema,
  sessaoRespostaSchema,
  type Comando,
  type ListaPedidos,
  type HistoricoPedido,
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

/** Como as pessoas entram, segundo o servidor (`GET /sessao/modo`). */
export type ModoSessao = 'oidc' | 'simulada' | 'indisponivel';

/** Hosts para onde o logout pode levar o navegador (o logout do Entra ID). */
const HOSTS_DE_LOGOUT = ['login.microsoftonline.com'];

function lerModo(dado: unknown): ModoSessao {
  const modo = (dado as { modo?: unknown } | null)?.modo;
  if (modo === 'oidc' || modo === 'simulada' || modo === 'indisponivel') return modo;
  throw new Error('modo desconhecido');
}

/** URL de logout do Entra ID, ou `null` se a resposta apontar para outro lugar. */
function lerLogout(dado: unknown): string | null {
  const url = (dado as { redirecionarPara?: unknown } | null)?.redirecionarPara;
  if (typeof url !== 'string') return null;
  try {
    const lida = new URL(url);
    return lida.protocol === 'https:' && HOSTS_DE_LOGOUT.includes(lida.host)
      ? lida.toString()
      : null;
  } catch {
    return null;
  }
}

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

    /** Qual login oferecer. Falha de rede ou resposta estranha é `indisponivel`: nunca cai na simulada. */
    modoSessao: async (): Promise<ModoSessao> => {
      try {
        return lerModo(await (await pedir('/sessao/modo', {})).json());
      } catch {
        return 'indisponivel';
      }
    },

    /** Sessão aberta no servidor, ou `null` sem sessão (401). */
    sessaoAtual: async (): Promise<SessaoResposta | null> => {
      const resposta = await pedir('/sessao', {});
      if (resposta.status === 401) return null;
      return ler(resposta, (d) => sessaoRespostaSchema.parse(d), 'Falha ao consultar a sessão');
    },

    /** Endereço que leva ao login do Entra ID; o retorno é sempre um caminho local. */
    urlEntrarOidc: (retorno: string): string =>
      `${baseUrl}/sessao/oidc/entrar?retorno=${encodeURIComponent(retorno)}`,

    /**
     * Logout OIDC por POST com CSRF: o servidor encerra a sessão local e devolve o
     * logout do Entra ID. Só um destino do Entra ID é aceito.
     */
    sairOidc: async (): Promise<string | null> => {
      const resposta = await pedir('/sessao/oidc/sair', {
        method: 'POST',
        headers: { ...CABECALHO_CSRF },
      });
      if (!resposta.ok) return null;
      try {
        return lerLogout(await resposta.json());
      } catch {
        return null;
      }
    },

    listarPedidos: (): Promise<ListaPedidos> =>
      obter('/pedidos', (d) => listaPedidosSchema.parse(d)),

    detalharPedido: (pedidoId: string): Promise<PedidoDetalhe> =>
      obter(`/pedidos/${encodeURIComponent(pedidoId)}`, (d) => pedidoDetalheSchema.parse(d)),

    consultarHistorico: (pedidoId: string, cursor?: string): Promise<HistoricoPedido> =>
      obter(
        `/pedidos/${encodeURIComponent(pedidoId)}/historico${cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`}`,
        (d) => historicoPedidoSchema.parse(d),
      ),

    importarDoJira: (): Promise<ResultadoImportacao> =>
      enviar(
        '/importacoes/jira',
        {},
        (d) => resultadoImportacaoSchema.parse(d),
        'Não foi possível importar do Jira',
      ),

    /** O ator vem da sessão no servidor; o comando leva só o pedido, a versão vista e os dados. */
    executarComando: async (
      pedidoId: string,
      versaoEsperada: number,
      comando: ComandoDoPedido,
    ): Promise<RespostaSucesso> => {
      try {
        return await enviar(
          `/pedidos/${encodeURIComponent(pedidoId)}/comandos`,
          { ...comando, pedidoId, versaoEsperada },
          (d) => respostaSucessoSchema.parse(d),
          'Não foi possível executar a ação',
        );
      } catch (erro) {
        // A API pode ter confirmado a transação antes de perder a resposta.
        if (
          erro instanceof ErroApi &&
          (erro.status === undefined ||
            erro.status >= 500 ||
            (erro.status >= 200 && erro.status < 300))
        ) {
          throw new ErroApi(
            'Não foi possível confirmar o resultado da ação. Confira o pedido antes de tentar novamente.',
            erro.status,
            'RESULTADO_DESCONHECIDO',
          );
        }
        throw erro;
      }
    },
  };
}

export type ClienteApi = ReturnType<typeof criarClienteApi>;
