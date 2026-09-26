#!/usr/bin/env bash
# PostToolUse hook (Edit|Write): lint --fix the edited file, then typecheck the workspace.
# Exit 2 feeds errors back to Claude so they are fixed immediately.
set -uo pipefail

file=$(jq -r '.tool_response.filePath // .tool_input.file_path // empty')
case "$file" in
  *.ts | *.tsx | *.js | *.mjs) ;;
  *) exit 0 ;;
esac
case "$file" in
  */node_modules/* | */src/generated/* | */.next/*) exit 0 ;;
esac

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}" || exit 0
[ -f "$file" ] || exit 0

if ! out=$(pnpm exec eslint --fix "$file" 2>&1); then
  echo "ESLint errors in $file:" >&2
  echo "$out" >&2
  exit 2
fi

if ! out=$(pnpm typecheck 2>&1); then
  echo "Typecheck failed after editing $file:" >&2
  echo "$out" | grep -E "error TS|: error" | head -30 >&2
  exit 2
fi
exit 0
