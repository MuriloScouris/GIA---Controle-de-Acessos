# Operação em produção — runbook (DEV-280)

Este runbook descreve como subir, observar, liberar escrita e voltar atrás com
a API e o worker do GIA. **Produção não está pronta**: veja
[Pendências para produção](#pendências-para-produção) antes de qualquer
liberação.

## Configuração por ambiente

| Variável                          | Serviço      | Padrão            | Observação                                                         |
| --------------------------------- | ------------ | ----------------- | ------------------------------------------------------------------ |
| `GIA_AMBIENTE`                    | API e worker | `desenvolvimento` | `desenvolvimento`, `teste` ou `producao`                           |
| `GIA_DATABASE_URL_ARQUIVO`        | API e worker | —                 | caminho do arquivo do cofre com a URL do PostgreSQL                |
| `GIA_DATABASE_URL`                | API e worker | —                 | só sem senha; em produção prefira o `_ARQUIVO`                     |
| `GIA_ESCRITA_EXTERNA`             | API e worker | `false`           | chave mestra; nunca aceita em `desenvolvimento`                    |
| `GIA_ESCRITA_LIBERADA`            | API e worker | vazio             | `ad:criar,ad:revogar,...`; exige a chave mestra; sem curinga       |
| `GIA_VERSAO`                      | API          | `desconhecida`    | versão/commit do deploy, exposta na prontidão                      |
| `GIA_LOG_NIVEL`                   | API e worker | `info`            | `debug`, `info`, `aviso`, `erro`                                   |
| `GIA_METRICAS_PORTA`              | API          | desligado         | métricas Prometheus em `127.0.0.1:<porta>/metrics`                 |
| `GIA_WORKER_METRICAS_PORTA`       | worker       | desligado         | idem, para o worker                                                |
| `GIA_WORKER_ARQUIVO_SAUDE`        | worker       | desligado         | arquivo de batimento lido pela sonda                               |
| `GIA_WORKER_SAUDE_MAXIMO_MS`      | sonda        | `90000`           | idade máxima do batimento para considerar o worker vivo            |

Regras aplicadas no arranque (o erro cita só nomes de variáveis):

- **Segredos fora do ambiente (regra 12):** em `producao`, qualquer
  `GIA_*SENHA*`, `*TOKEN*`, `*SECRET*`, `*CHAVE*`… passado por valor, ou URL
  com `usuario:senha@`, impede a subida. Use `<NOME>_ARQUIVO` montado pelo
  cofre. Fora de produção, a API registra o aviso `segredo_no_ambiente`.
- **Produção e escrita real exigem PostgreSQL:** a memória do processo perderia
  a fila e os eventos de auditoria num reinício.
- O login simulado não existe em `producao`.

## Gates de escrita externa (regra 8)

A escrita real só acontece com **três** chaves, nesta ordem:

1. `GIA_ESCRITA_EXTERNA=true` (chave mestra) — as operações novas nascem `real`;
2. `GIA_ESCRITA_LIBERADA` contém o sistema e a operação (`ad:criar`) — a API
   recusa com `ESCRITA_NAO_LIBERADA` o que não estiver na lista;
3. o worker tem conector real para o sistema — sem ele, a operação sai
   `CONECTOR_REAL_INDISPONIVEL`, sem chamar nada (nunca cai no simulador).

O worker reconfere 1 e 2 antes de cada chamada: operação `real` já na fila
quando a chave foi desligada **não é executada** (`ESCRITA_NAO_LIBERADA`).
Conectores com flag própria (`GIA_DOCUSIGN_ESCRITA_HABILITADA`,
`GIA_JIRA_ESCRITA_HABILITADA`) continuam valendo como cadeado adicional.

Os mesmos valores de gate devem ir para a API e para o worker.

## Deploy

1. Aplicar migrações: `pnpm --filter @gia/persistencia migrar`
   (`GIA_DATABASE_URL` ou `_ARQUIVO`). As migrações são aditivas; para desfazer
   a última há `desfazerUltima` no migrador (só com aprovação, pode perder dado).
2. Subir a API e o worker com a **mesma** configuração de gates.
3. Rodar o smoke (abaixo). Falhou → rollback.

## Saúde

- **API, vivacidade:** `GET /saude` → `200 {"status":"ok"}`. Não consulta
  dependências: banco fora não reinicia a API.
- **API, prontidão:** `GET /saude/pronta` → `200` com `status: pronta` ou
  `503` com as verificações em `falha`. Mostra também `versao` e o estado da
  escrita (`modo`, `liberadas`) para conferência.
- **Worker:** `pnpm --filter @gia/worker saude` (exec probe) → sai 0 se o
  último lote (ou falha tratada) tem até `GIA_WORKER_SAUDE_MAXIMO_MS`.

## Logs e auditoria operacional

Uma linha JSON por evento (`instante`, `nivel`, `servico`, `ambiente`,
`evento`, campos). Valores passam por sanitização: tokens, senhas, CPF e
e-mail são mascarados, e campos como `login`, `nome`, `email` e `cpf` nunca
são registrados.

| Evento                  | Serviço | Quando                                                        |
| ----------------------- | ------- | ------------------------------------------------------------- |
| `api_configurada`       | API     | partida: versão, modo de execução, gates, persistência        |
| `worker_iniciado`       | worker  | partida: gates, conectores reais, métricas, batimento         |
| `http_requisicao`       | API     | cada requisição (exceto sondas): `correlacaoId`, rota declarada, status, duração |
| `erro_interno`          | API     | 5xx: `correlacaoId` e só o tipo do erro                       |
| `prontidao_falhou`      | API     | prontidão com dependência em falha                            |
| `gate_escrita`          | worker  | decisão do gate por operação real (`liberada`/`bloqueada`/`semConectorReal`) |
| `operacao_registrada`   | worker  | resultado gravado: `operacaoId`, `pedidoId`, `itemId`, sistema, efeito, código |
| `lote_falhou`           | worker  | lote com erro (tipo do erro)                                  |

**Correlação:** toda resposta da API leva `x-correlacao-id` (gerado pela API;
o do cliente é ignorado). O mesmo ID vai para o log e para os eventos de
auditoria do pedido; o worker correlaciona pelo `operacaoId`/`pedidoId`.

## Métricas (Prometheus)

Servidas só na porta interna (`127.0.0.1`), nunca na porta pública da API.

- API: `gia_api_requisicoes_total{metodo,rota,status}`,
  `gia_api_duracao_ms` (histograma), `gia_api_erros_internos_total{rota}`,
  `gia_escrita_externa_ligada`, `gia_escrita_liberada{liberacao}`.
- Worker: `gia_worker_lotes_total{resultado}`,
  `gia_worker_operacoes_total{sistema,acao,modo,desfecho,efeito}`,
  `gia_worker_leases_recuperados_total{destino}`,
  `gia_worker_gate_escrita_total{sistema,tipo,decisao}`,
  `gia_worker_ultimo_lote_timestamp_segundos`.

Alertas sugeridos: prontidão em 503; `gia_api_erros_internos_total` subindo;
`time() - gia_worker_ultimo_lote_timestamp_segundos > 90`;
`gia_worker_gate_escrita_total{decisao!="liberada"}` subindo (operações reais
barradas); `gia_escrita_externa_ligada == 1` fora de janela autorizada.

## Smoke test pós-deploy (somente leitura)

```sh
GIA_SMOKE_URL=https://gia.interno \
GIA_SMOKE_MODO_ESPERADO=simulado \
GIA_SMOKE_METRICAS_URL=http://127.0.0.1:9100/metrics \
GIA_AMBIENTE=producao \
pnpm --filter @gia/api smoke
```

Confere vivacidade, prontidão (e o modo de escrita esperado), cabeçalhos de
segurança e correlação, que dados exigem sessão, que o login simulado não
existe em produção e as métricas. Sai 1 se algo falhar.

Os conectores têm homologação somente leitura própria:
`pnpm --filter @gia/conectores ad:verificar` (PR #12) e
`softexpert:verificar` (PR #14).

## Rollback

1. **Escrita real (imediato, sem novo deploy):** `GIA_ESCRITA_EXTERNA=false`
   (ou remover o sistema de `GIA_ESCRITA_LIBERADA`) e reiniciar **API e
   worker**. Operações novas nascem simuladas; as reais já na fila saem
   `ESCRITA_NAO_LIBERADA` sem chamar o destino. O que já foi escrito no
   destino não é desfeito: confira pelos eventos e reconcilie.
2. **Versão:** voltar a imagem anterior da API e do worker com a mesma
   configuração. As migrações atuais são compatíveis com a versão anterior
   (só adicionam); não rode `desfazerUltima` sem aprovação.
3. Rodar o smoke de novo e conferir `/saude/pronta` e o evento de partida
   (`api_configurada`/`worker_iniciado`) com os gates esperados.

## Pendências para produção

- **Login real (OIDC/Entra ID) não existe:** em `producao` não há login
  simulado, então a API sobe, responde saúde e smoke, mas ninguém consegue
  operar. Bloqueia o uso em produção.
- **Nenhum conector real está registrado no worker** (`apps/worker/src/reais.ts`):
  os PRs #12 (AD), #13 (DocuSign), #14 (SoftExpert) e #15 (Jira) precisam
  registrar o seu ali ao entrar na `main`.
- **Validação real** de cada sistema de destino e da infraestrutura
  (cofre montando os arquivos, scraping das métricas, sondas no orquestrador)
  ainda não foi feita em ambiente de produção.
- `GIA_JIRA_API_TOKEN` (PR #15) é segredo por valor: em `producao` passa a ser
  recusado; o PR precisa adotar `GIA_JIRA_API_TOKEN_ARQUIVO`.
