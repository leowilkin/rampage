#!/bin/sh
# rampage installer — https://rampage.alphabeti.se
#
#   curl -fsSL https://rampage.alphabeti.se/setup.sh | sh
#
# Installs the scanner into ~/.rampage and wires it up GLOBALLY via
# `git config --global core.hooksPath` — every repo on this machine gets the
# PII scan, no per-repo setup.
#
# Plays nice with what you already have:
#  - a previous global hooksPath (e.g. ggshield/GitGuardian) is chained after
#    the rampage scan, not replaced
#  - repo-local .git/hooks still run: every hook here is a pass-through shim
#  - repos that set their own core.hooksPath (e.g. husky) are untouched —
#    local config beats global
set -eu

BASE_URL="${RAMPAGE_BASE_URL:-https://rampage.alphabeti.se}"
RAMPAGE_HOME="${RAMPAGE_HOME:-$HOME/.rampage}"
HOOKS_DIR="$RAMPAGE_HOME/hooks"

say() { printf '%s\n' "$*" >&2; }

command -v node >/dev/null 2>&1 || { say "rampage needs node (>=20) — install it first, partner."; exit 1; }
command -v npm  >/dev/null 2>&1 || { say "rampage needs npm — install it first, partner."; exit 1; }

say "🤠 installing rampage into $RAMPAGE_HOME ..."
mkdir -p "$RAMPAGE_HOME" "$HOOKS_DIR"

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

# remember a pre-existing global hooksPath (ggshield etc.) so we can chain it
previous=$(git config --global --get core.hooksPath 2>/dev/null || true)
if [ -n "$previous" ] && [ "$previous" != "$HOOKS_DIR" ]; then
  printf '%s\n' "$previous" > "$RAMPAGE_HOME/previous-hooks-path"
  say "   chaining your existing global hooks: $previous"
fi

# pre-commit: rampage scan → previous global hook (if any) → repo's own hook
cat > "$HOOKS_DIR/pre-commit" <<HOOKEOF
#!/bin/sh
# rampage PII scanner — https://rampage.alphabeti.se
node "$RAMPAGE_HOME/scan-staged.mjs" || exit \$?
prev_dir=\$(cat "$RAMPAGE_HOME/previous-hooks-path" 2>/dev/null || true)
if [ -n "\$prev_dir" ] && [ -x "\$prev_dir/pre-commit" ]; then
  exec "\$prev_dir/pre-commit" "\$@"
fi
repo_hook="\$(git rev-parse --git-dir)/hooks/pre-commit"
[ -x "\$repo_hook" ] && exec "\$repo_hook" "\$@"
exit 0
HOOKEOF
chmod +x "$HOOKS_DIR/pre-commit"

# every other client-side hook: pure pass-through so nothing gets silenced
for hook in applypatch-msg pre-applypatch post-applypatch pre-merge-commit \
            prepare-commit-msg commit-msg post-commit pre-rebase post-checkout \
            post-merge pre-push post-rewrite pre-auto-gc sendemail-validate; do
  cat > "$HOOKS_DIR/$hook" <<SHIMEOF
#!/bin/sh
prev_dir=\$(cat "$RAMPAGE_HOME/previous-hooks-path" 2>/dev/null || true)
if [ -n "\$prev_dir" ] && [ -x "\$prev_dir/$hook" ]; then
  exec "\$prev_dir/$hook" "\$@"
fi
repo_hook="\$(git rev-parse --git-dir)/hooks/$hook"
[ -x "\$repo_hook" ] && exec "\$repo_hook" "\$@"
exit 0
SHIMEOF
  chmod +x "$HOOKS_DIR/$hook"
done

git config --global core.hooksPath "$HOOKS_DIR"

say "✅ rampage is watching every repo on this machine."
say "   previous global hooks and repo-local .git/hooks still run after the scan."
say "   skip once:  RAMPART_SKIP=1 git commit ..."
say "   uninstall:  git config --global core.hooksPath \"\$(cat $RAMPAGE_HOME/previous-hooks-path 2>/dev/null)\" || git config --global --unset core.hooksPath"
say "   (first scan downloads the ~15MB model from hugging face, then it's cached)"
