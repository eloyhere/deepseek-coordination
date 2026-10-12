#!/usr/bin/env bash
#
# dsh-os.sh - POSIX implementation of the dsh-os atomic command surface.
#
# Contract: command.txt (authoritative), docs/os-spec.md, spec/verbs.tsv, spec/charsets.tsv.
# This file is the counterpart of src/host/bin/dsh-os.ps1 and must accept exactly the same
# arguments and emit exactly the same JSON envelope shape, so a caller can run the same command on
# either platform and parse the same result.
#
# Design rules, mirroring the Windows implementation:
#   * Values arrive as separate argv elements. This script never re-parses a command line and never
#     assembles one, so a path containing spaces stays a single argument.
#   * File content is read and written byte-exactly. The BOM is stripped on read and restored on
#     write; the file's line-ending convention is preserved across every mutation.
#   * stdout carries exactly one UTF-8 (no BOM) JSON envelope. stderr is for humans only.
#   * Read-only verbs never prompt; mutating verbs require --allow.
#   * Unsupported capabilities return a typed error rather than an empty success.
#
# Requires only POSIX shell utilities plus iconv(1). LC_ALL is pinned to a UTF-8 locale because a
# byte-oriented C locale silently corrupts non-ASCII paths and content.

set -euo pipefail

# ---------------------------------------------------------------------------
# Locale and stream encoding. A non-UTF-8 locale is refused rather than
# tolerated: silently mangling non-ASCII text is the exact failure this layer
# exists to prevent.
# ---------------------------------------------------------------------------
pin_locale() {
  for candidate in C.UTF-8 en_US.UTF-8 C.utf8; do
    if [ "$(LC_ALL="$candidate" locale charmap 2>/dev/null || true)" = "UTF-8" ]; then
      export LC_ALL="$candidate"
      return 0
    fi
  done
  # Fall back to whatever is set if it is genuinely UTF-8.
  if [ "$(locale charmap 2>/dev/null || true)" = "UTF-8" ]; then
    export LC_ALL="${LC_ALL:-${LANG:-C.UTF-8}}"
    return 0
  fi
  printf '%s\n' '{"ok":false,"verb":null,"error":{"code":"E_NOT_SUPPORTED","message":"a UTF-8 locale is required; set LC_ALL to a UTF-8 locale","hint":"try LC_ALL=C.UTF-8"}}'
  exit 4
}
pin_locale

SELF_PATH="$0"
case "$SELF_PATH" in
  /*) ;;
  *) SELF_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")" ;;
esac
SCRIPT_DIR="$(cd "$(dirname "$SELF_PATH")" && pwd)"
HOST_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# The repository root is found by walking upward for a marker rather than by counting ".." levels:
# counting is what silently produced a wrong root on the Windows side and disarmed the
# protected-path guard, so both implementations locate the root the same explicit way.
find_repo_dir() {
  dir="$1"
  local i=0
  while [ -n "$dir" ] && [ "$i" -lt 8 ]; do
    if [ -f "$dir/package.json" ] && [ -d "$dir/src/host" ]; then
      printf '%s' "$dir"
      return 0
    fi
    local parent
    parent="$(dirname "$dir")"
    # `[ ... ] && break` must not be the last command of the function: when the test is FALSE its
    # status is 1, and because the caller assigns the result with ROOT_DIR="$(find_repo_dir ...)",
    # `set -e` then aborts the entire script during load. That made every failing invocation die
    # before the entry point could re-emit its envelope, and it also silently emptied ROOT_DIR.
    if [ "$parent" = "$dir" ]; then
      break
    fi
    dir="$parent"
    i=$((i + 1))
  done
  # Fall back to the historical assumption so a relocated script still runs.
  (cd "$SCRIPT_DIR/../.." && pwd)
  return 0
}
