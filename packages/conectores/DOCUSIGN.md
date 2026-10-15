# DocuSign — DEV-283

## Estado verificável

Transporte eSignature REST v2.1 implementado sobre `ClienteDocusign`, com montagem
explícita por `criarConectorDocusignDoAmbiente`. Testes usam fixtures HTTP, servidor
HTTP local com sockets reais e o worker sobre PostgreSQL descartável. Nenhuma
operação foi executada em uma conta DocuSign real.

O worker em `apps/worker/src/index.ts` ainda monta exclusivamente
`criarCatalogoSimulado`. O schema global em
`packages/contratos/src/configuracao.ts` aceita somente escrita externa desligada.
Integrar o novo conector ao catálogo e liberar escrita por sistema requer trabalho
de backend/configuração da Sprint 1. Este transporte não altera esses gates.

## Fronteira e autenticação

O backend decide se deve provisionar ou revogar; o cliente executa somente a
comunicação externa. JWT RS256 usa os scopes `signature impersonation`, com chave
RSA de pelo menos 2048 bits carregada de secret montado como arquivo. Token fica
somente em memória e é renovado antes de expirar; 401 invalida o cache para a
próxima chamada. Consentimento, integração habilitada no ambiente e permissões de
administração de usuários precisam ser fornecidos pelo administrador DocuSign.

O ambiente escolhe o host OAuth. `/oauth/userinfo` precisa conter exatamente a
conta configurada. A base URI deve ser HTTPS no domínio DocuSign e no ambiente
correto, sem credenciais, porta, caminho ou query adicionais. Redirecionamentos
HTTP são recusados. URLs de paginação retornadas pela rede não são seguidas:
as próximas páginas são construídas sob a mesma conta.

## Configuração por ambiente

| Variável                             | Finalidade                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| `GIA_AMBIENTE`                       | Impede selecionar demo quando o Gia está em produção.                             |
| `GIA_DOCUSIGN_AMBIENTE`              | Ambiente DocuSign explícito: demo ou produção.                                    |
| `GIA_DOCUSIGN_INTEGRACAO_ID`         | Identificador da integração habilitada no ambiente.                               |
| `GIA_DOCUSIGN_USUARIO_ID`            | Identificador do usuário administrativo impersonado.                              |
| `GIA_DOCUSIGN_CONTA_ID`              | API Account ID da conta alvo.                                                     |
| `GIA_DOCUSIGN_CHAVE_PRIVADA_ARQUIVO` | Caminho de arquivo montado pelo gerenciador de secrets.                           |
| `GIA_DOCUSIGN_ESCRITA_HABILITADA`    | Gate adicional do transporte; desligado por padrão.                               |
| `GIA_DOCUSIGN_TIMEOUT_MS`            | Prazo total de uma operação, inclusive OAuth e backoff; padrão 20 s, máximo 25 s. |
| `GIA_DOCUSIGN_TENTATIVAS_LEITURA`    | Tentativas de GET; padrão e máximo 3.                                             |

Configuração inválida informa somente nomes de variáveis. Chave, assertion JWT,
token, corpo de erro externo e cabeçalho Authorization não são registrados.
O arquivo da chave deve ter ACL de leitura restrita à identidade do serviço.
Rotacionar a chave exige remontar o secret e recriar o cliente/reiniciar o processo.

## Dados e comportamento

- Criação envia e-mail, nome, empresa, cargo, perfil, grupo, idioma e endereço
  quando informado. Perfil/grupo são resolvidos por nome normalizado para IDs da
  conta; ausência ou ambiguidade impede a escrita. Endereço textual é mapeado para
  `workAddress.address1`; idioma usa `userSettings.localePolicy.cultureName`.
- A consulta localiza o e-mail exato, lê o detalhe e todos os grupos do usuário.
  Estado desconhecido, resposta incompleta ou mais de uma conta correspondente
  causam erro; não se infere sucesso de dados incompletos.
- Uma conta ativa ou pendente existente retorna `USUARIO_JA_EXISTE`, sem novo
  convite e sem confirmar automaticamente o item do Gia (regra 6). Conta encerrada
  não é reaberta implicitamente. Encerramento repetido não envia outro DELETE;
  conta ausente não é criada por uma revogação.
- Criação e encerramento são serializados por e-mail dentro da instância. A
  garantia persistente entre workers/reinícios permanece na fila com lease e chave
  de idempotência do Gia. Não se pressupõe suporte do fornecedor a um header de
  idempotência. Após resultado incerto, o worker encaminha para reconciliação;
  não reenvie manualmente criação enquanto houver resultado desconhecido.

## Falhas, resiliência e evidência

Todas as requisições de uma operação compartilham um prazo com cancelamento via
AbortSignal, inclusive durante paginação/backoff; prazo vencido impede escritas
tardias. GET pode repetir HTTP 429/5xx com backoff exponencial e Retry-After,
respeitando o prazo total. OAuth POST, criação POST e encerramento DELETE têm
uma única tentativa. Um Retry-After maior que o orçamento não é encurtado.

401, 403, consentimento ausente, JWT recusado, throttling, erro interno em 2xx,
timeout e resposta perdida têm códigos estáveis. Erro individual em 2xx é falha;
5xx, timeout ou resposta inválida depois de escrita são efeito desconhecido.
O transporte não confirma uma alteração quando perdeu a resposta.

O worker persiste `operacaoResultadoRegistrado` na transação existente com
sistema, operação, pedido, correlação, resultado e referência externa. Resultado
incerto também gera `operacaoEncaminhadaParaReconciliacao`. Os testes em
`apps/worker/src/docusign-integracao.test.ts` verificam os eventos no PostgreSQL,
ausência de segredos na evidência e ausência de reenvio ao processar outro lote.

## Dependências para aceite em produção

Nesta execução não estão presentes as variáveis `GIA_DOCUSIGN_*`. Sem os IDs,
chave montada, consentimento e permissões da conta não é possível validar OAuth,
mapeamento ou chamadas na conta alvo. Além dessa configuração administrativa,
falta a montagem do catálogo real e liberação de escrita pelo backend. Não há
evidência para declarar a DEV-283 funcionando em produção ou marcar Done.

Uma validação futura deve começar por conexão/consulta sem escrita. Criação em
conta autorizada envia convite e pode consumir licença. Encerramento é alteração
real de acesso e exige aprovação explícita da operação/alvo antes da execução.

## Conhecimento para o Brain

O cliente real pode ser injetado no adaptador existente; detalhes HTTP/JWT não
entram no domínio. Uma conta pode ter vários grupos: a conferência deve testar
pertencimento, não somente o primeiro grupo. O retorno incerto de escrita exige
reconciliação persistente, mesmo que uma consulta posterior encontre a conta.
O projeto Linear consultado não contém descrição/content nem documentos de Brain
publicados; decisões locais e READMEs foram usados na auditoria.
