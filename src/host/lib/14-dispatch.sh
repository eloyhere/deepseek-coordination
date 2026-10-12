
cmd_arg_error() {
  fail "$ARG_ERROR_CODE" "$ARG_ERROR_MESSAGE" "$ARG_ERROR_HINT"
}

# dispatch <verb-function...>
#
# Runs a verb body and records its status in MAIN_STATUS instead of letting a non-zero exit escape.
#
# This MUST be a top-level function, not a nested one inside main: the verb body runs in the command
# substitution below, which is what contains fail()'s `exit`. A nested definition is only in scope
# while main is executing, so any earlier caller (the entry-point argument-error path) hit
# "dispatch: command not found" and produced no envelope at all.
#
# RESULT is a global for the same reason: main reads it after the body has run.
RESULT=""
MAIN_STATUS=0

dispatch() {
  local status=0
  RESULT="$("$@")" || status=$?
  if [ "$status" -ne 0 ]; then
    MAIN_STATUS="$status"
  fi
  return 0
}

cmd_not_implemented() {
  fail E_NOT_SUPPORTED "verb '$CURRENT_VERB' is not implemented in this build" \
    'run: dsh-os.sh selfcheck   (implemented verbs are listed in its "implemented" field)'
}

# ---------------------------------------------------------------------------
# Dispatch. Two or three word verbs: "selfcheck", "file charset", "file verify charset".
# ---------------------------------------------------------------------------
known_verb() {
  local key="$1" file="$HOST_DIR/spec/verbs.tsv"
  [ -f "$file" ] || return 1
  awk -F'\t' -v k="$key" '!/^#/ && $1 == k { found = 1 } END { exit(found ? 0 : 1) }' "$file"
}

# Verb bodies that are declared in the verb table but not yet implemented here. Resolving them
# normally lets the case statement's default branch report a typed E_NOT_SUPPORTED envelope, instead
# of the script dying in the parser with nothing on stdout.
UNKNOWN_VERB=""

resolve_verb() {
  # Sets the global CURRENT_VERB and strips the consumed verb tokens from POSITIONALS.
  #
  # This must run in the CURRENT shell, not inside $(...). Called as CURRENT_VERB="$(resolve_verb)",
  # the reassignment of POSITIONALS happens in a subshell and is thrown away, so every verb body
  # then reads its first positional as the literal verb token ("file" instead of the path). The
  # result is a plausible-looking but wrong error such as: cannot read 'file': not found.
  local key="${POSITIONALS[0]:-}"
  if [ -z "$key" ]; then
    # Returns rather than calling fail(). fail() exits, and an exit raised here -- in the current
    # shell, before the entry point -- terminates the script with no envelope. The caller reports it.
    UNKNOWN_VERB=""
    return 2
  fi
  local consumed=1
  while [ "$consumed" -lt 3 ] && [ "$consumed" -lt "${#POSITIONALS[@]}" ]; do
    local token="${POSITIONALS[$consumed]}"
    case "$token" in -*) break ;; esac
    case "$token" in *[!a-z0-9-]*|'') break ;; esac
    local candidate="$key.$token"
    if known_verb "$candidate"; then
      key="$candidate"; consumed=$((consumed + 1))
    else
      # The key may still be extended further (file.verify is not a verb while
      # file.verify.charset is), so test the one deeper candidate before giving up. The guard also
      # verifies that the deeper key is not itself extendable, so a two-token continuation is only
      # accepted when it is a genuine terminal verb rather than a prefix of a longer one.
      if [ "$consumed" -lt 2 ] && [ $((consumed + 1)) -lt "${#POSITIONALS[@]}" ]; then
        local deeper="$candidate.${POSITIONALS[$((consumed + 1))]}"
        if known_verb "$deeper"; then
          local deeper_token="${POSITIONALS[$((consumed + 2))]:-}"
          local extends=""
          if [ -n "$deeper_token" ]; then
            case "$deeper_token" in
              -*) : ;;
              *[!a-z0-9-]*) : ;;
              *) if known_verb "$deeper.$deeper_token"; then extends="yes"; fi ;;
            esac
          fi
          if [ -z "$extends" ]; then
            key="$deeper"; consumed=$((consumed + 2))
          else
            break
          fi
        else
          break
        fi
      else
        break
      fi
    fi
  done
  # Drop the consumed verb tokens by rebuilding the array explicitly.
  #
  # The obvious form POSITIONALS=("${POSITIONALS[@]:$consumed}") is a trap: with `set -u`, slicing a
  # fully-consumed array is an unbound expansion, which in some bash builds aborts the whole script
  # inside the caller's command substitution. The symptom is that every verb returns an empty
  # "result" and every failure returns status 0, with the real error visible only on stderr. So the
  # remaining tokens are collected one at a time instead of sliced.
  local remaining=()
  local idx="$consumed"
  while [ "$idx" -lt "${#POSITIONALS[@]}" ]; do
    remaining+=("${POSITIONALS[$idx]}")
    idx=$((idx + 1))
  done
  POSITIONALS=()
  if [ "${#remaining[@]}" -gt 0 ]; then
    POSITIONALS=("${remaining[@]}")
  fi
  CURRENT_VERB="$key"
  return 0
}
