# New GIA - Controle de Acessos

Projeto desenvolvido por um time de agentes orquestrado no Maestri (Maestro Hermes + Dev Opus + Dev Sonnet + Revisor Terra + Revisor Sol).

Fluxo: issue no Linear -> branch/worktree por issue -> PR -> CI -> revisão independente -> merge squash -> Done.

## Desenvolvimento

Requer Node.js >= 22 e pnpm (versão fixada em `packageManager`).

```
pnpm install
pnpm build        # turbo run build
pnpm lint
pnpm typecheck
pnpm test
pnpm check        # format:check + lint + typecheck + test + build
```

Estrutura: `apps/{api,worker,web}`, `packages/{dominio,contratos,conectores,persistencia,documentos}`, `tests/`.
O scaffold não contém regra de negócio nem integrações reais; a escrita externa é desligada por padrão.
