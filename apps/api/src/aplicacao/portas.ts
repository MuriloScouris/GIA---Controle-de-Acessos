import type {
  Colaborador,
  ConfiguracaoSistemas,
  Evento,
  IdentidadeProposta,
  Instante,
  ItemAcesso,
  Operacao,
  PedidoAdmissao,
  Revisao,
  TipoEvento,
  UsoIdentidade,
  Uuid,
} from '@gia/dominio';
import type { UnidadeDeTrabalho } from '@gia/persistencia';

/**
 * Portas que os casos de uso enxergam. A implementação atual é em memória
 * (`persistencia/memoria.ts`); a definitiva (PostgreSQL + Kysely, ADR-0003)
 * implementa as mesmas interfaces, com as unicidades como restrições do banco.
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
  /** Fila de operações (ADR-0004): a operação gravada aqui é a intenção que o worker consome. */
  readonly operacoes: {
    doPedido(pedidoId: Uuid): Promise<readonly Operacao[]>;
    /** Chave de idempotência é única. */
    salvar(operacoes: readonly Operacao[]): Promise<void>;
  };
  /** Somente inserção (regra 11). */
  readonly eventos: {
    anexar(eventos: readonly Evento[]): Promise<void>;
    porTipo(tipo: TipoEvento): Promise<readonly Evento[]>;
  };
  readonly configuracao: {
    atual(): Promise<ConfiguracaoSistemas>;
  };
}

export type Persistencia = UnidadeDeTrabalho<Repositorios>;

/** Usos de login, e-mail e UPN já existentes no AD e no M365 (leitura, sem escrita). */
export interface ConsultaDiretorio {
  buscarUsos(identidade: IdentidadeProposta): Promise<readonly UsoIdentidade[]>;
}

/** Origem dos chamados de onboarding no Jira (leitura). */
export interface FonteChamadosJira {
  buscarChamadosOnboarding(): Promise<readonly unknown[]>;
}

export interface Relogio {
  agora(): Instante;
}
