# DEV-292 — Matriz de prontidão do Onboarding

**Decisão atual: NO_GO. Produção não homologada. Escrita permanece desligada.**

A matriz executável reúne 62 requisitos de AD, Microsoft 365, DocuSign, SoftExpert,
Jira, OIDC e operação global. Cada linha contém responsável por papel, estado,
evidência, decisão necessária e comandos de verificação. O CLI somente lê arquivos
locais; não acessa cofre, rede, API, fila ou sistemas externos, nem altera flags.

Responsáveis são **papéis propostos**, sem titular corporativo confirmado.
`responsavelConfirmado=false` é uma pendência real; cabe ao responsável pela mudança
nomear o titular no registro administrativo restrito. Não inventar pessoa, aprovação,
credencial, janela ou resultado. O administrador do Gia não contorna estes gates.

## Executar e interpretar

Instalar pelo lockfile e compilar (`pnpm install --frozen-lockfile`, `pnpm build`).
No SHA integrado que será avaliado:

```text
git rev-parse HEAD
pnpm --filter @gia/worker prontidao --revisao <SHA-40> --saida <nova-matriz.json>
```

Sem evidências, todas as 62 linhas ficam pendentes, saída 1. O arquivo JSON é a
matriz completa, reproduzível pelo catálogo `apps/worker/src/prontidao/catalogo.ts`.
O catálogo é versionado; o relatório tem horário de geração e referências aos PRs.
Arquivo novo obrigatório quando `--saida` é usado: criação exclusiva, sem sobrescrever,
0600 em POSIX. Stdout informa o SHA-256 dos bytes gravados. Em Windows, revisar ACL.

| Estado da linha                 | O que comprova                                                                | O que falta                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `pendente`                      | Nenhuma evidência suficiente recebida                                         | Ação do responsável e evidência válida                                      |
| `bloqueado`                     | Bloqueio explícito no registro ou checks/gates inseguros                      | Correção e nova verificação                                                 |
| `leituraComprovada`             | Checks correspondentes no preflight produtivo, recente e na revisão informada | Conta/ACL, permissões de escrita, ensaio real e validação administrativa    |
| `declaracaoPendenteDeValidacao` | Referência administrativa sanitizada foi registrada                           | Administrador conferir origem, conteúdo e aprovação no repositório restrito |

Todas as linhas mantêm `pronto=false` e `validacaoAdministrativa=pendente`.
O programa **nunca** emite go-live nem oferece override/aprovação automática.
Saída 2 significa somente que todas as leituras esperadas foram consolidadas;
`decisao=NO_GO`, `producaoPronta=false` e `escritaHabilitada=false` continuam.
Não tratar 2 como sucesso de deploy. Saída 1 inclui ausência, inconsistência ou
bloqueio de evidência. Configurar a automação para esperar estes códigos.

`escritaHabilitada=false` descreve a garantia deste comando. O estado encontrado no
ambiente vem de `gatesObservados` do preflight; ausência é `null`, não prova desligamento.
Gates inseguros impedem comprovação de leituras. O comando não desliga sistemas remotos.

## Preflight e evidências sanitizadas

No ambiente autorizado, com todos os gates de escrita desligados e arquivos já montados:

```text
pnpm --filter @gia/worker preflight --offline --saida <novo-offline.json>
pnpm --filter @gia/worker preflight --saida <novo-online.json>
pnpm --filter @gia/worker prontidao --revisao <SHA-40> --preflight <novo-online.json> --preflight-sha256 <SHA256-DO-ARQUIVO> --saida <nova-matriz.json>
```

Antes do preflight, fornecer `GIA_PREFLIGHT_REVISAO` com o SHA implantado. A revisão
deve ser a mesma informada à matriz, não apenas o SHA do checkout do operador.
Configuração, variáveis de cofre, endpoints e limites estão no
[runbook DEV-289](dev-289-preflight.md) e na [composição DEV-287](../integracoes/dev-287-composicao.md).
Não passar credenciais inline nem copiar ambiente resolvido para evidências.

O preflight precisa estar no schema `gia.preflight.v1`, conter os cinco sistemas
sem duplicidade e ter no máximo 24 horas, sem horário futuro. A matriz exige checksum
exato, schema fechado e contexto de revisão; não aceita campos extras, estado pronto,
arquivo maior que 1 MiB ou relatórios de teste como evidência produtiva.
Checks individuais são conferidos; o booleano superior não supera um bloqueio.
DNS/TCP/TLS precisam corresponder ao mesmo índice de destino, inclusive múltiplos DCs.
Falha parcial preserva leitura válida dos outros sistemas e mantém a consolidação bloqueada.

O checksum detecta troca de bytes; **não autentica a origem nem assina aprovação**.
Conferir origem, identidade do operador, horário, revisão implantada e ACL no repositório
corporativo restrito. Guardar somente JSON sanitizado, checksum e referência administrativa.
CI, fixtures, Samba descartável e HTTP simulado comprovam software; não comprovam empresa,
tenant, permissões, criação, revogação ou homologação real.

## Matriz por sistema e decisão necessária

Os cinco conectores têm nove linhas comuns: `credenciais`, `redeCa`, `consentimentos`,
`contaServico`, `permissoes`, `campos`, `ensaio`, `rollback`, `escrita`.
O catálogo executável detalha cada linha e seus comandos. Para AD e outros cenários
sem consentimento OAuth, o administrador documenta a não aplicabilidade na evidência
restrita; o programa não a presume.

| Sistema / responsável proposto                             | Credenciais, rede e conta                                                                                               | Decisão específica / ensaio obrigatório                                                                                                                   | Evidência de implementação            |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| AD / Administração AD e Segurança                          | LDAPS em cada DC, CA/nome, bind por arquivo, delegação mínima, base/OU e CPF aprovados                                  | `ad.senhaInicial`: geração, canal de entrega, reset/expiração e titular; ensaiar criar, repetição, grupos, erro parcial e recuperação sob autorização     | #12, #20, #22                         |
| Microsoft 365 / Administração Entra/M365                   | Aplicativo confidencial, arquivo do cofre, authority/Graph, permissões mínimas e consentimento administrativo revisados | `m365.sincronizacaoLicencas`: AD→Entra, SKUs/assentos, licença herdada e ativação assíncrona; Graph atual não cria usuário nem remove grupos na revogação | #18, #20, #22                         |
| DocuSign / Administração DocuSign                          | Chave RSA por arquivo, integração, impersonation/consentimento, conta e endpoint regional corretos                      | Homologar permissões para convite/encerramento e efeitos incertos; resolver integração do complemento #19 preservando composição #20                      | #13, #19, #20, #22                    |
| SoftExpert / Administração SoftExpert                      | Conta de serviço em produção, arquivo do cofre, gateway/CA e catálogos corporativos                                     | `softexpert.wsdlRevogacao`: conferir WSDL/versionamento e contrato de `disableUser`; flag `GIA_SOFTEXPERT_REVOGACAO_CONFERIDA` não substitui comprovação  | #14, #20, #22                         |
| Jira / Administração Jira e RH                             | Conta/domínio aprovados, token por arquivo, projeto/request types e acesso aos campos                                   | `jira.vinculos`: amostra celetista/terceiro com campos válidos sem exportar dados; homologar deduplicação, criação/revogação e auditoria                  | #15, #20, #22                         |
| OIDC / Administração Entra e Backend/Segurança             | Tenant/aplicativo, segredo por arquivo, CA/authority/JWKS, redirects, scopes/consentimentos e titular                   | Nove linhas: credenciais, rede/CA, consentimentos, conta/aplicação, papéis, ensaio, rollback, sessões e integração UI                                     | #21, #23; integração DEV-291 pendente |
| Global / Operações, RH, Segurança e responsável da mudança | SHA implantado, banco/readiness, gates efetivos de API e worker, responsáveis nomeados                                  | Quatro linhas: runtime, regras corporativas, integração final e decisão go-live. Heartbeat só comprova vivacidade do worker                               | #16, #17, #20–#23; DEV-291            |

OIDC está implementado em branch paralelo e CI com provedor simulado, sem tenant real.
Validar login, papéis reais, usuário sem papel negado, callback, erro, logout e auditoria.
O #23 implementa a integração visual; isso não homologa o tenant nem está incorporado neste
branch. O #21 usa sessões em memória: decidir persistência/compartilhamento, topologia,
reinício e expiração antes de aceitar produção. A arquitetura do projeto exige sessões
compartilhadas; não ocultar esse desvio como mera credencial pendente.
Regras fictícias de área/cargo também bloqueiam a ativação.

## Registro administrativo sem dados pessoais

Importação opcional com `--registro <arquivo.json> --registro-sha256 <SHA256>`.
O schema `gia.decisoes.v1` é fechado. Exemplo deliberadamente **pendente**, a preencher
com SHA/horário reais; não representa autorização ou ensaio:

```json
{
  "schema": "gia.decisoes.v1",
  "revisao": "<SHA-40>",
  "ambiente": "producao",
  "geradoEm": "<UTC-ISO-8601>",
  "itens": [
    {
      "id": "ad.senhaInicial",
      "responsavelConfirmado": false,
      "estado": "pendente",
      "evidencia": null
    }
  ]
}
```

IDs são os 62 do catálogo. Itens omitidos continuam pendentes; duplicatas são recusadas.
Estados aceitos: `pendente`, `bloqueado`, `declarado`. Declarado exige responsável confirmado
e objeto `evidencia` contendo exatamente:

| Campo         | Formato / restrição                                                            |
| ------------- | ------------------------------------------------------------------------------ |
| `referencia`  | `EV-` seguido de UUID v4 minúsculo, referência opaca ao registro restrito      |
| `sha256`      | 64 hexadecimais minúsculos, hash do documento sanitizado, nunca da credencial  |
| `tipo`        | `administrativa` ou `ensaioRealAutorizado`                                     |
| `autorizacao` | Referência `EV-UUIDv4` para ensaio real; `null` permitido só no administrativo |
| `ocorridoEm`  | UTC ISO-8601, até 24 h, não futuro nem posterior à geração do registro         |

Linhas de ensaio/rollback declaradas exigem `ensaioRealAutorizado` e autorização referenciada.
Isso continua sendo declaração pendente de validação, não ensaio verificado pelo programa.
Não incluir nome, e-mail, CPF, URL corporativa, caminho de cofre, token, senha, cookie,
payload, mensagem do fornecedor ou comentário livre. A referência opaca leva ao registro
restrito com titular, aprovador, janela, auditoria e resultado. O CLI nunca abre esse registro.
Erros usam somente `MATRIZ_NAO_VERIFICADA`, sem eco de conteúdo, argumento, path ou stack.

## Ensaio, rollback e habilitação controlada

1. Nomear responsáveis; aprovar regras, permissões, consentimentos e decisões específicas.
   Confirmar cofre/ACL/rotação e rede no ambiente autorizado. Manter chave/lista/flags desligadas.
2. Integrar a sprint via DEV-291 e executar `pnpm check` e `pnpm test:e2e` no SHA final;
   conferir OIDC com `pnpm --filter @gia/api exec vitest run src/oidc.test.ts` nesse branch.
   Nenhum destes testes substitui tenant/ensaio real.
3. Executar preflight online e gerar matriz por checksum. Validar administrativamente origem
   das evidências e configuração efetiva de todas as instâncias de API/worker.
4. Aprovação explícita deve delimitar sistema/operação, identidade de ensaio, janela,
   aprovador, observador, critérios de interrupção e rollback. Este trabalho não concede
   essa aprovação nem executa o ensaio.
5. Pelo procedimento corporativo, ensaiar efeito no destino, auditoria persistida/correlação,
   repetição idempotente, perda de resposta, falha parcial, reconciliação e sincronização AD→M365.
   Revogação e recuperação afetam acesso e também exigem autorização específica.
6. Rollback autorizado: desligar `GIA_ESCRITA_EXTERNA`, esvaziar `GIA_ESCRITA_LIBERADA`,
   desligar `GIA_JIRA_ESCRITA_HABILITADA` e `GIA_DOCUSIGN_ESCRITA_HABILITADA`; reiniciar
   API/worker conforme operação. Conferir gates de todas as instâncias e fila real bloqueada,
   preservar auditoria e reconciliar operações incertas. Desligar gate não desfaz efeito já ocorrido.
7. Repetir preflight com arquivo novo e registrar ensaio de rollback. Operação incerta
   não é reenviada automaticamente; compensação exige decisão autorizada.
8. Responsável de mudança e Segurança revisam o conjunto e registram decisão administrativa.
   Habilitação por sistema/operação segue procedimento separado, sem curinga e sem
   comandos de ativação neste CLI. Esta matriz continua `NO_GO` até essa validação externa.

## Evidências, dependências e Brain

[Fontes sanitizadas](dev-292-fontes.json): snapshots dos PRs #12–#23 com SHA,
base e CI observado em UTC. Os resultados referem-se àqueles SHAs; não comprovam
o futuro branch integrado. O catálogo referencia PRs como implementação, sem convertê-los
em evidência produtiva. O [CI do #22](https://github.com/MuriloScouris/GIA---Controle-de-Acessos/actions/runs/38782926167)
e seu artefato negativo comprovam falha fechada, sem validação corporativa.
Artefatos CI têm retenção de sete dias; preservar cópia sanitizada no repositório restrito.

Base desta issue: #22 em `7d205b1e66dc89e6fe626f3c44a626ceb66a6a09`, sobre #20.
Este delta adiciona matriz/registro/documentação/CI, sem tocar UI, main ou branches de origem.
Não integra #19/#21/#23; DEV-291 é a frente responsável pela consolidação. Ao integrar,
preservar composição central #20, preflight #22 e login/UI #21/#23, resolver aditivamente
scripts/README/workflow/lockfile e repetir gates. Não fazer merge ou deploy nesta issue.

Conhecimento para o Brain: prontidão depende de origem da evidência, SHA implantado,
validade, titular confirmado, decisão administrativa e ensaio real. Leitura, CI e declaração
são evidências distintas. Cofre/consentimentos/rede corporativos, senha inicial AD, WSDL
SoftExpert, OIDC/sessões, regras, ensaio/rollback e decisão de escrita seguem bloqueados.

O CI testa o CLI compilado sem evidência: espera saída 1, 62 linhas pendentes, NO_GO
e artefato `matriz-no-go-dev292`. Testes de contrato usam evidências sintéticas para
checksum/schema/contexto, gates, falha parcial, autorização e sanitização; não são homologação.

Validação local da implementação:

- `pnpm test --concurrency=1`: 891 testes em 97 arquivos, sem skips; PostgreSQL 17
  e AD Samba LDAPS descartáveis, sem credenciais corporativas.
- 36 testes novos da matriz: ausência de evidência, ambiente de teste, gates inseguros,
  falha parcial, DC incompleto, checksum, schema, SHA, validade/futuro, duplicatas,
  declaração sem autorização, todos os registros preenchidos sem aprovação automática,
  sanitização, criação privada e recusa de sobrescrita.
- `pnpm check`: formato, lint, tipos, testes e build.
- `pnpm test:e2e`: sete cenários Chromium, sem retries, em 41,7 s; SPA/API/worker/banco
  reais com destinos simulados. OIDC real depende do branch integrado e tenant autorizado.
- O CI testa o CLI compilado e publica a matriz NO_GO; link do PR/run/artefato na issue.
