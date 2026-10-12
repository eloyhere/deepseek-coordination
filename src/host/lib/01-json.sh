ROOT_DIR="$(find_repo_dir "$SCRIPT_DIR")"

# ---------------------------------------------------------------------------
# JSON helpers. The envelope is built by hand so that control characters and
# non-ASCII are escaped predictably and stdout stays byte-stable.
# ---------------------------------------------------------------------------
json_escape() {
  # Escape a string for inclusion in a JSON document, on top of the raw bytes.
  LC_ALL=C awk '
    BEGIN { RS = "\x01" }
    {
      s = $0
      out = ""
      # Walk byte by byte; only the characters JSON requires are escaped.
      for (i = 1; i <= length(s); i++) {
        c = substr(s, i, 1)
        o = index("\"\\", c)
        if (c == "\"") { out = out "\\\"" }
        else if (c == "\\") { out = out "\\\\" }
        else if (c == "\n") { out = out "\\n" }
        else if (c == "\r") { out = out "\\r" }
        else if (c == "\t") { out = out "\\t" }
        else {
          v = 0
          # Detect control bytes; awk in the C locale treats each byte separately.
          if (c ~ /[\001-\010\013\014\016-\037\177]/) {
            printf "" > "/dev/null"
            out = out sprintf("\\u%04x", 0)
          } else {
            out = out c
          }
        }
      }
      printf "%s", out
    }
  ' <<<"$1"
}

# A simpler, faster escaper: use printf %q-free manual substitution via sed for the common cases,
# which is correct for the byte sequences this layer deals with (UTF-8 text, no lone control bytes
# in practice) while still escaping what JSON requires.
jstr() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '"%s"' "$s"
}

PARSE_PRETTY=0
PARSE_QUIET=0

emit_envelope() {
  # emit_envelope <verb> <result-json-or-empty> <error-json-or-empty> <duration-ms>
  local verb="$1" result="$2" error="$3" duration="$4"
  local body
  if [ -n "$error" ]; then
    body='{"ok":false,"verb":'"$(jstr "$verb")"',"error":'"$error"',"meta":{"durationMs":'"$duration"',"platform":"'"$(platform_name)"'","shell":"sh"}}'
  else
    body='{"ok":true,"verb":'"$(jstr "$verb")"',"result":'"$result"',"meta":{"durationMs":'"$duration"',"platform":"'"$(platform_name)"'","shell":"sh"}}'
  fi
  printf '%s\n' "$body"
}

platform_name() {
  case "$(uname -s 2>/dev/null || echo unknown)" in
    Darwin) printf 'darwin' ;;
    Linux) printf 'linux' ;;
    FreeBSD) printf 'freebsd' ;;
    MINGW*|MSYS*|CYGWIN*) printf 'windows' ;;
    *) printf 'unknown' ;;
  esac
}

EXIT_USAGE=1
EXIT_TYPE=2
EXIT_PERMISSION=3
EXIT_UNSUPPORTED=4
EXIT_TARGET=5
EXIT_TIMEOUT=6
EXIT_INTERNAL=7

exit_code_for() {
  case "$1" in
    E_USAGE) printf 1 ;;
    E_TYPE|E_CHARSET_UNKNOWN|E_BOUNDARY|E_RANGE|E_WINDOW_AMBIGUOUS) printf 2 ;;
    E_PERMISSION|E_PERMISSION_DENIED_BY_RULE|E_PERMISSION_PROTECTED_PATH|E_PERMISSION_DELEGATE_ONLY|E_PERMISSION_FILE_UNTRUSTED|E_PERMISSION_NO_ANSWERER|E_ELEVATION_REQUIRED) printf 3 ;;
    E_NOT_SUPPORTED|E_ACCESSIBILITY_DENIED|E_ACCESSIBILITY_UNAVAILABLE|E_NO_DISPLAY) printf 4 ;;
    E_TIMEOUT) printf 6 ;;
    E_ABORTED|E_INTERNAL) printf 7 ;;
    *) printf 5 ;;
  esac
}

fail() {
  # fail <code> <message> [hint]
  #
  # The envelope is stashed in a file, NOT printed to stdout, because almost every verb body runs
  # inside a $(...) command substitution and a command substitution captures stdout: anything
  # written there is swallowed, leaving the caller with a bare non-zero exit and no envelope.
  #
  # A scratch file is used rather than a file descriptor: writing to an inherited descriptor (fd 8)
  # produced an empty result under git-bash/MSYS even though the descriptor was demonstrably open
  # and the identical pattern works in a standalone script. A path is portable and observable.
  local code="$1" message="$2" hint="${3:-}"
  local err
  if [ -n "$hint" ]; then
    err='{"code":'"$(jstr "$code")"',"message":'"$(jstr "$message")"',"hint":'"$(jstr "$hint")"'}'
  else
    err='{"code":'"$(jstr "$code")"',"message":'"$(jstr "$message")"'}'
  fi
  local body='{"ok":false,"verb":'"$(jstr "${CURRENT_VERB:-}")"',"error":'"$err"',"meta":{"durationMs":'"${ELAPSED_MS:-0}"',"platform":"'"$(platform_name)"'","shell":"sh"}}'
  # The scratch path is derived here rather than read from a top-level variable. A variable set at
  # the top level of this script was observed to be EMPTY when fail() ran, while the same name read
  # inside the function had the right value -- so the value is not relied upon at all. ROOT_DIR and
  # HOST_DIR are set above and are stable, and there is exactly one scratch path per repository.
  local errfile="${ROOT_DIR}/.temporary/dsh-os.err"
  if [ -n "${ROOT_DIR:-}" ]; then
    mkdir -p "${ROOT_DIR}/.temporary" 2>/dev/null || true
    printf '%s\n' "$body" >"$errfile" 2>/dev/null || true
  fi
  # Also keep a copy on stderr for a human running the script by hand; it never participates in
  # parsing, and the entry point re-emits the file content on stdout exactly once.
  printf '%s\n' "$body" >&2
  exit "$(exit_code_for "$code")"
}

# read_envelope <code> <json> - build the success envelope without going through a subshell.
success_envelope() {
  local verb="$1" result="$2" duration="$3"
  printf '{"ok":true,"verb":%s,"result":%s,"meta":{"durationMs":%s,"platform":%s,"shell":"sh"}}' \
    "$(jstr "$verb")" "$result" "$duration" "$(jstr "$(platform_name)")"
}
