# Pendências MÉDIAS da Sprint 1 (revisão do PR #25)

Itens de severidade **média** apontados na 1ª rodada de revisão do PR #25
(DEV-291, integração da Sprint 1). Por decisão da revisão, **não bloqueiam o
merge técnico** do #25, mas ficam registrados aqui com status explícito. Todos
**bloqueiam a liberação em produção** até serem corrigidos ou aceitos
formalmente, e cada um vira issue própria no Linear (Maestro).

Status possíveis: `pendente` → `em correção` → `corrigido (PR #n)` ou
`risco aceito (quem, quando)`. As referências de linha são do branch
`dev-291-integracao-sprint1` na 2ª rodada de revisão.

| # | Área | Item | Referência | Correção sugerida | Status |
| --- | --- | --- | --- | --- | --- |
| M1 | OIDC / autorização | Papel derivado do **nome** do grupo/role. Sem entrada no mapa, um valor igual ao nome de um papel (`administrador`, `revisor`...) vira papel do GIA. Quem cria um grupo ou app role com esse nome no tenant ganha o papel. | `apps/api/src/sessao/oidc.ts:174` (`papeisDoToken`) | Aceitar só o que estiver em `GIA_OIDC_MAPA_PAPEIS` (por object ID do grupo); remover o fallback por nome. | pendente |
| M2 | Conector AD | O provisionamento do AD não registra `progressoConfirmado` entre etapas. Uma retomada depois de falha parcial (criar → senha → habilitar → grupos) não sabe em que etapa parou. | `packages/conectores/src/adaptadores/ad.ts:145` | Confirmar o progresso por etapa, como os demais conectores, e testar a retomada no meio da sequência. | pendente |
| M3 | Prazo HTTP | `criarFetchComPrazo` chama `exigirPrazo()` depois da resposta. Uma resposta 2xx que chega no vencimento é descartada como timeout, mas a escrita pode ter ocorrido no destino. | `packages/conectores/src/prazo.ts:29` | Não descartar uma resposta já recebida, ou classificar o resultado como efeito desconhecido para reconciliação, nunca como falha limpa. | pendente |
| M4 | Conector AD / LDAP | O timeout das operações LDAP não fica limitado pelo prazo restante do motor: usa o `timeoutOperacaoMs` fixo. | `packages/conectores/src/transportes/ldap.ts:178` | Usar o mínimo entre `timeoutOperacaoMs` e o prazo restante, como o HTTP. | pendente |
| M5 | Conector DocuSign | Regressão de timeout na composição: o DocuSign recebe `limitar(...)` sobre o padrão de 20 s. Isso pode divergir dos timeouts próprios do cliente do #19. | `packages/conectores/src/composicao.ts:126-129` | Unificar a política de timeout do DocuSign com o cliente do #19 e cobrir com teste. | pendente |
| M6 | TLS | `NODE_TLS_REJECT_UNAUTHORIZED=0` só é barrado no preflight. A API e o worker sobem normalmente com a verificação TLS desligada. | `apps/worker/src/preflight/preflight.ts:307` | Recusar a subida da API e do worker em `producao` com essa variável; idealmente, avisar em qualquer ambiente. | pendente |
| M7 | Observabilidade | `/saude/pronta` é pública e expõe detalhes operacionais (versão, modo e liberações de escrita). | `apps/api/src/http/observabilidade.ts:85` | Na porta pública, responder só o status; mover os detalhes para a porta interna de métricas ou exigir autenticação. | pendente |
| M8 | OIDC | `/sessao/oidc/entrar` não tem teto de requisições. Cada chamada cria um estado pendente (state/nonce/PKCE) em memória, o que permite abuso e consumo de memória. | `apps/api/src/http/rotas-oidc.ts` | Limitar a taxa por origem e o total de estados pendentes, com expiração curta. | pendente |
| M9 | OIDC / testes | Faltam testes negativos de token: `nonce` trocado, `aud` errado, `iss` errado, `tid` de outro tenant e `exp` vencido. | `apps/api/src/oidc.test.ts` | Um teste por claim inválida, cada um esperando `LOGIN_TOKEN_INVALIDO` e nenhuma sessão aberta. | pendente |
| M10 | E2E | O E2E (Playwright e `tests/e2e`) só roda com a sessão simulada. O caminho OIDC não é exercitado de ponta a ponta. | `tests/e2e/apoio.ts`, `tests/browser/` | Criar um E2E com provedor OIDC falso local (emissor, JWKS e authorize), cobrindo login, acesso negado e logout. | pendente |

## Como atualizar

Ao corrigir um item, troque o status para `corrigido (PR #n)` no mesmo PR da
correção e cite o teste que cobre o caso. Risco aceito exige o nome de quem
aceitou e a data, registrados na DEV correspondente do Linear.

Os bloqueios de produção que não dependem de código, como validação real,
sessões em memória e decisões de produto, estão em
[`producao.md`](producao.md#pendências-para-produção) e na
[matriz de prontidão](dev-292-prontidao.md).
