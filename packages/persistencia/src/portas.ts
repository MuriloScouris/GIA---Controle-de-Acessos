import type {
  Colaborador,
  ConfiguracaoSistemas,
  Evento,
  Instante,
  ItemAcesso,
  Operacao,
  PedidoAdmissao,
  Revisao,
  Sistema,
  TipoEvento,
  Uuid,
} from '@gia/dominio';
import type { UnidadeDeTrabalho } from './unidade-de-trabalho.js';

/**
 * Repositórios que os casos de uso enxergam. Há duas implementações com o
 * mesmo contrato: em memória (testes e desenvolvimento da API) e PostgreSQL
 * (ADR-0003), em que as unicidades são restrições do banco.
 */
export interface Repositorios {
  readonly colaboradores: {
    porId(id: Uuid): Promise<Colaborador | null>;
    /** CPF só com dígitos; único. */
    porCpf(cpf: string): Promise<Colaborador | null>;
    todos(): Promise<readonly Colaborador[]>;
    salvar(colaborador: Colaborador): Promise<void>;
  };
  readonly pedidos: {
    porId(id: Uuid): Promise<PedidoAdmissao | null>;
    /** Chave canônica de origem (`chaveDeOrigem`); única entre pedidos (regra 10). */
    porOrigem(chave: string): Promise<PedidoAdmissao | null>;
    todos(): Promise<readonly PedidoAdmissao[]>;
    salvar(pedido: PedidoAdmissao): Promise<void>;
  };
  readonly revisoes: {
    porId(id: Uuid): Promise<Revisao | null>;
    salvar(revisao: Revisao): Promise<void>;
  };
  readonly itens: {
    doPedido(pedidoId: Uuid): Promise<readonly ItemAcesso[]>;
    /** (revisão, sistema) é único. */
    salvar(itens: readonly ItemAcesso[]): Promise<void>;
  };
  /**
   * Fila de operações (ADR-0004). Gravar a operação na mesma transação do
   * estado e dos eventos é o outbox: a intenção só existe se o resto existir.
   */
  readonly operacoes: {
    doPedido(pedidoId: Uuid): Promise<readonly Operacao[]>;
    /** Chave de idempotência é única. */
    salvar(operacoes: readonly Operacao[]): Promise<void>;
  };
  /** Somente inserção (regra 11). */
  readonly eventos: {
    anexar(eventos: readonly Evento[]): Promise<void>;
    porTipo(tipo: TipoEvento): Promise<readonly Evento[]>;
    /** Mais recentes primeiro; cursor de outro pedido/não encontrado devolve página vazia. */
    doPedido(
      pedidoId: Uuid,
      consulta: { readonly antesDe?: Uuid; readonly limite: number },
    ): Promise<readonly Evento[]>;
  };
  readonly configuracao: {
    atual(): Promise<ConfiguracaoSistemas>;
  };
}

export type Persistencia = UnidadeDeTrabalho<Repositorios>;

/**
 * Leitura da fila para quem consome operações. As operações devolvidas ficam
 * travadas até o fim da transação (`FOR UPDATE SKIP LOCKED`): outro
 * consumidor concorrente nunca recebe as mesmas.
 */
export interface FilaOperacoes {
  /**
   * Pendentes, já disponíveis e sem dependência por confirmar, em ordem de
   * disponibilidade; com `sistema`, só as daquele destino.
   */
  reservaveis(filtro: {
    readonly agora: Instante;
    readonly limite: number;
    readonly sistema?: Sistema;
  }): Promise<readonly Operacao[]>;
  /**
   * Serializa, até o fim da transação, quem reserva operações do sistema
   * (trava consultiva no banco, vale entre workers).
   */
  travarSistema(sistema: Sistema): Promise<void>;
  /** Operações do sistema reservadas com lease ainda válido (em execução ou na vez). */
  ativasNoSistema(filtro: { readonly sistema: Sistema; readonly agora: Instante }): Promise<number>;
  /** Reservadas cujo lease venceu (o worker caiu ou travou). */
  comLeaseExpirado(filtro: {
    readonly agora: Instante;
    readonly limite: number;
  }): Promise<readonly Operacao[]>;
  /** Lê e trava a operação, para renovar o lease ou registrar resultado. */
  operacaoPorId(id: Uuid): Promise<Operacao | null>;
  itemPorId(id: Uuid): Promise<ItemAcesso | null>;
}

export interface RepositoriosComFila extends Repositorios {
  readonly fila: FilaOperacoes;
}
