# Integração da Sprint 1 (DEV-291)

Branch `dev-291-integracao-sprint1`: todos os PRs abertos da sprint compostos num
único histórico, validados juntos. **Não é merge nem deploy**; serve como gate
técnico e como ordem de merge verificável.

## Composição

| Passo | Ref | PR | Hash | Como entrou |
| --- | --- | --- | --- | --- |
| base | `origin/dev-289-preflight-producao` | #22 (DEV-289) | `7d205b1` | ponto de partida |
| ↳ | `origin/dev-287-conectores-worker-controlados` | #20 (DEV-287) | `865b6e3` | já contido na base |
| ↳ | `origin/dev-287-dependencias` | #12–#18 | `5dc703e` | já contido na base (commits reaplicados) |
| 1 | `origin/dev-288-login-entra-oidc` | #21 (DEV-288) | `c40a6eb` | `merge --no-ff` → `9555e5f` |
| 2 | `origin/dev-290-login-oidc-ui-legado` | #23 (DEV-290) | `e0a89d2` | `merge --no-ff` → `115e1a4` (limpo) |
| 3 | `origin/dev-283-docusign-complemento` | #19 (DEV-283) | `ecdf910` | `merge --no-ff` → `bfa15da` |
| 4 | correções da revisão do #25 | — | — | commits `6d14836`…`66cf59f` (abaixo) |
| 5 | `origin/dev-292-matriz-prontidao` | #24 (DEV-292) | `100c21c` | `merge --no-ff` → `07e0502` (limpo) |

`origin/main` (`6a7863f`) é ancestral da base. Os heads acima estão fixados em
[`sprint1-manifesto.json`](sprint1-manifesto.json).

## Verificação independente

```bash
node scripts/verificar-integracao-sprint1.mjs            # alvo: HEAD
node scripts/verificar-integracao-sprint1.mjs --detalhe  # lista cada linha ausente
```

O verificador **não usa os merges publicados nem as resoluções deles**; parte só
dos commits de origem de cada PR:

0. **Hash dos arquivos declarados:** todo arquivo declarado como exceção tem o
   hash do blob git fixado em `blobs` no manifesto. Isso vale para substituição,
   ajuste ou conflito, inclusive `apps/api/src/index.ts` e
   `apps/worker/src/index.ts`. Declarar um arquivo não libera conteúdo novo
   nele: um desvio como `GIA_BACKDOOR=1 -> sessão simulada` falha com saída 1.
   Este passo não precisa das refs dos PRs (`--somente-blobs`). Mudança
   legítima exige regravar o hash (`--gravar-blobs`), e o diff do manifesto
   mostra o que mudou para a revisão. O teste
   `tests/e2e/verificador-integracao.test.ts` injeta esse desvio, num
   repositório isolado e no real, e confirma a falha.
1. **Fixação:** o head de cada PR no GitHub ainda é o integrado. Se um PR andar,
   o verificador falha e pede reintegração.
2. **Preservação:** toda linha que cada PR adiciona (contra a própria base) tem
   de existir no alvo, e todo arquivo que ele cria tem de continuar lá. Também
   informa se o PR é ancestral do alvo e quantos commits não têm patch
   equivalente (`git cherry`; esperado para #12–#18, reaplicados).
3. **Reconstrução do zero:** num worktree temporário, a partir de
   `origin/main`, aplica a contribuição de cada PR na ordem do manifesto
   (`git apply --3way`). Conflito é resolvido por união mecânica dos dois
   lados. A árvore obtida é comparada com o alvo.

Toda diferença precisa estar declarada no manifesto, em uma de três listas:
`substituicoes` (por PR e arquivo, com motivo e o teste que cobre o
comportamento), `ajustesIntegracao` (mudanças desta integração) e
`conflitosPorUniao` (arquivos que a união mecânica não resolve igual à mão).
Sem declaração, o verificador sai 1. Teste negativo: apagar uma linha do OIDC
do #21 num commit temporário faz o verificador falhar nos passos 2 e 3.

Resultado no HEAD desta integração: 0 linhas perdidas sem declaração em 13 PRs.
O que foi substituído de propósito:

- **#15/#16/#19 → #20:** o roteamento por sistema no worker (Jira do #15,
  stub `reais.ts` do #16, `docusign.ts` do #19) virou
  `criarIntegracoesDoAmbiente` + `aplicarGatesDeEscrita`. O próprio
  `docusign.ts` previa essa troca.
- **#16 → #20:** `segredos.ts` endurecido (comprovação de origem, token do
  Jira por arquivo).
- **#20 → #22:** `fetchComPrazo` virou fábrica com transporte injetável.
- **Textos de estado** (READMEs, cabeçalhos) reescritos pelos PRs seguintes.
- **Correções da revisão do #25** (abaixo).

### `docusign.ts` do #19

A remoção foi conferida. Todos os casos de `docusign-worker.test.ts` do #19
foram portados para `apps/worker/src/docusign-composicao.test.ts`, sobre a
composição atual:

- sem configuração, nada muda;
- configuração parcial impede a subida, citando só os nomes;
- chave lida do cofre;
- operação simulada vai ao simulador e a real ao conector real;
- operação real sem conector termina em `semEfeito`, sem tocar o simulador;
- executor sobre PostgreSQL.

Há uma diferença intencional: o #19 ligava o DocuSign real com qualquer
`GIA_DOCUSIGN_*` presente. O #20 exige `GIA_DOCUSIGN_MODO=real`, porque a
seleção nunca é inferida de uma credencial. Do #19 permanecem os timeouts do
cliente e o `docusign:verificar`.

## Conflitos e decisões dos merges

**#21 (OIDC na API)**

- `apps/api/src/app.ts`: mantidas as opções do #16 (saúde, métricas, smoke) e
  acrescentada a `autenticacao` do #21.
- `apps/api/src/index.ts`: composição do #20 mais a `autenticacao` em `comum`.
- Ajustes semânticos: `jira-cloud.test.ts` e o caso "fora de produção" de
  `smoke.test.ts` passam a declarar a sessão simulada, que o #21 só libera com
  opt-in fora de desenvolvimento.

**#23 e #24:** sem conflito.

**#19 (complemento DocuSign)**

- `cliente.ts`: fica a versão do #19, com os timeouts.
- `package.json`: scripts unidos.
- `DOCUSIGN.md`: a seção "Integração no worker" foi reescrita para a
  composição do #20.
- `apps/worker/src/index.ts`: fica o do #20; `docusign.ts` e o teste dele saem
  (ver acima).

## Correções da revisão do #25

1. **Sessão simulada fail-closed** (`6d14836`): o padrão `desenvolvimento` da
   configuração não basta mais. A sessão simulada exige `GIA_AMBIENTE`
   declarado como `desenvolvimento`, ou como `teste` com
   `GIA_AUTH_SIMULADA=true`. Sem a variável, a API sobe sem login
   (`/sessao/modo` = `indisponivel`) e `POST /sessao/simulada` responde 404,
   mesmo com `GIA_AUTH_SIMULADA=true`.
2. **Verificador independente** (`9a4d9b0`): substitui o script de reprodução
   anterior, que recriava a árvore a partir dos próprios merges publicados.
3. **Privilégio mínimo da API** (`92b553a`): a API passa a usar
   `criarLeiturasDoAmbiente`, que valida a configuração de todo sistema
   selecionado. Ela só abre os segredos das leituras que usa: diretório
   (AD + M365, juntos) e origem Jira. A chave do DocuSign e a credencial do
   SoftExpert nunca são lidas pela API.
4. **`migrar` com `GIA_DATABASE_URL_ARQUIVO`** (`b6276be`): usa o mesmo
   resolvedor de segredos da API e do worker. Em produção, URL com senha por
   valor é recusada. Erros do driver não são impressos.
5. **Runbook** (`366d6ec`): `docs/operacao/producao.md` e o README da API
   descrevem o estado real. O OIDC e os conectores existem, sem validação
   real. A tabela inclui `GIA_<SISTEMA>_MODO`, `GIA_OIDC_*` e
   `GIA_AUTH_SIMULADA`.

## Itens médios da revisão

Os 10 itens de severidade média da 1ª rodada estão registrados, com status
`pendente`, em
[`docs/operacao/pendencias-medias-sprint1.md`](../operacao/pendencias-medias-sprint1.md).
Não bloqueiam o merge técnico, mas bloqueiam a liberação em produção.

## Validação (local, 2026-10-15)

Postgres 17 e Samba AD (LDAPS) efêmeros em Docker, como no CI. A escrita
externa ficou **desligada**.

| Verificação | Resultado |
| --- | --- |
| `node scripts/verificar-integracao-sprint1.mjs` | OK (13 PRs, reconstrução confere) |
| `format:check`, lint, typecheck, build | OK |
| Testes | dominio 203, contratos 89, documentos 7, web 100, conectores 243, persistencia 38, api 130, worker 123, e2e 9 — todos passando (AD real no Samba) |
| Playwright (`test:browser`) | 7/7 |
| `smoke:integracoes --configuracao` | `escritaExterna: false`; 5 sistemas `naoConfigurado` |
| `preflight --offline` (#22) | código 1, `escritaHabilitada: false`, `producaoPronta: false` |
| `prontidao` (#24) | código 1, `NO_GO`, 62 itens pendentes |
| API real sem `GIA_AMBIENTE` | `/sessao/modo` = `indisponivel`; `POST /sessao/simulada` → 404 |
| API real com `GIA_AMBIENTE=desenvolvimento` | sessão simulada abre (201) |

## Bloqueios para merge

1. **Ordem de merge.** Os #12–#18 chegam à `main` pela pilha
   `dev-287-dependencias`, com hashes reaplicados. Mesclar também os PRs
   originais geraria conflitos e duplicação. Recomendação: mesclar este branch
   e fechar os #12–#24 (exceto este) como absorvidos.
2. **Drafts:** #13, #15, #17, #20 e #22 ainda estão em rascunho.
3. **Sem validação real:** nenhuma credencial ou tenant real para AD, M365,
   DocuSign, SoftExpert, Jira e Entra ID. **Produção não está pronta**: o
   preflight dá `producaoPronta: false` e a matriz, `NO_GO`.
4. **Sessões em memória:** a API não suporta mais de uma instância.
5. **Mesma credencial para ler e escrever:** a API usa as mesmas contas de
   serviço do worker (AD, M365, Jira). Contas só de leitura ainda não existem.
6. **SoftExpert:** o `disableUser` não foi conferido no serviço real.
7. **Senha inicial** do colaborador: sem decisão de entrega.
8. **Planos alternativos de licença M365:** decisão de produto pendente.
9. **UI:** a faixa "Ambiente com dados de exemplo" é fixa.
