# DEV-286 — Onboarding ponta a ponta e validação operacional

Status: implementação e ensaio local automatizado; **produção não validada**.
Nenhuma credencial produtiva foi fornecida e nenhuma operação externa foi autorizada
ou executada nesta issue. Nenhum merge ou deploy faz parte da entrega.

## Escopo implementado

- Navegador Chromium real → SPA compilada → HTTP local → API → PostgreSQL 17
  descartável → executor real do worker → cinco conectores sobre simuladores.
  O navegador não recebe respostas de negócio fabricadas no caminho de sucesso.
  As falhas de rede são injetadas somente nos casos que as verificam.
- Importar, revisar identidade, aprovar, rejeitar com motivo, reabrir, solicitar
  execução, acompanhar resultado por sistema e consultar o histórico persistido.
- Perda da resposta de um comando depois do commit não significa falha da decisão:
  a aba fecha a confirmação, avisa sobre resultado desconhecido e relê o pedido.
  Não repete a escrita. 5xx ou 2xx fora do contrato de comando também são incertos;
  recusas 4xx preservam o código do servidor.
- `GET /pedidos/:pedidoId/historico?limite=25&cursor=<evento>`: metadados de
  auditoria, mais recentes por ordem de inserção. Máximo de 100 por página;
  cursor é o UUID de um evento do próprio pedido. Índice `(pedido_id, ordem)`
  existente, sem migração. Cursor de outro pedido não revela eventos.
- Retorna tipo, instante, ator, origem, sistema, IDs de operação/correlação e
  referência de correção. Não retorna snapshots `antes/depois`, payloads de
  fornecedor nem dados RH. Aplica a projeção de dados pessoais existente.
  O registro completo continua imutável no banco; esta rota é uma consulta de
  metadados, não uma exportação dos snapshots de auditoria.
- Auditor e Administrador do GIA consultam histórico persistido; os outros
  papéis recebem 403. A aba mantém o resumo de estados existente para quem não
  possui essa permissão. Autorização é sempre revalidada no servidor.
- Consulta da timeline trata carregamento, vazio, falha transitória, paginação e
  perda de permissão. Usa os componentes/classes existentes, sem alterar CSS,
  tokens, navegação ou o worktree da UI legado.

## Evidência automatizada e reprodução

```sh
pnpm install --frozen-lockfile
pnpm --filter @gia/tests exec playwright install chromium
# Definir GIA_DATABASE_URL_TESTE para PostgreSQL descartável com CREATE DATABASE.
pnpm check
pnpm test:e2e
```

`pnpm test:e2e` compila a aplicação e executa o Playwright com um worker e sem
retries. Cada teste cria banco, API e servidor de arquivos/proxy locais próprios;
o worker é acionado pelo teste sobre a mesma persistência. Não há endpoint de
controle/teste na API de produção, nem liberação de escrita real escondida no
harness. Tráfego do navegador fora de loopback é bloqueado. Sem variável de banco,
o gate de navegador falha: não pula os testes em silêncio.

O proxy do harness reproduz o prefixo `/api` localmente. Isso **não** valida o
reverse proxy, TLS, cookies ou hospedagem de produção, que exigem o ensaio abaixo.

| Cenário                           | Evidência                                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| Revisão → rejeição → reabertura   | Identidade editada, motivo obrigatório, nenhum acesso criado, eventos preservados                   |
| Aprovação concorrente             | Segunda sessão altera a versão; aba recebe 409, fecha confirmação e exige releitura                 |
| Carregamento/503/recuperação/401  | Estados visíveis; retomada de leitura; sessão expirada remove detalhe da tela                       |
| Permissão por papel               | Auditor não tem ações de escrita; perfil local forjado não muda autorização da API                  |
| Parcial e timeout isolados        | AD parcial e Jira desconhecido não escondem sucesso dos demais; nova simulação explícita só do Jira |
| Resposta perdida depois do commit | Decisão persistida, nenhum POST repetido, alerta e estado atualizado                                |
| Cinco conectores e auditoria      | Resultado por sistema, simulação não confirma acesso real; paginação do histórico sem duplicatas    |

Testes da API também cobrem 401/403, Administrador do GIA, cursor cruzado e query
inválida; testes da interface cobrem histórico, paginação, falha e perda de permissão.
O CI executa os gates normais e o navegador com PostgreSQL. Em falha, anexa traces,
capturas e relatório por sete dias; artefatos de teste não entram em lint ou Git.

Evidência local em 15/10/2026: `pnpm check` aprovado (formatação, lint, tipos,
testes e build); suíte completa de unidade/integração com PostgreSQL: 612 testes
em 69 arquivos, sem skips. Foi executada com `pnpm test --concurrency=1` e o
gate final reutilizou cache Turbo das verificações aprovadas. `pnpm test:e2e`
aprovou os sete cenários de navegador, sem retries; a captura do histórico foi
inspecionada. São três testes novos de unidade/integração e sete de navegador.
Esses números não incluem os testes adicionais dos PRs #12–#15 ainda abertos.

## Dependências dos PRs abertos

Base desta branch: main `6a7863f`. Nenhum PR foi mesclado/cherry-picked nesta issue.

| Dependência                                                                            | Conteúdo / limite conhecido                                       | Integração necessária no fechamento da sprint                                   |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [PR #12 / DEV-281](https://github.com/MuriloScouris/GIA---Controle-de-Acessos/pull/12) | AD LDAPS; integração Samba no CI; ativação real pendente          | Preservar steps/env do Samba ao combinar com o novo gate de navegador           |
| [PR #13 / DEV-283](https://github.com/MuriloScouris/GIA---Controle-de-Acessos/pull/13) | DocuSign JWT/REST; credenciais e composição real pendentes        | Ensaiar consentimento, conta/perfil/grupo e resultado real                      |
| [PR #14 / DEV-284](https://github.com/MuriloScouris/GIA---Controle-de-Acessos/pull/14) | SoftExpert SOAP; conta técnica e contrato de revogação pendentes  | Confirmar WSDL/contrato e parametrização real                                   |
| [PR #15 / DEV-285](https://github.com/MuriloScouris/GIA---Controle-de-Acessos/pull/15) | Jira Cloud real opt-in; campos/request types e ativação pendentes | Usar a origem real em vez das fixtures, mantendo as novas rotas de histórico    |
| DEV-282                                                                                | Microsoft 365 ainda Todo na auditoria desta issue                 | Licenciamento real, espera AD → Entra, grupos e remoção precisam de evidência   |
| DEV-280                                                                                | Produção segura/observabilidade em andamento                      | Flags por conector/operação, credenciais, health/readiness, métricas e rollback |

As alterações desta issue evitam os clientes, adaptadores, motor e catálogo de
conectores. Sobreposições aditivas: `.github/workflows/ci.yml` com #12 e
`pnpm-lock.yaml` com #12/#15. Reconciliar o workflow preservando ambos os gates e
recalcular o lockfile; não substituir esses arquivos pela versão de uma branch.
Depois da integração aprovada, repetir todos os gates sobre o commit combinado.

## Checklist de go-live — pendente de ambiente e autorização

Não marcar itens abaixo usando o ensaio local simulado. Registrar responsável,
data, commit, ambiente e link da evidência para cada item concluído; nunca anexar
tokens, cookies, senhas, CPF, matrícula ou payloads pessoais aos tickets/relatórios.

- [ ] Integrar os PRs aprovados da sprint e executar gates no commit resultante.
- [ ] Concluir DEV-282 e a composição real dos cinco sistemas. A API desta base
      fixa `modoExecucao: simulado`; `GIA_ESCRITA_EXTERNA` só aceita `false`.
      O worker padrão também usa o catálogo simulado. Não contornar por SQL direto.
- [ ] Configurar OIDC/sessão segura e mapear grupos para papéis no servidor.
      O picker e o perfil local são demonstração; produção não possui login simulado.
      Não habilitá-lo para obter uma evidência de produção.
- [ ] Substituir regras, cadastros e consulta de identidade fictícios da API
      por dependências aprovadas. “Livre” no diretório simulado não comprova ausência
      de conflito no AD/Entra real.
- [ ] Provisionar segredos no cofre e confirmar tenant, contas técnicas, escopos,
      consentimentos, certificados e permissões mínimas de cada integração.
- [ ] Confirmar projeto/request types e campos atuais do Jira, uma issue autorizada
      por vínculo, sem presumir que lista vazia prova sincronização correta.
- [ ] Validar HTTPS, prefixo `/api`, cookies HttpOnly/Secure/SameSite, CSRF, sessão
      expirada, timeout do proxy e fallback de rotas SPA no ambiente de destino.
- [ ] Aplicar migrações aprovadas; comprovar backup/restauração e retenção de
      auditoria. Verificar conectividade de API e worker ao mesmo banco e leases.
- [ ] Definir quem libera escrita por conector/operação, somente após aprovação;
      default permanece desligado. Definir interrupção de consumo e rollback com DEV-280.
- [ ] Obter aprovação explícita do ensaio externo com issues, contas, OUs, grupos,
      licenças e responsáveis delimitados. Revogação/limpeza precisam de aprovação própria.
- [ ] Importar as duas issues autorizadas e repetir a importação: um pedido por
      origem, proposta correta por vínculo, recusas isoladas e auditoria da entrada.
- [ ] Com contas OIDC distintas, comprovar revisão/edição, aprovação/rejeição,
      execução pelo papel permitido, auditor somente leitura e negativas 401/403/404/409.
- [ ] Aprovar sem executar; conferir que a decisão não criou acesso. Solicitar
      execução separadamente; conferir operações, dependência AD → Entra/M365 e estado
      real dos cinco destinos, não apenas uma mensagem verde na aba.
- [ ] Ensaiar parcial, throttling, indisponibilidade e resposta perdida em sandbox.
      Não provocar erro em usuários produtivos. Resultado incerto exige conferência
      e reconciliação; os endpoints reais de conferência/reconciliação ainda não estão
      disponíveis nesta base, portanto esse tratamento bloqueia go-live completo.
- [ ] Comprovar que reprocessamento afeta apenas falhas elegíveis, preserva etapas
      concluídas e não repete sucesso confirmado. Simulação não vale como essa prova real.
- [ ] Conferir metadados de histórico e auditoria persistida com ator, correlação,
      pedido e operação. Correções são novos eventos, sem alterar o original.

## Checklist pós-deploy — executar após deploy autorizado

- [ ] Conferir commit efetivamente implantado e flags fechadas antes do smoke.
- [ ] Verificar `/saude`, banco, fila, leases e conectividade dos destinos
      separadamente; `/saude` sozinho é liveness, não comprova prontidão produtiva.
- [ ] Testar login, papéis e leitura da aba sem permissões extras nem perfis demo.
- [ ] Executar somente o ensaio aprovado acima; conferir resultados no destino
      e no banco. Guardar apenas referências técnicas de evidência, sem dados pessoais.
- [ ] Monitorar falhas/429, latência, operações sem progresso, leases vencidos e
      fila de reconciliação pela janela operacional definida com DEV-280.
- [ ] Se houver resultado desconhecido, impedir repetição automática de escrita,
      conferir externamente e registrar reconciliação. Não apagar operações/eventos.
- [ ] Em rollback, fechar flags e suspender novas reservas pelo procedimento
      aprovado; preservar auditoria e reconciliar o que já estava em voo. Voltar uma
      versão do código não desfaz acesso já concedido em sistema externo.
- [ ] Executar limpeza/revogação aprovada, atestar os destinos e registrar o resultado.
- [ ] Fechar DEV-286 somente quando houver evidência real, responsável e aceite.

## Conhecimento para o Brain

O resumo derivado da timeline continua útil para acompanhamento, mas não era uma
consulta de auditoria. A nova rota lê metadados do registro imutável por pedido,
com paginação estável e permissão explícita. A validação de navegador agora cruza
SPA/API/banco/worker em vez de apenas injetar HTTP ou simular o cliente da tela.
Isso comprova o fluxo local; não elimina as dependências de autenticação, configuração,
conectores reais, reconciliação e autorização do ensaio de produção.

Referências do harness: [fixtures Playwright](https://playwright.dev/docs/test-fixtures)
e [CI Playwright](https://playwright.dev/docs/ci-intro).
