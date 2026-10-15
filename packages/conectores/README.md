# @gia/conectores

Adaptadores dos sistemas de destino (AD, Microsoft 365, DocuSign, SoftExpert e Jira), o Jira como origem de chamados e um simulador em memória de cada fornecedor.

## Como funciona

- **Contrato:** cada conector implementa `Conector` de `@gia/dominio` (testar conexão, validar, conferir existência, provisionar e revogar). Nenhuma interface do domínio ou de `@gia/contratos` foi alterada.
- **Motor (`motor.ts`):** comum a todos os sistemas. Executa as etapas na ordem do domínio, retoma a partir de `etapaInicial`, aplica o timeout da ADR-0004, traduz falhas técnicas (regra 3: timeout e resposta perdida são `desconhecido`), aplica a regra 5 na revogação e valida todo resultado com os schemas de `@gia/contratos` (mensagens sanitizadas, regra 12).
- **Adaptadores (`adaptadores/`):** a lógica de cada sistema sobre um **cliente de transporte** injetado (`ClienteAd`, `ClienteGraph`, `ClienteDocusign`, `ClienteSoftexpert`, `ClienteJira`, `ClienteJiraOrigem`). O M365 não tem como criar usuário (regra 7).
- **Simuladores (`simuladores/`):** implementam esses clientes em memória, sem rede e sem segredos, com cenários de sucesso, falha, parcial, timeout, resposta perdida, conexão recusada, 2xx com erro e limite de taxa (`roteiro.programar(...)` ou `roteiro.aplicar(...)`). Todo resultado sai com `modo: 'simulado'` (regra 9).
- **Catálogo (`catalogo.ts`):** `criarCatalogoSimulado()` monta os cinco conectores e o Jira de origem sobre os simuladores.

## SoftExpert real (SOAP pelo API Gateway)

`src/softexpert/` traz o transporte de produção do SE Suite: `ClienteSoftexpertSoap` implementa `ClienteSoftexpert` sobre o `adm_ws.php` (namespace `urn:admin`) e `criarConectorSoftexpertReal(config)` monta o conector com `modo: 'real'`. Montar o conector **não** libera escrita (regra 8). Endpoint, autenticação, `getUserData`, `newUser` e o formato das respostas seguem o levantamento feito contra o ambiente real (`docs/softexpert-api.md` do GIA anterior, 2026-07-29).

- **Autenticação:** token do API Gateway (JWT **sem** `Bearer`) ou conta de serviço (Basic). Em `GIA_AMBIENTE=producao` só a conta de serviço é aceita: o token é pessoal e morre com o desligamento de quem o gerou. Segredos vêm de **arquivo** do cofre, relidos a cada chamada.
- **Identificação:** o SE Suite identifica o usuário pelo `IDUSER` (matrícula; CPF formatado para quem não tem), não pelo login. O adaptador busca, cria e inativa por `identificador`.
- **Criação:** `newUser` com os campos na ordem do serviço, senha inicial forte aleatória (nunca devolvida, guardada ou registrada) e `LANGUAGE` só quando configurado (valor desconhecido derruba a criação com "Idioma inexistente").
- **Idempotência:** antes do `newUser`, o `getUserData` confere o `IDUSER`; o mesmo usuário (login, área e função iguais) devolve a chave sem nova escrita. `newUser` recusado é reconferido (corrida com outra tentativa). Matrícula de outro login é `IDENTIFICADOR_EM_USO`.
- **Respostas:** `Status FAILURE` em 2xx é recusa com o `Detail` do SE para o operador; "Usuário inexistente" é a única FAILURE lida como "livre". SOAP `Fault` (2xx ou 500) é recusa. Resposta fora do SOAP é recusa na leitura e incerteza (`respostaPerdida`) depois de uma escrita. 401 é credencial; 403 com `x-rate-limit-remaining: 0` e 429 são limite de taxa (com `Retry-After`); 408/5xx é incerteza. O XML é lido por um leitor próprio que **recusa DOCTYPE** (sem XXE).
- **Timeout e retentativa:** prazo total por chamada (`GIA_SOFTEXPERT_TIMEOUT_MS`, abaixo do timeout do motor) cobrindo tentativas e esperas; leituras repetem em falha transitória com backoff; escritas nunca repetem aqui. Falha na consulta feita antes do `newUser` sai como `conexaoRecusada` (nada foi gravado), não como incerteza.
- **Auditoria:** `aoRegistrar` (operação, desfecho, código, status HTTP, duração, tentativas), sem identificador, login, e-mail, senha ou token.
- **O que a API não oferece:** não lista nem consulta área, função ou grupo de acesso, e o `getUserData` não informa situação (ativo) nem grupo. Por isso a validação **avisa** (`CADASTRO_NAO_VERIFICAVEL`) em vez de afirmar, e a conferência de existência nunca comprova a etapa sozinha (regra 6).
- **Revogação:** o `disableUser` ainda não foi conferido no WSDL do ambiente. Enquanto `GIA_SOFTEXPERT_REVOGACAO_CONFERIDA` não for `true`, a revogação é recusada sem chamar o SE Suite.

| Variável                               | Padrão  | Observação                                          |
| -------------------------------------- | ------- | --------------------------------------------------- |
| `GIA_SOFTEXPERT_URL`                   | —       | base HTTPS do ambiente, sem caminho                 |
| `GIA_SOFTEXPERT_AUTENTICACAO`          | —       | `contaServico` (obrigatório em produção) ou `token` |
| `GIA_SOFTEXPERT_USUARIO_SERVICO`       | —       | com `contaServico`                                  |
| `GIA_SOFTEXPERT_SENHA_SERVICO_ARQUIVO` | —       | com `contaServico`; arquivo do cofre                |
| `GIA_SOFTEXPERT_TOKEN_ARQUIVO`         | —       | com `token`; arquivo do cofre                       |
| `GIA_SOFTEXPERT_IDIOMA`                | omitido | código existente no cadastro de idiomas do SE       |
| `GIA_SOFTEXPERT_TIMEOUT_MS`            | `20000` | 100 a 25000                                         |
| `GIA_SOFTEXPERT_TENTATIVAS_LEITURA`    | `2`     | 1 a 3                                               |
| `GIA_SOFTEXPERT_REVOGACAO_CONFERIDA`   | `false` | `true` só depois de conferir o `disableUser`        |

Homologação somente leitura (autentica e consulta um `IDUSER` inexistente): `pnpm --filter @gia/conectores softexpert:verificar` com as variáveis acima.

## O que ainda não existe

Os transportes reais (LDAPS, Microsoft Graph, eSignature REST, SOAP, REST do Jira) **não** fazem parte deste pacote: dependem de credenciais do cofre e de acesso aos ambientes. Ao implementá-los, cada transporte deve:

- lançar `ErroFornecedor` com o tipo correto (`timeout`, `respostaPerdida`, `conexaoRecusada`, `limiteDeTaxa`, `recusado`);
- tratar 2xx com erro interno como `recusado`;
- escapar entrada humana com `escaparValorFiltroLdap`, `escaparValorDn` e `escaparXml`;
- nunca devolver nem registrar senha, token ou chave.

A escrita continua desligada por padrão: a liberação por sistema e por operação (regra 8) é decidida pelo domínio antes de qualquer chamada ao conector.
