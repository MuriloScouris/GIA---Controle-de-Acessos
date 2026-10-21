# CLAUDE.md — New GIA (Controle de Acessos)

Instruções para agentes Claude neste repositório. O que o sistema faz, arquitetura e como rodar
estão no [README](README.md); decisões em [`docs/adr`](docs/adr); status de cada módulo em
[`docs/gia-estrutura-e-funcionalidades.md`](docs/gia-estrutura-e-funcionalidades.md).

@AGENTS.md

## Regras inegociáveis

- **Nunca codar na `main`.** Cada issue do Linear = 1 branch + 1 worktree em
  `C:/Users/ft.murilo/antigravity/new-gia-wt/<ID>`. O nome da branch é o campo `branchName` da
  issue no Linear (assim a issue e o PR ficam vinculados automaticamente).
- Commits com o ID da issue (`DEV-312: ...`); PR com título `<ID>: <título>` e `Closes <ID>` no corpo.
- **Escrita externa nasce desligada** (`GIA_ESCRITA_EXTERNA=false`). Nunca ligue escrita real em
  AD, Microsoft 365, DocuSign, SoftExpert ou Jira sem pedido explícito do Murilo.
- Nada de segredos em código, commits, PRs, issues, notas ou logs.
- Código e textos em português do Brasil, seguindo o vocabulário do domínio (`pedido`, `revisao`,
  `item`, `operacao`...).

## Comandos

```sh
pnpm install
pnpm check                         # format:check + lint + typecheck + test + build (gate do PR)
pnpm --filter @gia/<pacote> test   # testes de um pacote
pnpm test:e2e                      # build + Playwright (exige GIA_DATABASE_URL_TESTE)
```

Testes: siga a seção "Carga e tempo" do README (fake timers em vez de janelas reais, nada de
aumentar timeout global).

## Ambiente local nesta máquina

As portas padrão do README colidem com outros projetos — use estas:

| Porta  | O quê                                                                                   |
| ------ | --------------------------------------------------------------------------------------- |
| `3000` | **Não é do GIA** (Docker `itam-backend`). Nunca aponte o web para ela.                  |
| `5173` | **Não é do GIA** (Docker `ad-manager-frontend`).                                        |
| `3100` | API da `main` (`PORT=3100 GIA_AMBIENTE=desenvolvimento`)                                |
| `5180` | Web da `main` (`GIA_API_PORT=3100 pnpm --filter @gia/web dev --port 5180 --strictPort`) |
| `3101` | API da branch em trabalho (worktree)                                                    |
| `5181` | Web da branch em trabalho (`GIA_API_PORT=3101 ... --port 5181`)                         |

A API exige `pnpm build` antes de `pnpm --filter @gia/api start`. Sem `GIA_DATABASE_URL` ela usa
persistência em memória com login simulado.

## Time de agentes (Maestri)

Os roles dos agentes são os globais `Partitura · *`; a configuração do time (Linear, serviços,
portais, portas proibidas) está na seção [Partitura](#partitura), no fim deste arquivo.

| Agente        | Papel                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------------- |
| `Claude Code` | Maestro: cria issues no Linear, despacha, valida no portal, mantém o `Painel`. Não escreve código. |
| `Bigorna`     | Dev: único que escreve código. Uma issue por vez, worktree próprio, abre o PR.                     |
| `Faísca`      | Ideador: ideias na nota `Ideias`; só viram issue com aprovação do Murilo.                          |
| `Coruja`      | Revisor de segurança: só age quando o Murilo pedir.                                                |
| `Caldeira`    | Terminal Shell que mantém API `:3100` e web `:5180` da `main` no ar.                               |

Portais: `GIA Web` mostra a `main` (`:5180`) e `GIA Branch` mostra a branch em trabalho (`:5181`),
para comparar antes/depois na mesma rota.

Fluxo: pedido → issue no Linear → Bigorna implementa no worktree → `pnpm check` → PR → validação
visual nos dois portais → merge só com OK do Murilo → Done.

## Partitura

Configuração do time de agentes Maestri deste projeto (skill `/partitura`, roles globais
`Partitura · *`). Os agentes leem esta seção; mantenha-a atualizada.

```yaml
projeto: New GIA - Controle de Acessos
sigla: GIA
workspace_maestri: New Gia - Gestão de acessos
repo: https://github.com/MuriloScouris/GIA---Controle-de-Acessos
branch_padrao: main
clone_main: C:/Users/ft.murilo/antigravity/new-gia
worktrees: C:/Users/ft.murilo/antigravity/new-gia-wt/<ID>

linear:
  team_id: 4e9fd532-67df-45c7-8fa5-fea6bd4e0dda # DEV "Time-dev-ia"
  project_id: 93d36750-193a-452d-8128-d747d2fc9cb2 # New Gia - Controle de acessos
  estados:
    backlog: d67a9a36-81c0-436b-89b0-3b884e87463e
    todo: f66da1a6-d2d8-4a95-a2fc-df6aa7d1451e
    in_progress: f86c42e7-2c9b-4190-a2e9-8741996c47dd
    in_review: 489c5e7d-0d62-4af1-a222-32edaba96d37
    done: 15764e65-fa8c-4748-b085-fc1e03bcf432
    canceled: 0e2dbe4a-ec50-4eed-af48-2d3202929f4d
  labels:
    Bug: ab5d5de8-0482-46b4-bfe7-85034dc04824
    Feature: 900606ef-0f96-4c54-85a5-aa2d4e546e29
    Improvement: 2f1a52a4-0117-414f-aea1-caa1ab537b0d
    risk:high: cbd1045e-03b3-4e18-b9e0-ef250d0158ea
    needs-human: 07c182ca-578d-4685-84d6-9e53dc9930f8

comandos:
  instalar: pnpm install
  check: pnpm check
  build: pnpm build

servicos:
  main: # terminal "Caldeira", a partir de clone_main (pnpm build antes da API)
    api: PORT=3100 GIA_AMBIENTE=desenvolvimento pnpm --filter @gia/api start
    web: GIA_API_PORT=3100 pnpm --filter @gia/web dev --port 5180 --strictPort
    url: http://localhost:5180
  branch: # Bigorna, a partir do worktree (pnpm build antes da API)
    api: PORT=3101 GIA_AMBIENTE=desenvolvimento pnpm --filter @gia/api start
    web: GIA_API_PORT=3101 pnpm --filter @gia/web dev --port 5181 --strictPort
    url: http://localhost:5181

portais:
  main: GIA Web
  branch: GIA Branch

portas_proibidas: [3000, 3001, 5173, 5433, 54322, 54323]
```
