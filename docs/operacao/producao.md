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
| `GIA_<SISTEMA>_MODO`              | API e worker | `simulado`        | `real` liga o conector do sistema (`ad`, `m365`, `docusign`, `softexpert`, `jira`) |
| `GIA_OIDC_*`                      | API          | —                 | login Entra ID; obrigatório em `producao` ([guia](login-entra-id.md)) |
| `GIA_AUTH_SIMULADA`               | API          | `false`           | só em `teste` declarado; recusado em `producao`                    |

Regras aplicadas no arranque (o erro cita só nomes de variáveis):

- **Segredos fora do ambiente (regra 12):** em `producao`, qualquer
  `GIA_*SENHA*`, `*TOKEN*`, `*SECRET*`, `*CHAVE*`… passado por valor, ou URL
  com `usuario:senha@`, impede a subida. Use `<NOME>_ARQUIVO` montado pelo
  cofre. Fora de produção, a API registra o aviso `segredo_no_ambiente`.
- **Produção e escrita real exigem PostgreSQL:** a memória do processo perderia
  a fila e os eventos de auditoria num reinício.
- **Login:** em `producao` a API só sobe com o OIDC completo (`GIA_OIDC_*`) e
  recusa `GIA_AUTH_SIMULADA`. O login simulado só existe com `GIA_AMBIENTE`
  **declarado** como `desenvolvimento` (ou `teste` com `GIA_AUTH_SIMULADA=true`):
  sem a variável, a API sobe sem login nenhum (`/sessao/modo` = `indisponivel`),
  nunca com a sessão simulada.
- **Privilégio mínimo da API:** a API só consulta o diretório (AD + M365) e a
  origem Jira. Ela valida a configuração de todo conector selecionado, mas só
  abre os segredos dessas leituras; a chave do DocuSign e a credencial do
  SoftExpert ficam só no worker e não precisam ser montadas na API.

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
   (`GIA_DATABASE_URL_ARQUIVO` em produção; URL com senha por valor é recusada,
   como na API e no worker). As migrações são aditivas; para desfazer
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

Os conectores têm homologação somente leitura própria, em `@gia/conectores`:
`ad:verificar`, `m365:verificar`, `docusign:verificar` e `softexpert:verificar`.
O worker tem `smoke:integracoes` (conexão de cada conector real, sem escrita)
e `preflight` (DEV-289, evidência sanitizada; ver
[dev-289-preflight.md](dev-289-preflight.md)).

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

O que já existe no código (Sprint 1, ver
[integração DEV-291](../integracao/sprint1-dev291.md)): login Entra ID/OIDC na
API e na UI (DEV-288/DEV-290) e conectores reais de AD, M365, DocuSign,
SoftExpert e Jira compostos no worker por `criarIntegracoesDoAmbiente`
(DEV-287), cada um atrás de `GIA_<SISTEMA>_MODO=real` e dos gates de escrita.
Nada disso foi validado em ambiente real. Continua bloqueando produção:

- **Validação real** de cada conector e do login com tenant e contas de
  serviço reais (o preflight hoje sai `producaoPronta: false`), e da
  infraestrutura: cofre montando os arquivos, scraping das métricas, sondas no
  orquestrador.
- **Sessões em memória:** a API não pode rodar em mais de uma instância.
- **Mesma credencial para ler e escrever:** a API usa as contas de serviço do
  AD, M365 e Jira também usadas pelo worker para escrever; contas só de leitura
  para a API ainda não existem.
- **SoftExpert:** `softexpert:revogar` exige `GIA_SOFTEXPERT_REVOGACAO_CONFERIDA=true`,
  que só deve ser ligado depois de conferir o `disableUser` no serviço real.
- **Decisões de produto pendentes:** entrega da senha inicial e planos
  alternativos de licença M365.
- **UI:** a faixa "Ambiente com dados de exemplo" é fixa.
- **Itens médios da revisão do PR #25** (autorização OIDC por nome de grupo,
  prazos de AD/HTTP/DocuSign, TLS, `/saude/pronta`, limites e testes do OIDC):
  ver [pendencias-medias-sprint1.md](pendencias-medias-sprint1.md).
