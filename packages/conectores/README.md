# @gia/conectores

Adaptadores dos sistemas de destino (AD, Microsoft 365, DocuSign, SoftExpert e Jira), o Jira como origem de chamados e um simulador em memória de cada fornecedor.

## Como funciona

- **Contrato:** cada conector implementa `Conector` de `@gia/dominio` (testar conexão, validar, conferir existência, provisionar e revogar). Nenhuma interface do domínio ou de `@gia/contratos` foi alterada.
- **Motor (`motor.ts`):** comum a todos os sistemas. Executa as etapas na ordem do domínio, retoma a partir de `etapaInicial`, aplica o timeout da ADR-0004, traduz falhas técnicas (regra 3: timeout e resposta perdida são `desconhecido`), aplica a regra 5 na revogação e valida todo resultado com os schemas de `@gia/contratos` (mensagens sanitizadas, regra 12).
- **Adaptadores (`adaptadores/`):** a lógica de cada sistema sobre um **cliente de transporte** injetado (`ClienteAd`, `ClienteGraph`, `ClienteDocusign`, `ClienteSoftexpert`, `ClienteJira`, `ClienteJiraOrigem`). O M365 não tem como criar usuário (regra 7).
- **Simuladores (`simuladores/`):** implementam esses clientes em memória, sem rede e sem segredos, com cenários de sucesso, falha, parcial, timeout, resposta perdida, conexão recusada, 2xx com erro e limite de taxa (`roteiro.programar(...)` ou `roteiro.aplicar(...)`). Todo resultado sai com `modo: 'simulado'` (regra 9).
- **Catálogo (`catalogo.ts`):** `criarCatalogoSimulado()` monta os cinco conectores e o Jira de origem sobre os simuladores.

## O que ainda não existe

Os transportes reais (LDAPS, Microsoft Graph, eSignature REST, SOAP, REST do Jira) **não** fazem parte deste pacote: dependem de credenciais do cofre e de acesso aos ambientes. Ao implementá-los, cada transporte deve:

- lançar `ErroFornecedor` com o tipo correto (`timeout`, `respostaPerdida`, `conexaoRecusada`, `limiteDeTaxa`, `recusado`);
- tratar 2xx com erro interno como `recusado`;
- escapar entrada humana com `escaparValorFiltroLdap`, `escaparValorDn` e `escaparXml`;
- nunca devolver nem registrar senha, token ou chave.

A escrita continua desligada por padrão: a liberação por sistema e por operação (regra 8) é decidida pelo domínio antes de qualquer chamada ao conector.
