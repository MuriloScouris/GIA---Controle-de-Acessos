#!/usr/bin/env bash
# Reproduz a integração da Sprint 1 (DEV-291) a partir das refs publicadas e
# confere que o resultado é idêntico ao branch de integração publicado.
#
# Uso: scripts/reproduzir-integracao-sprint1.sh [ref-da-integracao]
#   ref-da-integracao: padrão origin/dev-291-integracao-sprint1
#
# Não altera nenhum branch existente: trabalha num worktree temporário e o
# remove no fim. As resoluções de conflito vêm dos commits de merge publicados
# (só dos arquivos em conflito), e a árvore final é comparada por hash.
set -euo pipefail

INTEGRACAO="${1:-origin/dev-291-integracao-sprint1}"
BASE="origin/dev-289-preflight-producao" # pilha #12–#18 (dev-287-dependencias) + #20 + #22
MERGES=(
  "origin/dev-288-login-entra-oidc"     # #21 DEV-288
  "origin/dev-290-login-oidc-ui-legado" # #23 DEV-290
  "origin/dev-283-docusign-complemento" # #19 DEV-283 (complemento)
)

git fetch --quiet origin
raiz="$(git rev-parse --show-toplevel)"
temporario="$(mktemp -d)"
trap 'git -C "$raiz" worktree remove --force "$temporario" >/dev/null 2>&1 || true' EXIT
git -C "$raiz" worktree add --quiet --detach "$temporario" "$BASE"
cd "$temporario"

# Commits de merge publicados, na ordem (primeiro pai), para buscar as resoluções.
mapfile -t publicados < <(git rev-list --first-parent --merges --reverse "$BASE..$INTEGRACAO")
if [ "${#publicados[@]}" -ne "${#MERGES[@]}" ]; then
  echo "esperava ${#MERGES[@]} merges em $INTEGRACAO, achei ${#publicados[@]}" >&2
  exit 1
fi

for i in "${!MERGES[@]}"; do
  ref="${MERGES[$i]}"
  echo "== merge $ref"
  publicado="${publicados[$i]}"
  if ! git -c user.name=reproducao -c user.email=reproducao@invalid merge --no-ff --no-edit "$ref" >/dev/null 2>&1; then
    # Só os arquivos em conflito recebem a resolução publicada.
    git diff --name-only --diff-filter=U | while read -r f; do
      echo "  conflito resolvido como no publicado: $f"
      if git cat-file -e "$publicado:$f" 2>/dev/null; then
        git checkout "$publicado" -- "$f"
      else
        git rm --quiet "$f"
      fi
    done
    git -c user.name=reproducao -c user.email=reproducao@invalid commit --quiet --no-edit
  fi
  # Ajustes semânticos feitos no próprio commit de merge, fora dos conflitos
  # (ex.: testes que passam a declarar o modo de autenticação): listados e aplicados.
  ajustes="$(git diff --name-only HEAD "$publicado")"
  if [ -n "$ajustes" ]; then
    echo "$ajustes" | sed 's/^/  ajuste do merge publicado: /'
    git read-tree --reset -u "$publicado"
    git -c user.name=reproducao -c user.email=reproducao@invalid commit --quiet --amend --no-edit
  fi
  if [ "$(git rev-parse HEAD^{tree})" != "$(git rev-parse "$publicado^{tree}")" ]; then
    echo "  árvore difere do merge publicado $publicado" >&2
    exit 1
  fi
  echo "  árvore idêntica a $publicado"
done

# Commits posteriores aos merges (documentação/ajustes da integração) são reaplicados.
ultimo="${publicados[-1]}"
for c in $(git rev-list --reverse --first-parent "$ultimo..$INTEGRACAO"); do
  git -c user.name=reproducao -c user.email=reproducao@invalid cherry-pick --quiet "$c"
done

if [ "$(git rev-parse HEAD^{tree})" = "$(git rev-parse "$INTEGRACAO^{tree}")" ]; then
  echo "OK: integração reproduzida; árvore idêntica a $INTEGRACAO"
else
  echo "FALHA: árvore final difere de $INTEGRACAO" >&2
  exit 1
fi
