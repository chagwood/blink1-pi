#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

for script in scripts/*.sh; do
  bash -n "$script"
done

echo "Shell syntax: PASS"


if command -v shellcheck >/dev/null 2>&1; then
  shellcheck scripts/*.sh
  echo "ShellCheck: PASS"
else
  echo "ShellCheck: SKIP (shellcheck not installed)"
fi

node tests/extension.test.cjs

git diff --check
echo "Whitespace check: PASS"
