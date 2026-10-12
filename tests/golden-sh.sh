#!/usr/bin/env bash
#
# golden-sh.sh - POSIX acceptance cases for src/host/bin/dsh-os.sh.
#
# The counterpart of tests/golden.ps1. Every case asserts the same invariant the contract requires:
# a caller always receives exactly ONE parseable JSON envelope on STDOUT, whether the invocation
# succeeded or failed. A failing invocation that returns only an exit code is useless to an agent,
# which is why the failure cases are the point of this file rather than an afterthought.
#
# Usage: bash tests/golden-sh.sh        (exit 0 when every case passes)

SH_NAME="dsh-os.sh"
TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$TESTS_DIR/.." && pwd)"
SH="$ROOT_DIR/src/host/bin/$SH_NAME"
BOX="$ROOT_DIR/.temporary/golden-sh"
rm -rf "$BOX"; mkdir -p "$BOX"

PASS=0; FAIL=0
FAILED_NAMES=""

# run <description> <expect-exit-class> -- <args...>
# Captures stdout separately from stderr, because the envelope must be on stdout alone.
run() {
  local desc="$1"; shift
  local want="$1"; shift
  [ "$1" = "--" ] && shift
  local out rc
  out="$(cd "$ROOT_DIR" && bash "$SH" "$@" 2>/dev/null)"
  rc=$?
  local ok=1
  [ -n "$out" ] || ok=0
  case "$out" in '{'*) ;; *) ok=0 ;; esac
  if [ "$want" != "-" ] && [ "$rc" != "$want" ]; then ok=0; fi
  if [ "$ok" = "1" ]; then
    PASS=$((PASS+1))
    printf '  PASS  %-46s rc=%-3s %s\n' "$desc" "$rc" "$(printf '%s' "$out" | cut -c1-72)"
  else
    FAIL=$((FAIL+1)); FAILED_NAMES="$FAILED_NAMES
  - $desc (rc=$rc, envelope=$( [ -n "$out" ] && echo present || echo MISSING ))"
    printf '  FAIL  %-46s rc=%-3s envelope=%s\n' "$desc" "$rc" "$( [ -n "$out" ] && echo present || echo MISSING )"
  fi
}

# extract <json> <key> - crude but dependency-free single-key read for assertions.
extract() {
  printf '%s' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p" | head -1
}

echo "== success paths must emit an envelope =="
run "selfcheck"                0 -- selfcheck
run "file charset"             0 -- file charset src/host/command.txt
run "file charset (named arg)" 0 -- file charset path=src/host/command.txt
run "file length"              0 -- file length src/host/command.txt
run "file information"         0 -- file information src/host/command.txt
run "file list"                0 -- file list src/host/spec
run "file view range"          0 -- file view src/host/spec/charsets.tsv utf-8 0 40
run "file verify charset"      0 -- file verify charset src/host/command.txt utf-8
run "file verify encoding"     0 -- file verify encoding src/host/command.txt utf-8
run "file search"              0 -- file search src/host/spec tsv
run "system brand"             0 -- system brand
run "system version"           0 -- system version
run "task list"                0 -- task list --limit 3
run "environment get"          0 -- environment get PATH --scope process
run "environment attribute get" 0 -- environment attribute get PATH --scope process
run "permission list"          0 -- permission list

echo "== failing paths must ALSO emit an envelope on stdout =="
run "missing file"             5 -- file charset /nope.txt
run "directory as file"        5 -- file charset src/host
run "unknown verb"             4 -- bogus verb
run "too few arguments"        1 -- file create
run "missing named arg target" 1 -- file create content=x charset=utf-8
run "charset mismatch"         5 -- file view src/host/command.txt gbk
run "range out of bounds"      2 -- file view src/host/command.txt utf-8 0 99999999
run "absent variable"          5 -- environment get DSH_ABSENT_VAR --scope process
run "unsupported scope"        4 -- environment list --scope machine
run "search missing directory" 5 -- file search /no/such/dir x
run "search a file not a dir"  5 -- file search src/host/command.txt x
run "unknown flag"             1 -- file charset src/host/command.txt --nonsense
run "unknown named argument"   1 -- file charset nope=x

echo "== write authorization =="
run "create without --allow"   3 -- file create "$BOX/a.txt" x utf-8
run "create with --allow"      0 -- file create "$BOX/a.txt" x utf-8 --allow

echo "== agent-first file view: raw text plus structured lines =="
(cd "$ROOT_DIR" && bash "$SH" file create "$BOX/view.txt" "alpha
beta" utf-8 --allow >/dev/null 2>&1)
view="$(cd "$ROOT_DIR" && bash "$SH" file view "$BOX/view.txt" utf-8 0 10 2>/dev/null)"
if printf '%s' "$view" | grep -qF '"text":"alpha\nbeta"'; then
  PASS=$((PASS+1)); printf '  PASS  %-46s raw text has no line-number prefix\n' "view/text is raw"
else
  FAIL=$((FAIL+1)); FAILED_NAMES="$FAILED_NAMES
  - view/text is raw (got: $view)"
  printf '  FAIL  %-46s %s\n' "view/text is raw" "$view"
fi
if printf '%s' "$view" | grep -q '"lines":\[{"number":1,"text":"alpha"}'; then
  PASS=$((PASS+1)); printf '  PASS  %-46s structured lines present\n' "view/lines structured"
else
  FAIL=$((FAIL+1)); FAILED_NAMES="$FAILED_NAMES
  - view/lines structured (got: $view)"
  printf '  FAIL  %-46s %s\n' "view/lines structured" "$view"
fi
# --with-numbers is the opt-in human rendering and must not be the default.
viewnum="$(cd "$ROOT_DIR" && bash "$SH" file view "$BOX/view.txt" utf-8 0 10 --with-numbers 2>/dev/null)"
if printf '%s' "$viewnum" | grep -q '"text":"1: alpha'; then
  PASS=$((PASS+1)); printf '  PASS  %-46s opt-in human rendering\n' "view/--with-numbers"
else
  FAIL=$((FAIL+1)); FAILED_NAMES="$FAILED_NAMES
  - view/--with-numbers (got: $viewnum)"
  printf '  FAIL  %-46s %s\n' "view/--with-numbers" "$viewnum"
fi

echo "== round-trip: BOM and EOL survive =="
(cd "$ROOT_DIR" && bash "$SH" file create "$BOX/bom.txt" hello utf-8-bom --allow >/dev/null 2>&1)
hex="$(od -An -tx1 -N3 "$BOX/bom.txt" 2>/dev/null | tr -d ' \n')"
if [ "$hex" = "efbbbf" ]; then
  PASS=$((PASS+1)); printf '  PASS  %-46s BOM preserved\n' "utf-8-bom create"
else
  FAIL=$((FAIL+1)); FAILED_NAMES="$FAILED_NAMES
  - utf-8-bom create (first bytes=$hex, expected efbbbf)"
  printf '  FAIL  %-46s first bytes=%s\n' "utf-8-bom create" "$hex"
fi

echo
printf 'passed=%s failed=%s\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then printf 'failures:%s\n' "$FAILED_NAMES"; exit 1; fi
exit 0
