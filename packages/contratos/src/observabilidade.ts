import { createServer, type Server } from 'node:http';
import { sanitizarTexto } from '@gia/dominio';

/**
 * Observabilidade sem dependências: logs estruturados (JSON por linha) com
 * correlação e métricas no formato de texto do Prometheus. Tudo que sai daqui
 * passa por sanitização (regra 12) e mascaramento de dados pessoais: logs e
 * métricas nunca levam senha, token, CPF ou e-mail.
 */

export type NivelLog = 'debug' | 'info' | 'aviso' | 'erro';

export type ValorCampo = string | number | boolean | null | readonly string[];
export type CamposLog = Readonly<Record<string, ValorCampo | undefined>>;

const PESO: Readonly<Record<NivelLog, number>> = { debug: 10, info: 20, aviso: 30, erro: 40 };

/** Chaves cujo valor nunca é registrado, qualquer que seja o conteúdo. */
const CHAVE_PROIBIDA =
  /senha|password|token|secret|segredo|chave|authorization|cookie|cpf|email|e-mail|login|nome/i;

const CPF = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;
const EMAIL = /\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b/g;

function limpar(texto: string): string {
  return sanitizarTexto(texto).replace(CPF, '[CPF]').replace(EMAIL, '[EMAIL]').slice(0, 2_000);
}

function limparCampo(chave: string, valor: ValorCampo): ValorCampo {
  if (CHAVE_PROIBIDA.test(chave)) return '[OCULTO]';
  if (typeof valor === 'string') return limpar(valor);
  if (Array.isArray(valor)) return valor.map((item: string) => limpar(item));
  return valor;
}

export interface Registrador {
  debug(evento: string, campos?: CamposLog): void;
  info(evento: string, campos?: CamposLog): void;
  aviso(evento: string, campos?: CamposLog): void;
  erro(evento: string, campos?: CamposLog): void;
  /** Registrador com campos fixos (ex.: `correlacaoId`, `operacaoId`). */
  filho(campos: CamposLog): Registrador;
}

export interface OpcoesRegistrador {
  readonly servico: string;
  readonly ambiente: string;
  readonly nivelMinimo?: NivelLog;
  /** Destino de cada linha; padrão: stdout. */
  readonly saida?: (linha: string) => void;
  readonly agora?: () => string;
}

export function criarRegistrador(opcoes: OpcoesRegistrador, fixos: CamposLog = {}): Registrador {
  const minimo = PESO[opcoes.nivelMinimo ?? 'info'];
  const saida = opcoes.saida ?? ((linha: string) => process.stdout.write(`${linha}\n`));
  const agora = opcoes.agora ?? (() => new Date().toISOString());
  const escrever = (nivel: NivelLog, evento: string, campos: CamposLog = {}) => {
    if (PESO[nivel] < minimo) return;
    const registro: Record<string, ValorCampo> = {
      instante: agora(),
      nivel,
      servico: opcoes.servico,
      ambiente: opcoes.ambiente,
      evento: limpar(evento),
    };
    for (const [chave, valor] of Object.entries({ ...fixos, ...campos })) {
      if (valor === undefined || chave in registro) continue;
      registro[chave] = limparCampo(chave, valor);
    }
    try {
      saida(JSON.stringify(registro));
    } catch {
      // Log nunca derruba o serviço.
    }
  };
  return {
    debug: (evento, campos) => escrever('debug', evento, campos),
    info: (evento, campos) => escrever('info', evento, campos),
    aviso: (evento, campos) => escrever('aviso', evento, campos),
    erro: (evento, campos) => escrever('erro', evento, campos),
    filho: (campos) => criarRegistrador(opcoes, { ...fixos, ...campos }),
  };
}

/** Lê `GIA_LOG_NIVEL` (padrão `info`). */
export function nivelDeLog(valor: string | undefined): NivelLog {
  const v = valor?.trim();
  return v === 'debug' || v === 'info' || v === 'aviso' || v === 'erro' ? v : 'info';
}

// ---------------------------------------------------------------------------
// Métricas (formato de texto 0.0.4 do Prometheus)
// ---------------------------------------------------------------------------

type Rotulos = Readonly<Record<string, string>>;

const NOME_METRICA = /^[a-z_][a-z0-9_]*$/;

function chaveDe(nomes: readonly string[], rotulos: Rotulos): string {
  return nomes.map((n) => rotulos[n] ?? '').join('\u0000');
}

function formatarRotulos(
  nomes: readonly string[],
  rotulos: Rotulos,
  extra?: [string, string],
): string {
  const pares: [string, string][] = nomes.map((n) => [n, rotulos[n] ?? '']);
  if (extra) pares.push(extra);
  if (pares.length === 0) return '';
  const escapar = (v: string) =>
    v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
  return `{${pares.map(([n, v]) => `${n}="${escapar(v)}"`).join(',')}}`;
}

interface Metrica {
  exportar(): string;
}

export class Contador implements Metrica {
  private readonly valores = new Map<string, { rotulos: Rotulos; valor: number }>();
  constructor(
    readonly nome: string,
    private readonly ajuda: string,
    private readonly nomesRotulos: readonly string[] = [],
  ) {}
  incrementar(rotulos: Rotulos = {}, valor = 1): void {
    const chave = chaveDe(this.nomesRotulos, rotulos);
    const atual = this.valores.get(chave);
    this.valores.set(chave, { rotulos, valor: (atual?.valor ?? 0) + valor });
  }
  valor(rotulos: Rotulos = {}): number {
    return this.valores.get(chaveDe(this.nomesRotulos, rotulos))?.valor ?? 0;
  }
  exportar(): string {
    const linhas = [`# HELP ${this.nome} ${this.ajuda}`, `# TYPE ${this.nome} counter`];
    for (const { rotulos, valor } of this.valores.values()) {
      linhas.push(`${this.nome}${formatarRotulos(this.nomesRotulos, rotulos)} ${valor}`);
    }
    return linhas.join('\n');
  }
}

export class Medidor implements Metrica {
  private readonly valores = new Map<string, { rotulos: Rotulos; valor: number }>();
  constructor(
    readonly nome: string,
    private readonly ajuda: string,
    private readonly nomesRotulos: readonly string[] = [],
  ) {}
  definir(valor: number, rotulos: Rotulos = {}): void {
    this.valores.set(chaveDe(this.nomesRotulos, rotulos), { rotulos, valor });
  }
  exportar(): string {
    const linhas = [`# HELP ${this.nome} ${this.ajuda}`, `# TYPE ${this.nome} gauge`];
    for (const { rotulos, valor } of this.valores.values()) {
      linhas.push(`${this.nome}${formatarRotulos(this.nomesRotulos, rotulos)} ${valor}`);
    }
    return linhas.join('\n');
  }
}

export class Histograma implements Metrica {
  private readonly series = new Map<
    string,
    { rotulos: Rotulos; baldes: number[]; soma: number; total: number }
  >();
  constructor(
    readonly nome: string,
    private readonly ajuda: string,
    private readonly limites: readonly number[],
    private readonly nomesRotulos: readonly string[] = [],
  ) {}
  observar(valor: number, rotulos: Rotulos = {}): void {
    const chave = chaveDe(this.nomesRotulos, rotulos);
    const serie = this.series.get(chave) ?? {
      rotulos,
      baldes: this.limites.map(() => 0),
      soma: 0,
      total: 0,
    };
    this.limites.forEach((limite, i) => {
      if (valor <= limite) serie.baldes[i]! += 1;
    });
    serie.soma += valor;
    serie.total += 1;
    this.series.set(chave, serie);
  }
  exportar(): string {
    const linhas = [`# HELP ${this.nome} ${this.ajuda}`, `# TYPE ${this.nome} histogram`];
    for (const { rotulos, baldes, soma, total } of this.series.values()) {
      this.limites.forEach((limite, i) => {
        linhas.push(
          `${this.nome}_bucket${formatarRotulos(this.nomesRotulos, rotulos, ['le', String(limite)])} ${baldes[i]}`,
        );
      });
      linhas.push(
        `${this.nome}_bucket${formatarRotulos(this.nomesRotulos, rotulos, ['le', '+Inf'])} ${total}`,
      );
      linhas.push(`${this.nome}_sum${formatarRotulos(this.nomesRotulos, rotulos)} ${soma}`);
      linhas.push(`${this.nome}_count${formatarRotulos(this.nomesRotulos, rotulos)} ${total}`);
    }
    return linhas.join('\n');
  }
}

/**
 * Registro de métricas. Os rótulos vêm sempre de conjuntos fechados no código
 * (rota declarada, sistema, efeito): nada de valor livre, que explodiria a
 * cardinalidade ou carregaria dado pessoal.
 */
export class RegistroMetricas {
  private readonly metricas = new Map<string, Metrica>();

  contador(nome: string, ajuda: string, rotulos: readonly string[] = []): Contador {
    return this.registrar(nome, () => new Contador(nome, ajuda, rotulos)) as Contador;
  }

  medidor(nome: string, ajuda: string, rotulos: readonly string[] = []): Medidor {
    return this.registrar(nome, () => new Medidor(nome, ajuda, rotulos)) as Medidor;
  }

  histograma(
    nome: string,
    ajuda: string,
    limites: readonly number[],
    rotulos: readonly string[] = [],
  ): Histograma {
    return this.registrar(nome, () => new Histograma(nome, ajuda, limites, rotulos)) as Histograma;
  }

  exportar(): string {
    return `${[...this.metricas.values()].map((m) => m.exportar()).join('\n')}\n`;
  }

  private registrar(nome: string, criar: () => Metrica): Metrica {
    if (!NOME_METRICA.test(nome)) throw new Error(`Nome de métrica inválido: ${nome}`);
    const existente = this.metricas.get(nome);
    if (existente !== undefined) return existente;
    const nova = criar();
    this.metricas.set(nome, nova);
    return nova;
  }
}

export const TIPO_METRICAS = 'text/plain; version=0.0.4; charset=utf-8';

/**
 * Servidor só de métricas, separado da porta pública da API e ligado por
 * padrão em `127.0.0.1`: quem raspa é o agente do ambiente, não a internet.
 */
export function servirMetricas(
  registro: RegistroMetricas,
  opcoes: { readonly porta: number; readonly host?: string },
): Promise<Server> {
  const servidor = createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/metrics' || req.url === '/metricas')) {
      res.writeHead(200, { 'content-type': TIPO_METRICAS, 'cache-control': 'no-store' });
      res.end(registro.exportar());
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolver, rejeitar) => {
    servidor.once('error', rejeitar);
    servidor.listen(opcoes.porta, opcoes.host ?? '127.0.0.1', () => resolver(servidor));
  });
}

/** Porta do servidor de métricas (`<VARIAVEL>`); ausente = desligado. */
export function portaDeMetricas(valor: string | undefined): number | null | 'invalida' {
  const v = valor?.trim();
  if (v === undefined || v === '') return null;
  return /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 65535 ? Number(v) : 'invalida';
}
