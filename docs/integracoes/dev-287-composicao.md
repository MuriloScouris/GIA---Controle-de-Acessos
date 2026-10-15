# DEV-287 — Composição real e habilitação controlada

Implementação verificável em ambiente isolado; **produção não validada**.
Nenhum segredo corporativo foi obtido, nenhum usuário real foi alterado e nenhum deploy foi feito.

## Escopo e fronteiras

O domínio decide quem pode solicitar cada operação. API grava intenção; worker consome a fila,
aplica novamente os gates e escolhe o transporte pelo modo persistido na operação.
`packages/conectores/src/composicao.ts` monta AD LDAPS, Graph v1.0, DocuSign eSignature,
SoftExpert SOAP e Jira Cloud. Montagem não faz rede nem libera escrita.

API valida as mesmas configurações antes de ouvir a porta. Usa Jira real como origem e,
quando AD e M365 estão ambos reais, uma porta somente leitura para colisões de identidade.
Falha do diretório propaga indisponibilidade; não vira identidade livre. Graph não comprova
CPF do titular: existência no Entra é conflito conservador com CPF desconhecido.
Com escrita ligada ou em produção, origem/diretório ausentes não recebem dados fictícios como fallback.
Os clientes de escrita são usados pelo worker; a API não provisiona diretamente.

## Seleção e cadeados

| Variável              | Valores            | Ausente  |
| --------------------- | ------------------ | -------- |
| `GIA_AD_MODO`         | `real`, `simulado` | simulado |
| `GIA_M365_MODO`       | `real`, `simulado` | simulado |
| `GIA_DOCUSIGN_MODO`   | `real`, `simulado` | simulado |
| `GIA_SOFTEXPERT_MODO` | `real`, `simulado` | simulado |
| `GIA_JIRA_MODO`       | `real`, `simulado` | simulado |

Cada `real` exige configuração completa e arquivos acessíveis. Erro não faz fallback.
Credenciais sozinhas nunca selecionam um cliente. Os nomes e limites dos quatro transportes
existentes permanecem nos runbooks dos PRs correspondentes.

Escrita requer `GIA_ESCRITA_EXTERNA=true` E lista exata `GIA_ESCRITA_LIBERADA` por
`sistema:criar`/`sistema:revogar`. Desenvolvimento recusa a chave mestra. Não há curinga.
Liberar um sistema ainda simulado é erro de arranque. Jira e DocuSign também exigem
`GIA_JIRA_ESCRITA_HABILITADA=true` / `GIA_DOCUSIGN_ESCRITA_HABILITADA=true`, coerentes com a lista.
SoftExpert revogar exige ainda `GIA_SOFTEXPERT_REVOGACAO_CONFERIDA=true`, somente após conferir o WSDL.
O gate do worker continua bloqueando operações reais pendentes quando a chave é desligada.
Operações persistidas como simuladas continuam simuladas, mesmo depois da habilitação real.

## Segredos

Somente nomes; valores não devem ser registrados em issue, Git, logs, capturas ou Brain.

| Sistema    | Arquivo montado pelo cofre                                            |
| ---------- | --------------------------------------------------------------------- |
| Banco      | `GIA_DATABASE_URL_ARQUIVO`                                            |
| AD         | `GIA_AD_SENHA_ARQUIVO`; CA opcional `GIA_AD_CA_ARQUIVO`               |
| M365       | `GIA_M365_CLIENT_SECRET_ARQUIVO`                                      |
| DocuSign   | `GIA_DOCUSIGN_CHAVE_PRIVADA_ARQUIVO`                                  |
| SoftExpert | `GIA_SOFTEXPERT_SENHA_SERVICO_ARQUIVO` (conta de serviço em produção) |
| Jira       | `GIA_JIRA_API_TOKEN_ARQUIVO`                                          |

Produção recusa valor inline, inclusive quando existe uma variável de caminho junto.
O resolvedor marca internamente a origem dos valores lidos; declarar um caminho não comprova origem.
Ambientes resolvidos não devem ser copiados/spread e revalidados: a cópia perde essa comprovação.
Banco e Jira são lidos no arranque (reiniciar após rotação). AD/SoftExpert relêem credencial por conexão/chamada.
Graph relê o segredo na aquisição/renovação do token; token cacheado até expiração com margem de 5 min.
DocuSign lê a chave no arranque; reiniciar após rotação. Nenhum token é persistido em auditoria.

## Microsoft 365 / dependencia DEV-282 (PR #18)

O PR #18 foi aberto durante a DEV-287. A composicao agora reutiliza integralmente o
`ClienteGraphHttp` desse PR, sem manter transporte concorrente. Seu snapshot foi incorporado
na base isolada e os testes originais permanecem. Nenhum arquivo do branch DEV-282 foi alterado.

- `GIA_M365_TENANT_ID`: GUID ou dominio explicito, nunca `common`/`organizations`.
- `GIA_M365_CLIENT_ID`: GUID da aplicacao; `GIA_M365_CLIENT_SECRET_ARQUIVO`: segredo montado.
- `GIA_M365_NUVEM`: `global` (padrao) ou `usgov`, hosts oficiais fixos; sem URL arbitraria.
- `GIA_M365_TIMEOUT_MS`: 100-25000, padrao 20000; composicao limita ao prazo do motor.
- `GIA_M365_TENTATIVAS_LEITURA`: 1-4, padrao 3.
- Conta por UPN, mail e proxyAddresses, com consultas avancadas. Escritas pelo objectId.
  Nao cria usuario. Ausencia aguarda a sincronizacao do AD, decidida pelo dominio/worker.
- Licencas por skuPartNumber e assentos disponiveis; grupos por ID/nome/alias/email,
  recusando nomes ambiguos e grupos sincronizados do AD. Usar somente parametros aprovados.
- Revoga somente licencas do item presentes na conta; nao remove grupos (porta atual).
- Ativacao assincrona dos servicos, licencas herdadas e permissoes precisam de ensaio no tenant.

O runbook do #18 lista permissoes de aplicacao `User.ReadWrite.All`, `Organization.Read.All`,
`GroupMember.ReadWrite.All` com consentimento administrativo. Antes de habilitar, o administrador
precisa validar a combinacao minima para as operacoes aprovadas no tenant. As referencias
oficiais atuais tambem listam permissoes mais especificas (`User.ReadUpdate.All`,
`LicenseAssignment.ReadWrite.All`); essa verificacao nao concede permissoes nem altera o tenant.

Fontes oficiais consultadas em 15/10/2026:
[client credentials](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow),
[get user](https://learn.microsoft.com/en-us/graph/api/user-get?view=graph-rest-1.0),
[update user](https://learn.microsoft.com/en-us/graph/api/user-update?view=graph-rest-1.0),
[assignLicense](https://learn.microsoft.com/en-us/graph/api/user-assignlicense),
[grupos](https://learn.microsoft.com/en-us/graph/api/group-post-members),
[SKUs](https://learn.microsoft.com/en-us/graph/api/subscribedsku-list?view=graph-rest-1.0),
[throttling](https://learn.microsoft.com/en-us/graph/throttling).

## Resiliência, correlação e auditoria

Prazo total da chamada propagado por AsyncLocalStorage, incluindo autenticação, paginação e backoff.
HTTP combina o cancelamento do cliente e o prazo total; LDAP confere o prazo antes de cada operação.
Mesmo se uma leitura atrasada ignorar cancelamento, não inicia uma escrita posterior ao prazo.
Operação já em voo pode ter ocorrido: resultado desconhecido exige reconciliação.

Leituras transitórias têm tentativas limitadas. Graph respeita `Retry-After` em 429, usa backoff,
renova token em 401 uma vez (recusa autenticada comprova que a operacao nao foi executada). Escritas não são repetidas
no transporte. Timeout, desconexão ou 5xx após envio de escrita são incertos; o worker não os reenvia
cegamente. Efeitos parciais mantêm a última etapa comprovada.

`integracao_chamada` contém sistema, ação, operaçãoId, itemId, desfecho e código, sem parâmetros,
URLs, mensagens do fornecedor ou credenciais. IDs ligam aos eventos transacionais do worker,
que preservam correlacaoId, ator e operação. Logs técnicos não substituem auditoria persistida.

## Arranque, smoke e ensaio autorizado

1. Integrar dependências conforme o documento de estratégia. Instalar com lockfile e compilar.
2. Montar arquivos no cofre; configurar identificadores, endpoints e mapas aprovados. Manter
   `GIA_ESCRITA_EXTERNA=false`, lista vazia, flags locais false. Não copiar valores para comandos.
3. `pnpm --filter @gia/worker smoke:integracoes --configuracao`: valida seleção/configuração/arquivos,
   sem rede. `configurado`/`NAO_ENSAIADO` **não** é validação produtiva.
4. Com acesso ao ambiente autorizado, `pnpm --filter @gia/worker smoke:integracoes`: autentica e
   só lê os cinco destinos. Não consome fila. Código de saída 1 se qualquer sistema estiver
   ausente/indisponível; relatório sem dados pessoais. Verificar também banco e API com smoke do #16.
5. Somente após autorização explícita, OIDC e regras corporativas validados, liberar um sistema e
   uma operação por vez, com conta de ensaio. Registrar autorização, commit, horário, IDs de
   auditoria e resultado; conferir no destino. Repetir solicitação e comprovar idempotência.
6. Ensaiar falha parcial, rate limit, perda de resposta, revogação e recuperação. Revogação altera
   acesso real e exige autorização; smoke jamais a executa.
7. Rollback: desligar chave mestra, esvaziar lista e flags locais, reiniciar API/worker. Conferir
   bloqueio da fila real e manter operações incertas para reconciliação; não apagar auditoria.

## Bloqueios de produção e conhecimento para o Brain

- Sem credenciais corporativas, permissões administrativas, rotas/CA/LDAPS, consentimento DocuSign
  e tenant Microsoft 365. HTTPs foram exercitados com contratos falsos; AD com Samba descartável.
- Falta ensaio autorizado com identidade de teste, incluindo remoção e efeitos parciais.
- #16/#17 já registram OIDC, regras de proposta corporativas e política operacional pendentes.
  As regras padrão da API ainda são fictícias; integração dos transportes não autoriza go-live.
- AD precisa de decisão sobre entrega/reset da senha inicial; SoftExpert precisa confirmar WSDL
  para revogação e cadastros que a API não comprova. DEV-282 precisa homologar licença no tenant.
- Brain: a seleção real agora é explícita e compartilhada; arquivo não habilita escrita;
  gate por sistema/operação protege inclusive a fila anterior; CI/smoke local não comprovam produção.

## Evidências locais

- `pnpm test --concurrency=1`: 816 testes em 93 arquivos, sem skips, com PostgreSQL 17
  e Samba AD descartáveis. Agendamento serial dos pacotes evita contenção local no Windows;
  nenhum timeout de teste foi ampliado. CI executa o gate normal em Linux.
- `pnpm check`: format, lint, typecheck, test e build passaram.
- `pnpm test:e2e`: sete cenários Chromium, sem retries, API/worker/PostgreSQL reais e destinos
  simulados. Este gate preserva a validação do #17, sem provar ativação corporativa.
- Smoke de configuração CLI: escrita externa false, nenhum destino implicitamente real,
  `validado=false`. Teste de leitura AD autentica por LDAPS na composição real do Samba.
- Testes da DEV-287 cobrem os cinco registros reais, recusa de segredo inline junto de arquivo,
  configuração parcial, HTTP indisponível, bloqueio de POST tardio, auditoria de resultado perdido
  uma única vez e rollback de operações pendentes.
- Delta sem mudanças em `apps/web` ou nos arquivos do transporte/adaptador M365 do #18.

CI, commit e PR são vinculados na DEV-287 e na descrição do PR. Serviços descartáveis locais
não usam credenciais corporativas e são removidos após os gates.
