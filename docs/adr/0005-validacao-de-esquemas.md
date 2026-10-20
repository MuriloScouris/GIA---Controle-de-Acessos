# ADR-0005 — Biblioteca de validação de esquemas

Status: Aceito

## Contexto

Contratos compartilhados precisam ser usados pela API e pela web, mas também validados em runtime nas fronteiras HTTP, Jira e respostas de fornecedores. Os tipos devem permanecer em TypeScript strict e os parâmetros por sistema precisam ser discriminados, não dicionários livres.

## Opções

### 1. Zod

Prós:
- schemas e inferência de tipos no mesmo código;
- excelente integração com TypeScript;
- composição simples para uniões discriminadas e mensagens de erro;
- ecossistema amplo.

Contras:
- custo de runtime proporcional ao tamanho do payload;
- alguns schemas complexos podem ficar verbosos.

### 2. Valibot

Prós:
- pacote pequeno e modular;
- boa inferência de tipos;
- custo potencialmente menor no navegador.

Contras:
- ecossistema menor;
- menos exemplos e integrações prontas para a equipe.

### 3. JSON Schema + Ajv

Prós:
- padrão independente de linguagem;
- alto desempenho;
- útil se contratos forem publicados para consumidores externos.

Contras:
- tipos TypeScript e schema podem precisar de geração ou duplicação;
- menos ergonômico para domínio e parâmetros discriminados escritos diretamente em TypeScript.

## Recomendação

Adotar **Zod em `packages/contratos`**, exportando schemas e tipos inferidos. A API valida toda entrada externa e a web reutiliza os tipos para chamadas e respostas; conectores validam resultados antes de entregá-los ao domínio.

## Consequências

- Schemas serão a fonte de verdade dos contratos em runtime.
- Erros de validação devem ser convertidos em códigos estáveis e mensagens sanitizadas.
- Nenhum schema deve aceitar segredos ou dados pessoais reais em fixtures e logs.
