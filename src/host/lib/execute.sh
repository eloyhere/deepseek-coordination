# Module: execute.sh - execute.command / execute.synchronous / execute.asynchronous.
#
# Contract, mirroring src/host/lib/execute.ps1 so a caller sees the same shape on both platforms:
#   - every element of the array is a SHELL command. The verb is named "command", the documented
#     examples are quoted strings, and the Windows side already runs them through cmd.exe. The POSIX
#     side therefore runs each through sh -c. This is the one verb group where a shell string is the
#     contract rather than a hazard; every other verb passes argv directly and never builds a command.
#   - synchronous runs them in order and STOPS at the first non-zero exit, so later steps never run
#     against a broken precondition.
#   - asynchronous starts them all first and only then collects. Waiting inside the start loop would
#     silently serialise it, which is the difference the verb exists to provide.
#   - each result reports exitCode (null when timed out), timedOut, durationMs, stdout and stderr.
#
# Output is redirected to scratch FILES, not pipes. A pipe whose reader is not draining fills up and
# deadlocks the whole run; a file cannot fill. This is why the collector can be a plain wait loop.

# Scratch files for the asynchronous run, and the per-command result, both at module scope so the
# helper functions can fill them in and the caller can read them.
EXEC_STATUS=""
EXEC_OUT=""
EXEC_ERR=""
EXEC_ELAPSED=0
EXEC_TIMED_OUT=0
EXEC_TIMEOUT=120000

# Milliseconds since the epoch. `date +%s%3N` is GNU; the fallback covers a date that lacks the
# extension by reporting whole seconds, which keeps arithmetic correct if less precise.
now_ms() {
  local t
  t="$(date +%s%3N 2>/dev/null)"
  case "$t" in
    ''|*[!0-9]*) printf '%s' "$(( $(date +%s) * 1000 ))" ;;
    *) printf '%s' "$t" ;;
  esac
}

# Does the coreutils timeout(1) exist? It enforces a deadline precisely and leaves nothing behind,
# which the fallback below cannot promise.
HAVE_TIMEOUT=0
if command -v timeout >/dev/null 2>&1; then HAVE_TIMEOUT=1; fi

# Run a command with a deadline. Prints the exit status to stdout.
#
# With timeout(1) available this is exact. The fallback uses "kill -0" in a loop, which is correct but
# costs a process spawn per iteration (about 27ms under git-bash), so on that platform the reported
# duration of a very short command is inflated by roughly a tenth of a second.
run_with_deadline() {
  local timeout_ms="$1"; shift
  if [ "$HAVE_TIMEOUT" = "1" ]; then
    local seconds
    seconds="$(awk -v ms="$timeout_ms" 'BEGIN { printf "%.2f", ms / 1000 }' 2>/dev/null)"
    case "$seconds" in ''|*[!0-9.]*) seconds="$(( (timeout_ms + 999) / 1000 ))" ;; esac
    timeout -k 1 "$seconds" "$@"
    return $?
  fi

  "$@" &
  local pid=$!
  local deadline=$(( $(now_ms) + timeout_ms ))
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$(now_ms)" -ge "$deadline" ]; then
      kill -TERM "$pid" 2>/dev/null || true
      sleep 1
      kill -KILL "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      # 124 is the status timeout(1) reports for a deadline it enforced, so the caller has one rule.
      return 124
    fi
    sleep 0.2
  done
  wait "$pid" 2>/dev/null
  return $?
}

# Wait for an already-running background pid, killing it once the timeout elapses.
# Returns 0 when the child exited on its own, 124 when it had to be killed.
#
# Only used when the caller cannot wrap the command in run_with_deadline, which is not the case here:
# both exec_launch and exec_launch_argv go through run_with_deadline. Kept for completeness because a
# timeout that silently fails to fire is worse than a slightly imprecise one.
wait_with_timeout() {
  local pid="$1" timeout_ms="$2"
  local deadline=$(( $(now_ms) + timeout_ms ))
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$(now_ms)" -ge "$deadline" ]; then
      kill -TERM "$pid" 2>/dev/null || true
      sleep 1
      kill -KILL "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    sleep 0.2
  done
  wait "$pid" 2>/dev/null || true
  return 0
}

# Launch one shell command into the given scratch prefix. Prints the command's exit status; prints
# nothing (empty) when it was killed for exceeding its deadline.
#
# The command runs through sh -c, NOT through eval. With eval, a command that calls exit - an ordinary
# thing to write, and one of the golden cases - terminates the wrapping subshell before the status is
# written, so no status reaches the caller and the command is then misreported as timed out. sh -c
# returns the status normally, and it is the same shell the Windows side uses for a command line.
#
# run_with_deadline performs the waiting, so this function never backgrounds the child itself. That is
# deliberate: an earlier version backgrounded it and polled, which inflated every measured duration.
exec_launch() {
  local command="$1" workdir="$2" prefix="$3"
  : >"$prefix.out"; : >"$prefix.err"; rm -f "$prefix.rc" "$prefix.timedout"
  local status
  if [ -n "$workdir" ]; then
    status="$( cd "$workdir" 2>/dev/null || exit 127
               run_with_deadline "$EXEC_TIMEOUT" sh -c "$command" >"$prefix.out" 2>"$prefix.err"
               printf '%s' "$?" )"
  else
    status="$( run_with_deadline "$EXEC_TIMEOUT" sh -c "$command" >"$prefix.out" 2>"$prefix.err"
               printf '%s' "$?" )"
  fi
  case "$status" in
    '') printf 'deadline' >"$prefix.timedout" ;;       # fallback path killed it
    124) printf 'deadline' >"$prefix.timedout" ;;      # timeout(1) enforced the deadline
    *) printf '%s' "$status" >"$prefix.rc" ;;
  esac
  printf '%s' "$status"
}

# Background variant used by execute.asynchronous: start the command now, record its status into
# <prefix>.rc, and return immediately so the caller can start the next one. This is what makes the
# asynchronous verb actually asynchronous; the foreground variant above would serialise it.
exec_launch_bg() {
  local command="$1" workdir="$2" prefix="$3"
  : >"$prefix.out"; : >"$prefix.err"; rm -f "$prefix.rc"
  if [ -n "$workdir" ]; then
    ( cd "$workdir" 2>/dev/null || exit 127
      s="$(run_with_deadline "$EXEC_TIMEOUT" sh -c "$command" >"$prefix.out" 2>"$prefix.err"; printf '%s' "$?")"
      case "$s" in ''|124) printf 'deadline' >"$prefix.timedout" ;; *) printf '%s' "$s" >"$prefix.rc" ;; esac ) &
  else
    ( s="$(run_with_deadline "$EXEC_TIMEOUT" sh -c "$command" >"$prefix.out" 2>"$prefix.err"; printf '%s' "$?")"
      case "$s" in ''|124) printf 'deadline' >"$prefix.timedout" ;; *) printf '%s' "$s" >"$prefix.rc" ;; esac ) &
  fi
  printf '%s' "$!"
}

# Fill EXEC_STATUS / EXEC_OUT / EXEC_ERR / EXEC_ELAPSED / EXEC_TIMED_OUT from one scratch prefix.
exec_collect() {
  local prefix="$1" started="$2"
  EXEC_OUT="$(cat "$prefix.out" 2>/dev/null || true)"
  EXEC_ERR="$(cat "$prefix.err" 2>/dev/null || true)"
  if [ -s "$prefix.rc" ]; then
    EXEC_STATUS="$(cat "$prefix.rc" 2>/dev/null)"
    EXEC_TIMED_OUT=0
EXEC_TIMEOUT=120000
  else
    EXEC_STATUS=""
    EXEC_TIMED_OUT=1
  fi
  EXEC_ELAPSED=$(( $(now_ms) - started ))
}

exec_result_json() {
  local command="$1"
  if [ "$EXEC_TIMED_OUT" = "0" ]; then
    printf '{"command":%s,"exitCode":%s,"timedOut":false,"durationMs":%s,"stdout":%s,"stderr":%s}' \
      "$(jstr "$command")" "$EXEC_STATUS" "$EXEC_ELAPSED" "$(jstr "$EXEC_OUT")" "$(jstr "$EXEC_ERR")"
  else
    # exitCode is null rather than 0 so a killed command can never look like a successful one.
    printf '{"command":%s,"exitCode":null,"timedOut":true,"durationMs":%s,"stdout":%s,"stderr":%s}' \
      "$(jstr "$command")" "$EXEC_ELAPSED" "$(jstr "$EXEC_OUT")" "$(jstr "$EXEC_ERR")"
  fi
}

exec_validate_timeout() {
  local timeout="$1"
  case "$timeout" in
    ''|*[!0-9]*) fail E_TYPE "<timeout> must be an integer, got '$timeout'" ;;
  esac
}

# Flags that are declared for a verb, are accepted by the argument parser, and CANNOT be honoured on this
# platform. Accepting them silently is the one outcome the contract forbids: a caller that passes
# --stdin and gets no input delivered, or --env and gets no variable set, has been misled by a success
# envelope. They are refused with a typed error instead.
#
# The Windows side reads --shell, --env, --stdin and --background and acts on the first three; --encoding
# selects the code page its output is decoded with. On POSIX the shell is always /bin/sh, so --shell has
# no distinct meaning and is refused too rather than silently ignored.
exec_reject_unhonoured_flags() {
  local verb="$1"
  local flag
  for flag in shell env stdin background encoding; do
    if have_flag "$flag"; then
      fail E_NOT_SUPPORTED "--$flag is not honoured on this platform" \
        "$verb runs the command through /bin/sh and passes no environment, stdin or code page"
    fi
  done
  return 0
}

cmd_execute_synchronous() {
  require_min 1 'execute synchronous'
  require_allow 'execute synchronous' "${#POSITIONALS[@]}"
  exec_reject_unhonoured_flags 'execute synchronous'
  local workdir timeout
  workdir="$(flag_value workdir)"
  timeout="$(flag_value timeout 120000)"
  exec_validate_timeout "$timeout"

  local start_ms n=${#POSITIONALS[@]}
  start_ms="$(now_ms)"
  local dir="$ROOT_DIR/.temporary/exec-sync-$$"
  mkdir -p "$dir" 2>/dev/null || true

  local results="" executed=0 failed=0 i=0
  while [ "$i" -lt "$n" ]; do
    local cmd="${POSITIONALS[$i]}" prefix="$dir/$i"
    local one_start; one_start="$(now_ms)"
    EXEC_TIMEOUT="$timeout"
    exec_launch "$cmd" "$workdir" "$prefix" >/dev/null
    exec_collect "$prefix" "$one_start"
    executed=$((executed + 1))
    results="$results$( [ "$executed" -gt 1 ] && printf ',' )$(exec_result_json "$cmd")"
    # Stop at the first failure: continuing would run later commands on a broken precondition.
    if [ "$EXEC_TIMED_OUT" = "1" ] || [ "$EXEC_STATUS" != "0" ]; then
      failed=1
      break
    fi
    i=$((i + 1))
  done
  rm -rf "$dir" 2>/dev/null || true

  local total all="false"
  total=$(( $(now_ms) - start_ms ))
  if [ "$failed" -eq 0 ] && [ "$executed" -eq "$n" ]; then all="true"; fi
  printf '{"mode":"synchronous","requested":%s,"executed":%s,"failed":%s,"allSucceeded":%s,"totalDurationMs":%s,"results":[%s]}' \
    "$n" "$executed" "$failed" "$all" "$total" "$results"
}

cmd_execute_asynchronous() {
  require_min 1 'execute asynchronous'
  require_allow 'execute asynchronous' "${#POSITIONALS[@]}"
  exec_reject_unhonoured_flags 'execute asynchronous'
  local workdir timeout
  workdir="$(flag_value workdir)"
  timeout="$(flag_value timeout 120000)"
  exec_validate_timeout "$timeout"

  local start_ms n=${#POSITIONALS[@]}
  start_ms="$(now_ms)"
  local dir="$ROOT_DIR/.temporary/exec-async-$$"
  mkdir -p "$dir" 2>/dev/null || true

  # Start every command before collecting any. This is the whole point of the verb.
  local pids=() starts=() k=0
  EXEC_TIMEOUT="$timeout"
  while [ "$k" -lt "$n" ]; do
    local cmd="${POSITIONALS[$k]}"
    starts+=("$(now_ms)")
    pids+=("$(exec_launch_bg "$cmd" "$workdir" "$dir/$k")")
    k=$((k + 1))
  done

  # Collect after the last start. Each wait is independently bounded, so one slow command cannot
  # extend another's timeout.
  local results="" executed=0 failed=0
  k=0
  while [ "$k" -lt "$n" ]; do
    local cmd="${POSITIONALS[$k]}" pid="${pids[$k]}"
    wait_with_timeout "$pid" "$timeout" || true
    exec_collect "$dir/$k" "${starts[$k]}"
    executed=$((executed + 1))
    results="$results$( [ "$executed" -gt 1 ] && printf ',' )$(exec_result_json "$cmd")"
    if [ "$EXEC_TIMED_OUT" = "1" ] || [ "$EXEC_STATUS" != "0" ]; then
      failed=$((failed + 1))
    fi
    k=$((k + 1))
  done
  rm -rf "$dir" 2>/dev/null || true

  local total all="false"
  total=$(( $(now_ms) - start_ms ))
  if [ "$failed" -eq 0 ] && [ "$executed" -eq "$n" ]; then all="true"; fi
  printf '{"mode":"asynchronous","requested":%s,"executed":%s,"failed":%s,"allSucceeded":%s,"totalDurationMs":%s,"results":[%s]}' \
    "$n" "$executed" "$failed" "$all" "$total" "$results"
}

# execute.command: a single command with its own argument vector.
#
# The first positional is the program and the rest are its arguments, passed as a real argv array:
# this is the one form in the surface that never involves a shell, which is why it exists next to the
# batch verbs. It reads POSITIONALS through pos(), like every other verb, because dispatch calls a
# verb function with no arguments at all.
cmd_execute_command() {
  require_min 1 'execute command'
  require_allow 'execute command' "${#POSITIONALS[@]}"
  exec_reject_unhonoured_flags 'execute command'
  local workdir timeout
  workdir="$(flag_value workdir)"
  timeout="$(flag_value timeout 120000)"
  exec_validate_timeout "$timeout"

  local argv=()
  local i=0 n=${#POSITIONALS[@]}
  while [ "$i" -lt "$n" ]; do argv+=("${POSITIONALS[$i]}"); i=$((i + 1)); done

  local dir="$ROOT_DIR/.temporary/exec-one-$$"
  mkdir -p "$dir" 2>/dev/null || true
  local prefix="$dir/0"
  : >"$prefix.out"; : >"$prefix.err"; rm -f "$prefix.rc" "$prefix.timedout"

  # Same deadline handling as the batch launchers: the command runs as a real argv with no shell, and
  # a deadline kill is recorded in a marker file rather than passed off as an exit status.
  local start_ms; start_ms="$(now_ms)"
  local st
  if [ -n "$workdir" ]; then
    st="$( cd "$workdir" 2>/dev/null || exit 127
           run_with_deadline "$timeout" "${argv[@]}" >"$prefix.out" 2>"$prefix.err"
           printf '%s' "$?" )"
  else
    st="$( run_with_deadline "$timeout" "${argv[@]}" >"$prefix.out" 2>"$prefix.err"
           printf '%s' "$?" )"
  fi
  case "$st" in
    ''|124) printf 'deadline' >"$prefix.timedout" ;;
    *) printf '%s' "$st" >"$prefix.rc" ;;
  esac
  exec_collect "$prefix" "$start_ms"
  rm -rf "$dir" 2>/dev/null || true

  local argv_json="" a=""
  for a in "${argv[@]}"; do
    argv_json="$argv_json$( [ -n "$argv_json" ] && printf ',' )$(jstr "$a")"
  done
  printf '{"argv":[%s],"exitCode":%s,"timedOut":%s,"durationMs":%s,"stdout":%s,"stderr":%s}' \
    "$argv_json" \
    "$( [ "$EXEC_TIMED_OUT" = "0" ] && printf '%s' "$EXEC_STATUS" || printf 'null' )" \
    "$( [ "$EXEC_TIMED_OUT" = "0" ] && printf 'false' || printf 'true' )" \
    "$EXEC_ELAPSED" "$(jstr "$EXEC_OUT")" "$(jstr "$EXEC_ERR")"
}
