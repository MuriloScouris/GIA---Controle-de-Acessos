# Login de produção com Entra ID (DEV-288)

O GIA autentica operadores com **OIDC no Entra ID** (Authorization Code com
PKCE, cliente confidencial). Todo o fluxo roda no servidor: o navegador só é
redirecionado e, no fim, recebe um cookie opaco de sessão. Nenhum token chega
ao navegador nem é guardado depois de validado.

**Estado:** implementado e testado com um Entra ID simulado (chaves RSA geradas
no teste). **Não foi validado contra um tenant real** — veja
[O que exige configuração real](#o-que-exige-configuração-real).

## Fluxo

1. `GET /sessao/oidc/entrar?retorno=/pedidos/123` → 302 para
   `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/authorize` com
   `state`, `nonce` e `code_challenge` (S256). O servidor guarda o login
   pendente (uso único, 10 min) e grava o cookie `gia_oidc_estado`
   (`HttpOnly; Secure; SameSite=Lax`).
2. O Entra ID volta em `GET /sessao/oidc/retorno?code=...&state=...`. O
   servidor exige que `state` exista, não tenha sido usado e seja igual ao
   cookie do mesmo navegador (anti-CSRF de login); troca o código com o
   `code_verifier` e o client secret; valida o ID token:
   - assinatura **RS256** pelas chaves do tenant (JWKS oficial);
   - `iss` exato `https://login.microsoftonline.com/<tenant>/v2.0`, `aud` =
     client ID, `tid` = tenant, `exp`/`iat` (tolerância de 2 min);
   - `nonce` igual ao do login (anti-replay) e `oid` presente.
3. Papéis do Gia a partir das **app roles** e/ou **grupos** do token. Sem
   nenhum papel → `ACESSO_NEGADO`, **nenhuma sessão é criada**.
4. Sessão nova (o identificador anterior do navegador é descartado — sem
   fixação), cookie `gia_sessao` `HttpOnly; Secure; SameSite=Strict`, expiração
   absoluta de 8 h, e 303 para o retorno **local** (caminho começando com `/`;
   `//host`, `\`, esquemas e controle viram `/`).
5. Falhas voltam para `/login?erro=<CÓDIGO>`: `LOGIN_ESTADO_INVALIDO`,
   `LOGIN_RECUSADO_PELO_PROVEDOR`, `LOGIN_TROCA_FALHOU`,
   `LOGIN_TOKEN_INVALIDO`, `ACESSO_NEGADO`, `LOGIN_INDISPONIVEL`. O texto do
   provedor nunca é repassado.
6. **Logout:** `POST /sessao/oidc/sair` (exige `x-gia-csrf`) encerra a sessão
   local **sempre** e devolve `{ redirecionarPara }` com o logout do Entra ID
   (`post_logout_redirect_uri`), para a interface navegar até lá.

`GET /sessao/modo` informa à interface qual login oferecer: `oidc`,
`simulada` ou `indisponivel`.

## Autorização

A sessão carrega `usuarioId` (o `oid` do Entra ID), nome e papéis; a matriz de
permissões do domínio decide cada ação (403 `PERMISSAO_NEGADA` para o que o
papel não pode). O ator vem sempre da sessão do servidor (regra 13).

Duas formas de dar papel, que podem ser combinadas:

- **App roles** (recomendado): criar no app registration as roles com os
  **valores** `solicitante`, `revisor`, `executor`, `auditor`,
  `administradorTecnico`, `administradorGia` e atribuí-las às pessoas. Valem
  sem configuração extra. Atribuir **grupos** a app roles exige Entra ID P1;
  sem P1, atribuir por pessoa.
- **Grupos de segurança**: habilitar `groups` no token (Token configuration →
  Groups claim → Security groups) e mapear o objectId de cada grupo em
  `GIA_OIDC_MAPA_PAPEIS`. Com mais de 200 grupos o Entra ID não lista os
  grupos no token (*overage*); o GIA então **nega** o acesso em vez de adivinhar
  — use app roles ou grupos atribuídos ao app.

## Configuração

| Variável                         | Obrigatória | Observação                                                         |
| -------------------------------- | ----------- | ------------------------------------------------------------------ |
| `GIA_OIDC_TENANT_ID`             | sim         | GUID do tenant (nunca `common`/`organizations`)                    |
| `GIA_OIDC_CLIENT_ID`             | sim         | ID do aplicativo (cliente)                                         |
| `GIA_OIDC_CLIENT_SECRET_ARQUIVO` | sim         | arquivo do cofre com o VALOR do client secret                      |
| `GIA_OIDC_REDIRECT_URI`          | sim         | URL HTTPS registrada no app que chega a `/sessao/oidc/retorno` (ex.: `https://gia.empresa/api/sessao/oidc/retorno`) |
| `GIA_OIDC_POS_LOGOUT_URI`        | não         | URL HTTPS para onde o Entra ID volta depois do logout              |
| `GIA_OIDC_MAPA_PAPEIS`           | não         | `objectIdDoGrupo=revisor,Valor.Da.Role=auditor,...`                 |
| `GIA_AUTH_SIMULADA`              | não         | `true` liga a sessão simulada em `teste` (testes automatizados); recusado em `producao` |

Regras no arranque (o erro cita só nomes de variáveis):

- `GIA_AMBIENTE=producao` **exige** o OIDC e recusa `GIA_AUTH_SIMULADA`;
- qualquer `GIA_OIDC_*` presente liga o OIDC e exige a configuração completa;
- `desenvolvimento` usa a sessão simulada; `teste` só com `GIA_AUTH_SIMULADA=true`.

## O que exige configuração real

Nada disto foi feito ou validado nesta entrega — depende do administrador do
Entra ID:

1. **App registration** (web, cliente confidencial) com o redirect URI de
   produção, `ID tokens` habilitados e escopos `openid profile email`.
2. **Client secret** no cofre, montado como arquivo (expira em 6–24 meses;
   certificado é o passo seguinte natural).
3. **App roles** criadas e atribuídas (ou o mapa de grupos).
4. Opcional: **Front-channel logout URL** e o post-logout redirect.
5. Validação ponta a ponta no tenant: login, papel por role/grupo, acesso
   negado, logout.

## Limitações conhecidas

- **Sessões em memória do processo:** não sobrevivem a reinício nem são
  compartilhadas entre instâncias. Produção com mais de uma instância da API
  precisa de armazenamento de sessão compartilhado (próximo passo).
- **Interface:** a tela de login atual só oferece a sessão simulada. Para
  produção ela precisa ler `GET /sessao/modo`, oferecer "Entrar com Microsoft"
  apontando para `/api/sessao/oidc/entrar?retorno=...`, mostrar o
  `?erro=` da `/login` (inclusive `ACESSO_NEGADO`) e usar
  `POST /api/sessao/oidc/sair` no logout. Fica com a frente da UI (não tocada
  aqui para não conflitar com a UI legado).
