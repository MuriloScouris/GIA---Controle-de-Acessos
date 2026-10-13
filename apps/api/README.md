# @gia/api

API HTTP do Gia (Fastify, ADR-0001): adaptador fino sobre os casos de uso de
onboarding. Domínio e regras vêm de `@gia/dominio`; toda entrada é validada
pelos schemas Zod de `@gia/contratos` (ADR-0005). A API **não fala com nenhum
sistema de destino**: aprovar só grava a decisão e solicitar execução só grava
a operação na fila, para o worker consumir.

## Rotas

| Método e rota                      | O que faz                                                                      | Permissão (domínio)  |
| ---------------------------------- | ------------------------------------------------------------------------------ | -------------------- |
| `POST /sessao/simulada`            | Abre sessão simulada para uma pessoa fictícia (`{ papel }`). Fora de produção. | —                    |
| `GET /sessao` · `DELETE /sessao`   | Sessão atual · logout.                                                         | sessão               |
| `POST /importacoes/jira`           | Importa os chamados de onboarding do Jira simulado (`{}`).                     | `criarPedido`        |
| `GET /pedidos`                     | Lista os pedidos visíveis para a pessoa.                                       | `acompanharPedido`   |
| `GET /pedidos/:pedidoId`           | Pedido, proposta (identidade, verificação, itens) e resultado dos itens.       | `acompanharPedido`   |
| `GET /pedidos/:pedidoId/itens`     | Resultado por item da revisão corrente, com as operações da fila.              | `acompanharPedido`   |
| `GET /pedidos/:pedidoId/itens/:id` | Um item (de qualquer revisão do pedido).                                       | `acompanharPedido`   |
| `POST /pedidos/:pedidoId/comandos` | Comando do contrato: `{ pedidoId, versaoEsperada, acao, dados }`.              | por ação, ver abaixo |

Comandos: `editarProposta` e `recalcularIdentidade` (`editarProposta`; revalidam a
identidade na mesma transação), `aprovar` (`decidirPedido`; revalida a identidade
antes de aprovar e não enfileira nada), `rejeitar` e `reabrir` (`decidirPedido`),
`solicitarExecucao` (`executarOperacoes`; responde `202` com `operacaoId` e
`operacaoIds`) e `registrarAcessoManual` (`registrarManualReconciliar`).
`conferirExistencia` e `reconciliar` dependem de conector e respondem `501
ACAO_INDISPONIVEL` (depois da checagem de permissão).

Respostas de erro seguem `respostaErroSchema`: código estável + mensagem em
português + `detalhes` sanitizados (sem segredo e com CPF mascarado). Status:
`400` entrada inválida, ator no corpo ou segredo; `401` sem sessão; `403`
permissão ou CSRF; `404` inexistente ou fora do recorte; `409` versão; `422`
regra de negócio; `501` ação ainda indisponível.

## Segurança

- **Ator vem da sessão (regra 13):** o cookie `gia_sessao` (`HttpOnly`, `Secure`,
  `SameSite=Strict`, expiração absoluta de 8 h) só carrega um identificador
  opaco; pessoa e papéis ficam no servidor. Ator no corpo (em qualquer nível)
  é recusado com `ATOR_INFORMADO_PELO_CLIENTE`; cabeçalhos do cliente não mudam
  ator nem correlação.
- **CSRF:** toda escrita (inclusive login e logout) exige `x-gia-csrf: 1`; a API
  não habilita CORS.
- **Permissão primeiro:** a permissão da ação é checada antes de carregar o
  pedido, então `403` não revela se ele existe.
- **Dados pessoais:** valor completo só para quem edita a proposta (revisor/
  aprovador) ou tem acesso total a dados pessoais (Administrador do Gia). Para os
  demais (executor, auditor, solicitante), a **projeção inteira** de cada resposta
  (lista, detalhe, itens, histórico, relatório de importação) é mascarada
  (`src/aplicacao/dados-pessoais.ts`): todo CPF válido em qualquer texto vira
  `123.***.***-09`, e a matrícula da pessoa vira `***01` no campo próprio e onde
  aparecer em texto livre (motivo, nome, gestor, observação, chave da issue).
  Campos técnicos (IDs, instantes `...Em`, datas civis,
  enums, códigos) e datas/instantes ISO dentro de texto livre não são
  alterados, para a resposta seguir o contrato; a troca da matrícula é literal
  (qualquer caractere). Detalhes de erro passam pela mesma máscara.
- **Escrita externa desligada:** a configuração só aceita `GIA_ESCRITA_EXTERNA=false`,
  então as operações nascem em modo `simulado` (regras 8 e 9). Em modo real, o
  domínio exige a liberação por sistema (`ESCRITA_NAO_LIBERADA`).
- Respostas com `cache-control: no-store`; erros internos nunca ecoam mensagens
  do framework ou dados recebidos.

## Limitações desta entrega

- **Persistência em memória** (`src/persistencia/memoria.ts`): `packages/persistencia`
  ainda não tem schema real. Os dados se perdem ao reiniciar, não são
  compartilhados entre instâncias (a API ainda não é sem estado) e as
  transações são serializadas no processo. Atomicidade (estado + eventos +
  fila), unicidades e eventos somente inserção são garantidos aqui, não por
  restrições do banco. As portas (`src/aplicacao/portas.ts`) são as que a
  implementação PostgreSQL + Kysely (ADR-0003) vai cumprir.
- **Sessão simulada em memória**, no lugar do OIDC com Entra ID; em produção a
  rota de login simulado não existe.
- **Jira e diretório simulados** (`src/simuladores/`): fixtures fictícias, sem
  rede. Regras de área e cargo fictícias em `src/aplicacao/regras-proposta.ts`.
- **Fila sem worker:** as operações ficam `pendente`. Consolidar o status do
  pedido após resultado ou registro manual é do serviço executor
  (`consolidarExecucao`), então o pedido não muda de status aqui.
- **Recorte de leitura provisório:** quem tem `acompanharPedido` restrito
  (solicitante) vê só os pedidos que importou; o recorte por pessoas/áreas
  ainda não existe. Sem paginação na listagem.
