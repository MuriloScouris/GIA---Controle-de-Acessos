# ADR-0007 — Perfil administrador do Gia

Status: Aceito

## Contexto

O Gia possui papéis separados para solicitação, aprovação, execução, auditoria e administração técnica. Para operação corporativa e suporte controlado, também é necessário um perfil capaz de executar o conjunto completo de ações funcionais sem depender de múltiplas contas.

## Decisão

Criar o perfil **Administrador do Gia**.

Esse perfil poderá:

- consultar pedidos, usuários, operações e auditoria;
- criar e acompanhar pedidos;
- editar propostas pendentes;
- validar e conferir existência;
- aprovar e rejeitar;
- solicitar execução, reprocessar e reconciliar;
- registrar acessos manuais;
- alterar configurações funcionais;
- baixar documentos e exportar auditoria.

O perfil não elimina proteções estruturais:

- o ator continua vindo da sessão no servidor;
- toda ação continua auditada;
- aprovação continua não executando escrita externa;
- escrita nos destinos continua desligada por padrão;
- segredos continuam restritos ao administrador técnico e ao cofre;
- gates de produção, migration destrutiva e liberação de escrita continuam exigindo decisão explícita.

## Consequências

- O perfil deve ser atribuído com parcimônia e todas as ações devem ser facilmente filtráveis na auditoria.
- Testes de autorização cobrirão tanto o acesso total do administrador quanto os limites que ele não pode ultrapassar.
- O perfil será útil no ambiente inicial e nos testes, sem transformar autorização em confiança implícita no navegador.
