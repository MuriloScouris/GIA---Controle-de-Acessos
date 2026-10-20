import { escaparXml as x } from '../escape.js';
import { descendente, lerXml, type ElementoXml } from '../softexpert/xml.js';
import { penduradoAteAbortar } from './pendurado.js';

export interface UsuarioSeFalso {
  iduser: string;
  login: string;
  nome: string;
  email: string;
  area: string;
  funcao: string;
  grupo: string;
  ativo: boolean;
}

export interface RequisicaoRecebida {
  readonly operacao: string;
  readonly soapAction: string | null;
  readonly autorizacao: string | null;
  readonly contentType: string | null;
  readonly campos: Readonly<Record<string, string>>;
  readonly corpo: string;
}

type Resposta = Response | (() => Response) | 'pendurar' | Error;

/**
 * SE Suite falso atrás de `fetch`, no formato das respostas reais do `adm_ws`
 * capturadas no levantamento (`getUserDataResponse` com `data/item`, `Status`,
 * `Detail`, `Code`, `RecordKey`). Dados fictícios. Permite programar respostas
 * HTTP por operação para os cenários de falha.
 */
export class SoftexpertFalso {
  readonly requisicoes: RequisicaoRecebida[] = [];
  readonly usuarios = new Map<string, UsuarioSeFalso>();
  /** Respostas programadas por operação, consumidas em ordem antes do comportamento normal. */
  readonly programadas = new Map<string, Resposta[]>();
  areasValidas = new Set(['INFRA', 'TEC']);
  idiomasValidos = new Set<string>();

  programar(operacao: string, ...respostas: Resposta[]): void {
    this.programadas.set(operacao, [...(this.programadas.get(operacao) ?? []), ...respostas]);
  }

  readonly fetch: typeof fetch = async (_url, init) => {
    const corpo = String(init?.body ?? '');
    const headers = new Headers(init?.headers);
    const envelope = lerXml(corpo);
    const body = envelope.filhos.find((f) => f.nome === 'Body')!;
    const operacao = body.filhos[0]!;
    const campos = Object.fromEntries(operacao.filhos.map((f) => [f.nome, f.texto]));
    this.requisicoes.push({
      operacao: operacao.nome,
      soapAction: headers.get('soapaction'),
      autorizacao: headers.get('authorization'),
      contentType: headers.get('content-type'),
      campos,
      corpo,
    });
    const programada = this.programadas.get(operacao.nome)?.shift();
    if (programada !== undefined) {
      if (programada === 'pendurar') {
        return penduradoAteAbortar(init?.signal);
      }
      if (programada instanceof Error) throw programada;
      return typeof programada === 'function' ? programada() : programada;
    }
    return this.responder(operacao);
  };

  private responder(operacao: ElementoXml): Response {
    const campo = (nome: string) => descendente(operacao, nome)?.texto ?? '';
    switch (operacao.nome) {
      case 'getUserData': {
        const u = this.usuarios.get(campo('iduser'));
        if (u === undefined)
          return resposta('getUserData', status('FAILURE', 'Usuário inexistente', '0'));
        return resposta(
          'getUserData',
          `<data><item><Usuário>${x(u.iduser)}</Usuário><Login>${x(u.login)}</Login><Nome>${x(u.nome)}</Nome>` +
            `<E-mail>${x(u.email)}</E-mail><department><item><iddepartment>${x(u.area)}</iddepartment>` +
            `<nmdepartment>Área ${x(u.area)}</nmdepartment></item></department><position><item>` +
            `<idposition>${x(u.funcao)}</idposition><nmposition>Função ${x(u.funcao)}</nmposition></item>` +
            `</position></item></data>` +
            status('SUCCESS', 'Executado com sucesso', '1'),
        );
      }
      case 'newUser': {
        const idioma = campo('LANGUAGE');
        if (idioma !== '' && !this.idiomasValidos.has(idioma)) {
          return resposta('newUser', status('FAILURE', 'Idioma inexistente', '0'));
        }
        if (!this.areasValidas.has(campo('IDAREA'))) {
          return resposta('newUser', status('FAILURE', 'Departamento inexistente', '0'));
        }
        if (this.usuarios.has(campo('IDUSER'))) {
          return resposta('newUser', status('FAILURE', 'Identificador já cadastrado', '0'));
        }
        this.usuarios.set(campo('IDUSER'), {
          iduser: campo('IDUSER'),
          login: campo('LOGIN'),
          nome: campo('NAME'),
          email: campo('EMAIL'),
          area: campo('IDAREA'),
          funcao: campo('IDFUNC'),
          grupo: campo('IDACCGROUP'),
          ativo: true,
        });
        return resposta(
          'newUser',
          status('SUCCESS', 'Executado com sucesso', '1') +
            `<RecordKey>${campo('IDUSER')}</RecordKey><RecordId>42</RecordId>`,
        );
      }
      case 'disableUser': {
        const u = this.usuarios.get(campo('IDUSER'));
        if (u === undefined)
          return resposta('disableUser', status('FAILURE', 'Usuário inexistente', '0'));
        u.ativo = false;
        return resposta('disableUser', status('SUCCESS', 'Executado com sucesso', '1'));
      }
      default:
        return new Response('<html><body>not found</body></html>', { status: 404 });
    }
  }
}

function status(valor: string, detalhe: string, codigo: string): string {
  return `<return>${codigo}</return><Status>${valor}</Status><Detail>${detalhe}</Detail><Code>${codigo}</Code>`;
}

export function resposta(operacao: string, conteudo: string, init: ResponseInit = {}): Response {
  return new Response(
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"><SOAP-ENV:Body>' +
      `<${operacao}Response xmlns="urn:admin">${conteudo}</${operacao}Response>` +
      '</SOAP-ENV:Body></SOAP-ENV:Envelope>',
    { status: 200, headers: { 'content-type': 'text/xml; charset=utf-8' }, ...init },
  );
}

export function fault(status = 500): Response {
  return new Response(
    '<?xml version="1.0"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">' +
      '<SOAP-ENV:Body><SOAP-ENV:Fault><faultcode>SOAP-ENV:Server</faultcode>' +
      '<faultstring>erro interno com dado maria.souza</faultstring></SOAP-ENV:Fault></SOAP-ENV:Body></SOAP-ENV:Envelope>',
    { status, headers: { 'content-type': 'text/xml' } },
  );
}

/** Erro de rede como o `fetch` do Node lança (TypeError com `cause.code`). */
export function erroDeRede(codigo: string): Error {
  return Object.assign(new TypeError('fetch failed'), { cause: { code: codigo } });
}
