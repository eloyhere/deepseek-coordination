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

echo "== execute: argv form, and the two batch modes =="
run "execute command (argv, no shell)" 0 -- execute command echo hello --allow
run "execute command argv keeps a space" 0 -- execute command echo "a b c" --allow
run "execute synchronous"      0 -- execute synchronous "echo one" "echo two" --allow
run "execute asynchronous"     0 -- execute asynchronous "echo alpha" "echo beta" --allow
run "execute batch needs --allow" 3 -- execute synchronous "echo x"

echo "== execute: the behaviours that distinguish the two batch modes =="
# Synchronous must stop at the first failure, so the third command never runs.
sync_out="$(cd "$ROOT_DIR" && bash "$SH" execute synchronous "echo first" "exit 3" "echo never" --allow 2>/dev/null)"
if printf '%s' "$sync_out" | grep -qF '"executed":2' && printf '%s' "$sync_out" | grep -qF '"exitCode":3'; then
  PASS=$((PASS+1)); printf '  PASS  %-46s stops at first failure\n' "execute/sync stops"
else
  FAIL=$((FAIL+1)); FAILED_NAMES="$FAILED_NAMES
  - execute/sync stops (got: $sync_out)"
  printf '  FAIL  %-46s %s\n' "execute/sync stops" "$sync_out"
fi
# Asynchronous must run every command even when one fails, and count the failure.
async_out="$(cd "$ROOT_DIR" && bash "$SH" execute asynchronous "echo ok" "exit 2" --allow 2>/dev/null)"
if printf '%s' "$async_out" | grep -qF '"executed":2' && printf '%s' "$async_out" | grep -qF '"failed":1'; then
  PASS=$((PASS+1)); printf '  PASS  %-46s runs every command, counts failures\n' "execute/async continues"
else
  FAIL=$((FAIL+1)); FAILED_NAMES="$FAILED_NAMES
  - execute/async continues (got: $async_out)"
  printf '  FAIL  %-46s %s\n' "execute/async continues" "$async_out"
fi
# A command killed for exceeding its deadline has no status of its own, so exitCode must be null
# rather than a made-up number, and timedOut must be set.
to_out="$(cd "$ROOT_DIR" && bash "$SH" execute command sleep 5 --timeout 800 --allow 2>/dev/null)"
if printf '%s' "$to_out" | grep -qF '"timedOut":true' && printf '%s' "$to_out" | grep -qF '"exitCode":null'; then
  PASS=$((PASS+1)); printf '  PASS  %-46s killed, exitCode null\n' "execute/timeout"
else
  FAIL=$((FAIL+1)); FAILED_NAMES="$FAILED_NAMES
  - execute/timeout (got: $to_out)"
  printf '  FAIL  %-46s %s\n' "execute/timeout" "$to_out"
fi
# A command that fails on its own must report its real status, including for exit 0.
exit_out="$(cd "$ROOT_DIR" && bash "$SH" execute synchronous "exit 7" --allow 2>/dev/null)"
if printf '%s' "$exit_out" | grep -qF '"exitCode":7'; then
  PASS=$((PASS+1)); printf '  PASS  %-46s real status reported\n' "execute/exit status"
else
  FAIL=$((FAIL+1)); FAILED_NAMES="$FAILED_NAMES
  - execute/exit status (got: $exit_out)"
  printf '  FAIL  %-46s %s\n' "execute/exit status" "$exit_out"
fi

echo "== process verbs: task/execute query, show, kill =="
run "execute query (own pid)"  0 -- execute query "$$"
run "task query (own pid)"     0 -- task query "$$"
run "task query nonexistent"   5 -- task query 999999
run "execute query nonexistent" 5 -- execute query 999999
run "task query bad pid"       2 -- task query abc
run "task kill without allow"  3 -- task kill 999999
run "task kill nonexistent"    5 -- task kill 999999 --allow
run "task kill bad pid"        2 -- task kill abc --allow
run "task kill pid 0"          2 -- task kill 0 --allow
# task show needs a display server; here there is none, and the verb must say so rather than succeed.
show_out="$(cd "$ROOT_DIR" && bash "$SH" task show "$$" 2>&1)"
case "$show_out" in
  *'"ok":true'*)
    PASS=$((PASS+1)); printf '  PASS  %-46s activated (display present)\n' "task show" ;;
  *E_NO_DISPLAY*|*E_NOT_SUPPORTED*)
    PASS=$((PASS+1)); printf '  PASS  %-46s typed capability error\n' "task show" ;;
  *)
    FAIL=$((FAIL+1)); FAILED_NAMES="$FAILED_NAMES
  - task show (got: $show_out)"
    printf '  FAIL  %-46s %s\n' "task show" "$show_out" ;;
esac

echo "== task kill: a real process, and one that refuses to die =="
sleep 60 & victim=$!
sleep 0.3
kill_out="$(cd "$ROOT_DIR" && bash "$SH" task kill "$victim" --allow 2>/dev/null)"
if kill -0 "$victim" 2>/dev/null; then
  FAIL=$((FAIL+1)); FAILED_NAMES="$FAILED_NAMES
  - task kill (process survived SIGTERM: $kill_out)"
  printf '  FAIL  %-46s still alive\n' "task kill graceful"
  kill -9 "$victim" 2>/dev/null
else
  PASS=$((PASS+1)); printf '  PASS  %-46s terminated\n' "task kill graceful"
fi

# A process that traps SIGTERM must be reported as still running. Claiming it was killed would leave
# the caller operating on a process it believes is gone.
sh -c 'trap "" TERM; sleep 60' & stubborn=$!
sleep 0.4
stub_out="$(cd "$ROOT_DIR" && bash "$SH" task kill "$stubborn" --allow 2>/dev/null)"
if kill -0 "$stubborn" 2>/dev/null && printf '%s' "$stub_out" | grep -qF '"stillRunning":true'; then
  PASS=$((PASS+1)); printf '  PASS  %-46s survived and reported honestly\n' "task kill ignores TERM"
else
  FAIL=$((FAIL+1)); FAILED_NAMES="$FAILED_NAMES
  - task kill ignores TERM (got: $stub_out)"
  printf '  FAIL  %-46s %s\n' "task kill ignores TERM" "$stub_out"
fi
force_out="$(cd "$ROOT_DIR" && bash "$SH" task kill "$stubborn" --force --allow 2>/dev/null)"
if kill -0 "$stubborn" 2>/dev/null; then
  FAIL=$((FAIL+1)); FAILED_NAMES="$FAILED_NAMES
  - task kill --force (process survived SIGKILL: $force_out)"
  printf '  FAIL  %-46s survived SIGKILL\n' "task kill --force"
  kill -9 "$stubborn" 2>/dev/null
else
  PASS=$((PASS+1)); printf '  PASS  %-46s SIGKILL took effect\n' "task kill --force"
fi

echo "== permission: read-only views and the delegate-only refusals =="
run "permission list"           0 -- permission list
run "permission audit"          0 -- permission audit
run "permission query"          0 -- permission query file.delete x
run "permission query bad arity" 1 -- permission query
# The two write verbs must be DELEGATE_ONLY, and the enforcement is that there is no implementation in
# the script at all: a durable grant needs the approval dialog only the plugin can reach.
run "permission grant is delegate-only"  3 -- permission grant file.delete x allow-always --allow
run "permission revoke is delegate-only" 3 -- permission revoke r-0001 --allow
run "permission grant needs --allow"     3 -- permission grant file.delete x allow-always

echo "== permission: the reported ACL strength must be measured, not assumed =="
# Whatever the mode is, selfcheck, permission list and permission query must agree with each other and
# with the file's actual writability.
sc_acl="$(cd "$ROOT_DIR" && bash "$SH" selfcheck 2>/dev/null | sed -n 's/.*"aclEnforced":\(true\|false\).*/\1/p' | head -1)"
pl_acl="$(cd "$ROOT_DIR" && bash "$SH" permission list 2>/dev/null | sed -n 's/.*"aclEnforced":\(true\|false\).*/\1/p' | head -1)"
writable=no; [ -w "$ROOT_DIR/permission.json" ] && writable=yes
expected=true; [ "$writable" = "yes" ] && expected=false
if [ "$sc_acl" = "$pl_acl" ] && [ "$sc_acl" = "$expected" ]; then
  PASS=$((PASS+1)); printf '  PASS  %-46s %s (writable=%s)\n' "permission/acl measured" "$sc_acl" "$writable"
else
  FAIL=$((FAIL+1)); FAILED_NAMES="$FAILED_NAMES
  - permission/acl measured (selfcheck=$sc_acl list=$pl_acl writable=$writable)"
  printf '  FAIL  %-46s selfcheck=%s list=%s writable=%s\n' "permission/acl measured" "$sc_acl" "$pl_acl" "$writable"
fi

echo "== selfcheck must report what is really implemented =="
# The implemented list is derived from the dispatch table. It used to be a hardcoded string naming
# nine groups while the table answered thirty-six verbs, so a caller would have concluded that most of
# the working surface did not exist.
sc_impl="$(cd "$ROOT_DIR" && bash "$SH" selfcheck 2>/dev/null | sed -n 's/.*"implementedCount":\([0-9]*\).*/\1/p' | head -1)"
# Counted with awk rather than grep, because the dispatch lines contain a ')' that a basic regular
# expression treats as a literal only when a '\(' has not opened a group, and getting that subtly
# wrong silently yielded zero.
dispatch_count="$(awk "/^    '/ && /) dispatch/ { n++ } END { print n + 0 }" "$SH")"
if [ -n "$sc_impl" ] && [ "$sc_impl" = "$dispatch_count" ]; then
  PASS=$((PASS+1)); printf '  PASS  %-46s %s verbs\n' "selfcheck/implemented derived" "$sc_impl"
else
  FAIL=$((FAIL+1)); FAILED_NAMES="$FAILED_NAMES
  - selfcheck/implemented derived (reported=$sc_impl dispatch=$dispatch_count)"
  printf '  FAIL  %-46s reported=%s dispatch=%s\n' "selfcheck/implemented derived" "$sc_impl" "$dispatch_count"
fi

echo "== environment: write verbs at process scope =="
run "environment add"            0 -- environment add DSH_G1 hello --allow
run "environment add needs allow" 3 -- environment add DSH_G2 x
run "environment add bad scope"  4 -- environment add DSH_G3 x --scope galaxy --allow
# Each invocation is its own process, so a value added in one run is not visible in the next. That is
# the real semantics, and the result says so rather than implying the caller can read it back.
run "environment set absent"     5 -- environment set DSH_GONE x --allow
run "environment delete absent"  5 -- environment delete DSH_GONE --allow

echo "== environment attribute: list mutations at process scope =="
# The harness's `run` executes the verb in its own process, so a list to mutate has to be seeded in the
# environment that invocation inherits. attr_run does that for the value-mutating cases.
attr_run() {
  local desc="$1"; shift
  local want="$1"; shift
  [ "$1" = "--" ] && shift
  local out rc
  out="$(cd "$ROOT_DIR" && DSH_ATTR="/a:/b:/c" bash "$SH" "$@" 2>/dev/null)"
  rc=$?
  local ok=1
  [ -n "$out" ] || ok=0
  case "$out" in '{'*) ;; *) ok=0 ;; esac
  [ "$want" = "-" ] || [ "$rc" = "$want" ] || ok=0
  if [ "$ok" = "1" ]; then
    PASS=$((PASS+1)); printf '  PASS  %-46s rc=%-3s %s\n' "$desc" "$rc" "$(printf '%s' "$out" | cut -c1-72)"
  else
    FAIL=$((FAIL+1)); FAILED_NAMES="$FAILED_NAMES
  - $desc (rc=$rc, envelope=$( [ -n "$out" ] && echo present || echo MISSING ))"
    printf '  FAIL  %-46s rc=%-3s envelope=%s\n' "$desc" "$rc" "$( [ -n "$out" ] && echo present || echo MISSING )"
  fi
}

run "environment attribute list"  0 -- environment attribute list --scope process
attr_run "attribute add appends"        0 -- environment attribute add DSH_ATTR /d --attr DSH_ATTR --scope process --allow
attr_run "attribute add duplicate"      5 -- environment attribute add DSH_ATTR /a --attr DSH_ATTR --scope process --allow
attr_run "attribute set replaces"       0 -- environment attribute set DSH_ATTR 1 /X --attr DSH_ATTR --scope process --allow
attr_run "attribute set out of range"   2 -- environment attribute set DSH_ATTR 9 /X --attr DSH_ATTR --scope process --allow
attr_run "attribute set bad integer"    2 -- environment attribute set DSH_ATTR abc /X --attr DSH_ATTR --scope process --allow
attr_run "attribute delete by index"    0 -- environment attribute delete DSH_ATTR --attr DSH_ATTR --index 0 --scope process --allow
attr_run "attribute delete by value"    0 -- environment attribute delete DSH_ATTR --attr DSH_ATTR --value /c --scope process --allow
attr_run "attribute delete absent"      5 -- environment attribute delete DSH_ATTR --attr DSH_ATTR --value /nope --scope process --allow
attr_run "attribute delete no selector" 1 -- environment attribute delete DSH_ATTR --attr DSH_ATTR --scope process --allow
attr_run "attribute delete bad index"   2 -- environment attribute delete DSH_ATTR --attr DSH_ATTR --index abc --scope process --allow
# Mutations are refused at a persistent scope rather than half-applied, because this platform has no
# kernel API for a list variable and reconstructing PATH in a startup file can make shells unusable.
attr_run "attribute add bad scope"      4 -- environment attribute add DSH_ATTR /d --attr DSH_ATTR --scope user --allow
attr_run "attribute add needs allow"    3 -- environment attribute add DSH_ATTR /d --attr DSH_ATTR --scope process

# The mutated list must actually have changed, not merely been reported as changed.
out="$(cd "$ROOT_DIR" && DSH_ATTR="/a:/b" bash "$SH" environment attribute add DSH_ATTR /c --attr DSH_ATTR --scope process --allow 2>/dev/null)"
cnt="$(printf '%s' "$out" | sed -n 's/.*"count":\([0-9]*\).*/\1/p' | head -1)"
if [ "$cnt" = "3" ]; then
  PASS=$((PASS+1)); printf '  PASS  %-46s count=%s\n' "attribute add reports the new count" "$cnt"
else
  FAIL=$((FAIL+1)); FAILED_NAMES="$FAILED_NAMES
  - attribute add reports the new count (got '$cnt', expected 3)"
  printf '  FAIL  %-46s count=%s\n' "attribute add reports the new count" "$cnt"
fi

echo "== environment: persistent scope through a managed block =="
# A temporary HOME, so the real profile is never touched.
FIXHOME="$(mktemp -d)"
printf '# user profile\nPATH=/usr/bin\n' > "$FIXHOME/.profile"
user_env() { (cd "$ROOT_DIR" && HOME="$FIXHOME" bash "$SH" "$@" 2>&1); }
user_env environment add DSH_U1 one --scope user --allow >/dev/null
user_env environment set DSH_U1 "two three" --scope user --allow >/dev/null
user_env environment add DSH_U2 'a"b$c' --scope user --allow >/dev/null
# Idempotent: a second set must not append a duplicate.
user_env environment set DSH_U1 again --scope user --allow >/dev/null

block_dupes="$(grep -c '^export DSH_U1=' "$FIXHOME/.profile" || true)"
if [ "$block_dupes" = "1" ]; then
  PASS=$((PASS+1)); printf '  PASS  %-46s one entry per variable\n' "env/user block idempotent"
else
  FAIL=$((FAIL+1)); FAILED_NAMES="$FAILED_NAMES
  - env/user block idempotent (found $block_dupes entries for DSH_U1)"
  printf '  FAIL  %-46s %s entries for DSH_U1\n' "env/user block idempotent" "$block_dupes"
fi
# The file outside the managed block must survive byte for byte.
if grep -q '^# user profile' "$FIXHOME/.profile" && grep -q '^PATH=/usr/bin' "$FIXHOME/.profile"; then
  PASS=$((PASS+1)); printf '  PASS  %-46s unrelated lines intact\n' "env/user preserves file"
else
  FAIL=$((FAIL+1)); FAILED_NAMES="$FAILED_NAMES
  - env/user preserves file (header or PATH line lost)"
  printf '  FAIL  %-46s unrelated lines lost\n' "env/user preserves file"
fi
# The written file must still be valid shell: an unquoted value with a space or $ would break every
# future shell the user opens, which is the worst possible outcome for this verb.
if bash -n "$FIXHOME/.profile" 2>/dev/null; then
  PASS=$((PASS+1)); printf '  PASS  %-46s still valid shell\n' "env/user file syntax"
else
  FAIL=$((FAIL+1)); FAILED_NAMES="$FAILED_NAMES
  - env/user file syntax (the written profile is not valid shell)"
  printf '  FAIL  %-46s not valid shell\n' "env/user file syntax"
fi
# Deleting must remove only the managed entry.
user_env environment delete DSH_U1 --scope user --allow >/dev/null
if ! grep -q '^export DSH_U1=' "$FIXHOME/.profile" && grep -q '^export DSH_U2=' "$FIXHOME/.profile"; then
  PASS=$((PASS+1)); printf '  PASS  %-46s removes only its own entry\n' "env/user delete"
else
  FAIL=$((FAIL+1)); FAILED_NAMES="$FAILED_NAMES
  - env/user delete (did not remove exactly the requested variable)"
  printf '  FAIL  %-46s wrong entries removed\n' "env/user delete"
fi
rm -rf "$FIXHOME"

echo "== wait ms: the one desktop-group verb that needs no display server =="
run "wait ms 0"                  0 -- wait ms 0
run "wait ms 50"                 0 -- wait ms 50
# A negative value is a range error, not a type error: the Windows side reports E_RANGE for it, so the
# sign is checked before the digit test.
run "wait ms negative"           2 -- wait ms -5
run "wait ms not an integer"     2 -- wait ms abc
run "wait ms beyond one hour"    2 -- wait ms 3600001

# elapsedMs must be a real measurement. It was initially derived from $SECONDS, a whole-second counter,
# so a 250 ms wait reported elapsedMs 0 - a false measurement rather than a rounding detail.
out="$(cd "$ROOT_DIR" && bash "$SH" wait ms 250 2>/dev/null)"
el="$(printf '%s' "$out" | sed -n 's/.*"elapsedMs":\([0-9]*\).*/\1/p' | head -1)"
if [ -n "$el" ] && [ "$el" -ge 200 ] && [ "$el" -le 700 ]; then
  PASS=$((PASS+1)); printf '  PASS  %-46s elapsedMs=%s\n' "wait ms measures elapsed time" "$el"
else
  FAIL=$((FAIL+1)); FAILED_NAMES="$FAILED_NAMES
  - wait ms measures elapsed time (got '$el', expected roughly 250)"
  printf '  FAIL  %-46s elapsedMs=%s\n' "wait ms measures elapsed time" "$el"
fi

# The verbs the desktop group cannot provide must fail in a TYPED way rather than returning an empty
# success or merely an exit code. This machine has no display server, which is exactly the condition
# under test.
echo "== unavailable desktop verbs must be typed errors, never empty successes =="
# keyboard.* and mouse.* moved OUT of this list when they were implemented: they now report
# E_NO_DISPLAY from their own capability gate rather than falling through to the unimplemented arm, so
# they are asserted in their own sections. What remains are the groups still unimplemented here.
for v in "window list" "clipboard read" "screenshot 0 0 10 10" "text 1 1" "structure 1 1"; do
  out="$(cd "$ROOT_DIR" && bash "$SH" $v 2>/dev/null)"
  rc=$?
  ok=1
  [ -n "$out" ] || ok=0
  case "$out" in '{'*) ;; *) ok=0 ;; esac
  case "$out" in *'"code":"E_NOT_SUPPORTED"'*) ;; *) ok=0 ;; esac
  if [ "$ok" = "1" ]; then
    PASS=$((PASS+1)); printf '  PASS  %-46s rc=%-3s typed E_NOT_SUPPORTED\n' "$v" "$rc"
  else
    FAIL=$((FAIL+1)); FAILED_NAMES="$FAILED_NAMES
  - $v (rc=$rc, envelope=$( [ -n "$out" ] && echo present || echo MISSING ))"
    printf '  FAIL  %-46s rc=%-3s\n' "$v" "$rc"
  fi
done

echo "== mouse.*: implemented, and typed when there is no display =="
# These ARE dispatched now, so they must report the missing display rather than falling through to the
# unimplemented arm. On a machine WITH a display they would act, so the assertion is on the error code
# for the condition that actually holds here: E_NO_DISPLAY when DISPLAY is unset, otherwise an envelope.
if [ -z "${DISPLAY:-}" ]; then
  want_mouse=E_NO_DISPLAY
else
  want_mouse=ANY
fi
for v in "mouse cursor" "mouse over 10 20 --allow" "mouse click 10 20 --allow" \
         "mouse context 10 20 --allow" "mouse wheel 10 20 --allow" "mouse down 10 20 --allow" \
         "mouse up --allow"; do
  out="$(cd "$ROOT_DIR" && bash "$SH" $v 2>/dev/null)"
  rc=$?
  ok=1
  [ -n "$out" ] || ok=0
  case "$out" in '{'*) ;; *) ok=0 ;; esac
  if [ "$want_mouse" = "E_NO_DISPLAY" ]; then
    case "$out" in *'"code":"E_NO_DISPLAY"'*) ;; *) ok=0 ;; esac
  fi
  if [ "$ok" = "1" ]; then
    PASS=$((PASS+1)); printf '  PASS  %-46s rc=%-3s %s\n' "$v" "$rc" "$want_mouse"
  else
    FAIL=$((FAIL+1)); FAILED_NAMES="$FAILED_NAMES
  - $v (rc=$rc, envelope=$( [ -n "$out" ] && echo present || echo MISSING ))"
    printf '  FAIL  %-46s rc=%-3s\n' "$v" "$rc"
  fi
done

# The mouse verbs are dispatched, so they must be reported as implemented; selfcheck derives that list
# from the dispatch table, and a verb that is dispatched but unlisted is the drift this guards against.
out="$(cd "$ROOT_DIR" && bash "$SH" selfcheck 2>/dev/null)"
mc="$(printf '%s' "$out" | grep -o '"mouse\.[a-z]*"' | sort -u | wc -l | tr -d ' ')"
if [ "$mc" = "7" ]; then
  PASS=$((PASS+1)); printf '  PASS  %-46s 7/7 listed\n' "selfcheck lists every mouse verb"
else
  FAIL=$((FAIL+1)); FAILED_NAMES="$FAILED_NAMES
  - selfcheck lists every mouse verb (found $mc, expected 7)"
  printf '  FAIL  %-46s %s/7 listed\n' "selfcheck lists every mouse verb" "$mc"
fi

echo "== keyboard.*: implemented, and typed when there is no display =="
# The same gates as mouse.*: dispatched, capability-checked, and a typed error rather than a fall
# through to the unimplemented arm.
for v in "keyboard codes" "keyboard down Return --allow" "keyboard up Return --allow" \
         "keyboard press F5 --allow" "keyboard combination ctrl c --allow" \
         "keyboard type hello --allow"; do
  out="$(cd "$ROOT_DIR" && bash "$SH" $v 2>/dev/null)"
  rc=$?
  ok=1
  [ -n "$out" ] || ok=0
  case "$out" in '{'*) ;; *) ok=0 ;; esac
  if [ -z "${DISPLAY:-}" ]; then
    case "$out" in *'"code":"E_NO_DISPLAY"'*) ;; *) ok=0 ;; esac
  fi
  if [ "$ok" = "1" ]; then
    PASS=$((PASS+1)); printf '  PASS  %-46s rc=%-3s\n' "$v" "$rc"
  else
    FAIL=$((FAIL+1)); FAILED_NAMES="$FAILED_NAMES
  - $v (rc=$rc, envelope=$( [ -n "$out" ] && echo present || echo MISSING ))"
    printf '  FAIL  %-46s rc=%-3s\n' "$v" "$rc"
  fi
done

out="$(cd "$ROOT_DIR" && bash "$SH" selfcheck 2>/dev/null)"
kc="$(printf '%s' "$out" | grep -o '"keyboard\.[a-z]*"' | sort -u | wc -l | tr -d ' ')"
if [ "$kc" = "6" ]; then
  PASS=$((PASS+1)); printf '  PASS  %-46s 6/6 listed\n' "selfcheck lists every keyboard verb"
else
  FAIL=$((FAIL+1)); FAILED_NAMES="$FAILED_NAMES
  - selfcheck lists every keyboard verb (found $kc, expected 6)"
  printf '  FAIL  %-46s %s/6 listed\n' "selfcheck lists every keyboard verb" "$kc"
fi
echo "== every envelope must be well-formed JSON =="
# An unquoted field produced a malformed envelope that a shell-based check did not notice, because the
# assertions used grep on substrings. This parses each reply instead.
if command -v node >/dev/null 2>&1; then
  bad_json=0
  for args in "environment add DSH_J1 v --allow" "environment set DSH_J1 v2 --allow" \
              "environment delete DSH_J1 --allow" "permission list" "selfcheck" \
              "window list" "mouse cursor" "keyboard codes"; do
    out="$(cd "$ROOT_DIR" && bash "$SH" $args 2>/dev/null)"
    if ! printf '%s' "$out" | node -e 'let t="";process.stdin.on("data",d=>t+=d);process.stdin.on("end",()=>{try{JSON.parse(t);console.log("ok")}catch(e){console.log("bad")}})' 2>/dev/null | grep -q '^ok$'; then
      bad_json=$((bad_json + 1))
      printf '  (malformed: %s)\n' "$args"
    fi
  done
  if [ "$bad_json" -eq 0 ]; then
    PASS=$((PASS+1)); printf '  PASS  %-46s 8 envelopes parsed\n' "envelope/json well-formed"
  else
    FAIL=$((FAIL+1)); FAILED_NAMES="$FAILED_NAMES
  - envelope/json well-formed ($bad_json malformed)"
    printf '  FAIL  %-46s %s malformed\n' "envelope/json well-formed" "$bad_json"
  fi
else
  printf '  SKIP  %-46s node not available\n' "envelope/json well-formed"
fi

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
