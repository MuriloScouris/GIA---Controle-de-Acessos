import {
  chaveDeOrigem,
  configuracaoPadrao,
  congelarProfundo,
  type ConfiguracaoSistemas,
  type Evento,
  type ItemAcesso,
  type Operacao,
} from '@gia/dominio';
import { sql, type Kysely, type RawBuilder, type Transaction } from 'kysely';
import pg from 'pg';
import { ErroDeConcorrencia, ErroDeIntegridade } from '../erros.js';
import type { RepositoriosComFila } from '../portas.js';
import type { UnidadeDeTrabalho } from '../unidade-de-trabalho.js';
import type { BancoGia } from './esquema.js';

type Tx = Transaction<BancoGia>;
type TabelaVersionada = 'colaboradores' | 'pedidos' | 'itens' | 'operacoes';

/** Restrição do banco → motivo legível. Nunca inclui o valor que colidiu (pode ser CPF). */
const MOTIVO_DA_RESTRICAO: Readonly<Record<string, string>> = {
  colaboradores_cpf_unico: 'CPF do colaborador',
  pedidos_origem_unica: 'origem do pedido',
  revisoes_numero_unico: 'número da revisão no pedido',
  itens_revisao_sistema_unico: '(revisão, sistema) do item',
  operacoes_chave_idempotencia_unica: 'chave de idempotência da operação',
  operacoes_item_ativa_unica: 'o item já tem operação ativa',
  eventos_pkey: 'evento já registrado',
};

/**
 * Traduz erros do PostgreSQL para os erros da persistência. O erro original
 * não é anexado: o `detail` do PostgreSQL repete os valores da chave.
 */
export function traduzirErro(erro: unknown): unknown {
  if (!(erro instanceof pg.DatabaseError)) return erro;
  const restricao = erro.constraint ?? '';
  const motivo = MOTIVO_DA_RESTRICAO[restricao];
  switch (erro.code) {
    case '23505':
      if (motivo !== undefined) return new ErroDeIntegridade(motivo);
      // Duas transações inserindo o mesmo registro ao mesmo tempo.
      if (restricao.endsWith('_pkey')) return new ErroDeConcorrencia(erro.table ?? '?', '?');
      return new ErroDeIntegridade(restricao || 'unicidade');
    case '23503':
      return new ErroDeIntegridade(`referência inexistente (${restricao})`);
    case '23514':
      return new ErroDeIntegridade(`restrição ${restricao}`);
    case 'P0001':
      return new ErroDeIntegridade(erro.message);
    case '40001':
    case '40P01':
      return new ErroDeConcorrencia(erro.table ?? 'transação', '?');
    default:
      return erro;
  }
}

async function executarSql<T>(consulta: RawBuilder<T>, tx: Tx) {
  try {
    return await consulta.execute(tx);
  } catch (erro) {
    throw traduzirErro(erro);
  }
}

function jsonb(valor: unknown): RawBuilder<unknown> {
  return sql`${JSON.stringify(valor)}::jsonb`;
}

async function lerDados<T>(tx: Tx, consulta: RawBuilder<{ dados: unknown }>): Promise<T[]> {
  const resultado = await executarSql(consulta, tx);
  return resultado.rows.map((linha) => linha.dados as T);
}

async function lerUm<T>(tx: Tx, consulta: RawBuilder<{ dados: unknown }>): Promise<T | null> {
  return (await lerDados<T>(tx, consulta))[0] ?? null;
}

/**
 * Versão de cada registro versionado como esta transação o conhece (lido ou
 * gravado por ela). É a versão esperada na próxima gravação do registro.
 */
type VersoesVistas = Map<string, number>;

function lerVersionados<T extends { readonly id: string; readonly versao: number }>(
  tx: Tx,
  vistas: VersoesVistas,
  tabela: TabelaVersionada,
  consulta: RawBuilder<{ dados: unknown }>,
): Promise<T[]> {
  return lerDados<T>(tx, consulta).then((registros) => {
    for (const registro of registros) vistas.set(`${tabela}:${registro.id}`, registro.versao);
    return registros;
  });
}

async function lerUmVersionado<T extends { readonly id: string; readonly versao: number }>(
  tx: Tx,
  vistas: VersoesVistas,
  tabela: TabelaVersionada,
  consulta: RawBuilder<{ dados: unknown }>,
): Promise<T | null> {
  return (await lerVersionados<T>(tx, vistas, tabela, consulta))[0] ?? null;
}

/**
 * Grava com controle otimista. Registro novo é inserido (`ON CONFLICT DO
 * NOTHING`); registro existente só é atualizado se esta transação o leu (ou
 * gravou) e ele ainda está nessa versão. O domínio pode avançar a versão mais
 * de uma vez antes de gravar; o que vale é a versão lida. Qualquer outro caso
 * (outra transação mudou o registro, ou a gravação parte de uma cópia que não
 * foi lida nesta transação) é `ErroDeConcorrencia`, e a transação inteira é
 * desfeita.
 */
async function gravarVersionado(
  tx: Tx,
  vistas: VersoesVistas,
  tabela: TabelaVersionada,
  entidade: { readonly id: string; readonly versao: number },
  colunas: Readonly<Record<string, unknown>>,
): Promise<void> {
  const chave = `${tabela}:${entidade.id}`;
  const dados = jsonb(entidade);
  const valores = Object.entries({ ...colunas, versao: entidade.versao });
  const vista = vistas.get(chave);
  const gravado =
    vista === undefined
      ? await executarSql(
          sql`
            insert into ${sql.table(tabela)}
              (${sql.join([sql.ref('id'), ...valores.map(([coluna]) => sql.ref(coluna)), sql.ref('dados')])})
            values (${sql.join([entidade.id, ...valores.map(([, valor]) => valor), dados])})
            on conflict (id) do nothing
          `,
          tx,
        )
      : await executarSql(
          sql`
            update ${sql.table(tabela)}
            set ${sql.join([
              ...valores.map(([coluna, valor]) => sql`${sql.ref(coluna)} = ${valor}`),
              sql`dados = ${dados}`,
            ])}
            where id = ${entidade.id} and versao = ${vista}
          `,
          tx,
        );
  if ((gravado.numAffectedRows ?? 0n) === 0n) throw new ErroDeConcorrencia(tabela, entidade.id);
  vistas.set(chave, entidade.versao);
}

function colunasDaOperacao(operacao: Operacao): Record<string, unknown> {
  return {
    pedido_id: operacao.pedidoId,
    item_id: operacao.itemId,
    depende_de_item_id: operacao.dependeDeItemId,
    chave_idempotencia: operacao.chaveIdempotencia,
    status: operacao.status,
    disponivel_em: operacao.disponivelEm,
    lease_worker_id: operacao.lease?.workerId ?? null,
    lease_expira_em: operacao.lease?.expiraEm ?? null,
  };
}

function repositorios(tx: Tx, configuracao: ConfiguracaoSistemas): RepositoriosComFila {
  const vistas: VersoesVistas = new Map();
  return {
    colaboradores: {
      porId: (id) =>
        lerUmVersionado(
          tx,
          vistas,
          'colaboradores',
          sql`select dados from colaboradores where id = ${id}`,
        ),
      porCpf: (cpf) =>
        lerUmVersionado(
          tx,
          vistas,
          'colaboradores',
          sql`select dados from colaboradores where cpf = ${cpf}`,
        ),
      todos: () =>
        lerVersionados(
          tx,
          vistas,
          'colaboradores',
          sql`select dados from colaboradores order by ordem`,
        ),
      salvar: (colaborador) =>
        gravarVersionado(tx, vistas, 'colaboradores', colaborador, { cpf: colaborador.cpf }),
    },
    pedidos: {
      porId: (id) =>
        lerUmVersionado(tx, vistas, 'pedidos', sql`select dados from pedidos where id = ${id}`),
      porOrigem: (chave) =>
        lerUmVersionado(
          tx,
          vistas,
          'pedidos',
          sql`select dados from pedidos where chave_origem = ${chave}`,
        ),
      todos: () =>
        lerVersionados(tx, vistas, 'pedidos', sql`select dados from pedidos order by ordem`),
      salvar: (pedido) =>
        gravarVersionado(tx, vistas, 'pedidos', pedido, {
          chave_origem: chaveDeOrigem(pedido.origem),
          colaborador_id: pedido.colaboradorId,
          status: pedido.status,
        }),
    },
    revisoes: {
      porId: (id) => lerUm(tx, sql`select dados from revisoes where id = ${id}`),
      // Revisão não tem `versao`; a aprovada é imutável por trigger.
      salvar: async (revisao) => {
        await executarSql(
          sql`
            insert into revisoes (id, pedido_id, numero, situacao, dados)
            values (${revisao.id}, ${revisao.pedidoId}, ${revisao.numero}, ${revisao.situacao},
                    ${jsonb(revisao)})
            on conflict (id) do update set
              pedido_id = excluded.pedido_id,
              numero = excluded.numero,
              situacao = excluded.situacao,
              dados = excluded.dados
          `,
          tx,
        );
      },
    },
    itens: {
      doPedido: (pedidoId) =>
        lerVersionados(
          tx,
          vistas,
          'itens',
          sql`select dados from itens where pedido_id = ${pedidoId} order by ordem`,
        ),
      salvar: async (itens) => {
        for (const item of itens) {
          await gravarVersionado(tx, vistas, 'itens', item, {
            pedido_id: item.pedidoId,
            revisao_id: item.revisaoId,
            sistema: item.sistema,
            status: item.status,
          });
        }
      },
    },
    operacoes: {
      doPedido: (pedidoId) =>
        lerVersionados(
          tx,
          vistas,
          'operacoes',
          sql`select dados from operacoes where pedido_id = ${pedidoId} order by ordem`,
        ),
      salvar: async (operacoes) => {
        for (const operacao of operacoes) {
          await gravarVersionado(tx, vistas, 'operacoes', operacao, colunasDaOperacao(operacao));
        }
      },
    },
    eventos: {
      anexar: async (eventos) => {
        for (const evento of eventos) {
          await executarSql(
            sql`
              insert into eventos
                (id, tipo, instante, pedido_id, operacao_id, colaborador_id, corrige_evento_id, dados)
              values (${evento.id}, ${evento.tipo}, ${evento.instante}, ${evento.pedidoId},
                      ${evento.operacaoId}, ${evento.colaboradorId}, ${evento.corrigeEventoId},
                      ${jsonb(evento)})
            `,
            tx,
          );
        }
      },
      porTipo: async (tipo) =>
        (
          await lerDados<Evento>(
            tx,
            sql`select dados from eventos where tipo = ${tipo} order by ordem`,
          )
        ).map((evento) => congelarProfundo(evento)),
    },
    configuracao: {
      atual: async () => configuracao,
    },
    fila: {
      reservaveis: ({ agora, limite }) =>
        lerVersionados<Operacao>(
          tx,
          vistas,
          'operacoes',
          sql`
            select o.dados from operacoes o
            where o.status = 'pendente'
              and o.disponivel_em <= ${agora}
              and (
                o.depende_de_item_id is null
                or exists (
                  select 1 from itens d
                  where d.id = o.depende_de_item_id and d.status = 'confirmado'
                )
              )
            order by o.disponivel_em, o.ordem
            limit ${limite}
            for update of o skip locked
          `,
        ),
      comLeaseExpirado: ({ agora, limite }) =>
        lerVersionados<Operacao>(
          tx,
          vistas,
          'operacoes',
          sql`
            select dados from operacoes
            where status = 'reservada' and lease_expira_em <= ${agora}
            order by lease_expira_em, ordem
            limit ${limite}
            for update skip locked
          `,
        ),
      operacaoPorId: (id) =>
        lerUmVersionado<Operacao>(
          tx,
          vistas,
          'operacoes',
          sql`select dados from operacoes where id = ${id} for update`,
        ),
      itemPorId: (id) =>
        lerUmVersionado<ItemAcesso>(
          tx,
          vistas,
          'itens',
          sql`select dados from itens where id = ${id}`,
        ),
    },
  };
}

export interface OpcoesPersistenciaPostgres {
  /** Configuração dos sistemas; ainda não é persistida (não há porta de escrita para ela). */
  readonly configuracao?: ConfiguracaoSistemas;
}

/**
 * Persistência PostgreSQL (ADR-0003). Cada `executar` é uma transação: estado,
 * eventos e operações da fila entram juntos ou não entram. O chamador é dono
 * do `db` e o encerra.
 */
export function criarPersistenciaPostgres(
  db: Kysely<BancoGia>,
  opcoes: OpcoesPersistenciaPostgres = {},
): UnidadeDeTrabalho<RepositoriosComFila> {
  const configuracao = opcoes.configuracao ?? configuracaoPadrao();
  return {
    async executar(trabalho) {
      try {
        return await db.transaction().execute((tx) => trabalho(repositorios(tx, configuracao)));
      } catch (erro) {
        // Chaves estrangeiras adiadas falham no commit, fora de `executarSql`.
        throw traduzirErro(erro);
      }
    },
  };
}
