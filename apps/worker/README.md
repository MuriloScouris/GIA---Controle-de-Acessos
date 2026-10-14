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
   disjuntos).
3. **Execução:** chama o conector com a chave de idempotência da operação
   (estável entre tentativas) e a etapa de retomada (a seguinte à última
   comprovada). Renova o lease a cada `renovacaoLeaseMs` enquanto o conector
   trabalha. Exceção do conector vira resultado `desconhecido` (regra 3).
4. **Registro:** grava resultado, item e eventos e consolida o pedido numa
   transação. Se o lease foi perdido, o domínio recusa e o resultado é
   descartado. Conflito de concorrência com a API: relê e grava de novo.

Só `provisionar` e `revogar` chamam o conector. Outras ações são encerradas
como `semEfeito` (`ACAO_NAO_SUPORTADA_PELO_WORKER`), sem tocar o destino.

## Como rodar

```sh
pnpm --filter @gia/persistencia migrar          # GIA_DATABASE_URL
GIA_DATABASE_URL=postgres://... pnpm --filter @gia/worker start
```

| Variável                  | Padrão                 |
| ------------------------- | ---------------------- |
| `GIA_DATABASE_URL`        | obrigatória            |
| `GIA_WORKER_ID`           | `worker-<host>-<pid>`  |
| `GIA_WORKER_INTERVALO_MS` | `1000` (fila vazia)    |
| `GIA_ESCRITA_EXTERNA`     | `false` (único aceito) |

Com a escrita externa desligada, os conectores são os simulados de
`@gia/conectores`. `SIGINT`/`SIGTERM` encerram depois do lote em andamento.
O log traz só contagens, nunca dados pessoais ou parâmetros.

## Testes

`pnpm test` com `GIA_DATABASE_URL_TESTE` (PostgreSQL real; ver
`packages/persistencia/README.md`). Cobrem execução, dependência AD → M365,
falha transitória com backoff e retomada da etapa, falha definitiva,
reconciliação, exceção do conector, conflito ao gravar, workers concorrentes,
renovação e perda de lease e queda do worker antes de gravar.
