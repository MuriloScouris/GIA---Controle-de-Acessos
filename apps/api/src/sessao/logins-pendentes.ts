import type { LoginPendente } from './oidc.js';

/**
 * Logins OIDC pendentes (state, nonce e verificador PKCE) guardados em memória entre
 * `/sessao/oidc/entrar` e `/sessao/oidc/retorno`. Cada chamada a `entrar` cria um estado, então o
 * endpoint é público e precisa de teto (pendência M8): por origem, na taxa e no total guardado,
 * com expiração curta e limpeza. Nada aqui chega à resposta: quem recusa só sabe "indisponível".
 */
export interface LimitesLoginsPendentes {
  /** Quanto tempo o navegador tem para voltar do Entra ID; vale também para o cookie de estado. */
  readonly validadeMs: number;
  /** Total de estados guardados, de todas as origens. */
  readonly maximoPendentes: number;
  /** Estados guardados por origem. */
  readonly maximoPorOrigem: number;
  /** Inícios de login aceitos por origem em `janelaMs`. */
  readonly iniciosPorJanela: number;
  readonly janelaMs: number;
  /** Origens com contagem de taxa ao mesmo tempo; um limite para a própria tabela não crescer. */
  readonly maximoOrigensRastreadas: number;
}

/**
 * Valores pensados para uma intranet: muita gente pode sair do mesmo IP (NAT ou, sem proxy
 * confiável configurado, o próprio proxy), então o limite por origem é folgado; o que ele barra é
 * automação, não pessoas.
 */
export const LIMITES_PADRAO: LimitesLoginsPendentes = {
  validadeMs: 5 * 60 * 1000,
  maximoPendentes: 5_000,
  maximoPorOrigem: 100,
  iniciosPorJanela: 30,
  janelaMs: 60 * 1000,
  maximoOrigensRastreadas: 10_000,
};

export type ResultadoReserva =
  { readonly ok: true } | { readonly ok: false; readonly motivo: 'origem' | 'capacidade' };

interface Guardado {
  readonly pendente: LoginPendente;
  readonly origem: string;
  readonly expiraEm: number;
}

/** Hextets de um IPv6, com `::` expandido; `null` se não for um IPv6 bem formado. */
function hextets(ip: string): number[] | null {
  const partes = ip.split('::');
  if (partes.length > 2) return null;
  const separar = (texto: string) => (texto === '' ? [] : texto.split(':'));
  const inicio = separar(partes[0]!);
  const fim = partes.length === 2 ? separar(partes[1]!) : [];
  const faltam = 8 - inicio.length - fim.length;
  if (partes.length === 1 ? faltam !== 0 : faltam < 1) return null;
  const todos = [...inicio, ...Array<string>(partes.length === 2 ? faltam : 0).fill('0'), ...fim];
  const numeros = todos.map((h) => (/^[0-9a-f]{1,4}$/i.test(h) ? parseInt(h, 16) : NaN));
  return numeros.some(Number.isNaN) ? null : numeros;
}

/**
 * Chave de rate limit de um IP. IPv4 vale inteiro; IPv4 mapeado em IPv6 vira o IPv4; IPv6 vale
 * pelo prefixo /64 (quem recebe um /64 inteiro não pode trocar de "origem" a cada requisição).
 * Sem IP legível, todos dividem uma origem só: falha para o lado seguro.
 */
export function origemDe(ip: string | undefined): string {
  const texto = (ip ?? '').trim().toLowerCase().split('%')[0]!;
  if (texto === '') return 'desconhecida';
  const mapeado = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(texto);
  if (mapeado !== null) return mapeado[1]!;
  if (!texto.includes(':')) return texto;
  const h = hextets(texto);
  if (h === null) return 'desconhecida';
  return `${h
    .slice(0, 4)
    .map((n) => n.toString(16))
    .join(':')}::/64`;
}

export class LoginsPendentes {
  /** Em ordem de inserção, que é a de vencimento (a validade é a mesma para todos). */
  readonly #estados = new Map<string, Guardado>();
  readonly #porOrigem = new Map<string, number>();
  /** Instantes dos últimos inícios de login de cada origem, no máximo `iniciosPorJanela`. */
  readonly #inicios = new Map<string, number[]>();
  #ultimaLimpezaDeOrigens = 0;

  constructor(
    private readonly agora: () => number,
    private readonly limites: LimitesLoginsPendentes = LIMITES_PADRAO,
  ) {}

  /** Quantos estados estão guardados (vencidos ainda não varridos inclusive). */
  get tamanho(): number {
    return this.#estados.size;
  }

  /** Quantas origens têm contagem de taxa guardada. */
  get origensRastreadas(): number {
    return this.#inicios.size;
  }

  /**
   * Decide se esta origem pode começar um login e conta a tentativa (aceita ou não: quem insiste
   * continua barrado). Quem aceita deve chamar `guardar` logo depois, no mesmo instante.
   */
  reservar(origem: string): ResultadoReserva {
    this.limpar();
    const t = this.agora();
    const inicios = this.#inicios.get(origem);
    if (inicios === undefined && this.#inicios.size >= this.limites.maximoOrigensRastreadas) {
      this.#limparOrigens(t, true);
      if (this.#inicios.size >= this.limites.maximoOrigensRastreadas) {
        return { ok: false, motivo: 'capacidade' };
      }
    }
    const recentes = (inicios ?? []).filter((instante) => t - instante < this.limites.janelaMs);
    const estourou = recentes.length >= this.limites.iniciosPorJanela;
    recentes.push(t);
    if (recentes.length > this.limites.iniciosPorJanela) recentes.shift();
    this.#inicios.set(origem, recentes);

    if (estourou || (this.#porOrigem.get(origem) ?? 0) >= this.limites.maximoPorOrigem) {
      return { ok: false, motivo: 'origem' };
    }
    if (this.#estados.size >= this.limites.maximoPendentes) {
      return { ok: false, motivo: 'capacidade' };
    }
    return { ok: true };
  }

  /** Guarda o login que acabou de ser reservado. */
  guardar(origem: string, pendente: LoginPendente): void {
    this.#estados.set(pendente.estado, {
      pendente,
      origem,
      expiraEm: this.agora() + this.limites.validadeMs,
    });
    this.#porOrigem.set(origem, (this.#porOrigem.get(origem) ?? 0) + 1);
  }

  /** Uso único: o estado sai da lista aconteça o que acontecer. Vencido não é devolvido. */
  consumir(estado: string): LoginPendente | undefined {
    this.limpar();
    const guardado = this.#estados.get(estado);
    if (guardado === undefined) return undefined;
    this.#remover(estado, guardado);
    return guardado.expiraEm > this.agora() ? guardado.pendente : undefined;
  }

  /** Varre os vencidos. Para no primeiro que ainda vale: o custo é só o do que expirou. */
  limpar(): void {
    const t = this.agora();
    for (const [estado, guardado] of this.#estados) {
      if (guardado.expiraEm > t) break;
      this.#remover(estado, guardado);
    }
    this.#limparOrigens(t, false);
  }

  #remover(estado: string, { origem }: Guardado): void {
    this.#estados.delete(estado);
    const restantes = (this.#porOrigem.get(origem) ?? 1) - 1;
    if (restantes > 0) this.#porOrigem.set(origem, restantes);
    else this.#porOrigem.delete(origem);
  }

  /** Esquece as origens sem início recente; no máximo uma vez por janela, salvo se a tabela encheu. */
  #limparOrigens(t: number, forcar: boolean): void {
    if (!forcar && t - this.#ultimaLimpezaDeOrigens < this.limites.janelaMs) return;
    this.#ultimaLimpezaDeOrigens = t;
    for (const [origem, inicios] of this.#inicios) {
      const ultimo = inicios[inicios.length - 1];
      if (ultimo === undefined || t - ultimo >= this.limites.janelaMs) this.#inicios.delete(origem);
    }
  }
}
