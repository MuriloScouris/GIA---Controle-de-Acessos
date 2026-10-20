# ADR-0002 — Framework da interface web

Status: Aceito

## Contexto

A interface consome somente a API do Gia. A autenticação ocorre no servidor via Entra ID/OIDC, com sessão em cookie seguro e sem tokens no navegador. O escopo inicial exige telas operacionais, atualização de operações assíncronas, acessibilidade e uma aba de offboarding visível como standby.

## Opções

### 1. React + Vite

Prós:
- adequado para uma SPA que consome uma API separada;
- build e desenvolvimento simples;
- ecossistema amplo para formulários, tabelas, acessibilidade e testes;
- não cria rotas server-side nem mistura sessão do servidor com a interface.

Contras:
- exige escolher roteador, biblioteca de dados e convenções de estado;
- SEO não é prioridade, mas também não é fornecido por padrão.

### 2. Next.js

Prós:
- oferece SSR, roteamento, streaming e estrutura integrada;
- pode atender telas públicas e privadas no mesmo projeto;
- ecossistema amplo.

Contras:
- adiciona um segundo modelo de servidor à arquitetura, embora a API seja separada;
- pode incentivar chamadas diretas a serviços no frontend server-side;
- mais complexidade para uma aplicação interna operacional.

### 3. Angular

Prós:
- framework completo, com roteamento, formulários, DI e convenções fortes;
- adequado para equipes que preferem uma solução opinativa.

Contras:
- maior peso inicial;
- menor alinhamento com a estratégia de pacotes compartilhados TypeScript simples;
- exige mais decisões específicas do framework para uma primeira fatia.

## Recomendação

Adotar **React + Vite**, com roteamento explícito, cliente de API tipado a partir de `packages/contratos` e biblioteca de componentes acessíveis escolhida durante o scaffold. A web permanece uma SPA separada e nunca acessa banco, conectores ou segredos.

## Consequências

- Precisaremos escolher roteador, estratégia de cache e biblioteca de componentes no scaffold.
- Atualizações de execução podem usar polling inicialmente; a escolha de SSE ou WebSocket deve ser tratada quando houver requisito real.
- A proteção de autorização continuará obrigatoriamente no servidor.
