import {
  anexarEventos,
  chaveDeOrigem,
  configuracaoPadrao,
  REGISTRO_VAZIO,
  type Colaborador,
  type ConfiguracaoSistemas,
  type ItemAcesso,
  type Operacao,
  type PedidoAdmissao,
  type RegistroEventos,
  type Revisao,
  type Uuid,
} from '@gia/dominio';
import { ErroDeIntegridade } from '@gia/persistencia';
import type { Persistencia, Repositorios } from '../aplicacao/portas.js';

export { ErroDeIntegridade };

/**
 * Persistência em memória do processo, para testes e desenvolvimento da API.
 * A definitiva é `criarPersistenciaPostgres` (ADR-0003), com o mesmo contrato.
 * Limitações conhecidas:
 * - tudo se perde ao reiniciar e não é compartilhado entre instâncias (a API
 *   ainda não é sem estado);
 * - transações são serializadas por uma fila única no processo;
 * - unicidades e o "somente inserção" dos eventos são checados aqui, não por
 *   restrições e triggers do banco.
 *
 * O que ela já garante: cada `executar` é tudo ou nada (estado + eventos +
 * operações da fila na mesma unidade de trabalho) e as unicidades do modelo.
 */
interface Tabelas {
  readonly colaboradores: Map<Uuid, Colaborador>;
  readonly pedidos: Map<Uuid, PedidoAdmissao>;
  readonly revisoes: Map<Uuid, Revisao>;
  readonly itens: Map<Uuid, ItemAcesso>;
  readonly operacoes: Map<Uuid, Operacao>;
  eventos: RegistroEventos;
  readonly configuracao: ConfiguracaoSistemas;
}

function copiar(tabelas: Tabelas): Tabelas {
  return {
    colaboradores: new Map(tabelas.colaboradores),
    pedidos: new Map(tabelas.pedidos),
    revisoes: new Map(tabelas.revisoes),
    itens: new Map(tabelas.itens),
    operacoes: new Map(tabelas.operacoes),
    eventos: tabelas.eventos,
    configuracao: tabelas.configuracao,
  };
}

function exigirUnico<T>(
  existentes: Iterable<T>,
  novo: T,
  mesmoRegistro: (a: T, b: T) => boolean,
  mesmaChave: (a: T, b: T) => boolean,
  motivo: string,
): void {
  for (const existente of existentes) {
    if (!mesmoRegistro(existente, novo) && mesmaChave(existente, novo)) {
      throw new ErroDeIntegridade(motivo);
    }
  }
}

function repositorios(t: Tabelas): Repositorios {
  const mesmoId = (a: { id: Uuid }, b: { id: Uuid }): boolean => a.id === b.id;
  return {
    colaboradores: {
      porId: async (id) => t.colaboradores.get(id) ?? null,
      porCpf: async (cpf) => [...t.colaboradores.values()].find((c) => c.cpf === cpf) ?? null,
      todos: async () => [...t.colaboradores.values()],
      salvar: async (colaborador) => {
        exigirUnico(
          t.colaboradores.values(),
          colaborador,
          mesmoId,
          (a, b) => a.cpf === b.cpf,
          'CPF do colaborador',
        );
        t.colaboradores.set(colaborador.id, colaborador);
      },
    },
    pedidos: {
      porId: async (id) => t.pedidos.get(id) ?? null,
      porOrigem: async (chave) =>
        [...t.pedidos.values()].find((p) => chaveDeOrigem(p.origem) === chave) ?? null,
      todos: async () => [...t.pedidos.values()],
      salvar: async (pedido) => {
        exigirUnico(
          t.pedidos.values(),
          pedido,
          mesmoId,
          (a, b) => chaveDeOrigem(a.origem) === chaveDeOrigem(b.origem),
          'origem do pedido',
        );
        t.pedidos.set(pedido.id, pedido);
      },
    },
    revisoes: {
      porId: async (id) => t.revisoes.get(id) ?? null,
      salvar: async (revisao) => {
        const anterior = t.revisoes.get(revisao.id);
        if (anterior?.situacao === 'aprovada') {
          throw new ErroDeIntegridade('revisão aprovada é imutável');
        }
        t.revisoes.set(revisao.id, revisao);
      },
    },
    itens: {
      doPedido: async (pedidoId) => [...t.itens.values()].filter((i) => i.pedidoId === pedidoId),
      salvar: async (itens) => {
        for (const item of itens) {
          exigirUnico(
            t.itens.values(),
            item,
            mesmoId,
            (a, b) => a.revisaoId === b.revisaoId && a.sistema === b.sistema,
            '(revisão, sistema) do item',
          );
          t.itens.set(item.id, item);
        }
      },
    },
    operacoes: {
      doPedido: async (pedidoId) =>
        [...t.operacoes.values()].filter((o) => o.pedidoId === pedidoId),
      salvar: async (operacoes) => {
        for (const operacao of operacoes) {
          exigirUnico(
            t.operacoes.values(),
            operacao,
            mesmoId,
            (a, b) => a.chaveIdempotencia === b.chaveIdempotencia,
            'chave de idempotência da operação',
          );
          t.operacoes.set(operacao.id, operacao);
        }
      },
    },
    eventos: {
      anexar: async (eventos) => {
        const anexado = anexarEventos(t.eventos, eventos);
        if (!anexado.ok) throw new ErroDeIntegridade('evento já registrado');
        t.eventos = anexado.valor;
      },
      porTipo: async (tipo) => t.eventos.filter((evento) => evento.tipo === tipo),
    },
    configuracao: {
      atual: async () => t.configuracao,
    },
  };
}

export interface PersistenciaMemoria extends Persistencia {
  /** Leitura direta para testes e diagnóstico; fora de transação. */
  readonly espiar: {
    pedidos(): readonly PedidoAdmissao[];
    itens(): readonly ItemAcesso[];
    operacoes(): readonly Operacao[];
    eventos(): RegistroEventos;
    colaboradores(): readonly Colaborador[];
  };
}

export function criarPersistenciaEmMemoria(
  configuracao: ConfiguracaoSistemas = configuracaoPadrao(),
): PersistenciaMemoria {
  let tabelas: Tabelas = {
    colaboradores: new Map(),
    pedidos: new Map(),
    revisoes: new Map(),
    itens: new Map(),
    operacoes: new Map(),
    eventos: REGISTRO_VAZIO,
    configuracao,
  };
  let fila: Promise<unknown> = Promise.resolve();

  return {
    executar<T>(trabalho: (tx: Repositorios) => Promise<T>): Promise<T> {
      const execucao = fila.then(async () => {
        const rascunho = copiar(tabelas);
        const resultado = await trabalho(repositorios(rascunho));
        tabelas = rascunho;
        return resultado;
      });
      fila = execucao.catch(() => undefined);
      return execucao;
    },
    espiar: {
      pedidos: () => [...tabelas.pedidos.values()],
      itens: () => [...tabelas.itens.values()],
      operacoes: () => [...tabelas.operacoes.values()],
      eventos: () => tabelas.eventos,
      colaboradores: () => [...tabelas.colaboradores.values()],
    },
  };
}
