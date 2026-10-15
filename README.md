# New GIA - Controle de Acessos

O Gia recebe chamados de admissão do Jira, propõe a identidade e os acessos
de cada pessoa por regra, deixa um humano revisar e aprovar, executa nos
sistemas de destino (AD, Microsoft 365, DocuSign, SoftExpert e Jira) por uma
fila com lease e registra tudo como evidência imutável.

Projeto desenvolvido por um time de agentes orquestrado no Maestri (Maestro
Hermes + Dev Opus + Dev Sonnet + Revisor Terra + Revisor Sol). Fluxo: issue no
Linear → branch/worktree por issue → PR → CI → revisão independente → merge
squash → Done.

## Primeira entrega: ponta a ponta simulada

Tudo funciona de ponta a ponta **sem escrever em nenhum sistema real**: a
escrita externa nasce desligada e só liga com gates explícitos (regra 8),
os conectores falam com simuladores em memória e resultado simulado nunca
confirma acesso (regra 9).

```
Jira (simulado) ──► API ──► PostgreSQL ◄── worker ──► conectores ──► simuladores
                     ▲        (pedidos, revisões,      (lease,         (AD, M365,
       web ──────────┘         itens, fila, eventos)    retomada)       DocuSign,
                                                                       SoftExpert, Jira)
```

1. **Importação:** `POST /importacoes/jira` lê os chamados, normaliza,
   deduplica pela chave da issue (regra 10) e cria pedido, colaborador e
   proposta (identidade + um item por sistema habilitado no vínculo).
2. **Revisão:** o revisor edita identidade e parâmetros, aprova ou rejeita.
   Aprovar só grava a decisão (regra 1).
3. **Execução:** o executor solicita; a API grava a operação na fila na mesma
   transação do estado e do evento (outbox) e responde `202`.
4. **Worker:** reserva com lease (`SKIP LOCKED`, limite por destino), chama o
   conector com a chave de idempotência, renova o lease, registra o resultado
   e consolida o pedido. Worker que cai é retomado pelo lease: simulação
   volta à fila; escrita real vai para reconciliação, nunca é reenviada às
   cegas (regra 3).
5. **Acompanhamento:** resultado por item e por operação na API e na web.
6. **Documento de acessos:** `GET /pedidos/:pedidoId/documento` emite o DOCX
   de um pedido **concluído**, só com os acessos confirmados, com download
   auditado (`documentoEmitido`). Na entrega simulada o pedido nunca conclui,
   então a resposta é `422 DOCUMENTO_INDISPONIVEL` — é a regra 9 funcionando.

Os testes ponta a ponta (`tests/e2e`) percorrem exatamente esse caminho com a
API montada pelo ambiente de produção e o worker real sobre o mesmo banco:
fluxo completo simulado, worker que cai antes de gravar (retomada pelo lease
com a mesma chave de idempotência), fornecedor com timeout e reprocessamento,
e o documento de um pedido concluído por fornecedores "reais" de teste
(permissões, cabeçalhos, conteúdo sem CPF e download auditado).

### O que ainda não existe

- **Escrita real:** transportes reais (LDAPS, Graph, REST, SOAP), cofre de
  segredos e liberação de escrita por sistema. A configuração recusa ligar a
  escrita externa.
- **Login real:** a sessão é simulada (`POST /sessao/simulada`); OIDC com
  Entra ID ainda não existe e a rota simulada não sobe em `producao`.
- **Conferência e reconciliação pela API:** `conferirExistencia` e
  `reconciliar` respondem `501 ACAO_INDISPONIVEL`.
- **Simuladores de desenvolvimento vazios:** o worker sobe com o catálogo
  simulado sem OUs, grupos, perfis ou cadastros, então as operações simuladas
  terminam como `semEfeito`. Os testes preparam esse estado a partir dos
  parâmetros dos itens (`tests/e2e/apoio.ts`).
- **Documento na web:** o download existe na API; a interface ainda não tem o
  botão.
- Retenção, sincronização de diretório, configuração pela interface e
  exportação de auditoria.

## Como rodar

Requer Node.js >= 22, pnpm (versão fixada em `packageManager`) e, para o
banco, Docker ou um PostgreSQL 17.

```sh
pnpm install
pnpm check        # format:check + lint + typecheck + test + build
```

### Ambiente local completo

```sh
# 1. Banco
docker run -d --name gia-pg -e POSTGRES_HOST_AUTH_METHOD=trust -p 55432:5432 postgres:17-alpine
export GIA_DATABASE_URL=postgres://postgres@localhost:55432/postgres

# 2. Build e migrações
pnpm build
pnpm --filter @gia/persistencia migrar

# 3. API (porta 3000) e worker, no mesmo banco
pnpm --filter @gia/api start
pnpm --filter @gia/worker start

# 4. Interface (Vite; /api vai para a porta 3000)
pnpm --filter @gia/web dev
```

Sem `GIA_DATABASE_URL`, a API sobe com persistência em memória (útil para a
interface sozinha), mas aí o worker não enxerga os pedidos.

| Variável                  | Quem       | Padrão                                         |
| ------------------------- | ---------- | ---------------------------------------------- |
| `GIA_AMBIENTE`            | API/worker | `desenvolvimento` (`teste`, `producao`)        |
| `GIA_ESCRITA_EXTERNA`     | API/worker | `false` (único valor aceito)                   |
| `PORT`                    | API        | `3000`                                         |
| `GIA_DATABASE_URL`        | API/worker | API: memória; worker: obrigatória              |
| `GIA_WORKER_ID`           | worker     | `worker-<host>-<pid>`                          |
| `GIA_WORKER_INTERVALO_MS` | worker     | `1000`                                         |
| `GIA_EXECUCAO_*`          | worker     | política do ADR-0004 (`apps/worker/README.md`) |
| `GIA_DATABASE_URL_TESTE`  | testes     | sem ela, os testes de banco são pulados        |

### Testes

```sh
export GIA_DATABASE_URL_TESTE=postgres://postgres@localhost:55432/postgres
pnpm test                          # todos os pacotes
pnpm --filter @gia/tests test      # só os ponta a ponta
```

Cada arquivo de teste de banco cria um PostgreSQL descartável a partir de
`GIA_DATABASE_URL_TESTE` e o apaga no fim. No CI a variável é obrigatória.

## Estrutura

| Pasta                   | O que é                                                                       |
| ----------------------- | ----------------------------------------------------------------------------- |
| `packages/dominio`      | Entidades, estados e as 13 regras de negócio; código puro, sem I/O.           |
| `packages/contratos`    | Schemas Zod da API e da configuração (ADR-0005).                              |
| `packages/persistencia` | PostgreSQL + Kysely: repositórios, migrações, outbox e lease (ADR-0003/0004). |
| `packages/conectores`   | Adaptadores dos cinco sistemas e simuladores dos fornecedores.                |
| `packages/documentos`   | Formulário de acessos em DOCX.                                                |
| `apps/api`              | API HTTP (Fastify): sessão, importação, consultas, comandos, documento.       |
| `apps/worker`           | Executor da fila: lease, retomada, idempotência, consolidação.                |
| `apps/web`              | Interface do onboarding (React).                                              |
| `tests/e2e`             | Cenários ponta a ponta da entrega simulada.                                   |

Decisões de arquitetura em `docs/adr` (fora do repositório nesta fase) e nos
READMEs de cada pacote.

## Operação em produção

Gates de escrita externa, segredos em arquivo do cofre, saúde e prontidão,
logs estruturados com correlação, métricas, smoke test pós-deploy e rollback:
[runbook de produção](docs/operacao/producao.md). Produção ainda depende de
login real (OIDC) e dos conectores reais registrados no worker.
