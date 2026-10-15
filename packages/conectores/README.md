# @gia/conectores

Adaptadores dos sistemas de destino (AD, Microsoft 365, DocuSign, SoftExpert e Jira), o Jira como origem de chamados e um simulador em memória de cada fornecedor.

## Como funciona

- **Contrato:** cada conector implementa `Conector` de `@gia/dominio` (testar conexão, validar, conferir existência, provisionar e revogar). Nenhuma interface do domínio ou de `@gia/contratos` foi alterada.
- **Motor (`motor.ts`):** comum a todos os sistemas. Executa as etapas na ordem do domínio, retoma a partir de `etapaInicial`, aplica o timeout da ADR-0004, traduz falhas técnicas (regra 3: timeout e resposta perdida são `desconhecido`), aplica a regra 5 na revogação e valida todo resultado com os schemas de `@gia/contratos` (mensagens sanitizadas, regra 12).
- **Adaptadores (`adaptadores/`):** a lógica de cada sistema sobre um **cliente de transporte** injetado (`ClienteAd`, `ClienteGraph`, `ClienteDocusign`, `ClienteSoftexpert`, `ClienteJira`, `ClienteJiraOrigem`). O M365 não tem como criar usuário (regra 7).
- **Simuladores (`simuladores/`):** implementam esses clientes em memória, sem rede e sem segredos, com cenários de sucesso, falha, parcial, timeout, resposta perdida, conexão recusada, 2xx com erro e limite de taxa (`roteiro.programar(...)` ou `roteiro.aplicar(...)`). Todo resultado sai com `modo: 'simulado'` (regra 9).
- **Catálogo (`catalogo.ts`):** `criarCatalogoSimulado()` monta os cinco conectores e o Jira de origem sobre os simuladores.

## Active Directory real (LDAPS)

`transportes/` traz o transporte de produção do AD: `ClienteAdLdap` implementa `ClienteAd` sobre LDAPS (`ldapts`) e `criarConectorAdReal(config)` monta o conector com `modo: 'real'`. Montar o conector **não** libera escrita: a liberação por sistema e por operação (regra 8) continua no domínio.

- **Autenticação:** bind simples da conta de serviço, só por `ldaps://` com TLS 1.2+ e certificado sempre verificado (CA próprio opcional; nome esperado configurável para DC acessado por IP/apelido). Vários DCs: o seguinte só é tentado se o anterior nem conectou.
- **Segredos (regra 12):** a senha da conta de serviço vem de **arquivo** montado pelo cofre e é relida a cada conexão (rotação). Nenhuma senha passa por variável de ambiente, resposta, log ou evento. `NODE_DEBUG=ldapts` é recusado no arranque, porque faria a biblioteca registrar a senha inicial.
- **Operações:** busca por login e por e-mail (`mail`/`proxyAddresses`), OU e grupo (por `cn` ou `sAMAccountName`); criação **sempre desabilitada** (`userAccountControl` com bit 2), com CPF no atributo configurado e gerente resolvido por login ou DN; senha inicial em `unicodePwd` com `pwdLastSet=0` (troca obrigatória); habilitar; adicionar ao grupo; desabilitar; mover para a OU de inativos. Nada é criado ou movido fora da base gerenciada.
- **Idempotência:** recriar a conta que a tentativa anterior criou (mesmo login e CPF, ainda desabilitada) devolve o mesmo `objectGUID`; membro já existente, conta já habilitada/desabilitada ou já na OU de destino não geram nova escrita. Login de outra pessoa (`LOGIN_EM_USO`) e homônimo na OU (`AD_NOME_EM_USO`) são recusados.
- **Timeout e retentativa:** timeout de conexão e de operação no cliente LDAP, abaixo do limite do motor (ADR-0004). Leituras são repetidas só quando nenhum DC aceitou a conexão; escritas nunca são repetidas aqui (regra 3: incerteza vai para conferência; a retentativa de transitórios é do worker).
- **Erros:** códigos LDAP viram `ErroFornecedor` com código estável (`AD_CREDENCIAL_INVALIDA`, `AD_PERMISSAO_INSUFICIENTE`, `AD_INDISPONIVEL`, `AD_TLS_INVALIDO`, `AD_RESPOSTA_PERDIDA`, `AD_TEMPO_ESGOTADO`...). Mensagens são fixas: as da biblioteca podem trazer filtro ou DN com dados da pessoa.
- **Auditoria:** o resultado de cada etapa (efeito, etapa, código) já vira evento no worker. O transporte expõe `aoRegistrar` com operação, desfecho, código, duração e tentativas — sem login, DN, e-mail, CPF ou senha.

| Variável                     | Padrão       | Observação                                         |
| ---------------------------- | ------------ | -------------------------------------------------- |
| `GIA_AD_URL`                 | obrigatória  | `ldaps://dc1:636,ldaps://dc2` (só LDAPS)           |
| `GIA_AD_BIND_DN`             | obrigatória  | DN da conta de serviço                             |
| `GIA_AD_SENHA_ARQUIVO`       | obrigatória  | caminho do segredo montado pelo cofre              |
| `GIA_AD_BASE_DN`             | obrigatória  | base gerenciada pelo GIA                           |
| `GIA_AD_OU_INATIVOS`         | obrigatória  | dentro da base                                     |
| `GIA_AD_ATRIBUTO_CPF`        | `employeeID` | atributo onde o CPF é gravado e conferido          |
| `GIA_AD_CA_ARQUIVO`          | —            | CA do AD em PEM; sem ele, o repositório do sistema |
| `GIA_AD_TLS_NOME_SERVIDOR`   | —            | nome esperado no certificado                       |
| `GIA_AD_TIMEOUT_CONEXAO_MS`  | `5000`       |                                                    |
| `GIA_AD_TIMEOUT_OPERACAO_MS` | `10000`      | por operação LDAP                                  |
| `GIA_AD_TENTATIVAS_LEITURA`  | `2`          | 1 a 5                                              |

Homologação somente leitura (autentica e lê a base, sem tocar pessoas): `pnpm --filter @gia/conectores ad:verificar` com as variáveis acima.

### Teste integrado contra AD real

`src/transportes/ad-ldap.integracao.test.ts` roda contra um Samba AD DC por LDAPS sempre que `GIA_AD_TESTE_*` está definido (no CI, sempre; ver `.github/workflows/ci.yml`). Cada execução usa uma OU própria e a apaga no fim. Localmente:

```sh
docker run -d --name gia-ad-teste --hostname dc1 -p 127.0.0.1:6360:636   -e REALM=GIA.TESTE.LOCAL -e DOMAIN=GIATESTE -e ADMINPASS="<senha gerada por você>"   smblds/smblds@sha256:2fa04e4a744c80057540ca2834a3550cbfa7c456821caf3f60cf5898c9051d23
docker cp gia-ad-teste:/var/lib/samba/private/tls/ca.pem ./ca.pem   # quando o contêiner estiver saudável
GIA_AD_TESTE_URL=ldaps://127.0.0.1:6360 GIA_AD_TESTE_BIND_DN="CN=Administrator,CN=Users,DC=gia,DC=teste,DC=local" GIA_AD_TESTE_SENHA_ARQUIVO=<arquivo com a senha> GIA_AD_TESTE_BASE_DN="DC=gia,DC=teste,DC=local" GIA_AD_TESTE_CA_ARQUIVO=./ca.pem GIA_AD_TESTE_TLS_NOME_SERVIDOR=dc1.gia.teste.local pnpm --filter @gia/conectores test
```

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

- **Escrita real ponta a ponta:** a composi??o continua pendente de integra??o com os gates operacionais.
- **Entrega da senha inicial:** a senha gerada nunca ? devolvida nem guardada; at? haver decis?o, ? necess?rio reset pelo suporte.

O transporte DocuSign eSignature REST est? implementado em `src/docusign/`, com JWT e configura??o por ambiente. Veja [DOCUSIGN.md](DOCUSIGN.md). O cat?logo padr?o ainda ? simulado.

Os demais transportes reais (Microsoft Graph, SOAP, REST do Jira) dependem de credenciais e de acesso aos ambientes. Ao implement?-los, cada transporte deve:

O transporte REST do Jira Cloud está em `src/jira/`, com configuração opt-in,
origem por cursor e destino com escrita desligada por padrão. Veja o
[runbook DEV-285](../../docs/integracoes/jira-dev-285.md), incluindo bloqueios reais
de ativação e validação produtiva pendente.

Os demais transportes reais (LDAPS, Microsoft Graph, eSignature REST, SOAP) ainda
dependem de implementação, credenciais do cofre e acesso aos ambientes. Cada transporte deve:

- lançar `ErroFornecedor` com o tipo correto (`timeout`, `respostaPerdida`, `conexaoRecusada`, `limiteDeTaxa`, `recusado`);
- tratar 2xx com erro interno como `recusado`;
- escapar entrada humana com `escaparValorFiltroLdap`, `escaparValorDn` e `escaparXml`;
- nunca devolver nem registrar senha, token ou chave.

A escrita continua desligada por padrão: a liberação por sistema e por operação (regra 8) é decidida pelo domínio antes de qualquer chamada ao conector.
