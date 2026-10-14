import { sql, type Kysely } from 'kysely';

/**
 * Esquema inicial (ADR-0003/0004). Cada entidade é gravada inteira em `dados`
 * (jsonb); as colunas ao lado existem para unicidades, chaves estrangeiras,
 * controle otimista (`versao`) e consultas da fila. As restrições têm nome
 * explícito porque a persistência traduz cada uma num erro de integridade.
 *
 * - Chaves estrangeiras são verificadas no commit (`DEFERRABLE INITIALLY
 *   DEFERRED`): a ordem de gravação dentro da transação não importa.
 * - `ordem` preserva a ordem de inserção nas listagens.
 * - Eventos são somente inserção e revisão aprovada é imutável (triggers).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table colaboradores (
      id uuid primary key,
      ordem bigint generated always as identity,
      cpf text not null constraint colaboradores_cpf_unico unique,
      versao integer not null check (versao >= 1),
      dados jsonb not null
    );

    create table pedidos (
      id uuid primary key,
      ordem bigint generated always as identity,
      chave_origem text not null constraint pedidos_origem_unica unique,
      colaborador_id uuid not null
        constraint pedidos_colaborador_fk references colaboradores (id)
        deferrable initially deferred,
      status text not null,
      versao integer not null check (versao >= 1),
      dados jsonb not null
    );

    create table revisoes (
      id uuid primary key,
      ordem bigint generated always as identity,
      pedido_id uuid not null
        constraint revisoes_pedido_fk references pedidos (id)
        deferrable initially deferred,
      numero integer not null,
      situacao text not null check (situacao in ('rascunho', 'aprovada')),
      dados jsonb not null,
      constraint revisoes_numero_unico unique (pedido_id, numero)
    );

    create table itens (
      id uuid primary key,
      ordem bigint generated always as identity,
      pedido_id uuid not null
        constraint itens_pedido_fk references pedidos (id)
        deferrable initially deferred,
      revisao_id uuid not null
        constraint itens_revisao_fk references revisoes (id)
        deferrable initially deferred,
      sistema text not null,
      status text not null,
      versao integer not null check (versao >= 1),
      dados jsonb not null,
      constraint itens_revisao_sistema_unico unique (revisao_id, sistema)
    );

    create table operacoes (
      id uuid primary key,
      ordem bigint generated always as identity,
      pedido_id uuid not null
        constraint operacoes_pedido_fk references pedidos (id)
        deferrable initially deferred,
      item_id uuid not null
        constraint operacoes_item_fk references itens (id)
        deferrable initially deferred,
      depende_de_item_id uuid
        constraint operacoes_dependencia_fk references itens (id)
        deferrable initially deferred,
      chave_idempotencia text not null constraint operacoes_chave_idempotencia_unica unique,
      status text not null check (
        status in (
          'pendente', 'reservada', 'concluida',
          'aguardandoReconciliacao', 'reconciliada', 'cancelada'
        )
      ),
      disponivel_em timestamptz not null,
      lease_worker_id text,
      lease_expira_em timestamptz,
      versao integer not null check (versao >= 1),
      dados jsonb not null,
      constraint operacoes_lease_da_reserva check (
        status <> 'reservada' or (lease_worker_id is not null and lease_expira_em is not null)
      )
    );

    -- Enquanto houver operação ativa, o item não ganha outra (STATUS_OPERACAO_ATIVA).
    create unique index operacoes_item_ativa_unica on operacoes (item_id)
      where status in ('pendente', 'reservada', 'aguardandoReconciliacao');
    create index operacoes_pendentes on operacoes (disponivel_em, ordem)
      where status = 'pendente';
    create index operacoes_reservadas on operacoes (lease_expira_em)
      where status = 'reservada';
    create index operacoes_pedido on operacoes (pedido_id);
    create index itens_pedido on itens (pedido_id);

    create table eventos (
      id uuid primary key,
      ordem bigint generated always as identity,
      tipo text not null,
      instante timestamptz not null,
      pedido_id uuid,
      operacao_id uuid,
      colaborador_id uuid,
      corrige_evento_id uuid constraint eventos_corrige_fk references eventos (id),
      dados jsonb not null
    );
    create index eventos_tipo on eventos (tipo, ordem);
    create index eventos_pedido on eventos (pedido_id, ordem);

    create function gia_eventos_somente_insercao() returns trigger
    language plpgsql as $$
    begin
      raise exception 'eventos são somente inserção' using errcode = 'P0001';
    end
    $$;
    create trigger eventos_sem_alteracao before update or delete on eventos
      for each row execute function gia_eventos_somente_insercao();
    create trigger eventos_sem_truncate before truncate on eventos
      for each statement execute function gia_eventos_somente_insercao();

    create function gia_revisao_aprovada_imutavel() returns trigger
    language plpgsql as $$
    begin
      if old.situacao = 'aprovada' then
        raise exception 'revisão aprovada é imutável' using errcode = 'P0001';
      end if;
      return case when tg_op = 'DELETE' then old else new end;
    end
    $$;
    create trigger revisoes_aprovada_imutavel before update or delete on revisoes
      for each row execute function gia_revisao_aprovada_imutavel();
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop table if exists eventos;
    drop table if exists operacoes;
    drop table if exists itens;
    drop table if exists revisoes;
    drop table if exists pedidos;
    drop table if exists colaboradores;
    drop function if exists gia_eventos_somente_insercao();
    drop function if exists gia_revisao_aprovada_imutavel();
  `.execute(db);
}
