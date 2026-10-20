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
| M1 | OIDC / autorização | Papel derivado do **nome** do grupo/role. Sem entrada no mapa, um valor igual ao nome de um papel (`administrador`, `revisor`...) vira papel do GIA. Quem cria um grupo ou app role com esse nome no tenant ganha o papel. | `apps/api/src/sessao/oidc.ts:174` (`papeisDoToken`) | Aceitar só o que estiver em `GIA_OIDC_MAPA_PAPEIS` (por object ID do grupo); remover o fallback por nome. | corrigido (DEV-294, PR #33): `papeisDoToken` só lê object IDs da claim `groups` mapeados em `GIA_OIDC_MAPA_PAPEIS`. A claim `roles`, nomes de grupo e textos iguais ao nome de um papel são ignorados, e grupo não mapeado não dá papel. O mapa só aceita chave GUID e papel humano (nunca `servicoExecutor`); fora disso a API não sobe. Testes: `apps/api/src/oidc.test.ts` (configuração do mapa, papéis do token e login negado com app role ou grupo não mapeado) |
| M2 | Conector AD | O provisionamento do AD não registra `progressoConfirmado` entre etapas. Uma retomada depois de falha parcial (criar → senha → habilitar → grupos) não sabe em que etapa parou. | `packages/conectores/src/adaptadores/ad.ts:145` | Confirmar o progresso por etapa, como os demais conectores, e testar a retomada no meio da sequência. | corrigido (DEV-295, PR #35): a etapa comprovada de cada resultado já é gravada em `etapaAlcancada`, e a retomada começa na etapa seguinte. `adicionarGrupos` passou a marcar `progressoConfirmado` quando um grupo falha depois de outro ter entrado (`parcial`, não `semEfeito`) e a não repetir grupos na mesma chamada. Testes de retomada em cada fronteira (criar, senha, habilitar, primeiro e segundo grupo) em `packages/conectores/src/adaptadores/ad.test.ts` e no worker sobre PostgreSQL em `apps/worker/src/executor.test.ts` |
| M3 | Prazo HTTP | `criarFetchComPrazo` chama `exigirPrazo()` depois da resposta. Uma resposta 2xx que chega no vencimento é descartada como timeout, mas a escrita pode ter ocorrido no destino. | `packages/conectores/src/prazo.ts:29` | Não descartar uma resposta já recebida, ou classificar o resultado como efeito desconhecido para reconciliação, nunca como falha limpa. | corrigido (PR #30) |
| M4 | Conector AD / LDAP | O timeout das operações LDAP não fica limitado pelo prazo restante do motor: usa o `timeoutOperacaoMs` fixo. | `packages/conectores/src/transportes/ldap.ts:178` | Usar o mínimo entre `timeoutOperacaoMs` e o prazo restante, como o HTTP. | corrigido (DEV-297, PR #32): ver [M4 — como foi corrigido](#m4--como-foi-corrigido-dev-297) |
| M5 | Conector DocuSign | Regressão de timeout na composição: o DocuSign recebe `limitar(...)` sobre o padrão de 20 s. Isso pode divergir dos timeouts próprios do cliente do #19. | `packages/conectores/src/composicao.ts:126-129` | Unificar a política de timeout do DocuSign com o cliente do #19 e cobrir com teste. | corrigido (PR #28) |
| M6 | TLS | `NODE_TLS_REJECT_UNAUTHORIZED=0` só é barrado no preflight. A API e o worker sobem normalmente com a verificação TLS desligada. | `apps/worker/src/preflight/preflight.ts:307` | Recusar a subida da API e do worker em `producao` com essa variável; idealmente, avisar em qualquer ambiente. | corrigido (DEV-299, PR #29; commits `14093f4`, `d4022a8` e `c1c5867`): `exigirTlsVerificado` (`packages/contratos/src/tls.ts`) recusa em `producao` a subida da API, do worker e do `smoke:integracoes`, antes de ler o cofre. Fora de produção, a API e o worker registram o aviso `tls_verificacao_desligada`, e o smoke o traz em `avisos` sem dar `validado`. Testes: `packages/contratos/src/tls.test.ts`, `apps/api/src/producao.test.ts`, `apps/api/src/arranque-integracoes.test.ts` (ordem antes do cofre) e `apps/worker/src/index.test.ts` |
| M7 | Observabilidade | `/saude/pronta` é pública e expõe detalhes operacionais (versão, modo e liberações de escrita). | `apps/api/src/http/observabilidade.ts:85` | Na porta pública, responder só o status; mover os detalhes para a porta interna de métricas ou exigir autenticação. | corrigido (DEV-300, PR #31; commits `5a5e6dc` e `8cd6c07`): a porta pública responde só `{ status }` (`prontidaoPublicaRespostaSchema`), com ou sem sessão; ambiente, versão, verificações e gates de escrita saem só na porta interna (`GIA_METRICAS_PORTA`, loopback), em `/saude/pronta`. O smoke e o preflight leem o detalhe ali (`GIA_SMOKE_METRICAS_URL`, `GIA_PREFLIGHT_API_INTERNA_URL`). Testes: `apps/api/src/producao.test.ts`, `apps/api/src/smoke.test.ts`, `apps/api/src/arranque-integracoes.test.ts`, `apps/worker/src/preflight/preflight.test.ts` |
| M8 | OIDC | `/sessao/oidc/entrar` não tem teto de requisições. Cada chamada cria um estado pendente (state/nonce/PKCE) em memória, o que permite abuso e consumo de memória. | `apps/api/src/http/rotas-oidc.ts` | Limitar a taxa por origem e o total de estados pendentes, com expiração curta. | corrigido (DEV-301, PR #34): ver [M8 — como foi corrigido](#m8--como-foi-corrigido-dev-301) |
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
  `timeout` (`INTEGRACAO_TIMEOUT`) sem enviar nada se o prazo já venceu. O ldapts lê `timeout` e
  `connectTimeout` do mesmo objeto de opções, então o transporte os reajusta a cada etapa: na
  abertura (depois de ler a senha), no bind e antes de **cada** operação (busca, inclusão,
  alteração e renomeação). Fora de `dentroDoPrazo` vale só o `timeoutOperacaoMs`, como antes.
- **Sem reconexão implícita (revisão do PR #32):** o ldapts reconecta sozinho quando o socket caiu,
  antes de enviar, e o prazo da operação só começa a contar depois disso. Por isso cada operação
  confere, no mesmo instante em que chama o ldapts (sem `await` no meio), o prazo e se a sessão
  ainda está conectada e autenticada (`isBound`). Se o socket caiu, a operação falha com
  `conexaoRecusada` / `AD_CONEXAO_PERDIDA` sem enviar nada e sem reconectar (cada sessão faz no
  máximo uma escrita, então nada foi feito para aquela operação); o worker decide se refaz. O
  `autoRebind` do ldapts fica desligado.
- **O que é garantido:** busca, inclusão, alteração e renomeação **nunca são enviadas depois do
  prazo do motor**, nem por reconexão, e a espera da resposta é limitada ao prazo restante no
  momento do envio. Uma operação já enviada que não responde a tempo vira `timeout` (o AD pode ter
  agido: efeito desconhecido, segue para reconciliação).
- **O que não é garantido:** a abertura da sessão (conexão e bind) usa o prazo restante de quando
  começa, mas o ldapts só envia o bind depois de conectar, e a espera da resposta do bind começa
  nesse momento; ela pode passar do prazo por até o tempo gasto conectando. O bind só autentica,
  não altera o AD. Os limites também valem na precisão dos timers do Node (milissegundos, sujeitos
  ao atraso do laço de eventos): é um teto de espera, não um relógio de tempo real.
- **Testes:** `packages/conectores/src/transportes/ldap.test.ts` (prazo restante menor, maior,
  igual e expirado, por operação; expirado antes da sessão e durante a leitura da senha; sessão sem
  conexão sem enviar; e um contrato com o ldapts real, num servidor local, que prova que o timeout
  alterado depois do bind vale), `packages/conectores/src/transportes/ldap.reconexao.test.ts`
  (LDAPS local com certificado verificado: o socket cai depois do bind e a reconexão é lenta, com
  zero escrita recebida pelo servidor e nenhuma reconexão; também com prazo de sobra, por operação)
  e `packages/conectores/src/prazo.test.ts` (`limitarAoPrazo`). O certificado do teste é gerado na
  hora com o `openssl` do ambiente; sem ele o teste é pulado fora do CI e falha no CI.
- **Fora de escopo:** os demais conectores não mudam; nenhuma escrita externa foi habilitada.

### M8 — como foi corrigido (DEV-301)

- **Causa:** `GET /sessao/oidc/entrar` é público e cada chamada guardava um login pendente
  (state, nonce e verificador PKCE) por 10 minutos. Só havia um teto global de 5000 estados:
  nenhum limite por origem nem de taxa, então uma origem esgotava a lista e deixava todo mundo sem
  login, e a limpeza varria a lista inteira a cada requisição.
- **Correção (`apps/api/src/sessao/logins-pendentes.ts`, usado por `http/rotas-oidc.ts`):**
  - **Taxa por origem:** no máximo 30 inícios de login por minuto. A tentativa recusada também
    conta, então quem insiste continua barrado até parar por uma janela inteira.
  - **Estados por origem:** no máximo 100 pendentes de uma mesma origem, dentro do teto global de
    5000. A tabela de origens contadas também tem teto (10.000), para não virar o novo alvo.
  - **Expiração curta:** 5 minutos (antes 10), também no `Max-Age` do cookie `gia_oidc_estado`. O
    estado vencido nunca é devolvido: o retorno vira `LOGIN_ESTADO_INVALIDO` sem trocar o código.
  - **Limpeza:** os estados ficam em ordem de vencimento, então a varredura para no primeiro que
    ainda vale (custo proporcional ao que venceu); consumir um estado ou ele vencer libera a vaga
    da origem; origens sem início recente são esquecidas uma vez por janela.
  - **Origem:** o IP da conexão (IPv4 inteiro; IPv6 pelo prefixo /64; IPv4 mapeado vira IPv4; sem
    IP legível, todos dividem uma origem só).
  - **Recusa sem vazar detalhe:** o limite por origem e o teto de capacidade respondem
    igualmente `303` para `/login?erro=LOGIN_INDISPONIVEL`, sem estado novo, sem corpo e sem
    cabeçalho de limite ou contagem. A auditoria recebe só `login_recusado` com `LOGIN_LIMITE_ORIGEM`
    ou `LOGIN_LIMITE_CAPACIDADE`, nunca o IP.
- **Origem atrás de proxy (`GIA_API_PROXY_CONFIAVEL`):** a API escuta em `127.0.0.1`, então, atrás
  de um proxy reverso, o IP da conexão é o do proxy e todos os usuários dividiriam a mesma origem
  (o limite por origem viraria um limite global, folgado de propósito para isso). Para limitar por
  cliente, informe os proxies em quem a API confia, por exemplo `GIA_API_PROXY_CONFIAVEL=127.0.0.1`
  (IPs ou CIDRs). A lista é validada na partida, e também ao montar a API, e recusa redes largas
  demais: IPv4 abaixo de `/8`, IPv6 abaixo de `/16`, `/0`, nomes, palavras-chave e zona (`%`).
  **IPv4 mapeado em IPv6** (`::ffff:a.b.c.d/N`) é normalizado para IPv4 antes de validar, porque o
  Fastify o compara como a rede IPv4 equivalente: o prefixo que vale é `N - 96`, então
  `::ffff:0.0.0.0/96` (o `0.0.0.0/0`, que faria qualquer cliente escolher a própria origem pelo
  `X-Forwarded-For`) é recusado, e `::ffff:10.0.0.0/104` vira `10.0.0.0/8`. Rede IPv6 que contém
  todo o bloco mapeado (`::/16`, `::/64`...) também é recusada. O `X-Forwarded-For`
  só vale quando a conexão vem desses endereços; sem a variável ele é ignorado, porque qualquer
  cliente poderia forjá-lo. Uma contagem de saltos não serve: o Fastify a trata como "não confiar
  em ninguém".
- **Limite conhecido:** os estados continuam em memória do processo, como as sessões (ver
  [`producao.md`](producao.md#pendências-para-produção)): um reinício derruba os logins em curso,
  que recomeçam no `/login`. Os limites são por processo. A recusa por abuso não gera alerta
  próprio; a auditoria registra cada uma.
- **Testes:** `apps/api/src/sessao/logins-pendentes.test.ts` (taxa, estados por origem, total,
  tabela de origens, expiração no instante exato, uso único, limpeza e `origemDe`),
  `apps/api/src/oidc.test.ts` ("limite de logins pendentes", pelo HTTP: recusa idêntica sem IP,
  vaga devolvida quando um login conclui, expiração de 5 minutos, varredura sem retorno,
  `X-Forwarded-For` ignorado e aceito só do proxy confiável, IPv6 /64 e o uso normal intacto) e
  `apps/api/src/producao.test.ts` (validação de `GIA_API_PROXY_CONFIAVEL`, inclusive o IPv4
  mapeado e a normalização; revisão do PR #34) e, pelo HTTP, o bloco "CIDR IPv4 mapeado em IPv6"
  de `oidc.test.ts` (31 inícios variando o `X-Forwarded-For`: 30 aceitos e 1 recusa com proxy
  restrito, e o `::ffff:0.0.0.0/96` nem sobe).
- **Fora de escopo:** o mapeamento de papéis (M1) não mudou; nenhuma escrita externa foi habilitada.
