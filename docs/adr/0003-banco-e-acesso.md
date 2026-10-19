# ADR-0003 — Banco relacional e camada de acesso

Status: Aceito

## Contexto

O Gia exige banco relacional único, unicidades explícitas, controle otimista por versão, outbox, leases de operações, eventos somente inserção, migrações e consultas paginadas. O domínio deve permanecer sem I/O e a persistência deve ser acessada por repositórios tipados.

## Opções

### 1. PostgreSQL + Kysely

Prós:
- SQL explícito para índices, unicidades, locks, leases e consultas de auditoria;
- tipagem forte sem esconder o comportamento transacional;
- adequado para outbox, `FOR UPDATE SKIP LOCKED` e consultas paginadas;
- migrações podem ser revisadas diretamente.

Contras:
- exige mais disciplina e código de repositório;
- relações e mapeamentos não são gerados automaticamente.

### 2. PostgreSQL + Prisma

Prós:
- excelente produtividade inicial;
- schema central e cliente tipado gerado;
- migrações e CRUD comuns são simples.

Contras:
- abstração pode dificultar SQL específico para leases, concorrência e auditoria;
- modelos gerados podem aproximar domínio e persistência;
- consultas complexas podem exigir escape frequente para SQL.

### 3. PostgreSQL + Drizzle

Prós:
- tipagem próxima do SQL;
- leve e adequado para monorepo TypeScript;
- bom controle sobre schema e consultas.

Contras:
- ecossistema e convenções operacionais menores que Prisma;
- exige validar cedo os padrões de migração e transação necessários ao projeto.

## Recomendação

Adotar **PostgreSQL + Kysely**, com migrações SQL versionadas e repositórios explícitos. A camada de persistência deve esconder o banco dos casos de uso, mas não esconder decisões importantes de concorrência e transação.

## Consequências

- O scaffold precisará padronizar criação de transações, mapeamento de linhas e migrações.
- Testes de persistência usarão um PostgreSQL de teste, não apenas mocks.
- A primeira fatia deve validar atomicidade de estado + evento e o comportamento de lease.
