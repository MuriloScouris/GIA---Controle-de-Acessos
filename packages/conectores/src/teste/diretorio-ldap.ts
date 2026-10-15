import {
  AlreadyExistsError,
  InvalidCredentialsError,
  NoSuchObjectError,
  TypeOrValueExistsError,
} from 'ldapts';
import type {
  AbrirSessaoLdap,
  BuscaLdap,
  EntradaLdap,
  MudancaLdap,
  SessaoLdap,
} from '../transportes/ldap.js';

type Valores = (string | Buffer)[];

interface Objeto {
  dn: string;
  atributos: Map<string, Valores>;
}

/**
 * Diretório LDAP em memória para os testes do transporte do AD. Avalia
 * filtros RFC 4515 de verdade (e, ou, igualdade, presença, valores escapados)
 * e mantém `memberOf` a partir de `member`, como o AD. Registra cada busca e
 * cada escrita, e deixa programar falhas por operação.
 */
export class DiretorioLdapFalso {
  readonly buscas: BuscaLdap[] = [];
  readonly escritas: { tipo: string; dn: string; mudancas?: readonly MudancaLdap[] }[] = [];
  aberturas = 0;
  /** Falhas da próxima abertura de sessão, consumidas em ordem. */
  readonly falhasAoAbrir: unknown[] = [];
  /** Falha programada por operação (`buscar`, `incluir`, `alterar`, `renomear`). */
  readonly falhas = new Map<string, unknown>();
  private readonly objetos = new Map<string, Objeto>();
  private guid = 0;

  constructor(readonly baseDn: string) {
    this.criar(baseDn, { objectClass: ['domain'] });
  }

  criar(dn: string, atributos: Record<string, readonly string[]>): void {
    const mapa = new Map<string, Valores>();
    for (const [chave, valores] of Object.entries(atributos))
      mapa.set(chave.toLowerCase(), [...valores]);
    if (!mapa.has('objectguid')) {
      this.guid += 1;
      const bytes = Buffer.alloc(16);
      bytes.writeUInt32LE(this.guid, 0);
      mapa.set('objectguid', [bytes]);
    }
    this.objetos.set(chave(dn), { dn, atributos: mapa });
    this.recalcularMemberOf();
  }

  objeto(dn: string): Record<string, Valores> | null {
    const o = this.objetos.get(chave(dn));
    return o === undefined ? null : Object.fromEntries(o.atributos);
  }

  procurarPorLogin(login: string): { dn: string; atributos: Record<string, Valores> } | null {
    for (const o of this.objetos.values()) {
      if (
        o.atributos
          .get('samaccountname')
          ?.some((v) => String(v).toLowerCase() === login.toLowerCase())
      ) {
        return { dn: o.dn, atributos: Object.fromEntries(o.atributos) };
      }
    }
    return null;
  }

  abridor(): AbrirSessaoLdap {
    return async () => {
      this.aberturas += 1;
      const falha = this.falhasAoAbrir.shift();
      if (falha !== undefined) throw falha;
      return this.sessao();
    };
  }

  credencialInvalida(): InvalidCredentialsError {
    return new InvalidCredentialsError();
  }

  private sessao(): SessaoLdap {
    const falhar = (operacao: string) => {
      const falha = this.falhas.get(operacao);
      if (falha !== undefined) {
        this.falhas.delete(operacao);
        throw falha;
      }
    };
    return {
      buscar: async (busca) => {
        this.buscas.push(busca);
        falhar('buscar');
        return this.buscar(busca);
      },
      incluir: async (dn, atributos) => {
        this.escritas.push({ tipo: 'incluir', dn });
        falhar('incluir');
        if (this.objetos.has(chave(dn))) throw new AlreadyExistsError();
        const login = atributos['sAMAccountName']?.[0];
        if (login !== undefined && this.procurarPorLogin(login) !== null)
          throw new AlreadyExistsError();
        if (!this.objetos.has(chave(pai(dn)))) throw new NoSuchObjectError();
        this.criar(dn, atributos);
      },
      alterar: async (dn, mudancas) => {
        this.escritas.push({ tipo: 'alterar', dn, mudancas });
        falhar('alterar');
        const o = this.objetos.get(chave(dn));
        if (o === undefined) throw new NoSuchObjectError();
        for (const m of mudancas) {
          const nome = m.atributo.toLowerCase();
          const atuais = o.atributos.get(nome) ?? [];
          if (m.operacao === 'replace') o.atributos.set(nome, [...m.valores]);
          if (m.operacao === 'delete') o.atributos.delete(nome);
          if (m.operacao === 'add') {
            if (
              m.valores.some((v) =>
                atuais.some((a) => String(a).toLowerCase() === String(v).toLowerCase()),
              )
            ) {
              throw new TypeOrValueExistsError();
            }
            o.atributos.set(nome, [...atuais, ...m.valores]);
          }
        }
        this.recalcularMemberOf();
      },
      renomear: async (dn, novoDn) => {
        this.escritas.push({ tipo: 'renomear', dn });
        falhar('renomear');
        const o = this.objetos.get(chave(dn));
        if (o === undefined) throw new NoSuchObjectError();
        if (!this.objetos.has(chave(pai(novoDn)))) throw new NoSuchObjectError();
        this.objetos.delete(chave(dn));
        o.dn = novoDn;
        this.objetos.set(chave(novoDn), o);
        for (const outro of this.objetos.values()) {
          const membros = outro.atributos.get('member');
          if (membros !== undefined) {
            outro.atributos.set(
              'member',
              membros.map((m) => (chave(String(m)) === chave(dn) ? novoDn : m)),
            );
          }
        }
        this.recalcularMemberOf();
      },
      encerrar: async () => undefined,
    };
  }

  private buscar(busca: BuscaLdap): EntradaLdap[] {
    const base = chave(busca.base);
    if (!this.objetos.has(base)) throw new NoSuchObjectError();
    const filtro = analisarFiltro(busca.filtro);
    const candidatos =
      busca.escopo === 'base'
        ? [this.objetos.get(base)!]
        : [...this.objetos.values()].filter(
            (o) => chave(o.dn) === base || chave(o.dn).endsWith(`,${base}`),
          );
    const achados = candidatos.filter((o) => filtro(o));
    const limitados = busca.limite ? achados.slice(0, busca.limite) : achados;
    const binarios = new Set((busca.binarios ?? []).map((b) => b.toLowerCase()));
    return limitados.map((o) => {
      const atributos: Record<string, string[] | Buffer[]> = {};
      for (const nome of busca.atributos.map((a) => a.toLowerCase())) {
        const valores = o.atributos.get(nome);
        if (valores === undefined) continue;
        atributos[nome] = binarios.has(nome)
          ? valores.map((v) => (Buffer.isBuffer(v) ? v : Buffer.from(v)))
          : (valores.map((v) => (Buffer.isBuffer(v) ? v.toString('utf8') : v)) as string[]);
      }
      return { dn: o.dn, atributos };
    });
  }

  private recalcularMemberOf(): void {
    for (const o of this.objetos.values()) o.atributos.delete('memberof');
    for (const grupo of this.objetos.values()) {
      for (const membro of grupo.atributos.get('member') ?? []) {
        const alvo = this.objetos.get(chave(String(membro)));
        if (alvo !== undefined) {
          alvo.atributos.set('memberof', [...(alvo.atributos.get('memberof') ?? []), grupo.dn]);
        }
      }
    }
  }
}

function chave(dn: string): string {
  return dn.replace(/\s*,\s*/g, ',').toLowerCase();
}

function pai(dn: string): string {
  const indice = dn.search(/(?<!\\),/);
  return indice < 0 ? '' : dn.slice(indice + 1);
}

type Predicado = (o: Objeto) => boolean;

/** Avaliador mínimo de filtros RFC 4515: `&`, `|`, `!`, igualdade e presença. */
function analisarFiltro(texto: string): Predicado {
  let i = 0;
  const ler = (): Predicado => {
    if (texto[i] !== '(') throw new Error('filtro inválido');
    i += 1;
    const op = texto[i];
    if (op === '&' || op === '|' || op === '!') {
      i += 1;
      const filhos: Predicado[] = [];
      while (texto[i] === '(') filhos.push(ler());
      i += 1;
      if (op === '&') return (o) => filhos.every((f) => f(o));
      if (op === '|') return (o) => filhos.some((f) => f(o));
      return (o) => !filhos[0]!(o);
    }
    const fim = texto.indexOf(')', i);
    const item = texto.slice(i, fim);
    i = fim + 1;
    const igual = item.indexOf('=');
    const atributo = item.slice(0, igual).toLowerCase();
    const bruto = item.slice(igual + 1);
    if (/[()*]/.test(bruto.replace(/\\[0-9a-f]{2}/gi, ''))) {
      if (bruto === '*') return (o) => o.atributos.has(atributo);
      throw new Error('o falso não aceita substring: valor não escapado?');
    }
    const valor = Buffer.from(
      bruto.replace(/\\([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))),
      'latin1',
    )
      .toString('utf8')
      .toLowerCase();
    return (o) => {
      if (atributo === 'objectcategory' && valor === 'person') {
        return (
          o.atributos.get('objectclass')?.some((c) => String(c).toLowerCase() === 'person') ?? false
        );
      }
      return (o.atributos.get(atributo) ?? []).some((v) => String(v).toLowerCase() === valor);
    };
  };
  return ler();
}
