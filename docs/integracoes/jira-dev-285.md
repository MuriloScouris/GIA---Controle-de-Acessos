# DEV-285 — Jira Cloud: implementação e validação pendente

Status: transporte implementado e testes locais de contrato/integração disponíveis;
**produção não validada**. Nenhuma operação foi executada no Jira real.

## Fronteiras e escopo

`jira/http.ts` cuida de HTTPS, Basic, timeout, retry de leitura e erros sanitizados.
`jira/origem.ts` implementa a porta da API com JQL, cursor e mapeamento.
`jira/destino.ts` implementa o cliente de contas/grupos sobre o adaptador existente.
O backend continua responsável por aprovação, vínculo, proposta, autorização e fila;
o worker registra estado e eventos na mesma transação PostgreSQL.

A API usa a origem REST quando configurada; a importação continua manual pela rota
autorizada `POST /importacoes/jira`. Não há novo polling/scheduler nesta entrega.
O worker seleciona o destino real somente para operações de modo `real`; operações
simuladas continuam no simulador e não escrevem no tenant.

## Configuração

| Variável                      | Uso                                                                       |
| ----------------------------- | ------------------------------------------------------------------------- |
| `GIA_JIRA_MODO`               | `simulado` por padrão; `real` seleciona transporte REST                   |
| `GIA_JIRA_BASE_URL`           | Origem HTTPS do site, sem usuário, senha, caminho, query ou fragmento     |
| `GIA_JIRA_EMAIL`              | Identidade técnica do Basic                                               |
| `GIA_JIRA_API_TOKEN`          | Token fornecido pelo cofre; nunca versionar nem registrar                 |
| `GIA_JIRA_TIMEOUT_MS`         | Prazo de cada HTTP, padrão 5000, intervalo 1–30000                        |
| `GIA_JIRA_ORIGEM_JSON`        | Projeto, nomes dos dois request types e caminhos dos nove campos          |
| `GIA_JIRA_ESCRITA_HABILITADA` | `false` por padrão; `true` é necessário, mas não suficiente para escrever |

Configuração inválida em modo real interrompe a montagem; não faz fallback para
fixtures. Autenticação usa e-mail + API token Basic do Jira Cloud. Este transporte
não implementa OAuth nem renovação de token: expiração/revogação produz
`JIRA_AUTENTICACAO` sem retry; a rotação pertence ao cofre/operador. Tokens com
escopo que exigem o gateway `api.atlassian.com/ex/jira/...` não são suportados por
esta composição de URL de site e precisam de configuração/adapter específico.

`GIA_JIRA_ORIGEM_JSON` tem a forma abaixo; os valores em maiúsculas são marcadores
para configuração verificada pelo administrador, não valores prontos para uso:

```json
{
  "projeto": "PROJETO",
  "tipos": {
    "celetista": "NOME_ATUAL_CELETISTA",
    "terceiro": "NOME_ATUAL_TERCEIRO"
  },
  "campos": {
    "tipoSolicitacao": "customfield_10010.requestType.name",
    "nomeCompleto": "customfield_10591",
    "cpf": "customfield_15560",
    "matricula": "customfield_15559",
    "emailCorporativo": "customfield_10594",
    "area": "customfield_10383",
    "cargo": "customfield_10381",
    "dataAdmissao": "customfield_10598",
    "gestor": "customfield_10382"
  },
  "tamanhoPagina": 50,
  "maxPaginas": 200
}
```

Os IDs acima vêm do levantamento histórico do Brain e do documento de mapeamento
do projeto anterior (consulta somente leitura); **não foram reconfirmados neste
tenant durante a DEV-285**. O campo de área e o request type terceiro precisam de
confirmação administrativa. Os nomes são filtrados em JQL e traduzidos para os
dois rótulos canônicos que o backend já reconhece. Não há filtro por ID de request
type nem exclusão por label legado, que poderia esconder chamados do novo banco.

Dados de entrada: chave, vínculo, nome, CPF, matrícula, e-mail, área, cargo, data,
e-mail do gestor. ADF é convertido em texto; select lê `value`; picker de gestor
aceita uma única pessoa com `emailAddress`. Formatos desconhecidos/ambíguos são
recusados por chamado. O relatório existente isola esses erros e preserva os
demais pedidos; campos obrigatórios ausentes não são preenchidos por suposição.

## Segurança, idempotência e falhas

- Chamados: `/rest/api/3/search/jql`, paginação `nextPageToken`, limites de página,
  rejeição de cursor repetido e deduplicação por chave na rodada. Busca falha não
  entrega um lote incompleto. Banco mantém unicidade por origem entre rodadas.
  A identificação continua pela chave da issue conforme o contrato atual; uma
  movimentação que renomeie a chave exige reconciliação administrativa.
- Conta: busca paginada pelo e-mail e comparação exata; não escolhe candidato por
  nome ou posição. E-mail oculto, duplicado, conta inativa ou portal-only impedem
  provisionamento. Consulta vazia depende da visibilidade/permissão do serviço;
  validar essa permissão é indispensável antes de liberar criação.
- Criação: `POST /rest/api/3/user`, `products: []`, nunca endpoint de customer
  portal-only. Reprocessamento reutiliza a conta encontrada. Nenhum header de
  idempotência fictício é enviado: Jira não oferece essa garantia neste endpoint.
- Grupos: consulta associação antes de adicionar/remover; repetições são no-op
  se o estado esperado já existe. Revogação remove somente grupos solicitados,
  não exclui nem desativa conta global. Conta ausente continua falha pela regra
  do domínio. Mudança concorrente durante escrita pode exigir nova conferência.
- Parcial: progresso entre grupos é preservado no resultado `parcial`; não desfaz
  grupos já aplicados. Retomada consulta estado antes de repetir cada grupo.
- HTTP: redirect recusado; abort por timeout cobre também a leitura do body.
  Prazo da operação é propagado a todos os HTTPs para impedir novas escritas após
  timeout. O worker aplica seus limites de conexão/chamada ao destino real.
- Retry: somente GET, até três tentativas, backoff exponencial com jitter e
  `Retry-After`. Atraso acima de 5s é devolvido ao chamador, não antecipado. Nenhum
  POST/DELETE tem retry no transporte, inclusive 429, timeout e 5xx.
- 401/403/4xx: códigos estáveis sem body do fornecedor. 5xx de escrita,
  timeout, resposta perdida ou 2xx inválido significam resultado desconhecido;
  worker aguarda reconciliação. Não reenviar automaticamente escrita incerta.
- Auditoria: API grava eventos do pedido; worker grava resultado + evento da
  operação atomicamente no PostgreSQL. Hook HTTP opcional recebe somente operação,
  método, tentativa, status e código. Esse hook não substitui auditoria durável.
  URLs, tokens, headers, bodies e dados pessoais não são registrados pelo cliente.

## Evidências automatizadas

- Servidor HTTP local: Basic, endpoints, cursores, projeção de campos, ADF,
  select/picker, dois vínculos, deduplicação, criação sem produtos e grupos.
- Destino real sobre servidor de contrato: parcial, retomada, revogação repetida,
  criação aplicada com resposta perdida e conferência antes de reprocessar.
- Transporte: 401/403/429/5xx, backoff, Retry-After, timeout/abort, bloqueio de
  redirect, resposta inválida e ausência de retry em escrita.
- API: origem REST, transações, erro individual, reimportação concorrente e
  eventos sem duplicidade. Worker: seleção por modo e erro real auditado em
  PostgreSQL, aguardando reconciliação sem nova escrita.

Gate: `pnpm check` com `GIA_DATABASE_URL_TESTE` apontando a PostgreSQL descartável.
Testes com servidor local/fetch controlado comprovam o contrato implementado;
não comprovam acesso, permissões ou comportamento do tenant de produção.

Na validação local de 15/10/2026, `pnpm test --concurrency=1` aprovou 631 testes
em 71 arquivos, sem skips, com PostgreSQL 17 descartável. São 22 testes novos nesta
issue. Uma rodada concorrente falhou no teste preexistente de renovação de lease
(`vi.waitFor` com janela padrão de 1s); ele passou isoladamente e na suíte completa
com menor concorrência entre pacotes. O executor e esse teste não foram alterados.
Essa ocorrência deve permanecer visível na evidência do PR e nos gates de CI.
O `pnpm check` final aprovou formatação, lint, tipos, testes e build (reutilizando
cache Turbo das verificações já aprovadas). A documentação, ignorada pelo gate
padrão de formatação do repositório, foi formatada/verificada separadamente.

## Bloqueios de produção e validação operacional

1. Não há variáveis `GIA_JIRA_*` neste terminal. Provisionar os nomes acima pelo
   cofre, com conta técnica e permissões de leitura de projeto/request types,
   busca de usuários/grupos e administração Jira para criar/alterar grupos.
2. Administrador confirma o nome atual de ambos request types e os campos com
   duas issues autorizadas, uma por vínculo. Resultado vazio não prova sucesso:
   nome alterado ou permissão insuficiente pode esconder chamados.
3. A API atual fixa `modoExecucao: 'simulado'`; `configuracaoAmbienteSchema` só
   aceita escrita global `false`. OIDC/sessão de produção e regras reais também
   não estão habilitados por esta issue. Integrar o conector não libera esse
   caminho de negócio. Depende do backend/ativação da Sprint 1, fora da fronteira
   técnica Jira. Não inserir operações reais diretamente no banco para contornar.
4. Sem habilitar escrita, validar conexão e importar as duas issues em ambiente
   autorizado com PostgreSQL; reimportar, conferir propostas, recusas e eventos.
5. Após ativação de backend e aprovação explícita para o ensaio externo, usar
   conta/grupos de teste autorizados: provisionar, conferir, repetir, revogar,
   repetir e comprovar estado no Jira e auditoria no banco. Revogação real requer
   aprovação específica; não foi executada durante este trabalho.
6. Falha parcial/indisponibilidade se ensaiam em sandbox; conferir grupos antes
   de reprocessar. Não provocar erro em usuário ou grupo produtivo.

Somente depois dessas evidências a DEV-285 pode ser fechada como funcionando em
produção. Até lá, PR permanece draft e issue permanece In Progress. Sem merge,
deploy, solicitação de revisores ou cutover do polling legado.

## Referências

- Project Brain: `Gia/integrations.md`, `architecture.md`, `workflows.md`,
  `decisions/ADR-002-somente-validacao-padrao.md` (descrevem o sistema anterior;
  não comprovam implantação deste repositório).
- [Autenticação Basic](https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/)
- [Busca JQL e cursor](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/)
- [Usuários](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-users/)
- [Grupos](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-groups/)
- [Rate limiting](https://developer.atlassian.com/cloud/jira/platform/rate-limiting/)
