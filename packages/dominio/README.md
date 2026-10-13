# @gia/dominio

Entidades, estados, transições e regras de negócio do Gia. Código puro em
TypeScript `strict`: **sem banco, rede, conectores, relógio, aleatoriedade ou
framework**. Casos de uso e adaptadores (API, worker, persistência, conectores)
dependem deste pacote; ele não depende de nada.

A pureza é garantida por três camadas: regra `no-restricted-imports` do ESLint
(só imports relativos em `src/`), `tsconfig` sem tipos do Node em `src/` e o
teste `test/unidade/pureza-do-dominio.test.ts`.

## Como rodar

```sh
pnpm install
pnpm check        # typecheck + lint + format:check + test + build
```

Scripts individuais: `typecheck`, `lint`, `format:check`, `test`, `build`
(nomes alinhados ao pipeline do Turborepo, ADR-0006).

## Modelo

| Entidade        | Arquivo                           | Estados                                                                                                                         |
| --------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Colaborador     | `src/colaborador/colaborador.ts`  | `ativo` · `afastado` · `desligado`                                                                                              |
| Pedido admissão | `src/admissao/pedido-admissao.ts` | `pendenteAprovacao` · `aprovado` · `emExecucao` · `concluidoComErros` · `concluido` · `rejeitado`                               |
| Revisão         | `src/admissao/revisao.ts`         | `rascunho` · `aprovada` (congelada)                                                                                             |
| Item de acesso  | `src/admissao/item-acesso.ts`     | `pendente` · `aguardandoDependencia` · `emExecucao` · `confirmado` · `parcial` · `falhou` · `desconhecido` · `registradoManual` |
| Operação        | `src/execucao/operacao.ts`        | `pendente` · `reservada` · `concluida` · `aguardandoReconciliacao` · `reconciliada` · `cancelada`                               |
| Evento          | `src/eventos/evento.ts`           | somente inserção                                                                                                                |

Cada máquina de estados é uma tabela `TRANSICOES_*` exportada e testada.

### Convenções dos comandos

- Todo comando recebe `ContextoComando` (`ator`, `agora`, `correlacaoId`,
  `novoId`). O ator é um `AtorAutenticado`, que só nasce de
  `criarAtorDaSessao` / `criarAtorDeServico`; o payload do cliente nunca
  carrega ator (`rejeitarAtorNoPayload`, `extrairDadosPermitidos`).
- Todo comando que altera entidade recebe `versaoEsperada` (controle otimista);
  divergência devolve `CONFLITO_DE_VERSAO`.
- Retorno é `Resultado<T>`: sucesso com as entidades novas + eventos, ou
  falha com `codigo` estável e mensagem em português (`MENSAGENS_ERRO`).
- Funções puras: devolvem cópias novas, nunca mutam a entrada. A persistência
  grava estado + eventos na mesma transação.
- Permissão é checada dentro do comando (defesa em profundidade); o recorte de
  escopo `restrito`/`proprio` fica no caso de uso, que conhece os dados.

### Efeitos e idempotência

- Efeitos de conector: `confirmado` · `parcial` · `semEfeito` · `desconhecido`;
  modo `real` ou `simulado`.
- Chave de idempotência determinística
  (`gia:<modo>:<pedido>:<revisao>:<item>:<acao>:g<geracao>`); `geracao` só avança
  quando um humano pede nova execução do item. `garantirOperacaoUnica` devolve a
  operação existente para a mesma chave.
- Lease com expiração (`reservarOperacao`, `renovarLease`). Lease expirado em
  escrita real vai para reconciliação; em leitura volta para a fila.
- Política da fila (ADR-0004) em `POLITICA_EXECUCAO_PADRAO`, validável por
  `validarPolitica`. Jitter é sorteado fora e passado como `sorteioJitter`.

## Regras de negócio → testes

| #   | Regra                                  | Teste                                                      |
| --- | -------------------------------------- | ---------------------------------------------------------- |
| 1   | Aprovar não executa                    | `test/regras/r01-aprovar-nao-executa.test.ts`              |
| 2   | Cinco operações distintas por conector | `test/regras/r02-cinco-operacoes-por-conector.test.ts`     |
| 3   | Timeout é resultado desconhecido       | `test/regras/r03-timeout-e-desconhecido.test.ts`           |
| 4   | Sucesso confirmado não se repete       | `test/regras/r04-sucesso-confirmado-nao-se-repete.test.ts` |
| 5   | Conta ausente na revogação é falha     | `test/regras/r05-revogacao.test.ts`                        |
| 6   | Existir não é sucesso                  | `test/regras/r06-existir-nao-e-sucesso.test.ts`            |
| 7   | M365 não cria usuário                  | `test/regras/r07-m365-nao-cria-usuario.test.ts`            |
| 8   | Escrita desligada por padrão           | `test/regras/r08-escrita-desligada-por-padrao.test.ts`     |
| 9   | Simulado não é confirmado              | `test/regras/r09-simulado-nao-e-confirmado.test.ts`        |
| 10  | Uma origem, um pedido                  | `test/regras/r10-uma-origem-um-pedido.test.ts`             |
| 11  | Evidência imutável                     | `test/regras/r11-evidencia-imutavel.test.ts`               |
| 12  | Segredos fora de tudo                  | `test/regras/r12-segredos-fora-de-tudo.test.ts`            |
| 13  | Ator vem da sessão                     | `test/regras/r13-ator-vem-da-sessao.test.ts`               |

Testes unitários complementares em `test/unidade/` (permissões e Administrador
do Gia, identidade, pedido, operação/lease, execução, colaborador, pureza).

## Decisões registradas

- **Identidade:** o e-mail corporativo sugerido pelo RH é a base; login = parte
  local do e-mail, UPN = e-mail, `proxyAddresses = SMTP:<email>`. O domínio não
  gera login alternativo: e-mail inválido ou login acima de 20 caracteres vira
  pendência para ajuste humano (`ajustarIdentidade`).
- **Colisão/uso:** `verificarIdentidade` classifica usos encontrados no AD/M365/Gia
  em `livre`, `emUsoPelaMesmaPessoa` (mesmo CPF, ex.: readmissão) ou
  `emUsoPorOutraPessoa` (inclusive titular sem CPF conhecido). A aprovação
  exige verificação atual (mesmos valores) e sem uso por outra pessoa.
- **Administrador do Gia (ADR-0007):** nível `total` em todas as ações
  funcionais; não configura segredos, não libera escrita e não registra
  resultado de worker. Continua sujeito ao gate de escrita e todos os eventos
  levam o ator com seus papéis (filtrável na auditoria).
- **Terceiros:** por padrão nenhum sistema gera item para `terceiro`.
- **Documento:** só itens `confirmado` de pedido `concluido`; registro manual e
  simulação não entram.
- **Eventos:** sanitizados (segredos) e com campos `cpf*` mascarados; o CPF
  completo fica só no cadastro do colaborador.
- **Offboarding (standby):** só o que as regras exigem — `interpretarEstadoParaRevogacao`,
  etapas de revogação e a transição `desligado` do colaborador.
