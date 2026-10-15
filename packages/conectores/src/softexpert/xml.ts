/**
 * Leitor XML mínimo para as respostas SOAP do SE Suite. Lê elementos, texto,
 * CDATA e as entidades predefinidas e numéricas; ignora declaração, comentários
 * e instruções de processamento. **Recusa DOCTYPE**: sem DTD não há entidade
 * externa (XXE) nem expansão em cascata. Prefixos de namespace são descartados
 * — as respostas são lidas pelo nome local, como no conector anterior.
 */
export interface ElementoXml {
  readonly nome: string;
  readonly filhos: readonly ElementoXml[];
  /** Texto direto do elemento (sem o dos filhos), já decodificado. */
  readonly texto: string;
}

export class XmlInvalido extends Error {
  constructor() {
    super('XML inválido.');
    this.name = 'XmlInvalido';
  }
}

/** Limite de tamanho da resposta; resposta maior que isso não é do adm_ws. */
const TAMANHO_MAXIMO = 2 * 1024 * 1024;
const PROFUNDIDADE_MAXIMA = 64;

const ENTIDADES: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

function decodificar(texto: string): string {
  return texto.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (_, ref: string) => {
    if (ref.startsWith('#x')) return String.fromCodePoint(parseInt(ref.slice(2), 16));
    if (ref.startsWith('#')) return String.fromCodePoint(parseInt(ref.slice(1), 10));
    const valor = ENTIDADES[ref];
    if (valor === undefined) throw new XmlInvalido();
    return valor;
  });
}

function nomeLocal(nome: string): string {
  const dois = nome.indexOf(':');
  return dois < 0 ? nome : nome.slice(dois + 1);
}

interface EmConstrucao {
  nome: string;
  filhos: ElementoXml[];
  texto: string;
}

export function lerXml(xml: string): ElementoXml {
  if (xml.length > TAMANHO_MAXIMO) throw new XmlInvalido();
  const pilha: EmConstrucao[] = [];
  let raiz: ElementoXml | null = null;
  let i = 0;
  while (i < xml.length) {
    const abre = xml.indexOf('<', i);
    const texto = xml.slice(i, abre < 0 ? xml.length : abre);
    if (texto.trim() !== '') {
      const atual = pilha.at(-1);
      if (atual === undefined) throw new XmlInvalido();
      atual.texto += decodificar(texto);
    }
    if (abre < 0) break;
    if (xml.startsWith('<!--', abre)) {
      const fim = xml.indexOf('-->', abre + 4);
      if (fim < 0) throw new XmlInvalido();
      i = fim + 3;
    } else if (xml.startsWith('<![CDATA[', abre)) {
      const fim = xml.indexOf(']]>', abre + 9);
      const atual = pilha.at(-1);
      if (fim < 0 || atual === undefined) throw new XmlInvalido();
      atual.texto += xml.slice(abre + 9, fim);
      i = fim + 3;
    } else if (xml.startsWith('<?', abre)) {
      const fim = xml.indexOf('?>', abre + 2);
      if (fim < 0) throw new XmlInvalido();
      i = fim + 2;
    } else if (xml.startsWith('<!', abre)) {
      // DOCTYPE e qualquer outra declaração de marcação: recusado.
      throw new XmlInvalido();
    } else {
      const fim = xml.indexOf('>', abre + 1);
      if (fim < 0) throw new XmlInvalido();
      const marca = xml.slice(abre + 1, fim);
      i = fim + 1;
      if (marca.startsWith('/')) {
        const fechado = pilha.pop();
        if (fechado === undefined || nomeLocal(marca.slice(1).trim()) !== fechado.nome) {
          throw new XmlInvalido();
        }
        const elemento: ElementoXml = {
          nome: fechado.nome,
          filhos: fechado.filhos,
          texto: fechado.texto.trim(),
        };
        const pai = pilha.at(-1);
        if (pai === undefined) {
          if (raiz !== null) throw new XmlInvalido();
          raiz = elemento;
        } else pai.filhos.push(elemento);
        continue;
      }
      const vazio = marca.endsWith('/');
      const nome = /^[^\s/>]+/.exec(marca)?.[0];
      if (nome === undefined) throw new XmlInvalido();
      const local = nomeLocal(nome);
      if (vazio) {
        const elemento: ElementoXml = { nome: local, filhos: [], texto: '' };
        const pai = pilha.at(-1);
        if (pai === undefined) {
          if (raiz !== null) throw new XmlInvalido();
          raiz = elemento;
        } else pai.filhos.push(elemento);
      } else {
        if (pilha.length >= PROFUNDIDADE_MAXIMA) throw new XmlInvalido();
        pilha.push({ nome: local, filhos: [], texto: '' });
      }
    }
  }
  if (pilha.length > 0 || raiz === null) throw new XmlInvalido();
  return raiz;
}

/** Primeiro descendente (em profundidade) com o nome local dado. */
export function descendente(raiz: ElementoXml, nome: string): ElementoXml | null {
  for (const filho of raiz.filhos) {
    if (filho.nome === nome) return filho;
    const achado = descendente(filho, nome);
    if (achado !== null) return achado;
  }
  return null;
}

/** Texto do primeiro descendente com o nome dado, ou `''`. */
export function textoDe(raiz: ElementoXml, nome: string): string {
  return descendente(raiz, nome)?.texto ?? '';
}
