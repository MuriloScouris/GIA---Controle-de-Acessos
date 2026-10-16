# DEV-287 — Estratégia para integrar os PRs abertos

Sem merge, deploy ou alteração dos branches de origem/main. Worktree próprio `DEV-287`,
branch `dev-287-conectores-worker-controlados`. Base isolada `dev-287-dependencias`, commit
`5dc703e`, contém cópias via cherry-pick dos seguintes snapshots:

| PR            | Branch de origem                        | Head consultado                          |
| ------------- | --------------------------------------- | ---------------------------------------- |
| #12 / DEV-281 | dev-281-conector-ad-producao            | 677f4aebc5ef9bd88d6bdb0c3e59e26e3b032eb2 |
| #13 / DEV-283 | dev-283-docusign-producao               | f7d315147a59fb4c5441abfb0b15cd976159eae7 |
| #14 / DEV-284 | dev-284-conector-softexpert-producao    | 2be9c428efea41c04d086a8e1613d9b3f5081a0d |
| #15 / DEV-285 | dev-285-conector-jira-producao          | 948f77d764690e023410d8481518456edacfd002 |
| #16 / DEV-280 | dev-280-producao-segura-observabilidade | 12742e71ce8bebeaf0bbc550ec4a455a4e64d20b |
| #17 / DEV-286 | dev-286-onboarding-e2e-validacao        | 6bee9ddf782656002df0b60ae9f307059f70d96b |

O PR #18 / DEV-282 (`dev-282-conector-m365-producao`, head
`b07552c40720a09d7522dd412c855230a19ea1c6`) foi aberto durante a implementacao.
Foi incorporado em seguida, sem alterar o branch de origem nem manter cliente Graph duplicado.

Sequência sobre `6a7863f`: `073932b 12cc95e 677f4ae f7d3151 cb0a818 7d1f93c 2be9c42
948f77d 7e920c0 1046048 8a44e6a 12742e7 f166dfe 6bee9dd 6bef133 390eca0 b07552c`.
Os novos hashes dos cherry-picks são esperados e não substituem os heads de origem.
Essa base reúne implementações para teste conjunto, não representa PRs aprovados/entrados.

Conflitos resolvidos preservando ambas as intenções:

- README/exports de conectores: conteúdo aditivo AD, DocuSign, SoftExpert e Jira;
  scripts `ad:verificar` e `softexpert:verificar` preservados.
- API index: origem Jira junto de gates, segredos, prontidão e métricas do #16.
- Worker index: montagem Jira junto dos gates do #16; a DEV-287 substitui a montagem mista
  pela composição central explícita. Regra: simulado nunca é a ausência de um transporte real.
- README raiz/exports contratos: operação #16 e histórico/E2E #17 preservados.
- CI conserva Samba AD do #12 e Chromium do #17; lockfile conserva ldapts e Playwright.

PR da DEV-287 aponta inicialmente para `dev-287-dependencias` para exibir somente seu delta.
Não aprovar/mergear essa base cumulativa em paralelo aos PRs originais: duplicaria as entregas.
No fechamento da sprint, responsável pelo merge deve:

1. Revisar e integrar #12–#15 e #18, depois #16 e #17 (estes dois independentes entre si, com
   resoluções aditivas indicadas acima). Revalidar os heads se os PRs mudarem.
2. Em branch própria a partir da main resultante, reaplicar **somente** commits posteriores a
   `dev-287-dependencias`, preservando código novo das dependências. Não escolher versões inteiras
   de arquivos em conflitos de composição. Preservar o ClienteGraphHttp do #18 e sua porta ClienteGraph.
3. Comparar o delta com este PR, rodar todos os gates com PostgreSQL/Samba/Chromium, atualizar o
   branch do PR e retargetar a base para main. Nenhum force-push/merge é executado nesta entrega.
4. Manter bloqueios de credencial/ensaio até evidência autorizada. Revisão somente no fechamento.

A UI de #17 foi somente trazida como dependência. O delta da DEV-287 não modifica `apps/web`
nem os worktrees da UI legado. A main e os sete branches originais ficam intactos.
