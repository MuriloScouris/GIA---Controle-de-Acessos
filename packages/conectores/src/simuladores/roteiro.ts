import { ErroFornecedor } from '../erros.js';

/**
 * Cenários que um simulador sabe reproduzir numa chamada.
 * - `falha`: o fornecedor recusa e nada muda;
 * - `erro2xx`: resposta 2xx com erro interno (DocuSign e SoftExpert); o adaptador a trata como erro;
 * - `timeout` / `respostaPerdida`: a resposta não chega; `efeitoAplicado` diz se o destino agiu mesmo assim;
 * - `conexaoRecusada` / `limiteDeTaxa`: nada chega ao destino.
 */
export type CenarioChamada =
  | 'sucesso'
  | 'falha'
  | 'erro2xx'
  | 'timeout'
  | 'respostaPerdida'
  | 'conexaoRecusada'
  | 'limiteDeTaxa';

export interface OpcoesCenario {
  /** Quantas chamadas seguidas seguem o cenário (padrão: 1). */
  readonly vezes?: number;
  /** Só para `timeout` e `respostaPerdida`: o destino executou antes de a resposta se perder. */
  readonly efeitoAplicado?: boolean;
  /** Só para `limiteDeTaxa`: `Retry-After` em milissegundos. */
  readonly tentarAposMs?: number;
}

/** Cenários prontos de alto nível, os mesmos que a spec pede de cada simulador. */
export type CenarioPronto = 'sucesso' | 'falha' | 'parcial' | 'timeout' | 'limiteDeTaxa';

export interface MetodosDeEscrita {
  readonly primeiro: string;
  readonly ultimo: string;
}

interface Programacao {
  readonly cenario: CenarioChamada;
  readonly opcoes: OpcoesCenario;
  restantes: number;
}

/**
 * Roteiro dos cenários de um simulador: fila de cenários por método. Sem
 * programação, toda chamada é `sucesso`. Nunca abre rede.
 */
export class Roteiro {
  private readonly filas = new Map<string, Programacao[]>();
  private readonly contagem = new Map<string, number>();

  constructor(private readonly escrita: MetodosDeEscrita) {}

  programar(metodo: string, cenario: CenarioChamada, opcoes: OpcoesCenario = {}): this {
    const fila = this.filas.get(metodo) ?? [];
    fila.push({ cenario, opcoes, restantes: opcoes.vezes ?? 1 });
    this.filas.set(metodo, fila);
    return this;
  }

  /** `parcial`: a última escrita falha, então as anteriores ficam feitas. */
  aplicar(cenario: CenarioPronto): this {
    switch (cenario) {
      case 'sucesso':
        return this.limpar();
      case 'falha':
        return this.programar(this.escrita.primeiro, 'falha');
      case 'parcial':
        return this.programar(this.escrita.ultimo, 'falha');
      case 'timeout':
        return this.programar(this.escrita.primeiro, 'timeout');
      case 'limiteDeTaxa':
        return this.programar(this.escrita.primeiro, 'limiteDeTaxa', { tentarAposMs: 2_000 });
    }
  }

  limpar(): this {
    this.filas.clear();
    return this;
  }

  /** Quantas vezes o método foi chamado, com sucesso ou não. */
  chamadas(metodo: string): number {
    return this.contagem.get(metodo) ?? 0;
  }

  /**
   * Passa uma chamada pelo roteiro. `efeito` muda o estado simulado e só roda
   * quando o cenário permite; o resultado dele é devolvido no sucesso.
   */
  async passar<T>(metodo: string, efeito: () => T | Promise<T>): Promise<T> {
    this.contagem.set(metodo, this.chamadas(metodo) + 1);
    const programacao = this.proxima(metodo);
    const cenario = programacao?.cenario ?? 'sucesso';
    const opcoes = programacao?.opcoes ?? {};
    switch (cenario) {
      case 'sucesso':
        return efeito();
      case 'falha':
        throw new ErroFornecedor(
          'recusado',
          'RECUSADO_PELO_FORNECEDOR',
          'O fornecedor recusou a operação.',
        );
      case 'erro2xx':
        throw new ErroFornecedor(
          'recusado',
          'ERRO_INTERNO_2XX',
          'O fornecedor respondeu 2xx com erro interno.',
        );
      case 'conexaoRecusada':
        throw new ErroFornecedor('conexaoRecusada');
      case 'limiteDeTaxa':
        throw new ErroFornecedor(
          'limiteDeTaxa',
          'LIMITE_DE_TAXA',
          'Limite de taxa do fornecedor.',
          opcoes.tentarAposMs ?? 1_000,
        );
      case 'timeout':
      case 'respostaPerdida': {
        if (opcoes.efeitoAplicado ?? cenario === 'respostaPerdida') await efeito();
        throw new ErroFornecedor(cenario);
      }
    }
  }

  private proxima(metodo: string): Programacao | undefined {
    const fila = this.filas.get(metodo);
    const atual = fila?.[0];
    if (fila === undefined || atual === undefined) return undefined;
    atual.restantes -= 1;
    if (atual.restantes <= 0) fila.shift();
    return atual;
  }
}
