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

`origin/main` (`6a7863f`) é ancestral da base.

### Fidelidade da pilha #12–#18

`dev-287-dependencias` reaplica os commits dos PRs #12–#18 (hashes diferentes).
Conferido arquivo a arquivo, linha a linha (todas as linhas adicionadas por cada
PR contra `main` procuradas no arquivo correspondente da pilha): nada se perdeu.
As únicas diferenças são intencionais do #20:

- `apps/api/src/index.ts`, `apps/worker/src/index.ts` e `apps/worker/src/reais.ts`
  passam a montar os conectores por `criarIntegracoesDoAmbiente`
  (`packages/conectores/src/composicao.ts`);
- `ldap.ts` lê a senha uma única vez; `segredos.ts` comprova a origem dos segredos
  e inclui `GIA_JIRA_API_TOKEN` em `SEGREDOS_EM_ARQUIVO`;
- READMEs reescritos.

## Conflitos e decisões

**#21 (OIDC na API)**

- `apps/api/src/app.ts`: mantidas as opções do #16 (saúde, métricas, smoke) e
  acrescentada `autenticacao` do #21.
- `apps/api/src/index.ts`: composição do #20 + `autenticacao:
  autenticacaoDoAmbiente(env, ambiente.config.ambiente)` em `comum`.
- Ajustes semânticos (sem conflito textual, necessários porque o #21 só libera a
  sessão simulada em desenvolvimento ou com `GIA_AUTH_SIMULADA=true`):
  `apps/api/src/jira-cloud.test.ts` ganha `GIA_AUTH_SIMULADA: 'true'`; o caso
  "fora de produção" de `apps/api/src/smoke.test.ts` declara
  `autenticacao: { modo: 'simulada' }`.

**#23 (login OIDC na UI legado)**: sem conflito.

**#19 (complemento DocuSign)**

- `packages/conectores/src/docusign/cliente.ts`: versão do #19 (timeouts).
- `packages/conectores/package.json`: scripts unidos (`docusign:verificar`).
- `README.md` dos conectores: seção DocuSign apontando para `DOCUSIGN.md`.
- `DOCUSIGN.md`, seção "Integração no worker": reescrita para a composição do #20.
- `apps/worker/src/index.ts`: fica o do #20. `apps/worker/src/docusign.ts` e
  `docusign-worker.test.ts` do #19 **removidos**: o roteamento DocuSign do worker
  é coberto por `criarIntegracoesDoAmbiente` do #20. Do #19 aproveitam-se os
  timeouts e o `docusign:verificar`.

## Reproduzir

```bash
scripts/reproduzir-integracao-sprint1.sh   # padrão: origin/dev-291-integracao-sprint1
```

Num worktree temporário: parte da base, refaz cada merge, aplica a resolução
publicada só nos arquivos em conflito, lista os ajustes semânticos de cada merge,
reaplica os commits posteriores e compara a árvore final por hash. Não altera
branches.

## Validação (local, 2026-10-15)

Postgres 17 e Samba AD (LDAPS) efêmeros em Docker; escrita externa **desligada**.

| Verificação | Resultado |
| --- | --- |
| `CI=1` format, lint, build, typecheck | OK |
| Testes | dominio 203, contratos 89, persistencia 34, web 100, conectores 240, api 128, worker 81, e2e 9 — todos passando |
| `pnpm test:e2e` (Playwright) | 7/7 |
| `smoke:integracoes --configuracao` | `escritaExterna: false`; 5 sistemas `naoConfigurado` |
| Preflight offline (#22) | código 1, `escritaHabilitada: false`, `producaoPronta: false` (esperado sem credenciais) |
| API em `production` com OIDC fictício | smoke 6/6; `/sessao/modo` = `oidc`; `/sessao/oidc/entrar` → 302 para o authorize da Microsoft; sem login simulado |
| API em `production` sem `GIA_OIDC_*` | recusa subir, listando as variáveis faltantes |

## Bloqueios para merge

1. **Ordem de merge.** #12–#18 chegam à `main` pela pilha `dev-287-dependencias`
   com hashes reaplicados; mesclar os PRs originais e a pilha geraria conflitos
   e duplicação. Recomendação: mesclar este branch (ou a pilha #20/#22 seguida
   dos merges acima) e fechar #12–#18 e #19 como absorvidos.
2. **#19**: o roteamento DocuSign no worker foi substituído pelo #20; só
   timeouts e `docusign:verificar` permanecem.
3. **Drafts**: #13, #15, #17, #20 e #22 ainda estão em rascunho.
4. **Sem validação real**: nenhuma credencial/tenant real para AD, M365,
   DocuSign, SoftExpert, Jira e Entra ID. **Produção não está pronta**; o
   preflight confirma `producaoPronta: false`.
5. **Sessões em memória**: não suportam mais de uma instância da API.
6. **SoftExpert**: `disableUser` não conferido contra o serviço real; produção
   exige conta de serviço.
7. **Senha inicial** do colaborador: sem decisão de como entregar.
8. **Planos alternativos de licença M365**: decisão de produto pendente.
9. **UI**: a faixa "Ambiente com dados de exemplo" é fixa, inclusive em produção.
