# ADR-0001 — Framework do backend

Status: Aceito

## Contexto

O Gia terá `apps/api` e `apps/worker` em TypeScript strict, como um monólito modular. A API deve ser sem estado e o worker precisa compartilhar domínio, contratos, persistência e configuração sem acoplar casos de uso ao transporte HTTP.

## Opções

### 1. Fastify

Prós:
- baixo overhead e bom desempenho;
- suporte maduro a TypeScript, plugins, hooks e schemas;
- não impõe uma arquitetura que conflite com as camadas do Gia;
- pode ser usado apenas na API, mantendo o worker como processo Node simples.

Contras:
- exige definir e documentar a arquitetura modular;
- parte da composição de casos de uso e autorização fica sob responsabilidade do projeto.

### 2. NestJS

Prós:
- estrutura pronta para módulos, injeção de dependências, guards e testes;
- convenções fortes para equipes maiores;
- integração ampla com recursos HTTP e observabilidade.

Contras:
- maior abstração e custo operacional;
- risco de espalhar detalhes de framework pelo domínio;
- o worker pode herdar complexidade que não precisa.

### 3. Hono

Prós:
- API pequena e moderna;
- boa experiência TypeScript;
- flexível para múltiplos runtimes.

Contras:
- menos alinhado ao requisito explícito de Node.js LTS;
- ecossistema e convenções menores para uma aplicação modular de longa duração;
- exigiria montar mais infraestrutura ao redor.

## Recomendação

Adotar **Fastify na API e Node.js puro no worker**, com casos de uso e adaptadores compartilhados em pacotes. O domínio não deve importar Fastify. Essa opção preserva desempenho, simplicidade e separação de processos sem introduzir uma estrutura pesada antes de haver necessidade.

## Consequências

- Precisaremos definir um padrão interno para módulos, composição de dependências, autorização e tratamento de erros.
- Rotas HTTP serão adaptadores finos dos casos de uso.
- O worker terá ciclo de consumo próprio e reutilizará os mesmos serviços de aplicação.
