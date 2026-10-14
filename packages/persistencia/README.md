# @gia/persistencia

Repositórios, migrações, fila de operações (outbox) e lease do Gia, em
**PostgreSQL + Kysely** (ADR-0003 e ADR-0004). Os casos de uso enxergam só as
portas (`src/portas.ts`); há duas implementações com o mesmo contrato: esta,
em PostgreSQL, e a em memória da API (testes e desenvolvimento).

## O que garante

| Garantia                       | Como                                                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Estado + eventos + fila juntos | Cada `executar` é uma transação; a operação gravada na fila é o outbox da intenção.                                                    |
| Unicidades do modelo           | Restrições nomeadas: CPF, origem do pedido, (revisão, sistema), chave de idempotência.                                                 |
| Uma operação ativa por item    | Índice único parcial em `operacoes (item_id)` para `pendente`/`reservada`/`aguardandoReconciliacao`.                                   |
| Eventos somente inserção       | Trigger recusa `UPDATE`, `DELETE` e `TRUNCATE` em `eventos`.                                                                           |
| Evento rastreável              | FKs de `eventos` para pedido, operação e colaborador (e para o evento corrigido).                                                      |
| Revisão aprovada imutável      | Trigger recusa alterar ou apagar revisão `aprovada`.                                                                                   |
| Controle otimista              | ID novo é inserido; registro existente só é atualizado na versão que a transação leu. Senão `ErroDeConcorrencia` (a API responde 409). |
| Lease                          | `reservarLote` trava com `FOR UPDATE SKIP LOCKED`: workers concorrentes recebem lotes disjuntos.                                       |

Violações viram `ErroDeIntegridade` com motivo legível; a mensagem nunca
repete o valor que colidiu (o `detail` do PostgreSQL pode conter CPF).

Cada entidade é gravada inteira em `dados` (jsonb). As colunas ao lado existem
para restrições, chaves estrangeiras (verificadas no commit), `versao` e
consultas da fila.

## Fila e lease

As regras são do domínio (`reservarOperacao`, `renovarLease`,
`recuperarLeaseExpirado`); `src/fila/lease.ts` só lê travando, aplica e grava
operação, item e eventos na mesma transação:

- `reservarLote(persistencia, politica, ctx, { limitePorSistema })`: até
  `lotePorWorker` operações pendentes, disponíveis e com dependência
  confirmada; com limite, cada sistema só recebe as vagas livres (trava
  consultiva por sistema; conta as reservadas com lease válido de todos os
  workers);
- `renovarLeaseDaOperacao(...)`: só o dono, antes de vencer;
- `recuperarLeasesExpirados(...)`: leitura/simulação volta à fila; escrita real
  vai para reconciliação e o item fica `desconhecido`.

Executar a operação no destino (worker e conectores) não é deste pacote.

## Migrações

Em `src/postgres/migracoes/`, aplicadas em ordem pelo nome; uma migração
publicada nunca é editada. O Kysely serializa instâncias que migram juntas.

```sh
pnpm --filter @gia/persistencia build
GIA_DATABASE_URL=postgres://... pnpm --filter @gia/persistencia migrar
```

## Testes

Usam PostgreSQL real. Cada arquivo cria um banco descartável e o apaga no fim,
a partir de `GIA_DATABASE_URL_TESTE` (usuário com permissão de criar banco).
Sem a variável, os testes de banco são pulados localmente; no CI ela é
obrigatória.

```sh
docker run -d --name gia-pg -e POSTGRES_HOST_AUTH_METHOD=trust -p 55432:5432 postgres:17-alpine
GIA_DATABASE_URL_TESTE=postgres://postgres@localhost:55432/postgres pnpm test
```
