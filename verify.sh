#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./verify.sh [quick]

Runs project checks without installing dependencies or starting services.
  quick  Run type checks and core tests only.
  (none) Run type checks, core tests, and the production build.
EOF
}

case "${1:-}" in
  --help|-h)
    usage
    exit 0
    ;;
  quick|"")
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

pnpm typecheck
pnpm test:core

if [[ "${1:-}" != "quick" ]]; then
  pnpm build
  pnpm verify:bundle
fi
