#!/bin/sh
# rampage installer — https://rampage.alphabeti.se
#
#   curl -fsSL https://rampage.alphabeti.se/setup.sh | sh
#
# Installs the scanner once into ~/.rampage, then wires a pre-commit hook
# into the git repo you run it from. Run it again inside any other repo to
# protect that one too (the shared install is reused).
set -eu

BASE_URL="${RAMPAGE_BASE_URL:-https://rampage.alphabeti.se}"
RAMPAGE_HOME="${RAMPAGE_HOME:-$HOME/.rampage}"

say() { printf '%s\n' "$*" >&2; }

command -v node >/dev/null 2>&1 || { say "rampage needs node (>=20) — install it first, partner."; exit 1; }
command -v npm  >/dev/null 2>&1 || { say "rampage needs npm — install it first, partner."; exit 1; }

say "🤠 installing rampage into $RAMPAGE_HOME ..."
mkdir -p "$RAMPAGE_HOME"

curl -fsSL "$BASE_URL/scan-staged.mjs" -o "$RAMPAGE_HOME/scan-staged.mjs"

cat > "$RAMPAGE_HOME/package.json" <<'PKG'
{
  "name": "rampage",
  "private": true,
  "type": "module",
  "dependencies": {
    "@huggingface/transformers": "^4.2.0",
    "@nationaldesignstudio/rampart": "^0.1.3"
  }
}
PKG

if [ ! -d "$RAMPAGE_HOME/node_modules/@nationaldesignstudio/rampart" ]; then
  say "   fetching NDS Rampart + transformers.js (one time) ..."
  # --ignore-scripts: skips sharp's native build, which rampage never needs
  npm install --prefix "$RAMPAGE_HOME" --ignore-scripts --no-audit --no-fund --silent
fi

# wire the hook into the current repo, if we're in one
if GIT_DIR=$(git rev-parse --git-dir 2>/dev/null); then
  HOOK="$GIT_DIR/hooks/pre-commit"
  if [ -f "$HOOK" ] && ! grep -q rampage "$HOOK"; then
    cp "$HOOK" "$HOOK.pre-rampage"
    say "   existing pre-commit hook backed up to $HOOK.pre-rampage"
  fi
  mkdir -p "$GIT_DIR/hooks"
  cat > "$HOOK" <<HOOKEOF
#!/bin/sh
# rampage PII scanner — https://rampage.alphabeti.se
exec node "$RAMPAGE_HOME/scan-staged.mjs"
HOOKEOF
  chmod +x "$HOOK"
  say "✅ rampage is watching this repo. commits with PII will get a talking-to."
else
  say "✅ rampage installed. run this script inside a git repo to hook it up:"
  say "   curl -fsSL $BASE_URL/setup.sh | sh"
fi
say "   (first scan downloads the ~15MB model from hugging face, then it's cached)"
