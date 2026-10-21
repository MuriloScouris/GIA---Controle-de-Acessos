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
