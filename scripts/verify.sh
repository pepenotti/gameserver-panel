#!/usr/bin/env bash
# Every gate, in the order CI would run them. "Green" means all of these pass,
# not just the tests.
#
#   scripts/verify.sh            all gates
#   scripts/verify.sh --offline  skip npm audit (needs the registry)
set -euo pipefail
cd "$(dirname "$0")/.."

offline=false
[[ "${1:-}" == "--offline" ]] && offline=true

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

step "lint"
npx eslint . --max-warnings=0

step "typecheck"
npm run typecheck --silent

step "tests"
npx vitest run

if [[ "$offline" == false ]]; then
  step "npm audit (runtime deps)"
  npm audit --omit=dev --audit-level=high
fi

step "line endings"
if git ls-files --eol | grep -E '^i/crlf' | grep -v 'fixtures/' ; then
  echo "CRLF files are committed; .gitattributes should prevent this." >&2
  exit 1
fi

printf '\n\033[32mAll gates green.\033[0m\n'
