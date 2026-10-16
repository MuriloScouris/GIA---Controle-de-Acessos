# DEV-289 — Preflight de produção e homologação

O preflight verifica configuração, arquivos e acessos de leitura dos cinco conectores.
Não altera AD, tenant, contas, grupos, licenças, pedidos ou fila. Não reinicia processos,
não habilita escrita e não registra resultado de homologação sem ensaio autorizado.

## Executar

Após instalar com lockfile e compilar (`pnpm build`):

```text
pnpm --filter @gia/worker preflight --offline --saida <arquivo-novo.json>
pnpm --filter @gia/worker preflight --saida <outro-arquivo-novo.json>
```

`--offline` valida configuração/cofre sem rede. A segunda forma faz DNS, TCP, TLS e leituras
autenticadas. O operador fornece o ambiente autorizado pelos arquivos montados pelo cofre.
Não passar valores de credenciais na linha de comando. Nenhuma opção libera escrita ou
remove pendências manuais. Argumento desconhecido é recusado sem ecoar seu conteúdo.

| Código de saída | Significado                                                                            | Decisão operacional                                        |
| --------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1               | Há bloqueio técnico, configuração ausente, amostra incompleta ou leitura não executada | Corrigir a condição e repetir, com novo arquivo            |
| 2               | Todas as leituras foram validadas; homologação administrativa/rollback ainda pendentes | Manter escrita desligada e concluir o checklist autorizado |

O comando não produz saída zero de liberação de produção. Mesmo com leituras aprovadas,
`producaoPronta=false` e `escritaHabilitada=false`. Autenticar/ler não comprova permissão
de criar, licenciar, adicionar grupo ou revogar. A decisão de go-live exige evidência
administrativa e ensaio autorizado fora deste comando. Não tratar código 2 como deploy liberado.

`escritaHabilitada=false` registra que o comando não habilita escrita. O estado encontrado
fica em `gatesObservados`: configuração `desligada`/`insegura` e API `desligada`/`ligada`/`naoConfirmada`.
Se o ambiente ou a API estiverem com escrita ligada, o programa informa e bloqueia; não os desliga
silenciosamente nem afirma que estão seguros. Reinício e rollback exigem o procedimento autorizado.

## Ambiente e arquivos

| Nome                                                                                        | Exigência                                                                                       |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GIA_AMBIENTE`                                                                              | `producao` ou `teste`; ausência/desenvolvimento não valida produção                             |
| `GIA_ESCRITA_EXTERNA`                                                                       | ausente/`false`                                                                                 |
| `GIA_ESCRITA_LIBERADA`                                                                      | vazia/ausente                                                                                   |
| `GIA_JIRA_ESCRITA_HABILITADA`, `GIA_DOCUSIGN_ESCRITA_HABILITADA`                            | ausentes/`false`                                                                                |
| `GIA_AD_MODO`, `GIA_M365_MODO`, `GIA_DOCUSIGN_MODO`, `GIA_SOFTEXPERT_MODO`, `GIA_JIRA_MODO` | `real` para validar cada sistema; ausente não usa simulador                                     |
| `GIA_DATABASE_URL_ARQUIVO`                                                                  | arquivo regular com URL PostgreSQL; a conexão é conferida pela readiness da API                 |
| `GIA_PREFLIGHT_API_URL`                                                                     | origem HTTPS da API, sem usuário/senha/caminho/query/fragmento; HTTP apenas loopback em `teste` |
| `GIA_WORKER_ARQUIVO_SAUDE`                                                                  | heartbeat do worker no mesmo ambiente, até 60 s e nunca no futuro                               |
| `GIA_PREFLIGHT_TIMEOUT_MS`                                                                  | 100–25000 por verificação, padrão 5000; timeouts internos limitados pela composição             |
| `GIA_PREFLIGHT_REVISAO`                                                                     | opcional, SHA de 40 caracteres para vincular a execução à revisão; não informar credencial      |
| `NODE_EXTRA_CA_CERTS`                                                                       | opcional para HTTP com CA corporativa; iniciar Node com essa variável, conforme runtime         |

Todas as configurações de conector são as do [runbook DEV-287](../integracoes/dev-287-composicao.md).
Segredos exclusivamente por arquivo: `GIA_AD_SENHA_ARQUIVO`, `GIA_M365_CLIENT_SECRET_ARQUIVO`,
`GIA_DOCUSIGN_CHAVE_PRIVADA_ARQUIVO`, `GIA_SOFTEXPERT_SENHA_SERVICO_ARQUIVO` (conta de serviço em
produção), `GIA_JIRA_API_TOKEN_ARQUIVO`. CA AD opcional: `GIA_AD_CA_ARQUIVO`.

Preflight recusa segredo inline inclusive acompanhado de `*_ARQUIVO`, TLS sem verificação,
`NODE_DEBUG` ou `DEBUG` ativos. Não modifica o ambiente para contornar o bloqueio.
`GIA_SOFTEXPERT_REVOGACAO_CONFERIDA` é declaração sobre WSDL, não chave de escrita; não é apagada
nem usada para liberar revogação. Produção recusa autenticação SoftExpert por token pessoal.

Arquivos precisam ser regulares, não vazios, até 1 MiB. Volumes de cofre com symlinks são aceitos
quando apontam para arquivo regular. Em POSIX, acesso de terceiros (bits world) bloqueia segredo;
grupo/ACL devem ser revisados pelo administrador. Em Windows, leitura não comprova ACL:
o checklist administrativo continua obrigatório. CA é PEM, com certificados parseáveis e vigentes;
chave DocuSign continua exigindo RSA de pelo menos 2048 bits. Não são exportados conteúdo, caminho,
hash de senha/token, certificado ou identidade do serviço.

## O que é verificado

| Sistema    | Rede/TLS                                                            | Leitura autenticada e limites                                                     |
| ---------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| AD         | Cada DC configurado por LDAPS, CA/cadeia/nome verificados, TLS 1.2+ | Bind e busca base; sem criar, senha, alteração de grupo, bloqueio ou movimentação |
| M365       | Authority e Graph da nuvem configurada, hosts fixos                 | Client credentials e organização; não cria identidade nem atribui/remove licença  |
| DocuSign   | Authority; TLS regional também validado no HTTP autenticado         | JWT, consentimento efetivo, userinfo/conta e GET users; sem convite/encerramento  |
| SoftExpert | Host do API Gateway, CA e hostname                                  | Somente o getUserData de conexão; sem newUser/disableUser                         |
| Jira       | Host configurado                                                    | GET myself e duas consultas JQL, no máximo um chamado celetista e um terceiro     |

DNS, TCP e TLS são resultados separados, com índice do destino, sem hostname. AD usa a ordem
de `GIA_AD_URL`; M365: 1 authority, 2 Graph; DocuSign/SE/Jira: 1 endpoint principal. Índice 0
nos checks globais é a API. Falha de TLS impede o envio da credencial àquele destino.
Ausência/erro de um conector não impede diagnóstico dos demais. Escrita habilitada ou outra
configuração global insegura impede toda a rede. Arquivo do banco inválido bloqueia o resultado,
mas permite diagnóstico de leitura dos conectores independentes.

Para Jira, a amostra passa pelo mapeamento existente, schema e CPF válido. Amostra ausente de
um vínculo fica pendente; campo inválido bloqueia. Não cria pedido, não grava auditoria de negócio,
não consulta histórico completo nem exporta chave, CPF, nome, e-mail ou valores dos campos.
Cadastro real de OU/grupos/perfis/área/função e permissão de escrita continuam no checklist.

O filtro HTTP permite GET nos hosts aprovados e somente os POSTs de OAuth/JWT e o corpo exato
do getUserData de conexão. Recusa POST/PATCH/PUT/DELETE de acesso, host externo e redirect.
Corpo de resposta limitado a 2 MiB, com cancelamento por prazo. Não usa o smoke da API que
testa sessão por POST: aqui são exclusivamente GET `/saude`, `/saude/pronta` e `/pedidos`.
Valida ambiente, persistência pronta, modo simulado/lista vazia, headers de proteção e 401 sem sessão.
Não abre sessão, não consome fila, não valida nem escreve um pedido real.

## Evidência e códigos

JSON `gia.preflight.v1` contém UUID da execução, horário UTC, SHA opcional, ambiente, códigos
fixos por check/sistema e pendências. Não contém mensagens, códigos dinâmicos SOAP, URLs,
payloads, paths ou credenciais. Erros de configuração expõem apenas nomes de variáveis.
O arquivo é criado com exclusividade (`wx`), modo 0600 em POSIX, sem sobrescrever o anterior.
Stdout também informa SHA-256 do arquivo; arquivar em repositório restrito de evidências,
com retenção e ACL corporativas. O checksum detecta alteração; não é assinatura administrativa.

| Código                                                                     | Próxima ação                                                                                   |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `ESCRITA_DEVE_ESTAR_DESLIGADA` / `API_ESCRITA_HABILITADA`                  | Desligar gates e confirmar configuração efetivamente implantada                                |
| `REAL_NAO_SELECIONADO` / `CONFIGURACAO_INVALIDA`                           | Completar seleção/configuração do sistema indicado                                             |
| `SEGREDO_INLINE_RECUSADO`                                                  | Remover valor inline e montar arquivo do cofre                                                 |
| `ARQUIVO_AUSENTE_OU_INVALIDO` / `ARQUIVO_PERMISSAO_ABERTA`                 | Conferir mount, formato, leitura e ACL                                                         |
| `DNS_INDISPONIVEL` / `TCP_INDISPONIVEL` / `TLS_INVALIDO`                   | Conferir rota, DNS, firewall, CA, validade e nome esperado                                     |
| `AUTENTICACAO_RECUSADA` / `CREDENCIAL_EXPIRADA`                            | Administrador confere conta e rotação no cofre                                                 |
| `CONSENTIMENTO_PENDENTE` / `CONTA_SEM_ACESSO` / `PERMISSAO_LEITURA_NEGADA` | Conferir aplicação, consentimento, conta e permissões                                          |
| `LIMITE_DE_TAXA` / `TEMPO_ESGOTADO` / `SERVICO_INDISPONIVEL`               | Conferir disponibilidade e limite; repetir somente leitura após correção                       |
| `CAMPOS_INVALIDOS` / `SEM_AMOSTRA_DOS_DOIS_VINCULOS`                       | Conferir mapeamento e chamados de ensaio autorizados                                           |
| `API_NAO_PRONTA` / `API_PROTECAO_INVALIDA` / `WORKER_SEM_BATIMENTO`        | Conferir processo/API/banco, proteção HTTP e worker                                            |
| `LEITURA_NAO_VALIDADA`                                                     | Falha sem classificação segura; conferir logs técnicos restritos do sistema sem copiar payload |

## Checklist de homologação e rollback (administrador autorizado)

1. Registrar responsável, autorização, janela, revisão implantada e referência da execução.
   Conferir que os arquivos montados correspondem às contas de serviço aprovadas, escopo mínimo,
   rotação, titularidade e ACL. Preflight autentica a credencial, não prova que ela é conta de serviço.
2. Conferir no AD delegação/base/atributo CPF/OU inativos, OUs e grupos aprovados; decidir entrega/reset
   da senha inicial. No Entra, consentimentos, licenças/assentos, grupos e sincronização AD confirmada.
3. Conferir DocuSign integration key/impersonation/conta e consentimento administrativo; SE conta de
   serviço, cadastros e WSDL de revogação; Jira projeto, request types, campos, domínio/conta e grupos.
   Nenhum GET comprova as respectivas permissões de escrita.
4. Concluir OIDC, autorização por papel e regras corporativas. DEV-288 está em andamento fora deste
   branch; não usar sessão simulada ou regras fictícias como evidência produtiva.
5. Repetir preflight online com gates desligados. Guardar JSON/checksum, códigos e evidências
   administrativas sem senhas, tokens ou dados pessoais.
6. Somente com aprovação explícita e identidade de ensaio: autorizar separadamente cada sistema e
   operação, pelo fluxo operacional próprio. Conferir efeito no destino e auditoria persistida,
   repetição idempotente, sincronização AD→M365, erro parcial, perda de resposta e reconciliação.
   Revogação, licenças e grupos alteram acesso: não fazem parte deste preflight.
7. Para rollback, desligar `GIA_ESCRITA_EXTERNA`, limpar `GIA_ESCRITA_LIBERADA`, desligar flags de
   escrita Jira/DocuSign e reiniciar API/worker pelo procedimento autorizado. Confirmar configuração
   implantada do worker, preservação de auditoria e bloqueio da fila pendente. Não reenviar incertos.
8. Executar novamente o preflight. Readiness confirma a API; heartbeat prova apenas vivacidade do
   worker, não o estado de seus gates. Registrar essa conferência administrativa e o ensaio de rollback.
   O programa não os marca concluídos por inferência nem oferece flag para eliminá-los.

## Dependências, gates e conhecimento para o Brain

Branch empilhado sobre PR #20, commit `865b6e334bd12caafd84d585d9b72b567a663720`, que agrega
#12–#18. Não altera UI, main, branches de origem nem ativa escrita. PR #19 (complemento DocuSign)
e DEV-288/OIDC são paralelos: preservar seus acréscimos, mantendo a composição central do #20;
não recolocar um segundo roteador DocuSign no worker. Retarget para main somente depois das
dependências e repetição de todos os gates no fechamento da sprint; sem merge/deploy neste trabalho.

CI usa PostgreSQL/Samba descartáveis e contratos HTTP; a senha efêmera do Samba agora é arquivo 0600. Testa código de saída não zero e artefato negativo do CLI sem credenciais, além dos gates
do #20 e Chromium. Isso verifica o programa, não representa homologação corporativa.

Brain: evidência de leitura e homologação administrativa são distintas. Rede/CA/arquivo/autenticação
podem ser automatizados; conta de serviço, permissão de escrita e ensaio/rollback precisam de
evidência autorizada. Campos de Jira são amostrados por vínculo sem ingestão. Segredos e dados
pessoais nunca entram no JSON; falha parcial produz diagnóstico por sistema, sem fallback simulado.

Bloqueios atuais: credenciais/permissões/rede corporativas, consentimentos, identidade de ensaio,
autorização administrativa, OIDC/regras reais e decisões/WSDL já documentados. Produção não validada.

## Evidências da implementação

- `pnpm test --concurrency=1`: 855 testes, 96 arquivos, sem skips, PostgreSQL 17 e Samba AD descartáveis.
- `pnpm check`: format, lint, typecheck, test e build verdes.
- `pnpm test:e2e`: sete cenários Chromium sem retries, com destinos simulados.
- 39 testes novos: filtro de escrita/host/SOAP, corpo limitado/cancelado, configuração insegura,
  arquivos, amostras dos vínculos, falha isolada, consentimento, timeout, sanitização, artefato/checksum,
  heartbeat e TLS/CA/nome. Leituras dos cinco transportes usam contratos HTTP e AD por LDAPS no Samba.
- Caso completo retorna 2 mantendo homologação/rollback pendentes. CLI compilado sem credenciais
  retorna 1 com os cinco sistemas e nenhuma indicação de produção pronta.
- Nenhuma mudança em `apps/web`, main ou branches de origem. CI/commit/PR vinculados na DEV-289.
