# ADR-0004 — Mecanismo da fila de operações

Status: Aceito

## Contexto

A API grava a intenção e responde sem chamar sistemas externos. O worker reserva operações com lease, precisa retomar após reinício, respeitar idempotência, evitar duplicidade e encaminhar resultados desconhecidos para reconciliação. O projeto começa com um banco relacional único.

## Opções

### 1. Tabela de operações com lease no banco

Prós:
- mantém intenção, outbox, estado e auditoria no mesmo limite transacional;
- não adiciona broker na primeira entrega;
- facilita idempotência e inspeção operacional;
- atende o volume inicial e permite vários workers.

Contras:
- polling precisa ser bem implementado;
- throughput e latência têm limites antes de exigir particionamento ou broker;
- exige cuidado com locks, lease expirado e backoff.

### 2. Broker dedicado, como RabbitMQ

Prós:
- distribuição e consumo de mensagens são recursos nativos;
- bom controle de confirmação, retry e dead-letter;
- reduz polling no banco.

Contras:
- nova infraestrutura para operar;
- estado de negócio e mensagem podem divergir sem um outbox bem definido;
- inspeção e reconciliação ficam distribuídas.

### 3. Serviço gerenciado de filas

Prós:
- reduz operação de infraestrutura;
- escala e disponibilidade ficam a cargo do provedor;
- pode fornecer retry e dead-letter.

Contras:
- acoplamento ao provedor;
- custo e comportamento variam por ambiente;
- ainda exige outbox e idempotência no banco.

## Recomendação

Adotar **tabela de operações com lease no PostgreSQL**, alimentada por outbox transacional. O worker usa seleção atômica, lease com expiração, backoff e chave de idempotência. Broker dedicado fica como evolução posterior se métricas demonstrarem necessidade.

## Parâmetros iniciais propostos

- Timeout de conexão: 5 segundos.
- Timeout total de uma chamada de conector: 30 segundos.
- Retentativas automáticas: até 3, somente para leituras e erros transitórios.
- Backoff: 5, 15 e 45 segundos, com jitter configurável.
- Escrita com resposta incerta: zero retentativas automáticas; encaminhar para conferência/reconciliação.
- Lease inicial: 2 minutos, renovado a cada 30 segundos enquanto a operação estiver ativa.
- Lote inicial por worker: 10 operações.
- Todos os parâmetros serão configuração validada, não constantes espalhadas no código.

## Consequências

- A primeira entrega terá menos componentes externos e será mais reproduzível localmente.
- Os parâmetros acima são defaults corporativos conservadores e poderão ser ajustados por métricas.
- A decisão deve ser reavaliada quando houver métricas reais de volume e latência.
