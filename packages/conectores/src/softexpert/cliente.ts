import { randomInt } from 'node:crypto';
import { setTimeout as esperar } from 'node:timers/promises';
import { ErroConfiguracao } from '@gia/contratos';
import { normalizarAcesso } from '@gia/dominio';
import type {
  ClienteSoftexpert,
  NovoUsuarioSoftexpert,
  UsuarioSoftexpert,
} from '../adaptadores/softexpert.js';
import { ErroFornecedor } from '../erros.js';
import { escaparXml } from '../escape.js';
import { cabecalhoAutorizacao, type ConfiguracaoSoftexpert } from './configuracao.js';
import { XmlInvalido, descendente, lerXml, textoDe, type ElementoXml } from './xml.js';

/** Operações do `adm_ws` usadas pelo GIA. */
export type OperacaoSoftexpert = 'getUserData' | 'newUser' | 'disableUser';

/** Registro de cada chamada ao SE Suite. Sem identificador, login, e-mail, senha ou token. */
export interface RegistroChamadaSoftexpert {
  readonly operacao: OperacaoSoftexpert;
  readonly desfecho: 'ok' | 'falhaNoCadastro' | ErroFornecedor['tipo'];
  readonly codigo: string;
  readonly httpStatus: number | null;
  readonly duracaoMs: number;
  readonly tentativas: number;
}

export interface DependenciasSoftexpert {
  readonly fetch?: typeof fetch;
  readonly relogio?: () => number;
  /**
   * Senha inicial do usuário novo (campo `PASS`, obrigatório no `newUser`).
   * Padrão: aleatória e forte, nunca devolvida, guardada ou registrada.
   */
  readonly gerarSenhaInicial?: () => string;
  readonly aoRegistrar?: (registro: RegistroChamadaSoftexpert) => void;
  /** Espera base entre tentativas de leitura (multiplicada a cada tentativa). */
  readonly esperaBaseMs?: number;
}

/** Resposta SOAP já lida: o elemento `<operacao>Response` e os campos de status. */
interface RespostaSe {
  readonly corpo: ElementoXml;
  readonly sucesso: boolean;
  readonly detalhe: string;
  readonly codigo: string;
  readonly chave: string;
}

const MENSAGEM_PADRAO = 'Falha ao acessar o SoftExpert.';

/**
 * Cliente SOAP do web service de administração do SE Suite (`adm_ws.php`),
 * pelo API Gateway. Cada método tem um prazo total (`timeoutMs`) que cobre
 * autenticação, tentativas e esperas. Leituras são repetidas em falha
 * transitória; escritas nunca (regra 3: incerteza vai para conferência).
 */
export class ClienteSoftexpertSoap implements ClienteSoftexpert {
  private readonly enviar: typeof fetch;
  private readonly relogio: () => number;
  private readonly gerarSenha: () => string;
  private readonly esperaBaseMs: number;

  constructor(
    private readonly config: ConfiguracaoSoftexpert,
    private readonly dependencias: DependenciasSoftexpert = {},
  ) {
    this.enviar = dependencias.fetch ?? fetch;
    this.relogio = dependencias.relogio ?? Date.now;
    this.gerarSenha = dependencias.gerarSenhaInicial ?? gerarSenhaSoftexpert;
    this.esperaBaseMs = dependencias.esperaBaseMs ?? 250;
  }

  /** Não há "ping" no adm_ws: consultar um IDUSER que não existe prova token e serviço. */
  async testar(): Promise<void> {
    await this.comPrazo((sinal) => this.lerUsuario('__gia_teste_conexao__', sinal));
  }

  buscarUsuario(identificador: string): Promise<UsuarioSoftexpert | null> {
    return this.comPrazo((sinal) => this.lerUsuario(identificador, sinal));
  }

  // A API não lista nem consulta área, função ou grupo de acesso: quem decide é o `newUser`.
  areaExiste(): Promise<boolean | null> {
    return Promise.resolve(null);
  }

  funcaoExiste(): Promise<boolean | null> {
    return Promise.resolve(null);
  }

  grupoAcessoExiste(): Promise<boolean | null> {
    return Promise.resolve(null);
  }

  criarUsuario(novo: NovoUsuarioSoftexpert): Promise<string> {
    return this.comPrazo(async (sinal) => {
      // Idempotência: a tentativa anterior pode ter criado o usuário e perdido a resposta.
      const existente = await antesDaEscrita(() => this.lerUsuario(novo.identificador, sinal));
      if (existente !== null) return this.mesmoUsuario(existente, novo);

      const campos: [string, string][] = [
        ['IDUSER', novo.identificador],
        ['NAME', novo.nome],
        ['LOGIN', novo.login],
        ['PASS', this.gerarSenha()],
        ['EMAIL', novo.email],
        ['IDAREA', novo.area],
        ['IDFUNC', novo.funcao],
        ['IDACCGROUP', novo.grupoAcesso],
      ];
      // LANGUAGE precisa existir no cadastro do ambiente; omitido, vale o padrão da conta.
      if (this.config.idioma !== null) campos.push(['LANGUAGE', this.config.idioma]);

      const resposta = await this.chamar('newUser', campos, sinal, { leitura: false });
      if (resposta.sucesso) return resposta.chave || novo.identificador;

      // O SE recusou. Se foi porque o usuário já existe (corrida com outra tentativa), confere.
      const depois = await this.lerUsuario(novo.identificador, sinal).catch(() => null);
      if (depois !== null) return this.mesmoUsuario(depois, novo);
      throw recusaDoCadastro(resposta);
    });
  }

  inativarUsuario(identificador: string): Promise<void> {
    return this.comPrazo(async (sinal) => {
      if (!this.config.revogacaoConferida) {
        throw new ErroFornecedor(
          'recusado',
          'SOFTEXPERT_REVOGACAO_NAO_CONFERIDA',
          'A inativação (disableUser) ainda não foi conferida no WSDL do ambiente; inative pelo SE Suite.',
        );
      }
      const existente = await antesDaEscrita(() => this.lerUsuario(identificador, sinal));
      if (existente === null) {
        throw new ErroFornecedor(
          'recusado',
          'CONTA_AUSENTE',
          'O usuário não existe no SoftExpert.',
        );
      }
      if (existente.ativo === false) return;
      const resposta = await this.chamar('disableUser', [['IDUSER', identificador]], sinal, {
        leitura: false,
      });
      if (!resposta.sucesso) throw recusaDoCadastro(resposta);
    });
  }

  // -------------------------------------------------------------------------

  private mesmoUsuario(existente: UsuarioSoftexpert, novo: NovoUsuarioSoftexpert): string {
    const igual = (a: string, b: string) => normalizarAcesso(a) === normalizarAcesso(b);
    if (
      igual(existente.login, novo.login) &&
      igual(existente.area, novo.area) &&
      igual(existente.funcao, novo.funcao)
    ) {
      return existente.identificador;
    }
    throw new ErroFornecedor(
      'recusado',
      igual(existente.login, novo.login) ? 'USUARIO_JA_EXISTE' : 'IDENTIFICADOR_EM_USO',
      'Já existe usuário no SoftExpert com esta matrícula/CPF e cadastro diferente do pedido.',
    );
  }

  private async lerUsuario(
    identificador: string,
    sinal: AbortSignal,
  ): Promise<UsuarioSoftexpert | null> {
    const resposta = await this.chamar('getUserData', [['iduser', identificador]], sinal, {
      leitura: true,
    });
    if (!resposta.sucesso) {
      // "Usuário inexistente" chega como FAILURE: é a resposta normal para IDUSER livre.
      if (/inexistente|n[ãa]o (foi )?encontrad/i.test(resposta.detalhe)) return null;
      throw recusaDoCadastro(resposta);
    }
    const item = descendente(resposta.corpo, 'item');
    if (item === null) return null;
    const usuario = {
      identificador: textoDe(item, 'Usuário'),
      login: textoDe(item, 'Login'),
      // O getUserData não informa situação nem grupo de acesso.
      ativo: null,
      area: textoDe(item, 'iddepartment'),
      funcao: textoDe(item, 'idposition'),
      grupoAcesso: null,
    };
    if (usuario.identificador === '' || usuario.login === '') {
      throw new ErroFornecedor(
        'recusado',
        'SOFTEXPERT_RESPOSTA_INVALIDA',
        'O SoftExpert devolveu um usuário incompleto.',
      );
    }
    return usuario;
  }

  private async comPrazo<T>(fazer: (sinal: AbortSignal) => Promise<T>): Promise<T> {
    return fazer(AbortSignal.timeout(this.config.timeoutMs));
  }

  private async chamar(
    operacao: OperacaoSoftexpert,
    campos: readonly (readonly [string, string])[],
    sinal: AbortSignal,
    { leitura }: { leitura: boolean },
  ): Promise<RespostaSe> {
    const inicio = this.relogio();
    const tentativas = leitura ? this.config.tentativasLeitura : 1;
    let tentativa = 0;
    let status: number | null = null;
    for (;;) {
      tentativa += 1;
      try {
        const { resposta, httpStatus } = await this.requisitar(operacao, campos, sinal, leitura);
        status = httpStatus;
        this.registrar(
          operacao,
          resposta.sucesso ? 'ok' : 'falhaNoCadastro',
          resposta.sucesso ? 'OK' : `SOFTEXPERT_${resposta.codigo || 'FAILURE'}`,
          status,
          inicio,
          tentativa,
        );
        return resposta;
      } catch (erro) {
        const falha = traduzirErroSoftexpert(erro, leitura);
        status = erro instanceof ErroHttp ? erro.status : status;
        const prazo = falha.tentarAposMs ?? this.esperaBaseMs * 3 ** (tentativa - 1);
        const transitoria = [
          'conexaoRecusada',
          'limiteDeTaxa',
          'respostaPerdida',
          'timeout',
        ].includes(falha.tipo);
        if (leitura && transitoria && tentativa < tentativas && !sinal.aborted) {
          try {
            await esperar(prazo, undefined, { signal: sinal });
            continue;
          } catch {
            // Prazo total esgotado durante a espera.
          }
        }
        const final = sinal.aborted && falha.tipo !== 'recusado' ? tempoEsgotado(leitura) : falha;
        this.registrar(operacao, final.tipo, final.codigo, status, inicio, tentativa);
        throw final;
      }
    }
  }

  private async requisitar(
    operacao: OperacaoSoftexpert,
    campos: readonly (readonly [string, string])[],
    sinal: AbortSignal,
    leitura: boolean,
  ): Promise<{ resposta: RespostaSe; httpStatus: number }> {
    const autorizacao = await cabecalhoAutorizacao(this.config.autenticacao);
    const resposta = await this.enviar(this.config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml;charset=UTF-8',
        SOAPAction: `urn:admin#${operacao}`,
        Authorization: autorizacao,
        Accept: 'text/xml',
      },
      body: envelopeSoftexpert(operacao, campos),
      signal: sinal,
      redirect: 'error',
    });
    const corpo = await lerCorpo(resposta);
    if (!resposta.ok) {
      // SOAP Fault com 500: o serviço processou e recusou.
      if (resposta.status === 500 && corpo !== null && ehFault(corpo)) {
        throw new ErroFornecedor(
          'recusado',
          'SOFTEXPERT_SOAP_FAULT',
          'O SoftExpert recusou a requisição (SOAP Fault).',
        );
      }
      throw new ErroHttp(resposta.status, resposta.headers);
    }
    if (corpo === null) throw respostaInvalida(leitura);
    if (ehFault(corpo)) {
      // 2xx com Fault é erro (spec, "Comportamento comum dos adaptadores").
      throw new ErroFornecedor(
        'recusado',
        'SOFTEXPERT_SOAP_FAULT',
        'O SoftExpert recusou a requisição (SOAP Fault).',
      );
    }
    const status = textoDe(corpo, 'Status').toUpperCase();
    if (status !== 'SUCCESS' && status !== 'FAILURE') throw respostaInvalida(leitura);
    return {
      httpStatus: resposta.status,
      resposta: {
        corpo,
        sucesso: status === 'SUCCESS',
        detalhe: textoDe(corpo, 'Detail'),
        codigo: textoDe(corpo, 'Code')
          .replace(/[^\w-]/g, '')
          .slice(0, 20),
        chave: textoDe(corpo, 'RecordKey'),
      },
    };
  }

  private registrar(
    operacao: OperacaoSoftexpert,
    desfecho: RegistroChamadaSoftexpert['desfecho'],
    codigo: string,
    httpStatus: number | null,
    inicio: number,
    tentativas: number,
  ): void {
    try {
      this.dependencias.aoRegistrar?.({
        operacao,
        desfecho,
        codigo,
        httpStatus,
        duracaoMs: Math.max(0, this.relogio() - inicio),
        tentativas,
      });
    } catch {
      // Observabilidade nunca derruba a operação.
    }
  }
}

/** Falha HTTP do gateway, antes de interpretar o corpo. */
class ErroHttp extends Error {
  constructor(
    readonly status: number,
    readonly headers: Headers,
  ) {
    super(`HTTP ${status}`);
    this.name = 'ErroHttp';
  }
}

/** Envelope SOAP 1.1 do `urn:admin`; todo valor é escapado (spec: XML do SOAP). */
export function envelopeSoftexpert(
  operacao: OperacaoSoftexpert,
  campos: readonly (readonly [string, string])[],
): string {
  const corpo = campos
    .map(([nome, valor]) => `<urn:${nome}>${escaparXml(valor)}</urn:${nome}>`)
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:admin">' +
    `<soapenv:Header/><soapenv:Body><urn:${operacao}>${corpo}</urn:${operacao}></soapenv:Body></soapenv:Envelope>`
  );
}

/** Corpo SOAP da resposta (o primeiro filho de `Body`), ou `null` se não for SOAP. */
async function lerCorpo(resposta: Response): Promise<ElementoXml | null> {
  const bytes = new Uint8Array(await resposta.arrayBuffer());
  const charset = /charset=([\w-]+)/i.exec(resposta.headers.get('content-type') ?? '')?.[1];
  let texto: string;
  try {
    texto = new TextDecoder(charset ?? 'utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  try {
    const raiz = lerXml(texto);
    if (raiz.nome !== 'Envelope') return null;
    const body = raiz.filhos.find((filho) => filho.nome === 'Body');
    return body?.filhos[0] ?? null;
  } catch (erro) {
    if (erro instanceof XmlInvalido) return null;
    throw erro;
  }
}

function ehFault(corpo: ElementoXml): boolean {
  return corpo.nome === 'Fault';
}

function respostaInvalida(leitura: boolean): ErroFornecedor {
  // Resposta fora do formato depois de uma escrita: não dá para saber se o SE agiu.
  return new ErroFornecedor(
    leitura ? 'recusado' : 'respostaPerdida',
    'SOFTEXPERT_RESPOSTA_INVALIDA',
    'O SoftExpert devolveu uma resposta fora do formato SOAP esperado.',
  );
}

function tempoEsgotado(leitura: boolean): ErroFornecedor {
  return new ErroFornecedor(
    'timeout',
    'SOFTEXPERT_TEMPO_ESGOTADO',
    leitura ? 'Tempo esgotado consultando o SoftExpert.' : MENSAGEM_PADRAO,
  );
}

/** FAILURE no corpo de um 2xx: recusa definitiva, com o Detail do SE para o operador. */
function recusaDoCadastro(resposta: RespostaSe): ErroFornecedor {
  if (/idioma inexistente/i.test(resposta.detalhe)) {
    return new ErroFornecedor(
      'recusado',
      'SOFTEXPERT_IDIOMA_INEXISTENTE',
      'O SoftExpert não conhece o idioma configurado (GIA_SOFTEXPERT_IDIOMA).',
    );
  }
  const detalhe = resposta.detalhe.replace(/\s+/g, ' ').slice(0, 300);
  return new ErroFornecedor(
    'recusado',
    resposta.codigo === '' ? 'SOFTEXPERT_RECUSADO' : `SOFTEXPERT_RECUSADO_${resposta.codigo}`,
    detalhe === ''
      ? 'O SoftExpert recusou a operação.'
      : `O SoftExpert recusou a operação: ${detalhe}`,
  );
}

/** Falha numa leitura feita ANTES da escrita: a escrita não saiu, então nada mudou no destino. */
async function antesDaEscrita<T>(ler: () => Promise<T>): Promise<T> {
  try {
    return await ler();
  } catch (erro) {
    if (
      erro instanceof ErroFornecedor &&
      erro.tipo !== 'recusado' &&
      erro.tipo !== 'limiteDeTaxa'
    ) {
      throw new ErroFornecedor(
        'conexaoRecusada',
        erro.codigo,
        'Não foi possível consultar o SoftExpert antes de gravar; nada foi feito.',
      );
    }
    throw erro;
  }
}

/** Traduz falha de rede/HTTP para o vocabulário do motor, sem repassar texto da resposta. */
export function traduzirErroSoftexpert(erro: unknown, leitura: boolean): ErroFornecedor {
  if (erro instanceof ErroFornecedor) return erro;
  if (erro instanceof ErroConfiguracao) {
    // Segredo do cofre ausente ou inválido: nada foi enviado ao SE Suite.
    return new ErroFornecedor(
      'recusado',
      'SOFTEXPERT_CONFIGURACAO',
      `Configuração do SoftExpert indisponível: ${erro.variaveis.join(', ')}.`,
    );
  }
  if (erro instanceof ErroHttp) {
    const tentarApos = retryAfter(erro.headers);
    switch (true) {
      case erro.status === 401:
        return new ErroFornecedor(
          'recusado',
          'SOFTEXPERT_AUTENTICACAO',
          'O API Gateway recusou a credencial (401). O token vai sem o prefixo "Bearer".',
        );
      case erro.status === 403 && erro.headers.get('x-rate-limit-remaining') === '0':
      case erro.status === 429:
        return new ErroFornecedor(
          'limiteDeTaxa',
          'SOFTEXPERT_LIMITE_DE_TAXA',
          'O API Gateway pediu para aguardar antes de nova chamada.',
          tentarApos,
        );
      case erro.status === 403:
        return new ErroFornecedor(
          'recusado',
          'SOFTEXPERT_ACESSO_NEGADO',
          'Acesso negado (403): conta sem permissão de administração ou limite do gateway.',
        );
      case erro.status === 404:
        return new ErroFornecedor(
          'recusado',
          'SOFTEXPERT_ENDPOINT_INEXISTENTE',
          'Endpoint não encontrado (404); confira GIA_SOFTEXPERT_URL.',
        );
      case erro.status === 408 || erro.status >= 500:
        // A requisição chegou; numa escrita o SE pode ter agido.
        return new ErroFornecedor(
          'respostaPerdida',
          `SOFTEXPERT_HTTP_${erro.status}`,
          MENSAGEM_PADRAO,
        );
      default:
        return new ErroFornecedor('recusado', `SOFTEXPERT_HTTP_${erro.status}`, MENSAGEM_PADRAO);
    }
  }
  const nome = (erro as { name?: unknown } | null)?.name;
  if (nome === 'TimeoutError' || nome === 'AbortError') return tempoEsgotado(leitura);
  const causa = (erro as { cause?: { code?: unknown } } | null)?.cause?.code;
  if (typeof causa === 'string') {
    if (/^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)$/.test(causa)) {
      return new ErroFornecedor(
        'conexaoRecusada',
        'SOFTEXPERT_CONEXAO_RECUSADA',
        'Não foi possível conectar ao SoftExpert; nada foi feito.',
      );
    }
    if (/^(ERR_TLS_|CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED)/.test(causa)) {
      return new ErroFornecedor(
        'recusado',
        'SOFTEXPERT_TLS_INVALIDO',
        'O certificado do SoftExpert não foi aceito.',
      );
    }
  }
  // Conexão caiu com a requisição em voo: o SE pode ter agido.
  return new ErroFornecedor('respostaPerdida', 'SOFTEXPERT_RESPOSTA_PERDIDA', MENSAGEM_PADRAO);
}

function retryAfter(headers: Headers): number | null {
  const valor = headers.get('retry-after');
  if (valor === null) return null;
  const ms = /^\d+$/.test(valor) ? Number(valor) * 1000 : Date.parse(valor) - Date.now();
  return Number.isSafeInteger(ms) ? Math.max(0, ms) : null;
}

const CLASSES = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!#%*+-=?@_'];

/** 20 caracteres de quatro classes com `crypto.randomInt`. */
export function gerarSenhaSoftexpert(): string {
  const todos = CLASSES.join('');
  const caracteres = CLASSES.map((classe) => classe[randomInt(classe.length)]!);
  while (caracteres.length < 20) caracteres.push(todos[randomInt(todos.length)]!);
  for (let i = caracteres.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [caracteres[i], caracteres[j]] = [caracteres[j]!, caracteres[i]!];
  }
  return caracteres.join('');
}
