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
| M3 | Prazo HTTP | `criarFetchComPrazo` chama `exigirPrazo()` depois da resposta. Uma resposta 2xx que chega no vencimento é descartada como timeout, mas a escrita pode ter ocorrido no destino. | `packages/conectores/src/prazo.ts:29` | Não descartar uma resposta já recebida, ou classificar o resultado como efeito desconhecido para reconciliação, nunca como falha limpa. | corrigido (PR #30) |
| M4 | Conector AD / LDAP | O timeout das operações LDAP não fica limitado pelo prazo restante do motor: usa o `timeoutOperacaoMs` fixo. | `packages/conectores/src/transportes/ldap.ts:178` | Usar o mínimo entre `timeoutOperacaoMs` e o prazo restante, como o HTTP. | corrigido (DEV-297, PR #32): ver [M4 — como foi corrigido](#m4--como-foi-corrigido-dev-297) |
| M5 | Conector DocuSign | Regressão de timeout na composição: o DocuSign recebe `limitar(...)` sobre o padrão de 20 s. Isso pode divergir dos timeouts próprios do cliente do #19. | `packages/conectores/src/composicao.ts:126-129` | Unificar a política de timeout do DocuSign com o cliente do #19 e cobrir com teste. | corrigido (PR #28) |
| M6 | TLS | `NODE_TLS_REJECT_UNAUTHORIZED=0` só é barrado no preflight. A API e o worker sobem normalmente com a verificação TLS desligada. | `apps/worker/src/preflight/preflight.ts:307` | Recusar a subida da API e do worker em `producao` com essa variável; idealmente, avisar em qualquer ambiente. | corrigido (DEV-299, PR #29; commits `14093f4`, `d4022a8` e `c1c5867`): `exigirTlsVerificado` (`packages/contratos/src/tls.ts`) recusa em `producao` a subida da API, do worker e do `smoke:integracoes`, antes de ler o cofre. Fora de produção, a API e o worker registram o aviso `tls_verificacao_desligada`, e o smoke o traz em `avisos` sem dar `validado`. Testes: `packages/contratos/src/tls.test.ts`, `apps/api/src/producao.test.ts`, `apps/api/src/arranque-integracoes.test.ts` (ordem antes do cofre) e `apps/worker/src/index.test.ts` |
| M7 | Observabilidade | `/saude/pronta` é pública e expõe detalhes operacionais (versão, modo e liberações de escrita). | `apps/api/src/http/observabilidade.ts:85` | Na porta pública, responder só o status; mover os detalhes para a porta interna de métricas ou exigir autenticação. | corrigido (DEV-300, PR #31; commits `5a5e6dc` e `8cd6c07`): a porta pública responde só `{ status }` (`prontidaoPublicaRespostaSchema`), com ou sem sessão; ambiente, versão, verificações e gates de escrita saem só na porta interna (`GIA_METRICAS_PORTA`, loopback), em `/saude/pronta`. O smoke e o preflight leem o detalhe ali (`GIA_SMOKE_METRICAS_URL`, `GIA_PREFLIGHT_API_INTERNA_URL`). Testes: `apps/api/src/producao.test.ts`, `apps/api/src/smoke.test.ts`, `apps/api/src/arranque-integracoes.test.ts`, `apps/worker/src/preflight/preflight.test.ts` |
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

### M5 — como foi corrigido (DEV-298)

- **Causa:** a composição reescrevia `GIA_DOCUSIGN_TIMEOUT_MS` com `limitar(...)` antes de o cliente
  validar. Valores que o cliente isolado recusa (acima de 25000, `1e3`, com espaço) eram aceitos e
  reduzidos em silêncio; além disso, um prazo do motor vencido antes do prazo próprio do cliente
  virava `respostaPerdida` em vez de `timeout`.
- **Correção:** o ambiente é validado como no fluxo isolado e o prazo do motor entra só como teto
  (`carregarConfiguracaoDocusign(env, { prazoMaximoMs })`); a montagem do conector é única
  (`montarConectorDocusign`); prazo vencido é sempre `timeout`. Política descrita em
  [`DOCUSIGN.md`](../../packages/conectores/DOCUSIGN.md#política-única-de-timeout-m5).
- **Testes:** `packages/conectores/src/docusign/cliente.test.ts` (política única e `TimeoutError`) e
  `packages/conectores/src/composicao.test.ts` (prazo do motor com o padrão de 20 s, timeout menor
  que o do motor, valores inválidos recusados, M365 sem regressão).
- **Efeito operacional:** quem tinha `GIA_DOCUSIGN_TIMEOUT_MS` acima de 25000 passa a falhar na
  subida (já era inválido na documentação). M365/SoftExpert não mudam.

### M3 — como foi corrigido (DEV-296)

- **Causa:** `criarFetchComPrazo` conferia o prazo depois da resposta e a descartava com um
  `timeout` genérico (`INTEGRACAO_TIMEOUT`), sem cancelar o corpo. Numa escrita o destino já tinha
  respondido (2xx) e podia ter agido; o registro dizia apenas "tempo esgotado".
- **Correção (`packages/conectores/src/prazo.ts`):** a resposta recebida depois do prazo continua
  sendo descartada (nenhuma etapa nova começa depois do prazo do motor), mas agora:
  - **escrita** (POST/PUT/PATCH/DELETE e qualquer método fora de GET/HEAD/OPTIONS) vira
    `respostaPerdida` com o código `INTEGRACAO_RESPOSTA_APOS_PRAZO`: efeito **desconhecido**, segue
    para reconciliação e nunca vira `semEfeito`;
  - **leitura** continua `timeout` (`INTEGRACAO_TIMEOUT`), que não altera nada no destino;
  - em ambos os casos o corpo da resposta é cancelado, sem deixar a conexão presa.
  Os tipos de `ErroFornecedor` e o mapeamento do motor (`timeout`/`respostaPerdida` →
  `desconhecido`) não mudaram; os clientes que repetem leituras tratam os dois tipos igualmente.
- **Testes:** `packages/conectores/src/prazo.test.ts` (resposta antes e depois do prazo, por método,
  `Request`, prazo já vencido sem envio, corpo cancelado) e `docusign/cliente.test.ts` (criação com
  2xx tardio vira `desconhecido`; com a resposta no prazo, `confirmado`).
- **Fora de escopo:** M4 (prazo LDAP), corrigido depois na DEV-297.

### M4 — como foi corrigido (DEV-297)

- **Causa:** `criarAbridorLdapts` criava o `Client` do ldapts com o `timeoutOperacaoMs` fixo. Uma
  busca ou escrita iniciada perto do fim do prazo do motor ainda podia esperar o timeout inteiro
  (até 120 s pela configuração), passando do deadline. A conferência `exigirPrazo()` só barrava
  o início da operação.
- **Correção (`packages/conectores/src/prazo.ts` e `transportes/ldap.ts`):** `limitarAoPrazo(ms)`
  devolve o menor entre o timeout próprio e o prazo restante (inteiro, nunca abaixo de 1) e lança
  `timeout` (`INTEGRACAO_TIMEOUT`) sem enviar nada se o prazo já venceu. O ldapts lê `timeout` do
  mesmo objeto de opções a cada requisição, então o transporte o reajusta antes de **cada**
  operação (bind, busca, inclusão, alteração e renomeação) e o `connectTimeout` também é limitado
  ao prazo. Fora de `dentroDoPrazo` vale só o `timeoutOperacaoMs`, como antes.
- **Limite conhecido:** a conexão e o bind são duas fases do ldapts, cada uma limitada ao prazo
  restante na abertura; o tempo somado das duas pode passar do prazo por, no máximo, um
  `connectTimeout`. As operações depois do bind não têm essa folga.
- **Testes:** `packages/conectores/src/transportes/ldap.test.ts` (prazo restante menor, maior,
  igual e expirado, por operação; expirado antes da sessão e durante a leitura da senha; e um
  contrato com o ldapts real, num servidor local, que prova que o timeout alterado depois do bind
  vale) e `packages/conectores/src/prazo.test.ts` (`limitarAoPrazo`).
- **Fora de escopo:** os demais conectores não mudam; nenhuma escrita externa foi habilitada.
