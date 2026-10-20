# ADR-0006 — Ferramentas de monorepo, testes e lint

Status: Aceito

## Contexto

O Gia terá apps e pacotes TypeScript compartilhados, precisa de build, lint, typecheck e testes na CI desde o scaffold. A execução local deve ser simples e a estrutura deve permitir cache e execução somente do que mudou.

## Opções

### 1. pnpm workspaces + Turborepo + Vitest + ESLint + Prettier

Prós:
- pnpm economiza espaço e oferece workspaces maduros;
- Turborepo organiza dependências e cache entre apps/pacotes;
- Vitest é rápido e alinhado ao ecossistema Vite;
- ESLint e Prettier são conhecidos e amplamente integrados.

Contras:
- cinco ferramentas e arquivos de configuração iniciais;
- Turborepo adiciona uma camada que pode ser desnecessária em um repositório pequeno.

### 2. pnpm workspaces + Nx + Vitest + ESLint + Prettier

Prós:
- grafo de projetos, cache e geração mais completos;
- boa governança para monorepos grandes;
- suporte a limites entre projetos.

Contras:
- maior complexidade e convenções próprias;
- risco de configurar mais plataforma do que o primeiro ciclo precisa.

### 3. npm workspaces + scripts nativos + Vitest + ESLint + Prettier

Prós:
- menor número de ferramentas;
- vem junto com Node.js;
- fácil de entender no scaffold inicial.

Contras:
- menos cache e orquestração entre projetos;
- scripts podem crescer de forma desigual;
- menor eficiência quando a quantidade de pacotes aumentar.

## Recomendação

Adotar **pnpm workspaces + Turborepo**, com **Vitest** para testes, **ESLint** para análise estática e **Prettier** para formatação. Usar scripts simples por pacote e pipelines `build`, `lint`, `typecheck` e `test` orquestrados pelo Turborepo.

## Consequências

- A CI poderá executar tarefas em paralelo e reutilizar cache.
- Cada pacote terá configuração explícita e não dependerá de imports internos não declarados.
- O scaffold deve incluir testes unitários de domínio, testes de persistência e testes ponta a ponta simulados sem chamadas reais.
