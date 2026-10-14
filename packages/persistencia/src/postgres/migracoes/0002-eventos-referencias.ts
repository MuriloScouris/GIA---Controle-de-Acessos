import { sql, type Kysely } from 'kysely';

/**
 * Evento de auditoria só aponta para pedido, operação e colaborador que
 * existem (regra 11: evidência rastreável). Como as demais FKs, são
 * verificadas no commit: o evento pode ser anexado antes da entidade na
 * mesma transação. Referência ausente (`null`) continua permitida.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table eventos
      add constraint eventos_pedido_fk foreign key (pedido_id)
        references pedidos (id) deferrable initially deferred,
      add constraint eventos_operacao_fk foreign key (operacao_id)
        references operacoes (id) deferrable initially deferred,
      add constraint eventos_colaborador_fk foreign key (colaborador_id)
        references colaboradores (id) deferrable initially deferred;

    create index eventos_operacao on eventos (operacao_id);
    create index eventos_colaborador on eventos (colaborador_id);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop index if exists eventos_colaborador;
    drop index if exists eventos_operacao;
    alter table eventos
      drop constraint if exists eventos_colaborador_fk,
      drop constraint if exists eventos_operacao_fk,
      drop constraint if exists eventos_pedido_fk;
  `.execute(db);
}
