import { randomUUID } from 'node:crypto';
import { setTimeout as esperar } from 'node:timers/promises';
import { ErroConfiguracao } from '@gia/contratos';
import { normalizarAcesso } from '@gia/dominio';
import type { ClienteGraph, UsuarioEntra } from '../adaptadores/m365.js';
import { ErroFornecedor } from '../erros.js';
import { NUVENS_M365, lerSegredoM365, type ConfiguracaoM365 } from './configuracao.js';

/** Operações do cliente, para o registro de auditoria. */
export type OperacaoGraph =
  | 'token'
  | 'testar'
  | 'buscarUsuario'
  | 'listarPlanos'
  | 'buscarGrupo'
  | 'definirPaisDeUso'
  | 'atribuirLicencas'
  | 'adicionarAoGrupo'
  | 'removerLicencas';

/**
 * Registro de cada chamada ao Graph. Leva o `client-request-id` enviado (o
 * suporte da Microsoft localiza a requisição por ele), nunca UPN, e-mail,
 * token ou segredo.
 */
export interface RegistroChamadaGraph {
  readonly operacao: OperacaoGraph;
  readonly desfecho: 'ok' | ErroFornecedor['tipo'];
  readonly codigo: string;
  readonly httpStatus: number | null;
  readonly idRequisicao: string | null;
  readonly duracaoMs: number;
  readonly tentativas: number;
}

export interface DependenciasGraph {
  readonly fetch?: typeof fetch;
  readonly relogio?: () => number;
  readonly aoRegistrar?: (registro: RegistroChamadaGraph) => void;
  /** Espera base entre tentativas de leitura sem `Retry-After` (multiplicada a cada tentativa). */
  readonly esperaBaseMs?: number;
}

interface Resposta {
  readonly status: number;
  readonly corpo: Record<string, unknown> | null;
}

interface Sku {
  readonly skuId: string;
  readonly nome: string;
  readonly livres: number;
}

interface Grupo {
  readonly id: string;
  readonly sincronizadoDoAd: boolean;
}

const CAMPOS_USUARIO = 'id,userPrincipalName,mail,usageLocation,assignedLicenses';
const VALIDADE_SKUS_MS = 60_000;
const MAXIMO_PAGINAS = 20;
const MENSAGEM_PADRAO = 'Falha ao acessar o Microsoft Graph.';

/**
 * Transporte do Microsoft Graph v1.0 (app-only, client credentials). Segue as
 * armadilhas conferidas no tenant pelo GIA anterior: busca por UPN → `mail` →
 * `proxyAddresses`; licença por `skuPartNumber`; `usageLocation` antes de
 * licenciar; `removeLicenses` sempre no corpo; "já é membro" (400) é sucesso;
 * grupo sincronizado do AD é somente leitura na nuvem.
 *
 * Cada método tem prazo total (`timeoutMs`). Leituras repetem em limite de
 * taxa (respeitando `Retry-After`) e falha transitória; escritas não (regra 3).
 * Regra 7: não há como criar usuário — só a identidade sincronizada do AD.
 */
export class ClienteGraphHttp implements ClienteGraph {
  private readonly enviar: typeof fetch;
  private readonly relogio: () => number;
  private readonly esperaBaseMs: number;
  private readonly hosts: (typeof NUVENS_M365)[keyof typeof NUVENS_M365];
  private token: { valor: string; expiraEm: number } | null = null;
  private skus: { lista: readonly Sku[]; em: number } | null = null;

  constructor(
    private readonly config: ConfiguracaoM365,
    private readonly dependencias: DependenciasGraph = {},
  ) {
    this.enviar = dependencias.fetch ?? fetch;
    this.relogio = dependencias.relogio ?? Date.now;
    this.esperaBaseMs = dependencias.esperaBaseMs ?? 500;
    this.hosts = NUVENS_M365[config.nuvem];
  }

  testar(): Promise<void> {
    return this.comPrazo(async (sinal) => {
      await this.ler('testar', '/organization?$select=id', sinal);
    });
  }

  buscarUsuario(upn: string, email?: string): Promise<UsuarioEntra | null> {
    return this.comPrazo(async (sinal) => {
      const bruto = await this.localizarUsuario(upn, email, sinal);
      if (bruto === null) return null;
      return this.usuarioDe(bruto, sinal);
    });
  }

  planoExiste(plano: string): Promise<boolean> {
    return this.comPrazo(async (sinal) => (await this.sku(plano, sinal)) !== null);
  }

  assentosLivres(plano: string): Promise<number | null> {
    return this.comPrazo(async (sinal) => (await this.sku(plano, sinal))?.livres ?? null);
  }

  grupoExiste(grupo: string): Promise<boolean> {
    return this.comPrazo(async (sinal) => (await this.grupo(grupo, sinal)) !== null);
  }

  definirPaisDeUso(upn: string, pais: string): Promise<void> {
    return this.comPrazo(async (sinal) => {
      const usuario = await this.exigirUsuario(upn, sinal);
      if (texto(usuario['usageLocation']).toUpperCase() === pais.toUpperCase()) return;
      await this.escrever('definirPaisDeUso', 'PATCH', `/users/${seguro(usuario['id'])}`, sinal, {
        usageLocation: pais,
      });
    });
  }

  atribuirLicencas(upn: string, planos: readonly string[]): Promise<void> {
    return this.comPrazo(async (sinal) => {
      const usuario = await this.exigirUsuario(upn, sinal);
      if (texto(usuario['usageLocation']) === '') {
        throw new ErroFornecedor(
          'recusado',
          'PAIS_DE_USO_AUSENTE',
          'A conta não tem país de uso; o Graph recusaria a licença.',
        );
      }
      const atribuidas = new Set(skuIdsDe(usuario));
      const adicionar: string[] = [];
      for (const plano of planos) {
        const sku = await this.sku(plano, sinal);
        if (sku === null) {
          throw new ErroFornecedor(
            'recusado',
            'PLANO_INEXISTENTE',
            `O plano "${plano}" não é assinatura deste tenant.`,
          );
        }
        if (atribuidas.has(sku.skuId)) continue;
        // Assento esgotado faria o Graph recusar no meio; falha antes, sem efeito.
        if (sku.livres <= 0) {
          throw new ErroFornecedor(
            'recusado',
            'SEM_ASSENTO',
            `Não há assento livre do plano "${plano}".`,
          );
        }
        adicionar.push(sku.skuId);
      }
      if (adicionar.length === 0) return;
      await this.escrever(
        'atribuirLicencas',
        'POST',
        `/users/${seguro(usuario['id'])}/assignLicense`,
        sinal,
        // `removeLicenses` é obrigatório, mesmo vazio.
        {
          addLicenses: adicionar.map((skuId) => ({ skuId, disabledPlans: [] })),
          removeLicenses: [],
        },
      );
      this.skus = null;
    });
  }

  adicionarAoGrupo(upn: string, nomeGrupo: string): Promise<void> {
    return this.comPrazo(async (sinal) => {
      const usuario = await this.exigirUsuario(upn, sinal);
      const grupo = await this.grupo(nomeGrupo, sinal);
      if (grupo === null) {
        throw new ErroFornecedor('recusado', 'GRUPO_INEXISTENTE', 'O grupo não existe no M365.');
      }
      if (grupo.sincronizadoDoAd) {
        throw new ErroFornecedor(
          'recusado',
          'M365_GRUPO_SINCRONIZADO_DO_AD',
          'O grupo vem do AD e é somente leitura na nuvem; inclua pelo grupo do AD.',
        );
      }
      const idUsuario = seguro(usuario['id']);
      const filtro = encodeURIComponent(`id eq '${odata(idUsuario)}'`);
      const membros = await this.ler(
        'adicionarAoGrupo',
        `/groups/${grupo.id}/members?$select=id&$count=true&$filter=${filtro}`,
        sinal,
        { avancada: true },
      );
      if (lista(membros.corpo).length > 0) return;
      const resposta = await this.escrever(
        'adicionarAoGrupo',
        'POST',
        `/groups/${grupo.id}/members/$ref`,
        sinal,
        { '@odata.id': `${this.hosts.graph}/v1.0/directoryObjects/${idUsuario}` },
        { aceitarJaMembro: true },
      );
      void resposta;
    });
  }

  removerLicencas(upn: string, planos: readonly string[]): Promise<void> {
    return this.comPrazo(async (sinal) => {
      const usuario = await this.localizarUsuario(upn, undefined, sinal);
      if (usuario === null) {
        throw new ErroFornecedor('recusado', 'CONTA_AUSENTE', 'A conta não existe no Entra ID.');
      }
      // Remoção segura: só as licenças pedidas E atribuídas hoje; nada além do plano.
      const atribuidas = new Set(skuIdsDe(usuario));
      const remover: string[] = [];
      for (const plano of planos) {
        const sku = await this.sku(plano, sinal);
        if (sku !== null && atribuidas.has(sku.skuId)) remover.push(sku.skuId);
      }
      if (remover.length === 0) return;
      await this.escrever(
        'removerLicencas',
        'POST',
        `/users/${seguro(usuario['id'])}/assignLicense`,
        sinal,
        { addLicenses: [], removeLicenses: remover },
      );
      this.skus = null;
    });
  }

  // -------------------------------------------------------------------------

  /** UPN → `mail` → `proxyAddresses`: o UPN do AD pode ter virado `onmicrosoft.com`. */
  private async localizarUsuario(
    upn: string,
    email: string | undefined,
    sinal: AbortSignal,
  ): Promise<Record<string, unknown> | null> {
    const direto = await this.ler(
      'buscarUsuario',
      `/users/${encodeURIComponent(upn)}?$select=${CAMPOS_USUARIO}`,
      sinal,
      { aceitar404: true },
    );
    if (direto.status !== 404 && direto.corpo !== null) return direto.corpo;
    if (email === undefined || email.trim() === '') return null;
    const valor = odata(email.trim());
    const porMail = await this.ler(
      'buscarUsuario',
      `/users?$select=${CAMPOS_USUARIO}&$filter=${encodeURIComponent(`mail eq '${valor}'`)}`,
      sinal,
    );
    const achado = unico(lista(porMail.corpo));
    if (achado !== null) return achado;
    const porAlias = await this.ler(
      'buscarUsuario',
      `/users?$select=${CAMPOS_USUARIO}&$count=true&$filter=${encodeURIComponent(
        `proxyAddresses/any(p:p eq 'smtp:${valor}')`,
      )}`,
      sinal,
      { avancada: true },
    );
    return unico(lista(porAlias.corpo));
  }

  private async exigirUsuario(upn: string, sinal: AbortSignal): Promise<Record<string, unknown>> {
    const usuario = await this.localizarUsuario(upn, undefined, sinal);
    // Regra 7: sem a identidade sincronizada do AD não há o que licenciar.
    if (usuario === null) throw new ErroFornecedor('identidadeNaoSincronizada');
    return usuario;
  }

  private async usuarioDe(
    bruto: Record<string, unknown>,
    sinal: AbortSignal,
  ): Promise<UsuarioEntra> {
    const id = seguro(bruto['id']);
    const skus = await this.listarSkus(sinal);
    const nomePorId = new Map(skus.map((s) => [s.skuId, s.nome]));
    const grupos: string[] = [];
    let caminho: string | null =
      `/users/${id}/memberOf/microsoft.graph.group?$select=id,displayName,mail,mailNickname`;
    for (let pagina = 0; caminho !== null && pagina < MAXIMO_PAGINAS; pagina += 1) {
      const resposta: Resposta = await this.ler('buscarUsuario', caminho, sinal);
      for (const g of lista(resposta.corpo)) {
        // Nome, alias e e-mail: o parâmetro do pedido pode trazer qualquer um deles.
        for (const chave of ['displayName', 'mailNickname', 'mail', 'id']) {
          const valor = texto(g[chave]);
          if (valor !== '' && !grupos.includes(valor)) grupos.push(valor);
        }
      }
      caminho = this.proximaPagina(resposta.corpo);
    }
    return {
      id,
      paisUso: texto(bruto['usageLocation']) || null,
      licencas: skuIdsDe(bruto).map((skuId) => nomePorId.get(skuId) ?? skuId),
      grupos,
    };
  }

  private async listarSkus(sinal: AbortSignal): Promise<readonly Sku[]> {
    if (this.skus !== null && this.relogio() - this.skus.em < VALIDADE_SKUS_MS) {
      return this.skus.lista;
    }
    const resposta = await this.ler(
      'listarPlanos',
      '/subscribedSkus?$select=skuId,skuPartNumber,prepaidUnits,consumedUnits',
      sinal,
    );
    const listaSkus = lista(resposta.corpo).map((item) => {
      const pagos = item['prepaidUnits'];
      // Só os assentos `enabled` podem ser usados (`warning`/`suspended` não).
      const habilitados =
        pagos !== null && typeof pagos === 'object'
          ? Number((pagos as Record<string, unknown>)['enabled'] ?? 0)
          : 0;
      const consumidos = Number(item['consumedUnits'] ?? 0);
      return {
        skuId: texto(item['skuId']),
        nome: texto(item['skuPartNumber']),
        livres: Math.max(0, (habilitados || 0) - (consumidos || 0)),
      };
    });
    this.skus = { lista: listaSkus, em: this.relogio() };
    return listaSkus;
  }

  private async sku(plano: string, sinal: AbortSignal): Promise<Sku | null> {
    const alvo = normalizarAcesso(plano);
    return (await this.listarSkus(sinal)).find((s) => normalizarAcesso(s.nome) === alvo) ?? null;
  }

  /** Grupo por objectId, nome de exibição, alias ou e-mail. Mais de um com o mesmo nome é erro. */
  private async grupo(nome: string, sinal: AbortSignal): Promise<Grupo | null> {
    const campos = 'id,displayName,onPremisesSyncEnabled';
    const ehId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nome);
    let candidatos: Record<string, unknown>[];
    if (ehId) {
      const r = await this.ler('buscarGrupo', `/groups/${nome}?$select=${campos}`, sinal, {
        aceitar404: true,
      });
      candidatos = r.status === 404 || r.corpo === null ? [] : [r.corpo];
    } else {
      const v = odata(nome);
      const filtro = `displayName eq '${v}' or mailNickname eq '${v}' or mail eq '${v}'`;
      const r = await this.ler(
        'buscarGrupo',
        `/groups?$select=${campos}&$filter=${encodeURIComponent(filtro)}`,
        sinal,
      );
      candidatos = lista(r.corpo);
    }
    if (candidatos.length === 0) return null;
    if (candidatos.length > 1) {
      throw new ErroFornecedor(
        'recusado',
        'M365_GRUPO_AMBIGUO',
        'Mais de um grupo no M365 corresponde ao nome; use o objectId.',
      );
    }
    const grupo = candidatos[0]!;
    return { id: seguro(grupo['id']), sincronizadoDoAd: grupo['onPremisesSyncEnabled'] === true };
  }

  private proximaPagina(corpo: Record<string, unknown> | null): string | null {
    const link = texto(corpo?.['@odata.nextLink']);
    const base = `${this.hosts.graph}/v1.0`;
    // Só segue páginas do próprio Graph.
    return link.startsWith(`${base}/`) ? link.slice(base.length) : null;
  }

  // -------------------------------------------------------------------------

  private comPrazo<T>(fazer: (sinal: AbortSignal) => Promise<T>): Promise<T> {
    return fazer(AbortSignal.timeout(this.config.timeoutMs));
  }

  private ler(
    operacao: OperacaoGraph,
    caminho: string,
    sinal: AbortSignal,
    opcoes: { aceitar404?: boolean; avancada?: boolean } = {},
  ): Promise<Resposta> {
    return this.chamar(operacao, 'GET', caminho, sinal, undefined, { ...opcoes, leitura: true });
  }

  private escrever(
    operacao: OperacaoGraph,
    metodo: 'POST' | 'PATCH',
    caminho: string,
    sinal: AbortSignal,
    corpo: unknown,
    opcoes: { aceitarJaMembro?: boolean } = {},
  ): Promise<Resposta> {
    return this.chamar(operacao, metodo, caminho, sinal, corpo, { ...opcoes, leitura: false });
  }

  private async chamar(
    operacao: OperacaoGraph,
    metodo: 'GET' | 'POST' | 'PATCH',
    caminho: string,
    sinal: AbortSignal,
    corpo: unknown,
    opcoes: {
      leitura: boolean;
      aceitar404?: boolean;
      avancada?: boolean;
      aceitarJaMembro?: boolean;
    },
  ): Promise<Resposta> {
    const inicio = this.relogio();
    const tentativas = opcoes.leitura ? this.config.tentativasLeitura : 1;
    let tentativa = 0;
    let renovouToken = false;
    let idRequisicao: string;
    let status: number | null = null;
    for (;;) {
      tentativa += 1;
      idRequisicao = randomUUID();
      try {
        const token = await this.obterToken(sinal);
        const resposta = await this.enviar(`${this.hosts.graph}/v1.0${caminho}`, {
          method: metodo,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'client-request-id': idRequisicao,
            ...(opcoes.avancada === true ? { ConsistencyLevel: 'eventual' } : {}),
            ...(corpo === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
          signal: sinal,
          redirect: 'error',
        });
        status = resposta.status;
        const json = await lerJson(resposta);
        if (resposta.ok || (resposta.status === 404 && opcoes.aceitar404 === true)) {
          this.registrar(operacao, null, status, idRequisicao, inicio, tentativa);
          return { status: resposta.status, corpo: json };
        }
        // 401: o token venceu ou foi revogado; a requisição não foi executada.
        if (resposta.status === 401 && !renovouToken) {
          renovouToken = true;
          this.token = null;
          tentativa -= 1;
          continue;
        }
        if (
          resposta.status === 400 &&
          opcoes.aceitarJaMembro === true &&
          /already exist/i.test(mensagemGraph(json))
        ) {
          this.registrar(operacao, null, status, idRequisicao, inicio, tentativa);
          return { status: resposta.status, corpo: json };
        }
        throw falhaHttp(resposta, json, opcoes.leitura, this.relogio());
      } catch (erro) {
        const falha = traduzirErroGraph(erro, opcoes.leitura);
        const repetivel = [
          'limiteDeTaxa',
          'conexaoRecusada',
          'respostaPerdida',
          'timeout',
        ].includes(falha.tipo);
        if (opcoes.leitura && repetivel && tentativa < tentativas && !sinal.aborted) {
          const espera = falha.tentarAposMs ?? this.esperaBaseMs * 2 ** (tentativa - 1);
          try {
            await esperar(espera, undefined, { signal: sinal });
            continue;
          } catch {
            // Prazo total esgotou na espera.
          }
        }
        const final =
          sinal.aborted && falha.tipo !== 'recusado' && falha.tipo !== 'limiteDeTaxa'
            ? new ErroFornecedor('timeout', 'M365_TEMPO_ESGOTADO')
            : falha;
        this.registrar(operacao, final, status, idRequisicao, inicio, tentativa);
        throw final;
      }
    }
  }

  private async obterToken(sinal: AbortSignal): Promise<string> {
    if (this.token !== null && this.relogio() < this.token.expiraEm) return this.token.valor;
    const inicio = this.relogio();
    const segredo = await lerSegredoM365(this.config.arquivoSegredo);
    const corpo = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: segredo,
      scope: `${this.hosts.graph}/.default`,
      grant_type: 'client_credentials',
    });
    let resposta: Response;
    try {
      resposta = await this.enviar(
        `${this.hosts.login}/${encodeURIComponent(this.config.tenantId)}/oauth2/v2.0/token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: corpo.toString(),
          signal: sinal,
          redirect: 'error',
        },
      );
    } catch (erro) {
      // Sem token nada foi enviado ao Graph.
      const falha = traduzirErroGraph(erro, true);
      this.registrar('token', falha, null, null, inicio, 1);
      throw falha.tipo === 'respostaPerdida'
        ? new ErroFornecedor('conexaoRecusada', 'M365_TOKEN_INDISPONIVEL', MENSAGEM_PADRAO)
        : falha;
    }
    const json = await lerJson(resposta);
    const valor = texto(json?.['access_token']);
    if (!resposta.ok || valor === '') {
      const falha = erroDoToken(resposta.status, json);
      this.registrar('token', falha, resposta.status, null, inicio, 1);
      throw falha;
    }
    const segundos = Number(json?.['expires_in'] ?? 3600);
    // Renova cinco minutos antes do fim, como o conector anterior.
    const validade = Math.max(60, (Number.isFinite(segundos) ? segundos : 3600) - 300) * 1000;
    this.token = { valor, expiraEm: this.relogio() + validade };
    this.registrar('token', null, resposta.status, null, inicio, 1);
    return valor;
  }

  private registrar(
    operacao: OperacaoGraph,
    falha: ErroFornecedor | null,
    httpStatus: number | null,
    idRequisicao: string | null,
    inicio: number,
    tentativas: number,
  ): void {
    try {
      this.dependencias.aoRegistrar?.({
        operacao,
        desfecho: falha?.tipo ?? 'ok',
        codigo: falha?.codigo ?? 'OK',
        httpStatus,
        idRequisicao,
        duracaoMs: Math.max(0, this.relogio() - inicio),
        tentativas,
      });
    } catch {
      // Observabilidade nunca derruba a operação.
    }
  }
}

// ---------------------------------------------------------------------------

/** Falha HTTP já classificada, com o código do Graph quando houver. */
class ErroHttpGraph extends Error {
  constructor(readonly erro: ErroFornecedor) {
    super(erro.message);
    this.name = 'ErroHttpGraph';
  }
}

function falhaHttp(
  resposta: Response,
  json: Record<string, unknown> | null,
  leitura: boolean,
  agora: number,
): ErroHttpGraph {
  const codigoGraph = codigoDoGraph(json);
  const apos = retryAfter(resposta.headers, agora);
  const s = resposta.status;
  const fornecedor = (() => {
    if (s === 429) {
      return new ErroFornecedor(
        'limiteDeTaxa',
        'M365_LIMITE_DE_TAXA',
        'O Graph pediu para aguardar antes de nova chamada.',
        apos,
      );
    }
    if ((s === 503 || s === 504) && leitura) {
      return new ErroFornecedor('limiteDeTaxa', `M365_HTTP_${s}`, MENSAGEM_PADRAO, apos);
    }
    if (s >= 500 || s === 408) {
      // Numa escrita o Graph pode ter aplicado a mudança antes de falhar.
      return new ErroFornecedor('respostaPerdida', `M365_HTTP_${s}`, MENSAGEM_PADRAO);
    }
    if (s === 401) {
      return new ErroFornecedor(
        'recusado',
        'M365_AUTENTICACAO',
        'O Graph recusou o token do app; confira o app registration.',
      );
    }
    if (s === 403) {
      return new ErroFornecedor(
        'recusado',
        'M365_PERMISSAO_INSUFICIENTE',
        'Permissão insuficiente no Graph: confira as permissões de aplicação e o consentimento do administrador.',
      );
    }
    if (s === 400 && /usage ?location/i.test(mensagemGraph(json))) {
      return new ErroFornecedor(
        'recusado',
        'PAIS_DE_USO_AUSENTE',
        'O Graph recusou: a conta precisa de país de uso antes da licença.',
      );
    }
    if (
      s === 400 &&
      /(no|not enough|insufficient)\b.*licen|licen.*(available|quantity)/i.test(mensagemGraph(json))
    ) {
      return new ErroFornecedor(
        'recusado',
        'SEM_ASSENTO',
        'O Graph recusou: não há assento livre.',
      );
    }
    return new ErroFornecedor(
      'recusado',
      codigoGraph === '' ? `M365_HTTP_${s}` : `M365_${codigoGraph}`.slice(0, 80),
      'O Graph recusou a operação.',
    );
  })();
  return new ErroHttpGraph(fornecedor);
}

/** Tradução de falhas para o motor (regra 3), sem repassar texto do fornecedor. */
export function traduzirErroGraph(erro: unknown, leitura: boolean): ErroFornecedor {
  if (erro instanceof ErroFornecedor) return erro;
  if (erro instanceof ErroHttpGraph) return erro.erro;
  if (erro instanceof ErroConfiguracao) {
    return new ErroFornecedor(
      'recusado',
      'M365_CONFIGURACAO',
      `Configuração do M365 indisponível: ${erro.variaveis.join(', ')}.`,
    );
  }
  const nome = (erro as { name?: unknown } | null)?.name;
  if (nome === 'TimeoutError' || nome === 'AbortError') {
    return new ErroFornecedor('timeout', 'M365_TEMPO_ESGOTADO');
  }
  const causa = (erro as { cause?: { code?: unknown } } | null)?.cause?.code;
  if (typeof causa === 'string') {
    if (/^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)$/.test(causa)) {
      return new ErroFornecedor(
        'conexaoRecusada',
        'M365_CONEXAO_RECUSADA',
        'Não foi possível conectar ao Graph; nada foi feito.',
      );
    }
    if (/^(ERR_TLS_|CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED)/.test(causa)) {
      return new ErroFornecedor(
        'recusado',
        'M365_TLS_INVALIDO',
        'O certificado do Graph não foi aceito.',
      );
    }
  }
  return new ErroFornecedor(
    leitura ? 'conexaoRecusada' : 'respostaPerdida',
    'M365_RESPOSTA_PERDIDA',
    MENSAGEM_PADRAO,
  );
}

/** Erros do token (AADSTS), traduzidos para o que fazer — sem repetir a descrição do Entra. */
function erroDoToken(status: number, json: Record<string, unknown> | null): ErroFornecedor {
  const descricao = `${texto(json?.['error_description'])} ${JSON.stringify(json?.['error_codes'] ?? '')}`;
  const tem = (codigo: string) =>
    descricao.includes(codigo.replace('AADSTS', '')) || descricao.includes(codigo);
  if (tem('AADSTS7000222')) {
    return new ErroFornecedor(
      'recusado',
      'M365_SEGREDO_EXPIRADO',
      'O client secret do app expirou (AADSTS7000222); gere outro e atualize o cofre.',
    );
  }
  if (tem('AADSTS7000215')) {
    return new ErroFornecedor(
      'recusado',
      'M365_SEGREDO_INVALIDO',
      'O Entra ID recusou o client secret (AADSTS7000215); use o VALOR do segredo, não o ID.',
    );
  }
  if (tem('AADSTS700016') || tem('AADSTS90002')) {
    return new ErroFornecedor(
      'recusado',
      'M365_APP_OU_TENANT_INEXISTENTE',
      'Aplicativo ou tenant não encontrado; confira GIA_M365_CLIENT_ID e GIA_M365_TENANT_ID.',
    );
  }
  if (status === 429 || status >= 500) {
    return new ErroFornecedor('conexaoRecusada', 'M365_TOKEN_INDISPONIVEL', MENSAGEM_PADRAO);
  }
  return new ErroFornecedor(
    'recusado',
    'M365_TOKEN_RECUSADO',
    'O Entra ID recusou a autenticação do app.',
  );
}

async function lerJson(resposta: Response): Promise<Record<string, unknown> | null> {
  try {
    const texto_ = await resposta.text();
    if (texto_ === '') return null;
    const valor: unknown = JSON.parse(texto_);
    return valor !== null && typeof valor === 'object' && !Array.isArray(valor)
      ? (valor as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function codigoDoGraph(json: Record<string, unknown> | null): string {
  const erro = json?.['error'];
  if (erro === null || typeof erro !== 'object') return '';
  return texto((erro as Record<string, unknown>)['code'])
    .replace(/[^\w-]/g, '')
    .slice(0, 60);
}

function mensagemGraph(json: Record<string, unknown> | null): string {
  const erro = json?.['error'];
  if (erro === null || typeof erro !== 'object') return '';
  return texto((erro as Record<string, unknown>)['message']);
}

function retryAfter(headers: Headers, agora: number): number | null {
  const valor = headers.get('retry-after');
  if (valor === null) return null;
  const ms = /^\d+$/.test(valor) ? Number(valor) * 1000 : Date.parse(valor) - agora;
  return Number.isSafeInteger(ms) ? Math.max(0, ms) : null;
}

function texto(valor: unknown): string {
  return typeof valor === 'string' ? valor : '';
}

function lista(corpo: Record<string, unknown> | null): Record<string, unknown>[] {
  const valor = corpo?.['value'];
  return Array.isArray(valor)
    ? valor.filter((v): v is Record<string, unknown> => v !== null && typeof v === 'object')
    : [];
}

/** Mais de uma conta para o mesmo e-mail não é "encontrada": é erro de cadastro. */
function unico(itens: Record<string, unknown>[]): Record<string, unknown> | null {
  if (itens.length === 0) return null;
  if (itens.length > 1) {
    throw new ErroFornecedor(
      'recusado',
      'M365_CONTA_AMBIGUA',
      'Mais de uma conta no Entra ID corresponde ao e-mail.',
    );
  }
  return itens[0]!;
}

function skuIdsDe(usuario: Record<string, unknown>): string[] {
  const atribuidas = usuario['assignedLicenses'];
  if (!Array.isArray(atribuidas)) return [];
  return atribuidas
    .map((l: unknown) =>
      l !== null && typeof l === 'object' ? texto((l as Record<string, unknown>)['skuId']) : '',
    )
    .filter((id) => id !== '');
}

/** objectId vindo do Graph, validado antes de entrar num caminho de URL. */
function seguro(valor: unknown): string {
  const id = texto(valor);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new ErroFornecedor(
      'recusado',
      'M365_RESPOSTA_INVALIDA',
      'O Graph devolveu um id inválido.',
    );
  }
  return id;
}

/** Literal OData: aspas simples são dobradas. */
function odata(valor: string): string {
  return valor.replace(/'/g, "''");
}
