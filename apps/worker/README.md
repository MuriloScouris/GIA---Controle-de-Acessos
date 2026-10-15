# @gia/worker

Serviço executor (ADR-0004): consome a fila de operações com lease, chama o
conector do sistema e grava resultado, estado do item, eventos e consolidação
do pedido na mesma transação. As regras são do domínio
(`registrarResultadoOperacao`, `consolidarPedido`, `reservarOperacao`,
`recuperarLeaseExpirado`); o worker só orquestra.

## Ciclo

Cada lote (`criarExecutor(...).processarLote()`):

1. **Retomada:** recupera leases vencidos (worker que caiu ou travou). Leitura
   e simulação voltam à fila; escrita real vai para reconciliação e o item
   fica `desconhecido`. Nada é reenviado às cegas.
2. **Reserva:** até `lotePorWorker` operações disponíveis, com a dependência
   confirmada (`FOR UPDATE SKIP LOCKED`; workers concorrentes recebem lotes
   disjuntos) e respeitando o **limite por destino**: o total de operações
   reservadas com lease válido num sistema, somando todos os workers, nunca
   passa do limite configurado (trava consultiva no PostgreSQL).
3. **Lease do lote:** enquanto o lote roda em sequência, os leases de todas as
   operações ainda não gravadas são renovados a cada `renovacaoLeaseMs`.
4. **Gate antes da chamada:** imediatamente antes de chamar o conector, o
   lease da operação é revalidado e renovado. Se venceu ou mudou de dono, o
   conector **não** é chamado (`naoExecutada`).
5. **Execução:** chama o conector com a chave de idempotência da operação
   (estável entre tentativas) e a etapa de retomada (a seguinte à última
   comprovada). Exceção do conector vira resultado `desconhecido` (regra 3).
6. **Registro:** grava resultado, item e eventos e consolida o pedido numa
   transação. Se o lease foi perdido durante a chamada, o domínio recusa e o
   resultado é descartado. Conflito de concorrência com a API: relê e grava.

Só `provisionar` e `revogar` chamam o conector. Outras ações são encerradas
como `semEfeito` (`ACAO_NAO_SUPORTADA_PELO_WORKER`), sem tocar o destino.

## Como rodar

```sh
pnpm --filter @gia/persistencia migrar          # GIA_DATABASE_URL
GIA_DATABASE_URL=postgres://... pnpm --filter @gia/worker start
```

| Variável                          | Padrão (ADR-0004)                      |
| --------------------------------- | -------------------------------------- |
| `GIA_DATABASE_URL`                | obrigatória                            |
| `GIA_WORKER_ID`                   | `worker-<host>-<pid>`                  |
| `GIA_WORKER_INTERVALO_MS`         | `1000` (fila vazia)                    |
| `GIA_ESCRITA_EXTERNA`             | `false` (único aceito)                 |
| `GIA_EXECUCAO_TIMEOUT_CONEXAO_MS` | `5000`                                 |
| `GIA_EXECUCAO_TIMEOUT_CHAMADA_MS` | `30000` (menor que o lease)            |
| `GIA_EXECUCAO_MAX_RETENTATIVAS`   | `3`                                    |
| `GIA_EXECUCAO_BACKOFF_MS`         | `5000,15000,45000`                     |
| `GIA_EXECUCAO_JITTER_MAXIMO_MS`   | `1000`                                 |
| `GIA_EXECUCAO_LEASE_MS`           | `120000`                               |
| `GIA_EXECUCAO_RENOVACAO_LEASE_MS` | `30000` (menor que o lease)            |
| `GIA_EXECUCAO_LOTE`               | `10`                                   |
| `GIA_EXECUCAO_ESPERA_M365_MS`     | `300000`                               |
| `GIA_EXECUCAO_LIMITE_POR_SISTEMA` | `5` por sistema (`3` ou `ad=2,m365=1`) |

A política é validada no arranque (`validarPolitica` do domínio, mais
`timeoutChamada < lease`); o erro cita só o nome das variáveis.

Com a escrita externa desligada, os conectores são os simulados de
`@gia/conectores`. `SIGINT`/`SIGTERM` encerram depois do lote em andamento.
O log traz só contagens, nunca dados pessoais ou parâmetros.

## Testes

Preflight de produção: `pnpm --filter @gia/worker preflight --saida <arquivo-novo.json>`.
`--offline` confere configuração/cofre sem rede. O comando faz somente leituras,
recusa escrita habilitada e gera evidência sanitizada. Saída 1 indica bloqueio
técnico; 2 indica leituras aprovadas com homologação administrativa pendente.
Nenhum desses códigos autoriza escrita. Configuração, códigos, checklist de
ensaio autorizado e rollback: [DEV-289](../../docs/operacao/dev-289-preflight.md).

`pnpm test` com `GIA_DATABASE_URL_TESTE` (PostgreSQL real; ver
`packages/persistencia/README.md`). Cobrem execução, dependência AD → M365,
falha transitória com backoff e retomada da etapa, falha definitiva,
reconciliação, exceção do conector, conflito ao gravar, workers concorrentes,
renovação e perda de lease, gate de lease no lote lento, limite por destino
entre workers, revogação (com retomada e `JA_REVOGADO`), espera de
sincronização do M365 e queda do worker antes de gravar.
