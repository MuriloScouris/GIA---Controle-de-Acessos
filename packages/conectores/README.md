# @gia/conectores

Adaptadores dos sistemas de destino (AD, Microsoft 365, DocuSign, SoftExpert e Jira), o Jira como origem de chamados e um simulador em memória de cada fornecedor.

## Como funciona

- **Contrato:** cada conector implementa `Conector` de `@gia/dominio` (testar conexão, validar, conferir existência, provisionar e revogar). Nenhuma interface do domínio ou de `@gia/contratos` foi alterada.
- **Motor (`motor.ts`):** comum a todos os sistemas. Executa as etapas na ordem do domínio, retoma a partir de `etapaInicial`, aplica o timeout da ADR-0004, traduz falhas técnicas (regra 3: timeout e resposta perdida são `desconhecido`), aplica a regra 5 na revogação e valida todo resultado com os schemas de `@gia/contratos` (mensagens sanitizadas, regra 12).
- **Adaptadores (`adaptadores/`):** a lógica de cada sistema sobre um **cliente de transporte** injetado (`ClienteAd`, `ClienteGraph`, `ClienteDocusign`, `ClienteSoftexpert`, `ClienteJira`, `ClienteJiraOrigem`). O M365 não tem como criar usuário (regra 7).
- **Simuladores (`simuladores/`):** implementam esses clientes em memória, sem rede e sem segredos, com cenários de sucesso, falha, parcial, timeout, resposta perdida, conexão recusada, 2xx com erro e limite de taxa (`roteiro.programar(...)` ou `roteiro.aplicar(...)`). Todo resultado sai com `modo: 'simulado'` (regra 9).
- **Catálogo (`catalogo.ts`):** `criarCatalogoSimulado()` monta os cinco conectores e o Jira de origem sobre os simuladores.

## Microsoft 365 real (Microsoft Graph)

`src/m365/` traz o transporte de produção: `ClienteGraphHttp` implementa `ClienteGraph` sobre o Graph v1.0 com client credentials (app registration no Entra ID) e `criarConectorM365Real(config)` monta o conector com `modo: 'real'`. Montar o conector **não** libera escrita (regra 8). As regras abaixo seguem o que o GIA anterior conferiu no tenant real (`docs/microsoft365-licencas.md`, 20/08/2026).

- **Autenticação:** `POST /{tenant}/oauth2/v2.0/token` com o segredo lido de **arquivo** do cofre, só no tenant explícito (nunca `common`). Token em cache até 5 min antes de vencer; 401 do Graph renova uma vez. Erros do Entra traduzidos para o que fazer: segredo expirado (`AADSTS7000222`), valor errado (`AADSTS7000215`), app/tenant inexistente.
- **Dependência do AD (regra 7):** não há como criar usuário. A conta é procurada por UPN → `mail` → `proxyAddresses` (consulta avançada com `ConsistencyLevel: eventual`), porque o UPN do AD pode virar `onmicrosoft.com` na sincronização. Sem a identidade, o resultado é `IDENTIDADE_NAO_SINCRONIZADA` (transitório, sem nenhuma escrita) e o worker espera (`GIA_EXECUCAO_ESPERA_M365_MS`). As escritas vão pelo `objectId`.
- **País e licenças:** `usageLocation` é definido antes de licenciar (não sincroniza do AD). Planos por `skuPartNumber` (ex.: `SPB`), mapeados para `skuId` por `/subscribedSkus`; assento esgotado falha **antes** do `assignLicense`, e a validação reprova sem assento e avisa com 3 ou menos. `removeLicenses` vai sempre no corpo.
- **Grupo:** por `objectId`, nome, alias ou e-mail; mais de um com o mesmo nome é erro. Grupo sincronizado do AD é recusado sem tentar (somente leitura na nuvem). Membro repetido (400 "already exist") é sucesso.
- **Idempotência e retomada:** licenças já atribuídas, país já igual e membro existente não geram escrita; cada etapa resolve a conta de novo, e a retomada faz só o que falta.
- **Remoção segura:** a revogação remove **só** os planos do item que a conta tem hoje; nenhuma outra licença. Já sem as licenças é `JA_REVOGADO`; conta ausente é falha (regra 5).
- **Timeout, retry e limite de taxa:** prazo total por chamada (`GIA_M365_TIMEOUT_MS`); leituras repetem em 429/503/504 respeitando `Retry-After` e em falha de rede; escritas nunca repetem aqui (429 vira `limiteDeTaxa` transitório, 5xx vira incerteza). Paginação só segue `@odata.nextLink` do próprio Graph.
- **Auditoria:** `aoRegistrar` (operação, desfecho, código, HTTP, `client-request-id` enviado ao Graph, duração, tentativas), sem UPN, e-mail, token ou segredo. O `client-request-id` permite ao suporte da Microsoft localizar a requisição.

Permissões **de aplicação** do app registration (com consentimento do administrador): `User.ReadWrite.All`, `Organization.Read.All`, `GroupMember.ReadWrite.All`.

| Variável                         | Padrão   | Observação                                 |
| -------------------------------- | -------- | ------------------------------------------ |
| `GIA_M365_TENANT_ID`             | —        | GUID ou domínio do tenant (nunca `common`) |
| `GIA_M365_CLIENT_ID`             | —        | ID do aplicativo (cliente)                 |
| `GIA_M365_CLIENT_SECRET_ARQUIVO` | —        | arquivo do cofre com o VALOR do segredo    |
| `GIA_M365_NUVEM`                 | `global` | `global` ou `usgov` (hosts fixos)          |
| `GIA_M365_TIMEOUT_MS`            | `20000`  | 100 a 25000                                |
| `GIA_M365_TENTATIVAS_LEITURA`    | `3`      | 1 a 4                                      |

Homologação somente leitura (token + organização, sem ler pessoas): `pnpm --filter @gia/conectores m365:verificar`.

## O que ainda não existe

Os transportes reais (LDAPS, Microsoft Graph, eSignature REST, SOAP, REST do Jira) **não** fazem parte deste pacote: dependem de credenciais do cofre e de acesso aos ambientes. Ao implementá-los, cada transporte deve:

- lançar `ErroFornecedor` com o tipo correto (`timeout`, `respostaPerdida`, `conexaoRecusada`, `limiteDeTaxa`, `recusado`);
- tratar 2xx com erro interno como `recusado`;
- escapar entrada humana com `escaparValorFiltroLdap`, `escaparValorDn` e `escaparXml`;
- nunca devolver nem registrar senha, token ou chave.

A escrita continua desligada por padrão: a liberação por sistema e por operação (regra 8) é decidida pelo domínio antes de qualquer chamada ao conector.
