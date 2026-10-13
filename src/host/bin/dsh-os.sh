#!/usr/bin/env bash
# dsh-os.sh - GENERATED FILE. Do not edit directly.
#
# Assembled by tools/build.ps1 from src/host/lib/*.sh, which are the source of truth:
#
#   preamble.sh
#   json.sh
#   command.sh
#   native.sh
#   paths.sh
#   charset.sh
#   file.sh
#   system.sh
#   execute.sh
#   task.sh
#   environment.sh
#   service.sh
#   permission.sh
#   window.sh
#   dispatch.sh
#   entry.sh
#
# The shipped script is deliberately a single self-contained file, LF-terminated and BOM-free: the
# shebang must be the very first bytes, and a carriage return would become part of the last token on
# every line.


# ===== preamble.sh =================================================

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

# ===== json.sh =====================================================

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

# ===== command.sh ==================================================


# ---------------------------------------------------------------------------
# Argument parsing. Mirrors the Windows parser: --flag, or --flag value for the
# names that take one; anything else is positional. Unknown flags are refused so
# a typo cannot silently become a positional.
# ---------------------------------------------------------------------------
VALUE_FLAGS=" encoding eol button count space out screen format workdir env stdin timeout interval method pid regex name max-bytes max-chars depth source bom text charset length sha256 limit filter scope index decision delegate args attr value "
KNOWN_FLAGS=" allow pretty quiet json backup permanent parents no-recursive no-numbers with-numbers force hold clearmodifiers exact absent z-order shell background "

POSITIONALS=()
declare -A FLAGS=()
declare -A FLAG_MULTI=()
declare -A NAMED=()
unknown_flag=""
ARG_ERROR_CODE=""
ARG_ERROR_MESSAGE=""
ARG_ERROR_HINT=""

# Declared positional names for a verb, in order, read from spec/verbs.tsv.
verb_params() {
  local key="$1" file="$HOST_DIR/spec/verbs.tsv"
  [ -f "$file" ] || return 0
  awk -F'\t' -v k="$key" '!/^#/ && $1 == k && NF >= 2 { if ($2 != "-") { n = split($2, a, "|"); for (i = 1; i <= n; i++) print a[i] } }' "$file"
}

# Fold name="value" arguments into the positional list, in the order the verb table declares them,
# so no verb body needs to know which calling form was used. Mirrors Merge-NamedArguments in the
# PowerShell implementation, including its refusal of a parameter given both ways.
merge_named_args() {
  local key="$1"
  [ "${#NAMED[@]}" -eq 0 ] && return 0
  local declared=()
  while IFS= read -r pname; do
    [ -n "$pname" ] && declared+=("$pname")
  done < <(verb_params "$key")
  if [ "${#declared[@]}" -eq 0 ]; then
    ARG_ERROR_CODE="E_USAGE"
    ARG_ERROR_MESSAGE="verb '$key' takes no named arguments"
    ARG_ERROR_HINT="named arguments are declared in spec/verbs.tsv"
    return 1
  fi
  local n=${#declared[@]}
  local slots=() filled=()
  local k
  for ((k = 0; k < n; k++)); do slots[$k]=""; filled[$k]=0; done
  local pos=0
  for ((k = 0; k < ${#POSITIONALS[@]}; k++)); do
    if [ "$k" -lt "$n" ]; then
      slots[$k]="${POSITIONALS[$k]}"; filled[$k]=1
    else
      pos=$((k + 1))
      ARG_ERROR_CODE="E_USAGE"
      ARG_ERROR_MESSAGE="unexpected extra argument <${POSITIONALS[$k]}>"
      return 1
    fi
  done
  local name
  for name in "${!NAMED[@]}"; do
    local found=-1
    for ((k = 0; k < n; k++)); do
      if [ "${declared[$k]}" = "$name" ]; then found=$k; break; fi
    done
    if [ "$found" -lt 0 ]; then
      ARG_ERROR_CODE="E_USAGE"
      ARG_ERROR_MESSAGE="unknown named argument '$name' for '$key'"
      ARG_ERROR_HINT="accepted names, in order: ${declared[*]}"
      return 1
    fi
    if [ "${filled[$found]}" = "1" ]; then
      ARG_ERROR_CODE="E_USAGE"
      ARG_ERROR_MESSAGE="'$name' was given both positionally and by name"
      return 1
    fi
    slots[$found]="${NAMED[$name]}"
    filled[$found]=1
  done
  POSITIONALS=()
  for ((k = 0; k < n; k++)); do
    if [ "${filled[$k]}" = "1" ]; then POSITIONALS+=("${slots[$k]}"); fi
  done
  NAMED=()
}

parse_args() {
  # Returns non-zero with ARG_ERROR_* set instead of calling fail(). parse_args populates the globals
  # POSITIONALS/FLAGS/NAMED, so it must run in the current shell; and fail() exits, which would
  # terminate the script before the entry point could emit an envelope. The caller reports the error.
  local i=0
  local n=$#
  local argv=("$@")
  while [ "$i" -lt "$n" ]; do
    local tok="${argv[$i]}"
    case "$tok" in
      --)
        i=$((i + 1))
        while [ "$i" -lt "$n" ]; do POSITIONALS+=("${argv[$i]}"); i=$((i + 1)); done
        break
        ;;
      --*)
        local name="${tok#--}"
        if [ -z "$name" ]; then
          ARG_ERROR_CODE="E_USAGE"; ARG_ERROR_MESSAGE='empty flag "--"'
          return 1
        fi
        if [ "${VALUE_FLAGS#* $name }" != "$VALUE_FLAGS" ]; then
          if [ $((i + 1)) -ge "$n" ]; then
            ARG_ERROR_CODE="E_USAGE"; ARG_ERROR_MESSAGE="flag --$name requires a value"
            return 1
          fi
          local val="${argv[$((i + 1))]}"
          if [ -n "${FLAGS[$name]:-}" ]; then
            FLAG_MULTI["$name"]="${FLAG_MULTI[$name]:-}${FLAG_MULTI[$name]:+$'\n'}$val"
          fi
          FLAGS["$name"]="$val"
          i=$((i + 2))
        elif [ "${KNOWN_FLAGS#* $name }" != "$KNOWN_FLAGS" ]; then
          FLAGS["$name"]="true"
          i=$((i + 1))
        else
          unknown_flag="$name"
          ARG_ERROR_CODE="E_USAGE"
          ARG_ERROR_MESSAGE="unknown flag --$name"
          ARG_ERROR_HINT='run: dsh-os.sh selfcheck   (lists every accepted flag)'
          return 1
        fi
        ;;
      *=*)
        # Named argument form: file create path="./a.txt" content="123" charset="utf-8-bom".
        # Values keep whatever the caller passed after '='; the calling shell consumes the quotes.
        local nname="${tok%%=*}"
        local nval="${tok#*=}"
        case "$nname" in
          *[!A-Za-z0-9_-]*|'')
            POSITIONALS+=("$tok")
            ;;
          *)
            if [ -n "${NAMED[$nname]:-}" ]; then
              ARG_ERROR_CODE="E_USAGE"
              ARG_ERROR_MESSAGE="named argument '$nname' was given more than once"
              return 1
            fi
            NAMED["$nname"]="$nval"
            ;;
        esac
        i=$((i + 1))
        ;;
      *)
        POSITIONALS+=("$tok")
        i=$((i + 1))
        ;;
    esac
  done
  return 0
}

have_flag() { [ -n "${FLAGS[$1]:-}" ]; }
flag_value() { printf '%s' "${FLAGS[$1]:-${2:-}}"; }

require_allow() {
  # require_allow <verb> <arity> [provided]
  local verb="$1" arity="$2" provided="${3:-0}"
  if [ "$provided" -gt "$arity" ]; then
    fail E_USAGE "unexpected extra argument <${POSITIONALS[$arity]}>"
  fi
  if ! have_flag allow; then
    fail E_PERMISSION "$verb is a mutating operation and requires user authorization" \
      're-run with --allow after the user has accepted the requested operation'
  fi
}

require_min() {
  # require_min <count> <verb>
  local min="$1" verb="$2"
  if [ "${#POSITIONALS[@]}" -lt "$min" ]; then
    fail E_USAGE "$verb requires $min argument(s), got ${#POSITIONALS[@]}" \
      'run: dsh-os.sh selfcheck   (lists every verb with its arguments and flags)'
  fi
}

pos() { printf '%s' "${POSITIONALS[${1}]:-}"; }

# ---------------------------------------------------------------------------
# Protected paths (authorization layer B, docs/permission-model.md section 3.1).
# Compared after full normalization, never by pattern: a regular expression is
# walked around by ".", "..", a trailing dot, or a symlink.
# ---------------------------------------------------------------------------
PROTECTED_RELATIVE=(
  'permission.json'
  'permission.json.bak'
  'src/host/command.txt'
  'src/host/bin/dsh-os.ps1'
  'src/host/bin/dsh-os.sh'
  'src/host/bin/dsh-os.bat'
  'src/host/spec/verbs.tsv'
  'src/host/spec/charsets.tsv'
)

normalize_path() {
  # Absolute, symlink-resolved where possible, with trailing dots/spaces removed.
  local p="$1"
  local dir base
  dir="$(dirname "$p")"
  base="$(basename "$p")"
  while [ "${#base}" -gt 1 ]; do
    case "$base" in
      *.|*' ') base="${base%?}" ;;
      *) break ;;
    esac
  done
  if [ -d "$dir" ]; then
    dir="$(cd "$dir" 2>/dev/null && pwd -P)" || dir="$(cd "$dir" && pwd)"
  fi
  printf '%s/%s' "$dir" "$base"
}

# ===== native.sh ===================================================

# Module: native.sh - platform-native primitives.
#
# Intentionally empty. The PowerShell module declares Add-Type P/Invoke bindings (SendInput, BitBlt,
# GDI, clipboard) because those are the only way to reach them on Windows. On POSIX the equivalents
# are external programs (xdotool, wl-copy, import) rather than a linked library, so there is nothing
# to declare here; the verbs that would use them return a typed E_NOT_SUPPORTED until implemented,
# which is the required behaviour rather than a silent no-op.

# ===== paths.sh ====================================================


is_protected() {
  local candidate
  candidate="$(normalize_path "$1")"
  local rel
  for rel in "${PROTECTED_RELATIVE[@]}"; do
    local prot
    prot="$(normalize_path "$ROOT_DIR/$rel")"
    if [ "$candidate" = "$prot" ]; then return 0; fi
    # A temporary staged beside a protected path is protected too.
    if [ "${candidate%/*}" = "${prot%/*}" ]; then
      case "${candidate##*/}" in
        "${prot##*/}".*) return 0 ;;
      esac
    fi
  done
  return 1
}

assert_not_protected() {
  # assert_not_protected <path> <verb>
  if is_protected "$1"; then
    fail E_PERMISSION_PROTECTED_PATH \
      "$2 may not modify '$1': it is part of the authorization layer" \
      'authorization changes go through the consent delegate, which requires a user-accepted dialog; see docs/permission-model.md'
  fi
}

# ===== charset.sh ==================================================


# ---------------------------------------------------------------------------
# Charset table (spec/charsets.tsv is the single source of truth).
# ---------------------------------------------------------------------------
charsets_file() { printf '%s' "$HOST_DIR/spec/charsets.tsv"; }

resolve_charset() {
  # resolve_charset <name> -> echoes the canonical IANA name, or fails.
  local want
  want="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  local file
  file="$(charsets_file)"
  if [ ! -f "$file" ]; then
    fail E_INTERNAL "charset table not found at $file"
  fi
  local line iana aliases
  while IFS=$'\t' read -r iana aliases _rest; do
    case "$iana" in ''|'#'*) continue ;; esac
    [ "$iana" = "iana" ] && continue
    if [ "$iana" = "$want" ]; then printf '%s' "$iana"; return 0; fi
    local a
    local IFS='|'
    for a in $aliases; do
      if [ "$a" = "$want" ]; then printf '%s' "$iana"; return 0; fi
    done
  done <"$file"
  fail E_CHARSET_UNKNOWN "unknown charset '$1'" 'see spec/charsets.tsv for supported names'
}

iconv_name_for() {
  local iana="$1" file
  file="$(charsets_file)"
  local line
  while IFS=$'\t' read -r name _aliases _dotnet iconv _bom _fixed; do
    case "$name" in ''|'#'*) continue ;; esac
    [ "$name" = "iana" ] && continue
    if [ "$name" = "$iana" ]; then printf '%s' "$iconv"; return 0; fi
  done <"$file"
  printf '%s' "$iana"
}

# ---------------------------------------------------------------------------
# Byte-level text model. A document records everything needed to write the file
# back exactly as it was apart from the intended change.
# ---------------------------------------------------------------------------
DOC_PATH=""
DOC_CHARSET=""
DOC_BOM=""
DOC_EOL=""
DOC_SIZE=0

detect_charset() {
  # detect_charset <file> -> prints "<iana> <bom-bytes>" with bom '-' when absent.
  local file="$1"
  local head
  head="$(LC_ALL=C od -An -tx1 -N4 "$file" | tr -d ' \n')"
  case "$head" in
    efbbbf*) printf 'utf-8-bom 3'; return ;;
    fffe0000*) printf 'utf-32le 4'; return ;;
    0000feff*) printf 'utf-32be 4'; return ;;
    fffe*) printf 'utf-16le 2'; return ;;
    feff*) printf 'utf-16be 2'; return ;;
  esac
  # Skip the BOM bytes and test validity as UTF-8, then GBK, then fall back to latin1.
  local body
  body="$(mktemp)"
  tail -c +1 "$file" >"$body"
  if iconv -f UTF-8 -t UTF-8 "$body" >/dev/null 2>&1; then
    rm -f "$body"; printf 'utf-8 -'; return
  fi
  if iconv -f GBK -t UTF-8 "$body" >/dev/null 2>&1; then
    rm -f "$body"; printf 'gbk -'; return
  fi
  rm -f "$body"
  printf 'latin1 -'
}

load_doc() {
  # load_doc <path> - populates the DOC_* globals, failing like the Windows reader.
  local path="$1"
  if [ ! -e "$path" ]; then
    fail E_NOT_FOUND "cannot read '$path': not found"
  fi
  if [ -d "$path" ]; then
    fail E_NOT_A_FILE "cannot read '$path': not a regular file"
  fi
  local detected iana bom
  detected="$(detect_charset "$path")"
  iana="${detected% *}"
  bom="${detected##* }"
  DOC_PATH="$path"
  DOC_CHARSET="$iana"
  DOC_BOM="$bom"
  DOC_SIZE="$(wc -c <"$path" | tr -d ' ')"
  # Binary detection: a NUL byte in the first 8 KiB, once past any BOM.
  #
  # The bytes must stay separated while looking for "00". Joining the od output into one string (the
  # obvious `tr -d ' \n'`) lets a NUL match across a byte boundary -- "b0 0a" becomes "b00a" -- so
  # ordinary UTF-8 text is misreported as binary. Matching per whitespace-delimited token avoids it.
  local skip=0
  [ "$bom" != "-" ] && skip="$bom"
  local nul
  nul="$(LC_ALL=C od -An -v -tx1 -j "$skip" -N 8192 "$path" | LC_ALL=C tr ' ' '\n' | LC_ALL=C grep -c '^00$' || true)"
  if [ "${nul:-0}" -gt 0 ]; then
    case "$iana" in
      utf-16le|utf-16be|utf-32le|utf-32be) : ;;
      *) fail E_BINARY_CONTENT "cannot read '$path' as text: the content looks binary" ;;
    esac
  fi
  # Line ending convention, from the first 4 KiB.
  local crlf
  crlf="$(LC_ALL=C head -c 4096 "$path" | LC_ALL=C tr -cd '\r' | wc -c | tr -d ' ')"
  if [ "$crlf" -gt 0 ]; then DOC_EOL="crlf"; else DOC_EOL="lf"; fi
}

doc_text() {
  # Decode the body (BOM excluded) to UTF-8 on stdout.
  local skip=0
  [ "$DOC_BOM" != "-" ] && skip="$DOC_BOM"
  local tmp
  tmp="$(mktemp)"
  tail -c "+$((skip + 1))" "$DOC_PATH" >"$tmp"
  local from
  from="$(iconv_name_for "$DOC_CHARSET")"
  iconv -f "$from" -t UTF-8 "$tmp" 2>/dev/null || cat "$tmp"
  rm -f "$tmp"
}

write_doc_bytes() {
  # write_doc_bytes <file> <bytes-file> - atomic replace via a sibling temporary.
  local target="$1" src="$2"
  local dir
  dir="$(dirname "$target")"
  if [ ! -d "$dir" ]; then
    fail E_NO_PARENT "cannot write '$target': directory '$dir' does not exist"
  fi
  local tmp="$dir/.dsh-os-$$.tmp"
  cp "$src" "$tmp"
  mv -f "$tmp" "$target"
}

rewrite_doc() {
  # rewrite_doc <text-file> - re-encode using the document's charset, BOM and EOL.
  local textfile="$1"
  local dir tmp payload
  dir="$(dirname "$DOC_PATH")"
  tmp="$(mktemp)"
  # Normalize to LF first so CRLF restoration is idempotent.
  LC_ALL=C sed 's/\r$//' "$textfile" >"$tmp"
  if [ "$DOC_EOL" = "crlf" ]; then
    local crlf
    crlf="$(mktemp)"
    LC_ALL=C awk '{ printf "%s\r\n", $0 }' "$tmp" >"$crlf"
    mv "$crlf" "$tmp"
  fi
  local from
  from="$(iconv_name_for "$DOC_CHARSET")"
  payload="$(mktemp)"
  if [ "$DOC_CHARSET" = "utf-8" ] || [ "$DOC_CHARSET" = "utf-8-bom" ]; then
    cp "$tmp" "$payload"
  else
    iconv -f UTF-8 -t "$from" "$tmp" >"$payload" 2>/dev/null || {
      rm -f "$tmp" "$payload"
      fail E_ENCODING_INVALID "content cannot be represented in $DOC_CHARSET"
    }
  fi
  if [ "$DOC_BOM" != "-" ]; then
    local withbom
    withbom="$(mktemp)"
    case "$DOC_CHARSET" in
      utf-8-bom) printf '\357\273\277' >"$withbom" ;;
      utf-16le) printf '\377\376' >"$withbom" ;;
      utf-16be) printf '\376\377' >"$withbom" ;;
      utf-32le) printf '\377\376\000\000' >"$withbom" ;;
      utf-32be) printf '\000\000\376\377' >"$withbom" ;;
    esac
    cat "$payload" >>"$withbom"
    mv "$withbom" "$payload"
  fi
  write_doc_bytes "$DOC_PATH" "$payload"
  rm -f "$tmp" "$payload"
}

# ===== file.sh =====================================================


# ---------------------------------------------------------------------------
# file.* verbs
# ---------------------------------------------------------------------------
cmd_file_create() {
  require_min 3 'file create'
  require_allow 'file create' 3 "${#POSITIONALS[@]}"
  local path content charset
  path="$(pos 0)"; content="$(pos 1)"; charset="$(pos 2)"
  assert_not_protected "$path" 'file create'
  if [ -e "$path" ]; then
    fail E_EXISTS "cannot create '$path': it already exists" \
      'use file view to read it, file append/file insert to extend it, or file delete then create'
  fi
  local dir
  dir="$(dirname "$path")"
  [ -d "$dir" ] || mkdir -p "$dir"
  local iana
  iana="$(resolve_charset "$charset")"
  local textfile payload
  textfile="$(mktemp)"; payload="$(mktemp)"
  printf '%s' "$content" >"$textfile"
  local eol
  eol="$(flag_value eol '')"
  if [ "$eol" = "crlf" ]; then
    LC_ALL=C awk '{ printf "%s\r\n", $0 }' "$textfile" >"$payload"
  else
    cp "$textfile" "$payload"
  fi
  if [ "$iana" = "utf-8-bom" ]; then
    local withbom; withbom="$(mktemp)"
    printf '\357\273\277' >"$withbom"; cat "$payload" >>"$withbom"; mv "$withbom" "$payload"
  elif [ "$iana" != "utf-8" ]; then
    local conv; conv="$(mktemp)"
    iconv -f UTF-8 -t "$(iconv_name_for "$iana")" "$payload" >"$conv" 2>/dev/null || {
      rm -f "$textfile" "$payload" "$conv"
      fail E_ENCODING_INVALID "content cannot be represented in $iana"
    }
    mv "$conv" "$payload"
  fi
  write_doc_bytes "$path" "$payload"
  local size; size="$(wc -c <"$path" | tr -d ' ')"
  rm -f "$textfile" "$payload"
  printf '{"path":%s,"operation":"create","charset":%s,"bom":%s,"eol":%s,"bytes":%s}' \
    "$(jstr "$path")" "$(jstr "$iana")" "$([ "$iana" = "utf-8-bom" ] && echo true || echo false)" \
    "$(jstr "${eol:-lf}")" "$size"
}

cmd_file_charset() {
  require_min 1 'file charset'
  local path; path="$(pos 0)"
  load_doc "$path"
  local textfile lines
  textfile="$(mktemp)"
  doc_text >"$textfile"
  lines="$(awk 'END { n = NR; if (NR == 0) n = 0; print n }' "$textfile")"
  rm -f "$textfile"
  printf '{"path":%s,"charset":%s,"bom":%s,"eol":%s,"size":%s,"lines":%s}' \
    "$(jstr "$DOC_PATH")" "$(jstr "$DOC_CHARSET")" \
    "$([ "$DOC_BOM" != "-" ] && echo true || echo false)" \
    "$(jstr "$DOC_EOL")" "$DOC_SIZE" "$lines"
}

cmd_file_information() {
  require_min 1 'file information'
  local path; path="$(pos 0)"
  [ -e "$path" ] || fail E_NOT_FOUND "cannot inspect '$path': not found"
  if [ -d "$path" ]; then
    printf '{"path":%s,"type":"directory"}' "$(jstr "$path")"
    return
  fi
  load_doc "$path"
  local textfile lines
  textfile="$(mktemp)"; doc_text >"$textfile"
  lines="$(awk 'END { print NR }' "$textfile")"
  rm -f "$textfile"
  local mtime
  mtime="$(date -u -r "$path" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf '{"path":%s,"type":"file","size":%s,"charset":%s,"bom":%s,"eol":%s,"lines":%s,"modified":%s,"realpath":%s}' \
    "$(jstr "$path")" "$DOC_SIZE" "$(jstr "$DOC_CHARSET")" \
    "$([ "$DOC_BOM" != "-" ] && echo true || echo false)" \
    "$(jstr "$DOC_EOL")" "$lines" "$(jstr "$mtime")" "$(jstr "$path")"
}

cmd_file_length() {
  require_min 1 'file length'
  local path; path="$(pos 0)"
  [ -e "$path" ] || fail E_NOT_FOUND "cannot measure '$path': not found"
  if [ -d "$path" ]; then
    if have_flag no-recursive; then
      printf '{"path":%s,"type":"directory","bytes":0,"files":0,"directories":0}' "$(jstr "$path")"
      return
    fi
    local total files dirs
    total="$(find "$path" -type f -printf '%s\n' 2>/dev/null | awk '{ s += $1 } END { printf "%d", s + 0 }')"
    files="$(find "$path" -type f 2>/dev/null | wc -l | tr -d ' ')"
    dirs="$(find "$path" -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
    printf '{"path":%s,"type":"directory","bytes":%s,"files":%s,"directories":%s,"recursive":true}' \
      "$(jstr "$path")" "$total" "$files" "$dirs"
    return
  fi
  local size; size="$(wc -c <"$path" | tr -d ' ')"
  printf '{"path":%s,"type":"file","bytes":%s,"recursive":false}' "$(jstr "$path")" "$size"
}

cmd_file_list() {
  require_min 1 'file list'
  local path; path="$(pos 0)"
  [ -e "$path" ] || fail E_NOT_FOUND "cannot list '$path': not found"
  [ -d "$path" ] || fail E_NOT_A_DIR "cannot list '$path': not a directory"
  local out="" count=0
  local entry
  for entry in "$path"/* "$path"/.[!.]*; do
    [ -e "$entry" ] || continue
    local name type size
    name="$(basename "$entry")"
    if [ -d "$entry" ]; then type="directory"; size=0; else type="file"; size="$(wc -c <"$entry" | tr -d ' ')"; fi
    [ "$count" -gt 0 ] && out="$out,"
    out="$out{\"name\":$(jstr "$name"),\"type\":$(jstr "$type"),\"size\":$size}"
    count=$((count + 1))
  done
  printf '{"path":%s,"entries":[%s],"count":%s}' "$(jstr "$path")" "$out" "$count"
}

cmd_file_delete() {
  require_min 1 'file delete'
  require_allow 'file delete' 1 "${#POSITIONALS[@]}"
  local path; path="$(pos 0)"
  assert_not_protected "$path" 'file delete'
  [ -e "$path" ] || fail E_NOT_FOUND "cannot delete '$path': not found"
  if have_flag permanent; then
    rm -rf -- "$path"
    printf '{"path":%s,"operation":"unlink","permanent":true}' "$(jstr "$path")"
    return
  fi
  # No standard trash facility on POSIX. Refuse rather than silently destroying data, which is the
  # opposite of the Windows behaviour where the Recycle Bin is always available.
  if command -v trash-put >/dev/null 2>&1; then
    trash-put -- "$path"
    printf '{"path":%s,"operation":"recycle","permanent":false}' "$(jstr "$path")"
    return
  fi
  fail E_NOT_SUPPORTED \
    "cannot recycle '$path': no trash facility (trash-put) is available" \
    'pass --permanent to delete irreversibly, or install trash-cli'
}

cmd_file_move() {
  require_min 2 'file move'
  require_allow 'file move' 2 "${#POSITIONALS[@]}"
  local src dst
  src="$(pos 0)"; dst="$(pos 1)"
  assert_not_protected "$src" 'file move'
  assert_not_protected "$dst" 'file move'
  [ -e "$src" ] || fail E_NOT_FOUND "cannot move '$src': not found"
  [ -e "$dst" ] && fail E_EXISTS "cannot move to '$dst': it already exists"
  local dir; dir="$(dirname "$dst")"
  [ -d "$dir" ] || fail E_NO_PARENT "cannot move to '$dst': directory '$dir' does not exist"
  mv -- "$src" "$dst"
  printf '{"source":%s,"destination":%s,"operation":"move"}' "$(jstr "$src")" "$(jstr "$dst")"
}

cmd_file_copy() {
  require_min 2 'file copy'
  require_allow 'file copy' 2 "${#POSITIONALS[@]}"
  local src dst
  src="$(pos 0)"; dst="$(pos 1)"
  assert_not_protected "$src" 'file copy'
  assert_not_protected "$dst" 'file copy'
  [ -e "$src" ] || fail E_NOT_FOUND "cannot copy '$src': not found"
  [ -e "$dst" ] && fail E_EXISTS "cannot copy to '$dst': it already exists"
  local dir; dir="$(dirname "$dst")"
  [ -d "$dir" ] || fail E_NO_PARENT "cannot copy to '$dst': directory '$dir' does not exist"
  cp -R -- "$src" "$dst"
  printf '{"source":%s,"destination":%s,"operation":"copy"}' "$(jstr "$src")" "$(jstr "$dst")"
}

cmd_file_mkdir() {
  require_min 1 'file mkdir'
  require_allow 'file mkdir' 1 "${#POSITIONALS[@]}"
  local path; path="$(pos 0)"
  assert_not_protected "$path" 'file mkdir'
  [ -e "$path" ] && fail E_EXISTS "cannot create directory '$path': it already exists"
  if have_flag parents; then
    mkdir -p -- "$path"
  else
    local parent; parent="$(dirname "$path")"
    [ -d "$parent" ] || fail E_NO_PARENT "cannot create '$path': parent '$parent' does not exist" \
      'pass --parents to create intermediate directories'
    mkdir -- "$path"
  fi
  printf '{"path":%s,"operation":"mkdir"}' "$(jstr "$path")"
}

cmd_file_append() {
  require_min 2 'file append'
  require_allow 'file append' 3 "${#POSITIONALS[@]}"
  local path content charset
  path="$(pos 0)"; content="$(pos 1)"; charset="$(pos 2)"
  assert_not_protected "$path" 'file append'
  load_doc "$path"
  if [ -n "$charset" ]; then
    local expect; expect="$(resolve_charset "$charset")"
    if [ "$expect" != "$DOC_CHARSET" ] && ! { [ "$expect" = "utf-8" ] && [ "$DOC_CHARSET" = "utf-8-bom" ]; }; then
      fail E_CHARSET_MISMATCH "'$path' is $DOC_CHARSET, not $expect"
    fi
  fi
  local textfile
  textfile="$(mktemp)"
  doc_text >"$textfile"
  local add; add="$(mktemp)"
  printf '%s' "$content" >"$add"
  if [ "$DOC_EOL" = "crlf" ]; then
    local crlf; crlf="$(mktemp)"
    LC_ALL=C sed 's/\r$//' "$add" | LC_ALL=C awk '{ printf "%s\r\n", $0 }' >"$crlf"
    mv "$crlf" "$add"
  fi
  cat "$add" >>"$textfile"
  local before="$DOC_SIZE"
  rewrite_doc "$textfile"
  rm -f "$textfile" "$add"
  local size; size="$(wc -c <"$path" | tr -d ' ')"
  printf '{"path":%s,"operation":"append","charset":%s,"bom":%s,"eol":%s,"offset":%s,"bytes":%s}' \
    "$(jstr "$path")" "$(jstr "$DOC_CHARSET")" \
    "$([ "$DOC_BOM" != "-" ] && echo true || echo false)" "$(jstr "$DOC_EOL")" "$before" "$size"
}

cmd_file_insert() {
  require_min 3 'file insert'
  require_allow 'file insert' 3 "${#POSITIONALS[@]}"
  local path content offset charset
  path="$(pos 0)"; content="$(pos 1)"; offset="$(pos 2)"
  charset="$(flag_value charset '')"
  assert_not_protected "$path" 'file insert'
  case "$offset" in
    ''|*[!0-9]*) fail E_TYPE "<offset> must be an integer, got '$offset'" ;;
  esac
  load_doc "$path"
  if [ -n "$charset" ]; then
    local expect; expect="$(resolve_charset "$charset")"
    if [ "$expect" != "$DOC_CHARSET" ] && ! { [ "$expect" = "utf-8" ] && [ "$DOC_CHARSET" = "utf-8-bom" ]; }; then
      fail E_CHARSET_MISMATCH "'$path' is $DOC_CHARSET, not $expect"
    fi
  fi
  if [ "$offset" -gt "$DOC_SIZE" ]; then
    fail E_RANGE "offset $offset is out of range for '$path' (0..$DOC_SIZE)"
  fi
  # Character-boundary check for UTF-8: a continuation byte is 10xxxxxx.
  if [ "$offset" -gt 0 ] && [ "$offset" -lt "$DOC_SIZE" ]; then
    case "$DOC_CHARSET" in
      utf-8|utf-8-bom)
        local byte
        byte="$(LC_ALL=C od -An -tx1 -j "$offset" -N1 "$path" | tr -d ' \n')"
        case "$byte" in
          8*|9*|a*|b*) fail E_BOUNDARY "offset $offset falls inside a multi-byte character in '$path'" \
                         'offsets are byte offsets and must land on a character boundary' ;;
        esac
        ;;
      utf-16le|utf-16be)
        [ $((offset % 2)) -eq 0 ] || fail E_BOUNDARY "offset $offset falls inside a UTF-16 code unit in '$path'"
        ;;
    esac
  fi
  # Splice on the byte level: the head keeps the BOM, the inserted bytes come from a fresh
  # encoding pass, and the tail is copied verbatim.
  local head tail add full tmp
  tmp="$(mktemp -d)"
  head="$tmp/head"; tail="$tmp/tail"; add="$tmp/add"
  head -c "$offset" "$path" >"$head"
  tail -c "+$((offset + 1))" "$path" >"$tail"
  printf '%s' "$content" >"$add"
  if [ "$DOC_EOL" = "crlf" ]; then
    local crlf; crlf="$tmp/crlf"
    LC_ALL=C sed 's/\r$//' "$add" | LC_ALL=C awk '{ printf "%s\r\n", $0 }' >"$crlf"
    mv "$crlf" "$add"
  fi
  if [ "$DOC_CHARSET" != "utf-8" ] && [ "$DOC_CHARSET" != "utf-8-bom" ]; then
    local conv; conv="$tmp/conv"
    iconv -f UTF-8 -t "$(iconv_name_for "$DOC_CHARSET")" "$add" >"$conv" 2>/dev/null || {
      rm -rf "$tmp"; fail E_ENCODING_INVALID "content cannot be represented in $DOC_CHARSET"
    }
    mv "$conv" "$add"
  fi
  full="$tmp/full"
  cat "$head" "$add" "$tail" >"$full"
  local addsize; addsize="$(wc -c <"$add" | tr -d ' ')"
  write_doc_bytes "$path" "$full"
  local size; size="$(wc -c <"$path" | tr -d ' ')"
  rm -rf "$tmp"
  printf '{"path":%s,"operation":"insert","charset":%s,"bom":%s,"eol":%s,"offset":%s,"written":%s,"bytes":%s}' \
    "$(jstr "$path")" "$(jstr "$DOC_CHARSET")" \
    "$([ "$DOC_BOM" != "-" ] && echo true || echo false)" "$(jstr "$DOC_EOL")" "$offset" "$addsize" "$size"
}

cmd_file_view() {
  require_min 1 'file view'
  local path charset start end
  path="$(pos 0)"; charset="$(pos 1)"; start="$(pos 2)"; end="$(pos 3)"
  load_doc "$path"
  if [ -n "$charset" ]; then
    local expect; expect="$(resolve_charset "$charset")"
    [ "$expect" = "$DOC_CHARSET" ] || fail E_CHARSET_MISMATCH "'$path' is $DOC_CHARSET, not $expect"
  fi
  local s=0 e="$DOC_SIZE"
  [ -n "$start" ] && s="$start"
  [ -n "$end" ] && e="$end"
  case "$s" in ''|*[!0-9]*) fail E_TYPE "<start> must be an integer, got '$s'" ;; esac
  case "$e" in ''|*[!0-9]*) fail E_TYPE "<end> must be an integer, got '$e'" ;; esac
  [ "$e" -ge "$s" ] || fail E_RANGE "end $e precedes start $s"
  [ "$e" -le "$DOC_SIZE" ] || fail E_RANGE "range [$s,$e) is out of bounds for a $DOC_SIZE-byte file"
  local slice
  slice="$(mktemp)"
  head -c "$e" "$path" | tail -c "+$((s + 1))" >"$slice"
  local from text
  from="$(iconv_name_for "$DOC_CHARSET")"
  text="$(iconv -f "$from" -t UTF-8 "$slice" 2>/dev/null || cat "$slice")"
  rm -f "$slice"
  # Strip a leading BOM character if the slice carried the preamble.
  text="${text#$'\xef\xbb\xbf'}"

  # Agent-first output, mirroring the PowerShell implementation. `text` carries the raw slice with no
  # line-number prefix, and `lines` carries the same content as structured objects, so a caller never
  # has to strip a human rendering back off or parse it. --with-numbers is opt-in for a human.
  local linesJson="" lineCount=0
  local numbered="$text"
  if have_flag with-numbers; then
    numbered="$(printf '%s' "$text" | awk '{ printf "%d: %s\n", NR, $0 }')"
  fi
  # Build the structured array. IFS is scoped so an embedded newline cannot split a record early.
  while IFS= read -r one || [ -n "$one" ]; do
    linesJson="$linesJson$( [ "$lineCount" -gt 0 ] && printf ',' )$(printf '{"number":%s,"text":%s}' "$((lineCount + 1))" "$(jstr "$one")")"
    lineCount=$((lineCount + 1))
  done <<<"$text"

  printf '{"path":%s,"charset":%s,"bom":%s,"eol":%s,"size":%s,"start":%s,"end":%s,"totalBytes":%s,"lineCount":%s,"lines":[%s],"truncated":false,"text":%s}' \
    "$(jstr "$path")" "$(jstr "$DOC_CHARSET")" \
    "$([ "$DOC_BOM" != "-" ] && echo true || echo false)" "$(jstr "$DOC_EOL")" \
    "$DOC_SIZE" "$s" "$e" "$DOC_SIZE" "$lineCount" "$linesJson" "$(jstr "$numbered")"
}

# ---------------------------------------------------------------------------
# file.verify.* - assertions that report rather than throw.
# ---------------------------------------------------------------------------
cmd_file_verify_charset() {
  require_min 2 'file verify charset'
  local path expect
  path="$(pos 0)"; expect="$(resolve_charset "$(pos 1)")"
  load_doc "$path"
  printf '{"path":%s,"assertion":"charset","expected":%s,"observed":%s,"match":%s,"bom":%s,"eol":%s,"size":%s}' \
    "$(jstr "$path")" "$(jstr "$expect")" "$(jstr "$DOC_CHARSET")" \
    "$([ "$expect" = "$DOC_CHARSET" ] && echo true || echo false)" \
    "$([ "$DOC_BOM" != "-" ] && echo true || echo false)" "$(jstr "$DOC_EOL")" "$DOC_SIZE"
}

cmd_file_verify_encoding() {
  require_min 2 'file verify encoding'
  local path charset
  path="$(pos 0)"; charset="$(resolve_charset "$(pos 1)")"
  local skip=0
  case "$charset" in
    utf-16le|utf-16be|utf-32le|utf-32be) : ;;
  esac
  local from; from="$(iconv_name_for "$charset")"
  local legal=true
  if ! iconv -f "$from" -t UTF-8 "$path" >/dev/null 2>&1; then legal=false; fi
  printf '{"path":%s,"assertion":"encoding","charset":%s,"legal":%s}' \
    "$(jstr "$path")" "$(jstr "$charset")" "$legal"
}

cmd_file_verify_completion() {
  require_min 1 'file verify completion'
  local path; path="$(pos 0)"
  if [ ! -e "$path" ]; then
    printf '{"path":%s,"assertion":"completion","complete":false,"missing":true}' "$(jstr "$path")"
    return
  fi
  load_doc "$path"
  local asserted=false allmatch=true checks=""
  local want got
  want="$(flag_value length '')"
  if [ -n "$want" ]; then
    asserted=true
    got="$DOC_SIZE"
    [ "$want" = "$got" ] || allmatch=false
    checks="$checks$( [ -n "$checks" ] && echo , )\"length\":{\"expected\":$want,\"observed\":$got,\"match\":$([ "$want" = "$got" ] && echo true || echo false)}"
  fi
  want="$(flag_value sha256 '')"
  if [ -n "$want" ]; then
    asserted=true
    got="$(sha256_of "$path")"
    [ "$want" = "$got" ] || allmatch=false
    checks="$checks$( [ -n "$checks" ] && echo , )\"sha256\":{\"expected\":$(jstr "$want"),\"observed\":$(jstr "$got"),\"match\":$([ "$want" = "$got" ] && echo true || echo false)}"
  fi
  want="$(flag_value bom '')"
  if [ -n "$want" ]; then
    asserted=true
    got=false; [ "$DOC_BOM" != "-" ] && got=true
    [ "$want" = "$got" ] || allmatch=false
    checks="$checks$( [ -n "$checks" ] && echo , )\"bom\":{\"expected\":$want,\"observed\":$got,\"match\":$([ "$want" = "$got" ] && echo true || echo false)}"
  fi
  want="$(flag_value eol '')"
  if [ -n "$want" ]; then
    asserted=true
    got="$DOC_EOL"
    [ "$want" = "$got" ] || allmatch=false
    checks="$checks$( [ -n "$checks" ] && echo , )\"eol\":{\"expected\":$(jstr "$want"),\"observed\":$(jstr "$got"),\"match\":$([ "$want" = "$got" ] && echo true || echo false)}"
  fi
  local complete
  if [ "$asserted" = "true" ]; then complete="$allmatch"; else complete=null; fi
  printf '{"path":%s,"assertion":"completion","asserted":%s,"complete":%s,"charset":%s,"bom":%s,"eol":%s,"size":%s,"checks":{%s}}' \
    "$(jstr "$path")" "$asserted" "$complete" "$(jstr "$DOC_CHARSET")" \
    "$([ "$DOC_BOM" != "-" ] && echo true || echo false)" "$(jstr "$DOC_EOL")" "$DOC_SIZE" "$checks"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else openssl dgst -sha256 "$1" | awk '{print $NF}'
  fi
}

# ---------------------------------------------------------------------------
# file.search - matches as a JSON ARRAY, mirroring the Windows implementation so an agent can parse
# either platform's answer identically.
# ---------------------------------------------------------------------------
cmd_file_search() {
  require_min 2 'file search'
  local dir name
  dir="$(pos 0)"; name="$(pos 1)"
  if [ ! -e "$dir" ]; then
    fail E_NOT_FOUND "cannot search '$dir': not found"
  fi
  if [ ! -d "$dir" ]; then
    fail E_NOT_A_DIR "cannot search '$dir': not a directory"
  fi
  local use_regex=0 recursive=0
  have_flag regex && use_regex=1
  have_flag recursive && recursive=1
  local maxdepth; maxdepth="$(flag_value max-depth '0')"
  local limit; limit="$(flag_value limit '500')"
  local typefilter; typefilter="$(flag_value type '*')"

  local out="" count=0 truncated=false
  local findargs=()
  if [ "$recursive" -eq 1 ] || [ "$maxdepth" -gt 0 ] 2>/dev/null; then
    findargs+=("-mindepth" "1")
    if [ "${maxdepth:-0}" -gt 0 ] 2>/dev/null; then
      findargs+=("-maxdepth" "$maxdepth")
    fi
  else
    findargs+=("-mindepth" "1" "-maxdepth" "1")
  fi

  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    local base itemtype size matched=0
    base="$(basename "$entry")"
    if [ -d "$entry" ]; then itemtype="directory"; size=0; else itemtype="file"; size="$(wc -c <"$entry" 2>/dev/null | tr -d ' ')"; fi
    [ -n "$size" ] || size=0
    if [ "$typefilter" != "*" ] && [ "$typefilter" != "" ] && [ "$itemtype" != "$typefilter" ]; then continue; fi
    if [ "$use_regex" -eq 1 ]; then
      if printf '%s' "$base" | grep -Eq -- "$name"; then matched=1; fi
    else
      case "$base" in
        *"$name"*) matched=1 ;;
      esac
    fi
    [ "$matched" -eq 1 ] || continue
    # Strip the leading directory so the caller gets a path relative to what it asked about.
    local rel="$entry"
    case "$entry" in
      "$dir"/*) rel="${entry#*/}" ;;
    esac
    # Built with printf rather than an escaped literal: backslash-escaped quotes inside a double
    # quoted string are where this kind of JSON assembly silently goes wrong.
    local one
    one="$(printf '{"path":%s,"name":%s,"type":%s,"size":%s,"relative":%s}' \
      "$(jstr "$entry")" "$(jstr "$base")" "$(jstr "$itemtype")" "$size" "$(jstr "$rel")")"
    if [ "$count" -gt 0 ]; then out="$out,$one"; else out="$one"; fi
    count=$((count + 1))
    if [ "$count" -ge "$limit" ]; then truncated=true; break; fi
  done < <(find "$dir" "${findargs[@]}" -print 2>/dev/null | LC_ALL=C sort)

  printf '{"matches":[%s],"count":%s,"truncated":%s,"limit":%s,"directory":%s,"pattern":%s,"regex":%s,"recursive":%s}' \
    "$out" "$count" "$truncated" "$limit" "$(jstr "$dir")" "$(jstr "$name")" \
    "$([ "$use_regex" -eq 1 ] && echo true || echo false)" \
    "$([ "$recursive" -eq 1 ] && echo true || echo false)"
}

# ===== system.sh ===================================================


# ---------------------------------------------------------------------------
# system.* - pure queries, each field degrading on its own.
# ---------------------------------------------------------------------------
cmd_system_brand() {
  local platform vendor product
  platform="$(platform_name)"
  vendor=""; product=""
  if [ -r /sys/devices/virtual/dmi/id/sys_vendor ]; then
    vendor="$(cat /sys/devices/virtual/dmi/id/sys_vendor 2>/dev/null || true)"
  fi
  if [ -r /sys/devices/virtual/dmi/id/product_name ]; then
    product="$(cat /sys/devices/virtual/dmi/id/product_name 2>/dev/null || true)"
  fi
  if [ "$platform" = "darwin" ]; then
    product="$(sysctl -n hw.model 2>/dev/null || true)"
    vendor="Apple"
  fi
  printf '{"platform":%s,"vendor":%s,"product":%s,"family":%s}' \
    "$(jstr "$platform")" "$(jstr "$vendor")" "$(jstr "$product")" "$(jstr "$platform")"
}

cmd_system_cpu() {
  local name="" cores="" model=""
  if [ -r /proc/cpuinfo ]; then
    model="$(awk -F: '/^model name/ { gsub(/^ +/, "", $2); print $2; exit }' /proc/cpuinfo)"
    cores="$(grep -c '^processor' /proc/cpuinfo 2>/dev/null || echo '')"
  fi
  if [ "$(platform_name)" = "darwin" ]; then
    model="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || true)"
    cores="$(sysctl -n hw.logicalcpu 2>/dev/null || true)"
  fi
  name="$model"
  printf '{"count":1,"processors":[{"name":%s,"cores":%s,"threads":%s}]}' \
    "$(jstr "$name")" "${cores:-null}" "${cores:-null}"
}

cmd_system_gpu() {
  # A machine with no usable driver legitimately reports an empty list.
  printf '{"count":0,"adapters":[]}'
}

cmd_system_version() {
  local caption="" version="" kernel="" arch
  arch="$(uname -m 2>/dev/null || echo unknown)"
  kernel="$(uname -r 2>/dev/null || echo unknown)"
  if [ -r /etc/os-release ]; then
    caption="$(awk -F= '/^PRETTY_NAME=/ { gsub(/"/, "", $2); print $2; exit }' /etc/os-release)"
    version="$(awk -F= '/^VERSION_ID=/ { gsub(/"/, "", $2); print $2; exit }' /etc/os-release)"
  fi
  if [ "$(platform_name)" = "darwin" ]; then
    caption="macOS $(sw_vers -productVersion 2>/dev/null || true)"
    version="$(sw_vers -buildVersion 2>/dev/null || true)"
  fi
  local uid_is_root=false
  [ "$(id -u 2>/dev/null || echo 0)" = "0" ] && uid_is_root=true
  printf '{"platform":%s,"caption":%s,"version":%s,"kernel":%s,"architecture":%s,"isElevated":%s,"user":%s}' \
    "$(jstr "$(platform_name)")" "$(jstr "$caption")" "$(jstr "$version")" "$(jstr "$kernel")" \
    "$(jstr "$arch")" "$uid_is_root" "$(jstr "$(id -un 2>/dev/null || echo unknown)")"
}

cmd_system_info() {
  local brand cpu gpu ver
  brand="$(cmd_system_brand)"; cpu="$(cmd_system_cpu)"; gpu="$(cmd_system_gpu)"; ver="$(cmd_system_version)"
  printf '{"brand":%s,"cpu":%s,"gpu":%s,"version":%s}' "$brand" "$cpu" "$gpu" "$ver"
}

# ===== execute.sh ==================================================

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

# ===== task.sh =====================================================


# ---------------------------------------------------------------------------
# task.* / environment.* / service.* / permission.*
# ---------------------------------------------------------------------------
cmd_task_list() {
  local limit; limit="$(flag_value limit '200')"
  local filter; filter="$(flag_value filter '*')"
  local out="" count=0
  if [ -d /proc ]; then
    local d pid name
    for d in /proc/[0-9]*; do
      [ -d "$d" ] || continue
      pid="${d#/proc/}"
      name="$(cat "$d/comm" 2>/dev/null || echo '')"
      case "$filter" in ''|'*') : ;; *) case "$name" in $filter) : ;; *) continue ;; esac ;; esac
      [ "$count" -gt 0 ] && out="$out,"
      out="$out{\"pid\":$pid,\"name\":$(jstr "$name")}"
      count=$((count + 1))
      [ "$count" -ge "$limit" ] && break
    done
  fi
  printf '{"count":%s,"limit":%s,"processes":[%s]}' "$count" "$limit" "$out"
}

cmd_task_query() {
  require_min 1 'task query'
  local pid; pid="$(pos 0)"
  case "$pid" in ''|*[!0-9]*) fail E_TYPE "<pid> must be an integer, got '$pid'" ;; esac
  if [ ! -d "/proc/$pid" ]; then
    fail E_NOT_FOUND "no process with pid $pid"
  fi
  local name path
  name="$(cat "/proc/$pid/comm" 2>/dev/null || echo '')"
  path="$(readlink "/proc/$pid/exe" 2>/dev/null || echo '')"
  printf '{"pid":%s,"name":%s,"path":%s}' "$pid" "$(jstr "$name")" "$(jstr "$path")"
}

# execute query pid - the same question as task query, kept as its own verb because the contract names
# it separately. Delegating rather than duplicating keeps one implementation of the answer.
cmd_execute_query() {
  cmd_task_query
}

# task show <pid> - bring the process's main window to the front.
#
# There is no portable way to do this: it needs X11 (wmctrl or xdotool) or a Wayland compositor
# protocol, and the tools are frequently absent. When they are absent this reports a typed
# E_NOT_SUPPORTED naming what is missing, rather than succeeding without doing anything - a caller
# that believes a window was raised will wait for something that never appears.
cmd_task_show() {
  require_min 1 'task show'
  local pid; pid="$(pos 0)"
  case "$pid" in ''|*[!0-9]*) fail E_TYPE "<pid> must be an integer, got '$pid'" ;; esac
  if [ ! -d "/proc/$pid" ]; then
    fail E_NOT_FOUND "no process with pid $pid"
  fi
  if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
    fail E_NO_DISPLAY 'there is no display server in this environment' \
      'window activation needs X11 or Wayland; DISPLAY and WAYLAND_DISPLAY are both unset'
  fi
  if command -v wmctrl >/dev/null 2>&1; then
    # -a activates by window id; -p adds the pid column, which is how the id is found from a pid.
    local id
    id="$(wmctrl -lp 2>/dev/null | awk -v p="$pid" '$3 == p { print $1; exit }')"
    if [ -z "$id" ]; then
      fail E_WINDOW_NOT_FOUND "pid $pid has no top-level window"
    fi
    wmctrl -i -a "$id" >/dev/null 2>&1 || fail E_IO "wmctrl could not activate window $id"
    printf '{"pid":%s,"window":%s,"tool":"wmctrl"}' "$pid" "$(jstr "$id")"
    return 0
  fi
  if command -v xdotool >/dev/null 2>&1; then
    local id2
    id2="$(xdotool search --pid "$pid" 2>/dev/null | head -1)"
    if [ -z "$id2" ]; then
      fail E_WINDOW_NOT_FOUND "pid $pid has no top-level window"
    fi
    xdotool windowactivate "$id2" >/dev/null 2>&1 || fail E_IO "xdotool could not activate window $id2"
    printf '{"pid":%s,"window":%s,"tool":"xdotool"}' "$pid" "$(jstr "$id2")"
    return 0
  fi
  fail E_NOT_SUPPORTED 'no window-activation tool is installed' \
    'install wmctrl or xdotool to use task show on this platform'
}

# task kill <pid> [--force] / execute kill <pid> [--force]
#
# Without --force this sends SIGTERM, which a process can handle: it is the request to stop. It then
# checks whether the process actually went away, because reporting success without checking is how a
# caller ends up operating on a process it believes is gone.
#
# With --force this sends SIGKILL, which cannot be caught, blocked or ignored, so the process gets no
# chance to save anything. SIGKILL is also relayed to a shell's children only if they are in the same
# process group, which is why the result reports the signal sent rather than a guarantee.
cmd_task_kill() {
  require_min 1 'task kill'
  require_allow 'task kill' "${#POSITIONALS[@]}"
  local pid; pid="$(pos 0)"
  case "$pid" in ''|*[!0-9]*) fail E_TYPE "<pid> must be an integer, got '$pid'" ;; esac
  if [ "$pid" -eq 0 ]; then
    fail E_TYPE '<pid> must be a real process id, not 0'
  fi
  if [ "$pid" = "$$" ]; then
    # Killing the reporting process would leave the caller with no result at all.
    fail E_USAGE 'refusing to kill the process running this verb'
  fi
  if [ ! -d "/proc/$pid" ]; then
    fail E_NOT_FOUND "no process with pid $pid"
  fi
  local name
  name="$(cat "/proc/$pid/comm" 2>/dev/null || echo '')"

  if have_flag force; then
    kill -KILL "$pid" 2>/dev/null || fail E_IO "pid $pid could not be killed (insufficient privilege?)"
    sleep 0.2
    local gone="true"
    kill -0 "$pid" 2>/dev/null && gone="false"
    printf '{"pid":%s,"name":%s,"mode":"force","signal":"SIGKILL","terminated":%s,"warning":"SIGKILL cannot be caught; the process had no chance to save state"}' \
      "$pid" "$(jstr "$name")" "$gone"
    return 0
  fi

  kill -TERM "$pid" 2>/dev/null || fail E_IO "pid $pid could not be signalled (insufficient privilege?)"
  # Give it a moment to act on the request before deciding whether it did.
  local waited=0
  while [ "$waited" -lt 3000 ]; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
    waited=$((waited + 100))
  done
  if kill -0 "$pid" 2>/dev/null; then
    printf '{"pid":%s,"name":%s,"mode":"graceful","signal":"SIGTERM","terminated":false,"stillRunning":true,"hint":"the process did not exit; re-run with --force to send SIGKILL"}' \
      "$pid" "$(jstr "$name")"
  else
    printf '{"pid":%s,"name":%s,"mode":"graceful","signal":"SIGTERM","terminated":true,"stillRunning":false,"waitedMs":%s}' \
      "$pid" "$(jstr "$name")" "$waited"
  fi
}

# execute kill pid - the same act as task kill, under the name the contract gives it.
cmd_execute_kill() {
  cmd_task_kill
}

# ===== environment.sh ==============================================


cmd_environment_list() {
  local scope; scope="$(flag_value scope 'user')"
  # Only the process scope exists in a POSIX shell; persistent scopes are shell configuration, not
  # an environment API, so asking for one is reported rather than faked.
  if [ "$scope" != "process" ]; then
    fail E_NOT_SUPPORTED "scope '$scope' is not available on this platform" \
      'only --scope process is supported; persistent variables live in shell startup files'
  fi
  local out="" count=0
  local name
  for name in $(env | LC_ALL=C sed 's/=.*//' | sort); do
    local value="${!name-}"
    [ "$count" -gt 0 ] && out="$out,"
    out="$out{\"name\":$(jstr "$name"),\"value\":$(jstr "$value")}"
    count=$((count + 1))
  done
  printf '{"scope":"process","count":%s,"variables":[%s]}' "$count" "$out"
}

cmd_environment_get() {
  require_min 1 'environment get'
  local name; name="$(pos 0)"
  local scope; scope="$(flag_value scope 'user')"
  if [ "$scope" != "process" ]; then
    fail E_NOT_SUPPORTED "scope '$scope' is not available on this platform" 'only --scope process is supported'
  fi
  if [ -z "${!name+x}" ]; then
    fail E_NOT_FOUND "'$name' is not set at process scope"
  fi
  printf '{"name":%s,"value":%s,"scope":"process"}' "$(jstr "$name")" "$(jstr "${!name}")"
}

env_separator() { printf ':'; }

cmd_environment_attribute_list() {
  local scope; scope="$(flag_value scope 'user')"
  if [ "$scope" != "process" ]; then
    fail E_NOT_SUPPORTED "scope '$scope' is not available on this platform" 'only --scope process is supported'
  fi
  local sep; sep="$(env_separator)"
  local out="" count=0
  local name
  for name in PATH PATHEXT LIB INCLUDE MANPATH CDPATH; do
    if [ -z "${!name+x}" ]; then continue; fi
    local entries=0
    local IFS="$sep"
    for _e in ${!name}; do entries=$((entries + 1)); done
    [ "$count" -gt 0 ] && out="$out,"
    out="$out{\"name\":$(jstr "$name"),\"known\":true,\"separator\":$(jstr "$sep"),\"entryCount\":$entries}"
    count=$((count + 1))
  done
  printf '{"scope":"process","count":%s,"attributes":[%s]}' "$count" "$out"
}

cmd_environment_attribute_get() {
  require_min 1 'environment attr get'
  local name; name="$(pos 0)"
  local attr; attr="$(flag_value attr 'PATH')"
  local scope; scope="$(flag_value scope 'user')"
  if [ "$scope" != "process" ]; then
    fail E_NOT_SUPPORTED "scope '$scope' is not available on this platform" 'only --scope process is supported'
  fi
  if [ -z "${!attr+x}" ]; then
    fail E_NOT_FOUND "attribute '$attr' is not set at process scope"
  fi
  local sep; sep="$(env_separator)"
  local out="" count=0
  local IFS="$sep"
  for e in ${!attr}; do
    out="$out$( [ "$count" -gt 0 ] && echo , ){\"index\":$count,\"value\":$(jstr "$e")}"
    count=$((count + 1))
  done
  printf '{"name":%s,"requestedName":%s,"scope":"process","separator":%s,"count":%s,"entries":[%s]}' \
    "$(jstr "$attr")" "$(jstr "$name")" "$(jstr "$sep")" "$count" "$out"
}

# ---------------------------------------------------------------------------
# environment.* - process scope, plus persistent scopes through a managed block
# in a shell startup file.
# ---------------------------------------------------------------------------
#
# Persisting a variable on POSIX has no kernel API: it means editing a shell startup file. That is a
# real edit to a file the user owns, so it is done inside a delimited block that this tool owns:
# everything between the markers is regenerated on each change, so a value can be added, replaced or
# removed idempotently, and the user can undo the whole thing by deleting the block. Writing
# assignments directly into the file would duplicate them on the second call and could not be undone.
ENV_BLOCK_BEGIN="# >>> dsh-os managed environment >>>"
ENV_BLOCK_END="# <<< dsh-os managed environment <<<"

env_scope_file() {
  local scope="$1"
  case "$scope" in
    user) printf '%s' "${HOME:-/tmp}/.profile" ;;
    machine) printf '%s' '/etc/environment' ;;
    *) printf '' ;;
  esac
}

# Resolve the requested scope, defaulting to process, which is the only scope that works without
# touching a file.
#
# This ASSIGNS ENV_SCOPE rather than printing it, so a verb can call it in its own shell. Called as
# `scope="$(env_resolve_scope)"` it runs in a subshell, where fail's `exit` ends only the subshell:
# the verb then carries on with an empty scope and produces a second, unrelated failure whose exit
# class contradicted the error code in the envelope.
ENV_SCOPE="process"
env_resolve_scope() {
  local scope; scope="$(flag_value scope 'process')"
  case "$scope" in
    process|user|machine) ENV_SCOPE="$scope"; return 0 ;;
    *) fail E_NOT_SUPPORTED "scope '$scope' is not available on this platform" \
         'accepted: process, user, machine' ;;
  esac
}

# Whether the CALLER can see the change. It is false for every scope on this platform, and that is not
# a defect of one scope: the verb runs as a separate process, so an export inside it cannot reach the
# shell that invoked it, and a persistent scope only affects shells started afterwards.
#
# This used to report true for process scope, which was simply wrong - the caller is a running process
# and it cannot see it. Reporting it as true would lead a caller to read the variable back, find it
# missing, and conclude the write had failed.
env_visible_note() {
  printf 'false'
}

env_visibility_note() {
  local scope="$1"
  if [ "$scope" = "process" ]; then
    printf '%s' 'process scope applies to this script process and any child it starts within the same invocation; the calling shell is unaffected'
  else
    printf '%s' 'in effect for shells started afterwards; open a new shell or source the file'
  fi
}

# JSON-escaped form of the note, because the raw text contains no quotes but is still free prose and
# emitting it unquoted produced a malformed envelope.
env_visibility_note_json() {
  jstr "$(env_visibility_note "$1")"
}

env_read_shell_value() {
  # The current value, if any, of a variable at process scope.
  local name="$1"
  if [ -z "${!name+x}" ]; then return 1; fi
  printf '%s' "${!name}"
  return 0
}

# Rewrite the managed block in a file so it holds exactly the given NAME=value pairs.
#
# Byte-safe on the rest of the file: every line outside the block is preserved verbatim, and a file
# that has no block yet gets one appended.
env_write_block() {
  local file="$1"; shift
  local dir; dir="$(dirname "$file")"
  if [ ! -d "$dir" ]; then
    fail E_NOT_FOUND "the directory for $file does not exist"
  fi
  # Refuse rather than clobber: if the file exists but cannot be written, that must be reported, not
  # half-applied.
  if [ -e "$file" ] && [ ! -w "$file" ]; then
    if [ "$(id -u)" -ne 0 ]; then
      fail E_ELEVATION_REQUIRED "cannot write $file without elevation" \
        'the target is not writable by this process; nothing was changed'
    fi
  fi

  local tmp; tmp="$(mktemp)"
  local in_block=0 wrote_block=0
  if [ -f "$file" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      if [ "$line" = "$ENV_BLOCK_BEGIN" ]; then
        in_block=1
        # Emit the block at the position of the old one, so ordering in the file is preserved.
        printf '%s\n' "$ENV_BLOCK_BEGIN" >>"$tmp"
        local kv
        for kv in "$@"; do
          printf 'export %s\n' "$kv" >>"$tmp"
        done
        printf '%s\n' "$ENV_BLOCK_END" >>"$tmp"
        wrote_block=1
        continue
      fi
      if [ "$in_block" = "1" ]; then
        if [ "$line" = "$ENV_BLOCK_END" ]; then in_block=0; fi
        continue
      fi
      printf '%s\n' "$line" >>"$tmp"
    done <"$file"
  fi
  if [ "$wrote_block" = "0" ]; then
    [ -s "$tmp" ] || : >"$tmp"
    printf '%s\n' "$ENV_BLOCK_BEGIN" >>"$tmp"
    local kv
    for kv in "$@"; do
      printf 'export %s\n' "$kv" >>"$tmp"
    done
    printf '%s\n' "$ENV_BLOCK_END" >>"$tmp"
  fi
  # Replace atomically so a crash cannot leave a half-written startup file, which would break every
  # future shell the user opens.
  mv -f "$tmp" "$file" 2>/dev/null || { rm -f "$tmp"; fail E_IO "could not replace $file"; }
}

# The NAME=value pairs currently in the managed block.
#
# awk reads </dev/null deliberately. Without it awk inherits the caller's stdin, which is the
# process-substitution pipe feeding the `while read` loop at the call site: awk drains that pipe, so
# the loop saw only the FIRST pair and every additional variable was appended on top of it, producing
# a line like `export A='1'B='2'` that is not valid shell.
env_block_pairs() {
  local file="$1"
  [ -f "$file" ] || return 0
  awk -v b="$ENV_BLOCK_BEGIN" -v e="$ENV_BLOCK_END" '
    $0 == b { inb = 1; next }
    $0 == e { inb = 0; next }
    inb && /^export / { sub(/^export /, ""); print }
  ' "$file" </dev/null
}

env_quote_value() {
  # Single-quote the value for the startup file so spaces, globs and dollars survive. An embedded
  # single quote is closed, escaped and reopened, which is the only way to represent one.
  local v="$1"
  printf "'%s'" "$(printf '%s' "$v" | sed "s/'/'\\\\''/g")"
}

# Replace one NAME=value pair in a pair list, or append it. Prints the new list, one pair per line.
#
# Emitted with printf directly rather than by accumulating a string and inserting newlines through
# command substitution: `out="$out$(printf '\n')$kv"` does not reliably produce a newline (it produced
# none here), and the failure mode is silent - two variables end up joined on one line as
# `A='1'B='2'`, which is not valid shell.
env_pairs_upsert() {
  local name="$1" value="$2"; shift 2
  local found=0 kv
  for kv in "$@"; do
    case "$kv" in
      "$name"=*) printf '%s=%s\n' "$name" "$value"; found=1 ;;
      *) printf '%s\n' "$kv" ;;
    esac
  done
  if [ "$found" = "0" ]; then printf '%s=%s\n' "$name" "$value"; fi
  return 0
}

env_pairs_delete() {
  local name="$1"; shift
  local kv
  for kv in "$@"; do
    case "$kv" in
      "$name"=*) : ;;
      *) printf '%s\n' "$kv" ;;
    esac
  done
  return 0
}

env_pairs_get() {
  local name="$1"; shift
  local kv
  for kv in "$@"; do
    case "$kv" in
      "$name"=*) env_unquote "${kv#*=}"; return 0 ;;
    esac
  done
  return 1
}

# The block stores values single-quoted so that spaces, globs and dollars survive. A caller reading
# `previous` wants the value, not its shell representation, so the surrounding quotes are removed -
# and only those: the `A='1'B='2'` corruption this guarded against is now caught upstream.
env_unquote() {
  local v="$1"
  case "$v" in
    \'*\') v="${v#\'}"; v="${v%\'}" ;;
  esac
  printf '%s' "$v"
}

cmd_environment_add() {
  require_min 2 'environment add'
  require_allow 'environment add' "${#POSITIONALS[@]}"
  local name; name="$(pos 0)"
  local value; value="$(pos 1)"
  env_resolve_scope
  local scope="$ENV_SCOPE"

  if [ "$scope" = "process" ]; then
    if [ -n "${!name+x}" ]; then
      fail E_EXISTS "'$name' is already set at process scope" 'use environment set to overwrite it'
    fi
    # Assigning through the environment of this shell only affects this process and its children
    # started within this same invocation. The calling shell is a running process and cannot see it,
    # which is what the note says.
    export "$name=$value"
    printf '{"name":%s,"value":%s,"scope":"process","operation":"add","previous":null,"visibleToRunningProcesses":%s,"note":%s}' \
      "$(jstr "$name")" "$(jstr "$value")" "$(env_visible_note "$scope")" "$(env_visibility_note_json "$scope")"
    return
  fi

  local file; file="$(env_scope_file "$scope")"
  local pairs=()
  while IFS= read -r p; do [ -n "$p" ] && pairs+=("$p"); done < <(env_block_pairs "$file")
  if env_pairs_get "$name" ${pairs[@]+"${pairs[@]}"} >/dev/null 2>&1; then
    fail E_EXISTS "'$name' is already set at $scope scope" 'use environment set to overwrite it'
  fi
  local quoted; quoted="$(env_quote_value "$value")"
  local newpairs; newpairs="$(env_pairs_upsert "$name" "$quoted" ${pairs[@]+"${pairs[@]}"})"
  local lines=()
  while IFS= read -r l; do [ -n "$l" ] && lines+=("$l"); done <<<"$newpairs"
  env_write_block "$file" ${lines[@]+"${lines[@]}"}
  printf '{"name":%s,"value":%s,"scope":%s,"operation":"add","previous":null,"file":%s,"visibleToRunningProcesses":%s,"note":"in effect for new shells; open a new shell or source the file"}' \
    "$(jstr "$name")" "$(jstr "$value")" "$(jstr "$scope")" "$(jstr "$file")" "$(env_visible_note "$scope")"
}

cmd_environment_set() {
  require_min 2 'environment set'
  require_allow 'environment set' "${#POSITIONALS[@]}"
  local name; name="$(pos 0)"
  local value; value="$(pos 1)"
  env_resolve_scope
  local scope="$ENV_SCOPE"

  if [ "$scope" = "process" ]; then
    if [ -z "${!name+x}" ]; then
      fail E_NOT_FOUND "'$name' is not set at process scope" 'use environment add to create it'
    fi
    local previous="${!name}"
    export "$name=$value"
    printf '{"name":%s,"value":%s,"scope":"process","operation":"set","previous":%s,"visibleToRunningProcesses":%s,"note":%s}' \
      "$(jstr "$name")" "$(jstr "$value")" "$(jstr "$previous")" "$(env_visible_note "$scope")" "$(env_visibility_note_json "$scope")"
    return
  fi

  local file; file="$(env_scope_file "$scope")"
  local pairs=()
  while IFS= read -r p; do [ -n "$p" ] && pairs+=("$p"); done < <(env_block_pairs "$file")
  local previous=""
  if previous="$(env_pairs_get "$name" ${pairs[@]+"${pairs[@]}"})"; then :; else
    fail E_NOT_FOUND "'$name' is not set at $scope scope" 'use environment add to create it'
  fi
  local quoted; quoted="$(env_quote_value "$value")"
  local newpairs; newpairs="$(env_pairs_upsert "$name" "$quoted" ${pairs[@]+"${pairs[@]}"})"
  local lines=()
  while IFS= read -r l; do [ -n "$l" ] && lines+=("$l"); done <<<"$newpairs"
  env_write_block "$file" ${lines[@]+"${lines[@]}"}
  printf '{"name":%s,"value":%s,"scope":%s,"operation":"set","previous":%s,"file":%s,"visibleToRunningProcesses":%s}' \
    "$(jstr "$name")" "$(jstr "$value")" "$(jstr "$scope")" "$(jstr "$previous")" "$(jstr "$file")" "$(env_visible_note "$scope")"
}

cmd_environment_delete() {
  require_min 1 'environment delete'
  require_allow 'environment delete' "${#POSITIONALS[@]}"
  local name; name="$(pos 0)"
  env_resolve_scope
  local scope="$ENV_SCOPE"

  if [ "$scope" = "process" ]; then
    if [ -z "${!name+x}" ]; then
      fail E_NOT_FOUND "'$name' is not set at process scope"
    fi
    local previous="${!name}"
    unset "$name"
    printf '{"name":%s,"scope":"process","operation":"delete","previous":%s,"visibleToRunningProcesses":%s,"note":%s}' \
      "$(jstr "$name")" "$(jstr "$previous")" "$(env_visible_note "$scope")" "$(env_visibility_note_json "$scope")"
    return
  fi

  local file; file="$(env_scope_file "$scope")"
  if [ ! -f "$file" ]; then
    fail E_NOT_FOUND "'$name' is not set at $scope scope ($file does not exist)"
  fi
  local pairs=()
  while IFS= read -r p; do [ -n "$p" ] && pairs+=("$p"); done < <(env_block_pairs "$file")
  local previous=""
  if previous="$(env_pairs_get "$name" ${pairs[@]+"${pairs[@]}"})"; then :; else
    fail E_NOT_FOUND "'$name' is not set at $scope scope"
  fi
  local newpairs; newpairs="$(env_pairs_delete "$name" ${pairs[@]+"${pairs[@]}"})"
  local lines=()
  while IFS= read -r l; do [ -n "$l" ] && lines+=("$l"); done <<<"$newpairs"
  env_write_block "$file" ${lines[@]+"${lines[@]}"}
  printf '{"name":%s,"scope":%s,"operation":"delete","previous":%s,"file":%s,"visibleToRunningProcesses":%s}' \
    "$(jstr "$name")" "$(jstr "$scope")" "$(jstr "$previous")" "$(jstr "$file")" "$(env_visible_note "$scope")"
}

# ---------------------------------------------------------------------------
# environment attribute add / set / delete
#
# An attribute is a list variable: PATH and friends, joined by the platform separator. add appends,
# set replaces one entry by index, delete removes one entry by --index or by --value. They mirror the
# Windows side field for field, so an agent parses the same result whichever platform answered.
#
# PROCESS SCOPE ONLY, deliberately. list and get already refuse every other scope here, and a list
# mutation is a worse candidate for persistence than a plain variable: editing PATH in a startup file
# can make a machine's shells unusable if the reconstruction is wrong, and the mutation would be
# invisible to the caller anyway because this verb runs as its own process. Refusing is honest;
# half-persisting a list would not be.
# ---------------------------------------------------------------------------

# Split the attribute's current value into ATTR_ENTRIES. Assigns rather than printing, because a verb
# must be able to call it in its own shell: in `entries=$(...)` a fail inside would exit only the
# subshell and the verb would carry on with empty data.
ATTR_ENTRIES=()
env_split_entries() {
  local name="$1"
  ATTR_ENTRIES=()
  if [ -z "${!name+x}" ]; then return 0; fi
  local sep; sep="$(env_separator)"
  local oldifs="$IFS"
  IFS="$sep"
  local e
  for e in ${!name}; do
    [ -n "$e" ] && ATTR_ENTRIES+=("$e")
  done
  IFS="$oldifs"
  return 0
}

# Rejoin entries and export. Prints the resulting count in ENV_ATTR_COUNT for the envelope.
env_join_entries() {
  local name="$1"
  local sep; sep="$(env_separator)"
  local joined="" i=0
  for e in ${ATTR_ENTRIES[@]+"${ATTR_ENTRIES[@]}"}; do
    if [ "$i" -eq 0 ]; then joined="$e"; else joined="$joined$sep$e"; fi
    i=$((i + 1))
  done
  ENV_ATTR_COUNT="$i"
  if [ "$i" -eq 0 ]; then
    # An empty list means the variable goes away rather than becoming an empty string, so that
    # `attribute list` stops reporting it, matching the Windows behaviour.
    unset "$name"
  else
    export "$name=$joined"
  fi
}

# Shared guard: attribute mutations are process scope only.
env_attr_require_process_scope() {
  local scope; scope="$(flag_value scope 'user')"
  if [ "$scope" != "process" ]; then
    fail E_NOT_SUPPORTED "scope '$scope' is not available on this platform" \
      'attribute mutations support --scope process only'
  fi
}

cmd_environment_attribute_add() {
  require_min 2 'environment attribute add'
  require_allow 'environment attribute add' "${#POSITIONALS[@]}"
  local name; name="$(pos 0)"
  local value; value="$(pos 1)"
  env_attr_require_process_scope
  local attr; attr="$(flag_value attr 'PATH')"
  if [ -z "${!attr+x}" ]; then
    fail E_NOT_FOUND "attribute '$attr' is not set at process scope"
  fi
  env_split_entries "$attr"
  local e
  for e in ${ATTR_ENTRIES[@]+"${ATTR_ENTRIES[@]}"}; do
    # Ordinal comparison: an entry differing from the named value only by a non-printable control
    # character must not be treated as the same entry. LC_ALL=C makes [ = ] a byte comparison.
    if LC_ALL=C [ "$e" = "$value" ]; then
      fail E_EXISTS "'$attr' already contains '$value'"
    fi
  done
  ATTR_ENTRIES+=("$value")
  env_join_entries "$attr"
  printf '{"name":%s,"added":%s,"scope":"process","count":%s,"operation":"attr-add","requestedName":%s,"visibleToRunningProcesses":%s,"note":%s}' \
    "$(jstr "$attr")" "$(jstr "$value")" "$ENV_ATTR_COUNT" "$(jstr "$name")" \
    "$(env_visible_note process)" "$(env_visibility_note_json process)"
}

cmd_environment_attribute_set() {
  require_min 3 'environment attribute set'
  require_allow 'environment attribute set' "${#POSITIONALS[@]}"
  local name; name="$(pos 0)"
  local index; index="$(pos 1)"
  case "$index" in ''|*[!0-9]*) fail E_TYPE "<index> must be an integer, got '$index'" ;; esac
  local value; value="$(pos 2)"
  env_attr_require_process_scope
  local attr; attr="$(flag_value attr 'PATH')"
  if [ -z "${!attr+x}" ]; then
    fail E_NOT_FOUND "attribute '$attr' is not set at process scope"
  fi
  env_split_entries "$attr"
  local n="${#ATTR_ENTRIES[@]}"
  if [ "$index" -ge "$n" ]; then
    local hi=0; [ "$n" -gt 0 ] && hi=$((n - 1))
    fail E_RANGE "index $index is out of range for '$attr' (0..$hi)"
  fi
  local previous="${ATTR_ENTRIES[$index]}"
  ATTR_ENTRIES[$index]="$value"
  env_join_entries "$attr"
  printf '{"name":%s,"index":%s,"previous":%s,"value":%s,"scope":"process","count":%s,"operation":"attr-set","requestedName":%s,"visibleToRunningProcesses":%s,"note":%s}' \
    "$(jstr "$attr")" "$index" "$(jstr "$previous")" "$(jstr "$value")" "$ENV_ATTR_COUNT" "$(jstr "$name")" \
    "$(env_visible_note process)" "$(env_visibility_note_json process)"
}

cmd_environment_attribute_delete() {
  require_min 1 'environment attribute delete'
  require_allow 'environment attribute delete' "${#POSITIONALS[@]}"
  local name; name="$(pos 0)"
  env_attr_require_process_scope
  local attr; attr="$(flag_value attr 'PATH')"
  local index_text; index_text="$(flag_value index '')"
  local value_text; value_text="$(flag_value value '')"
  if [ -z "$index_text" ] && [ -z "$value_text" ]; then
    fail E_USAGE 'environment attr delete needs --index or --value to say which entry to remove'
  fi
  if [ -z "${!attr+x}" ]; then
    fail E_NOT_FOUND "attribute '$attr' is not set at process scope"
  fi
  env_split_entries "$attr"
  local n="${#ATTR_ENTRIES[@]}"
  local removed="" kept=() i=0
  if [ -n "$index_text" ]; then
    local index; index="$index_text"
    case "$index" in ''|*[!0-9]*) fail E_TYPE "<index> must be an integer, got '$index'" ;; esac
    if [ "$index" -ge "$n" ]; then
      local hi=0; [ "$n" -gt 0 ] && hi=$((n - 1))
      fail E_RANGE "index $index is out of range for '$attr' (0..$hi)"
    fi
    removed="${ATTR_ENTRIES[$index]}"
    for e in ${ATTR_ENTRIES[@]+"${ATTR_ENTRIES[@]}"}; do
      [ "$i" -eq "$index" ] || kept+=("$e")
      i=$((i + 1))
    done
  else
    # Only the FIRST match is removed, and the comparison is ordinal for the same reason as add.
    local done_removing=0
    for e in ${ATTR_ENTRIES[@]+"${ATTR_ENTRIES[@]}"}; do
      if [ "$done_removing" -eq 0 ] && LC_ALL=C [ "$e" = "$value_text" ]; then
        removed="$e"; done_removing=1; continue
      fi
      kept+=("$e")
    done
    if [ -z "$removed" ]; then
      fail E_NOT_FOUND "'$attr' does not contain '$value_text'"
    fi
  fi
  ATTR_ENTRIES=(${kept[@]+"${kept[@]}"})
  env_join_entries "$attr"
  printf '{"name":%s,"removed":%s,"scope":"process","count":%s,"operation":"attr-delete","requestedName":%s,"visibleToRunningProcesses":%s,"note":%s}' \
    "$(jstr "$attr")" "$(jstr "$removed")" "$ENV_ATTR_COUNT" "$(jstr "$name")" \
    "$(env_visible_note process)" "$(env_visibility_note_json process)"
}

# ===== service.sh ==================================================

# Module: service.sh - service.* (systemd, launchd, SysV init).
#
# Intentionally empty. Service management is per-init-system on POSIX (systemctl, launchctl, service),
# and start/stop/restart need privilege. The verb table already declares these verbs and dispatch
# reports E_NOT_SUPPORTED for them until an implementation lands.

# ===== permission.sh ===============================================


# ---------------------------------------------------------------------------
# permission.* - read-only views of the authorization file, the two verbs that
# must be refused at the verb layer, and idempotent layer-A setup.
# ---------------------------------------------------------------------------
permission_file() { printf '%s' "$ROOT_DIR/permission.json"; }

# Layer A on POSIX means this process cannot write the authorization file. There is no portable
# equivalent of a Windows deny ACE, so the check is the file mode: if the file is not writable by us,
# something outside this process is preventing a rewrite.
#
# Measured, never assumed. A Windows version of this once reported a stored flag instead, which could
# claim protection the kernel was not applying.
acl_enforced() {
  local file; file="$(permission_file)"
  if [ ! -f "$file" ]; then printf 'false'; return; fi
  if [ -w "$file" ]; then printf 'false'; else printf 'true'; fi
}

acl_reason() {
  local file; file="$(permission_file)"
  if [ ! -f "$file" ]; then
    printf '%s' "$(jstr 'permission.json does not exist')"
  elif [ -w "$file" ]; then
    printf '%s' "$(jstr 'the authorization file is writable by this process, so no kernel-level protection is in effect; run: dsh-os.sh permission acl init')"
  else
    printf '%s' "$(jstr 'the authorization file is not writable by this process')"
  fi
}

# What is knowable from the bytes without a JSON parser: whether the file has content, and whether the
# documented writer field is present. Reporting that honestly beats reporting a rule count that might
# be wrong.
permission_trust_state() {
  local file; file="$(permission_file)"
  if [ ! -f "$file" ]; then printf 'missing'; return; fi
  local size; size="$(wc -c <"$file" | tr -d ' ')"
  if [ "$size" -eq 0 ]; then printf 'empty'; return; fi
  if grep -q '"updatedBy"[[:space:]]*:[[:space:]]*"consent-delegate"' "$file" 2>/dev/null; then
    printf 'trusted'
  else
    printf 'untrusted'
  fi
}

# trusted is false when the writer field is absent or says something else, because the delegate is
# supposed to be the only writer: honouring rules somebody else wrote would defeat the arrangement.
permission_trusted_json() {
  case "$(permission_trust_state)" in
    untrusted) printf 'false' ;;
    *) printf 'true' ;;
  esac
}

cmd_permission_list() {
  local file; file="$(permission_file)"
  local enforced; enforced="$(acl_enforced)"
  if [ ! -f "$file" ]; then
    printf '{"path":%s,"exists":false,"empty":false,"trusted":true,"count":0,"rules":[],"aclEnforced":%s,"aclReason":%s}' \
      "$(jstr "$file")" "$enforced" "$(acl_reason)"
    return
  fi
  local size; size="$(wc -c <"$file" | tr -d ' ')"
  if [ "$size" -eq 0 ]; then
    printf '{"path":%s,"exists":true,"empty":true,"trusted":true,"count":0,"rules":[],"aclEnforced":%s,"aclReason":%s}' \
      "$(jstr "$file")" "$enforced" "$(acl_reason)"
  else
    printf '{"path":%s,"exists":true,"empty":false,"trusted":%s,"fileState":%s,"count":null,"rules":null,"aclEnforced":%s,"aclReason":%s,"note":"rule parsing requires the harness plugin; the consent delegate owns writes"}' \
      "$(jstr "$file")" "$(permission_trusted_json)" "$(jstr "$(permission_trust_state)")" "$enforced" "$(acl_reason)"
  fi
}

cmd_permission_query() {
  require_min 1 'permission query'
  local verb; verb="$(pos 0)"
  local target; target="$(pos 1)"
  local file; file="$(permission_file)"
  # The stored rules cannot be evaluated here without a parser, so the answer states its own basis
  # rather than implying a rule was consulted. An untrusted file always answers from defaults.
  local source="defaults"
  local decision="ask"
  printf '{"verb":%s,"target":%s,"decision":%s,"ruleId":null,"source":%s,"trusted":%s,"rulesEvaluated":false,"fileExists":%s,"aclEnforced":%s,"aclReason":%s,"note":"rule evaluation requires the harness plugin; this answer is from defaults"}' \
    "$(jstr "$verb")" "$(jstr "$target")" "$(jstr "$decision")" "$(jstr "$source")" \
    "$(permission_trusted_json)" \
    "$( [ -f "$file" ] && printf 'true' || printf 'false' )" \
    "$(acl_enforced)" "$(acl_reason)"
}

cmd_permission_audit() {
  local file; file="$(permission_file)"
  if [ ! -f "$file" ]; then
    printf '{"path":%s,"count":0,"entries":[],"trusted":true}' "$(jstr "$file")"
    return
  fi
  # An empty list would be a lie and a parsed list is impossible here, so the count is null and the
  # reason is named.
  printf '{"path":%s,"count":null,"entries":null,"trusted":%s,"note":"audit parsing requires the harness plugin"}' \
    "$(jstr "$file")" "$(permission_trusted_json)"
}

# Both write verbs are delegate-only, and the enforcement is that there is no implementation here at
# all: creating a durable grant needs the user approval dialog, which only the plugin can reach. A
# permission check would be something to argue with; an absent implementation is not.
cmd_permission_grant() {
  require_min 3 'permission grant'
  require_allow 'permission grant' "${#POSITIONALS[@]}"
  fail E_PERMISSION_DELEGATE_ONLY 'permission grant can only be performed by the consent delegate' \
    'this verb needs the user approval dialog, which the delegate plugin owns; a script cannot reach it'
}

cmd_permission_revoke() {
  require_min 1 'permission revoke'
  require_allow 'permission revoke' "${#POSITIONALS[@]}"
  fail E_PERMISSION_DELEGATE_ONLY 'permission revoke can only be performed by the consent delegate' \
    'revoking a durable decision also needs the user approval dialog'
}

# permission acl init - idempotently make the authorization file non-writable.
#
# On POSIX this is a mode change, not an ACL rewrite, and the equivalence is weaker than the Windows
# deny ACE: the same user can chmod it back. That limitation is stated in the result rather than
# glossed over, because the reported strength is supposed to mean something.
cmd_permission_acl_init() {
  require_allow 'permission acl init' "${#POSITIONALS[@]}"
  local file; file="$(permission_file)"
  if [ ! -f "$file" ]; then
    fail E_NOT_FOUND "permission.json does not exist at $file" \
      'create the file first; the repository ships an empty one as the documented initial state'
  fi
  if [ "$(acl_enforced)" = "true" ]; then
    printf '{"path":%s,"changed":false,"enforced":true,"reason":%s}' "$(jstr "$file")" "$(acl_reason)"
    return
  fi
  local mode_before mode_after
  mode_before="$(stat -c '%a' "$file" 2>/dev/null || printf '')"
  if ! chmod a-w "$file" 2>/dev/null; then
    fail E_IO 'the authorization file mode could not be changed (insufficient privilege?)'
  fi
  mode_after="$(stat -c '%a' "$file" 2>/dev/null || printf '')"
  printf '{"path":%s,"changed":true,"enforced":%s,"modeBefore":%s,"modeAfter":%s,"reason":%s,"limitation":"a POSIX mode change is weaker than a Windows deny ACE: the same user can restore write access","restore":"chmod u+w permission.json"}' \
    "$(jstr "$file")" "$(acl_enforced)" "$(jstr "$mode_before")" "$(jstr "$mode_after")" "$(acl_reason)"
}

# ---------------------------------------------------------------------------
# selfcheck
# ---------------------------------------------------------------------------
cmd_selfcheck() {
  local verbs=0
  local file="$HOST_DIR/spec/verbs.tsv"
  if [ -f "$file" ]; then
    verbs="$(awk -F'	' '!/^#/ && NF >= 4 && $1 != "verb" { n++ } END { print n + 0 }' "$file")"
  fi
  # The implemented list is DERIVED from this script's own dispatch table, never written by hand. It
  # used to be a hardcoded string that had already drifted from the truth: it named nine groups while
  # the dispatch table answered thirty-six verbs, so a caller reading selfcheck would have concluded
  # that most of the working surface did not exist.
  local impl="" count=0 v=""
  while IFS= read -r v; do
    [ -z "$v" ] && continue
    [ -n "$impl" ] && impl="$impl,"
    impl="$impl$(jstr "$v")"
    count=$((count + 1))
  done <<EOF
$(sed -n "s/^    '\([a-z0-9.-]*\)') dispatch .*/\1/p" "$SELF_PATH")
EOF
  printf '{"script":"src/host/bin/dsh-os.sh","platform":%s,"locale":%s,"verbCount":%s,"implementedCount":%s,"implemented":[%s],"capabilities":{"inputInjection":%s,"clipboard":%s,"screenshot":%s,"accessibility":%s,"trash":%s},"aclEnforced":%s,"aclReason":%s}' \
    "$(jstr "$(platform_name)")" "$(jstr "${LC_ALL:-C}")" "$verbs" "$count" "$impl" \
    "$(capability_input_injection)" "$(capability_clipboard)" "$(capability_screenshot)" \
    "$(capability_accessibility)" \
    "$(command -v trash-put >/dev/null 2>&1 && echo '"available"' || echo '"unavailable"')" \
    "$(acl_enforced)" "$(acl_reason)"
}

# ---------------------------------------------------------------------------
# Capability reporting.
#
# Each of these is MEASURED, not a constant. They were four hardcoded "unavailable" strings, which was
# accurate for input injection and screen capture on a machine with no display server but would have
# stayed "unavailable" on a fully equipped desktop - a caller reading selfcheck would have concluded a
# working capability did not exist. This is the same failure the implemented list above already had and
# was fixed for, so the same rule applies: report what is measured.
#
# The strings are the tool names the verbs actually use, so a caller can act on the answer, and
# "unavailable" is reported only when nothing usable is present.
# ---------------------------------------------------------------------------
capability_input_injection() {
  if [ -z "${DISPLAY:-}" ]; then printf '"unavailable"'; return 0; fi
  if command -v xdotool >/dev/null 2>&1; then printf '"xdotool"'; return 0; fi
  printf '"unavailable"'
}

capability_clipboard() {
  if command -v xclip >/dev/null 2>&1; then printf '"xclip"'; return 0; fi
  if command -v xsel >/dev/null 2>&1; then printf '"xsel"'; return 0; fi
  # wl-copy needs a Wayland session, not merely the binary.
  if [ -n "${WAYLAND_DISPLAY:-}" ] && command -v wl-copy >/dev/null 2>&1; then printf '"wl-copy"'; return 0; fi
  printf '"unavailable"'
}

capability_screenshot() {
  if [ -z "${DISPLAY:-}" ]; then printf '"unavailable"'; return 0; fi
  if command -v import >/dev/null 2>&1; then printf '"import"'; return 0; fi
  if command -v scrot >/dev/null 2>&1; then printf '"scrot"'; return 0; fi
  printf '"unavailable"'
}

capability_accessibility() {
  # The AT-SPI bus is what an accessibility client talks to on Linux. Its presence in the session bus
  # is the evidence; a missing dbus tool means it cannot be determined, which is reported as such
  # rather than guessed at.
  if command -v dbus-send >/dev/null 2>&1; then
    if dbus-send --session --dest=org.a11y.Bus --print-reply /org/a11y/bus org.freedesktop.DBus.Peer.Ping >/dev/null 2>&1; then
      printf '"at-spi2"'; return 0
    fi
    printf '"unavailable"'; return 0
  fi
  printf '"unknown"'
}

# ===== window.sh ===================================================

# Module: window.sh - window.* / mouse.* / keyboard.* / clipboard.* / wait.* / observe.
#
# The desktop verbs are implemented on POSIX by driving the standard X11 command-line tools, because
# there is no library to link against: the shell side deliberately declares no native dependencies
# (native.sh is empty), so synthetic input means XTest through xdotool, window management through
# wmctrl or xdotool, the clipboard through xclip/xsel/wl-copy, and screen capture through import/scrot.
#
# Every one of them first checks that a display server exists and that the tool it needs is installed,
# and returns a TYPED error when either is missing - E_NO_DISPLAY or E_NOT_SUPPORTED naming the missing
# tool. That is the same contract task show already follows, and it is the important half: a caller that
# believes a click was delivered will wait for a result that never appears, so an unavailable capability
# must be an explicit error and never an empty success.
#
# On a Wayland session only some of this works, and only through the compositor's own protocols; those
# paths are not implemented, so the tools are simply absent and the verbs report that honestly.
#
# wait ms needs none of this and is implemented below without any capability check.

# ---------------------------------------------------------------------------
# Capability probes.
#
# HAVE_* are set once by window_probe. They are plain globals rather than a function per check, because
# each verb needs several of them and re-probing per call would fork a command -v for every test.
# ---------------------------------------------------------------------------
HAVE_XDOTOOL=0
HAVE_WMCTRL=0
HAVE_XCLIP=0
HAVE_XSEL=0
HAVE_WLCOPY=0
HAVE_IMPORT=0
HAVE_SCROT=0
HAVE_XRANDR=0
WINDOW_PROBED=0

window_probe() {
  [ "$WINDOW_PROBED" = "1" ] && return 0
  command -v xdotool  >/dev/null 2>&1 && HAVE_XDOTOOL=1
  command -v wmctrl   >/dev/null 2>&1 && HAVE_WMCTRL=1
  command -v xclip    >/dev/null 2>&1 && HAVE_XCLIP=1
  command -v xsel     >/dev/null 2>&1 && HAVE_XSEL=1
  command -v wl-copy  >/dev/null 2>&1 && HAVE_WLCOPY=1
  command -v import   >/dev/null 2>&1 && HAVE_IMPORT=1
  command -v scrot    >/dev/null 2>&1 && HAVE_SCROT=1
  command -v xrandr   >/dev/null 2>&1 && HAVE_XRANDR=1
  WINDOW_PROBED=1
  return 0
}

# There must be a display to talk to. Wayland alone is deliberately NOT accepted for the input and window
# verbs: those go through XTest and EWMH, which a bare Wayland session does not provide. Saying so is
# better than driving XWayland and reporting success for an action that never reached the app.
window_require_display() {
  window_probe
  if [ -z "${DISPLAY:-}" ]; then
    fail E_NO_DISPLAY 'there is no X display in this environment' \
      'DISPLAY is unset; the desktop verbs need X11 through xdotool/wmctrl'
  fi
  return 0
}

# require_tool <HAVE_FLAG> <tool-name> <what-for>
window_require_tool() {
  local have="$1" tool="$2" why="$3"
  if [ "$have" != "1" ]; then
    fail E_NOT_SUPPORTED "the '$tool' tool is not installed" "install $tool to use $why on this platform"
  fi
  return 0
}

# Coordinates arrive as text and must be signed integers before anything is injected. Checking here
# rather than letting xdotool fail keeps the error code the same as on Windows: E_TYPE for a non-integer.
# Validated coordinate. Sets WINDOW_INT rather than printing it.
#
# THIS ASSIGNS A GLOBAL RATHER THAN PRINTING, AND THAT IS LOAD-BEARING. Called as
# `x="$(window_int_arg ...)"` the whole function runs in a subshell, so its `fail` would `exit` only that
# subshell: the verb would carry on with an empty value and INJECT ANYWAY. That was a real defect here -
# `mouse over abc 20` moved the pointer and returned ok - and it is the same trap the environment module
# documents for env_resolve_scope. A validator that can reject must be called in the caller's own shell.
WINDOW_INT=""
window_int_arg() {
  local value="$1" label="$2"
  local digits="$value"
  # A leading '-' is part of a valid coordinate, so it is stripped before the digit test; anything that
  # is then not all digits is a type error. This is the same order the Windows side uses, which is why
  # '-5' is a range or type question rather than "not an integer".
  case "$digits" in -*) digits="${digits#-}" ;; esac
  case "$digits" in ''|*[!0-9]*) fail E_TYPE "<$label> must be an integer, got '$value'" ;; esac
  WINDOW_INT="$value"
}

# ---------------------------------------------------------------------------
# mouse.*
#
# Button numbering is X11's, and it is NOT the same as the Windows side's names: 1 is left, 2 is middle,
# 3 is right, 4 and 5 are the vertical wheel. The --button flag accepts a name or a number so a caller
# writing portable code can keep using names.
# ---------------------------------------------------------------------------
# Validated X11 button number. Sets WINDOW_BUTTON rather than printing it, for the same subshell reason
# as window_int_arg: a rejection inside $(...) would not stop the verb.
WINDOW_BUTTON=""
window_button_number() {
  local b="$1"
  case "$b" in
    ''|left|1) WINDOW_BUTTON='1' ;;
    middle|2) WINDOW_BUTTON='2' ;;
    right|3) WINDOW_BUTTON='3' ;;
    wheel-up|4) WINDOW_BUTTON='4' ;;
    wheel-down|5) WINDOW_BUTTON='5' ;;
    [0-9]*) WINDOW_BUTTON="$b" ;;
    *) fail E_TYPE "<button> must be left, middle, right or a number, got '$b'" ;;
  esac
}

# --clearmodifiers is xdotool's own option and does exactly what the Windows side implements by hand:
# release any modifier this process is holding before injecting, and restore it afterwards.
# have_flag is the right test rather than comparing a value: a flag given without a value is stored as
# "true" by parse_args, but a caller may also write --clearmodifiers=true, and both mean the same thing.
window_clearmod_flag() {
  if have_flag clearmodifiers; then
    printf -- '--clearmodifiers'
  fi
}

cmd_mouse_cursor() {
  window_require_display
  window_require_tool "$HAVE_XDOTOOL" xdotool 'mouse cursor'
  local out x y screen
  out="$(xdotool getmouselocation --shell 2>/dev/null)" || fail E_IO 'xdotool could not read the cursor position'
  x="$(printf '%s\n' "$out" | sed -n 's/^X=\(.*\)$/\1/p')"
  y="$(printf '%s\n' "$out" | sed -n 's/^Y=\(.*\)$/\1/p')"
  screen="$(printf '%s\n' "$out" | sed -n 's/^SCREEN=\(.*\)$/\1/p')"
  if [ -z "$x" ] || [ -z "$y" ]; then
    fail E_IO 'xdotool returned no cursor position'
  fi
  printf '{"cursor":{"x":%s,"y":%s},"screen":%s}' "$x" "$y" "$(jstr "${screen:-0}")"
}

cmd_mouse_over() {
  require_min 2 'mouse over'
  require_allow 'mouse over' "${#POSITIONALS[@]}"
  window_require_display
  window_require_tool "$HAVE_XDOTOOL" xdotool 'mouse over'
  local x y
  window_int_arg "$(pos 0)" x; x="$WINDOW_INT"
  window_int_arg "$(pos 1)" y; y="$WINDOW_INT"
  xdotool mousemove --sync "$x" "$y" >/dev/null 2>&1 || fail E_IO "xdotool could not move the cursor to $x,$y"
  # The position is read back rather than assumed: a movement can be clamped by the screen edge or
  # overridden by a window manager, and reporting where the cursor actually is is the useful answer.
  local after ax ay
  after="$(xdotool getmouselocation --shell 2>/dev/null)"
  ax="$(printf '%s\n' "$after" | sed -n 's/^X=\(.*\)$/\1/p')"
  ay="$(printf '%s\n' "$after" | sed -n 's/^Y=\(.*\)$/\1/p')"
  printf '{"requested":{"x":%s,"y":%s},"cursor":{"x":%s,"y":%s},"moved":%s,"tool":"xdotool"}' \
    "$x" "$y" "${ax:-$x}" "${ay:-$y}" "$( [ "${ax:-$x}" = "$x" ] && [ "${ay:-$y}" = "$y" ] && echo true || echo false )"
}

cmd_mouse_click() {
  require_min 2 'mouse click'
  require_allow 'mouse click' "${#POSITIONALS[@]}"
  window_require_display
  window_require_tool "$HAVE_XDOTOOL" xdotool 'mouse click'
  local x y button count cm
  window_int_arg "$(pos 0)" x; x="$WINDOW_INT"
  window_int_arg "$(pos 1)" y; y="$WINDOW_INT"
  # The button and count are resolved and validated HERE, before any injection. Both were originally
  # computed after the cursor had already been moved, so a rejected --count left the pointer somewhere
  # else - a failed call that had still changed the machine.
  window_button_number "$(flag_value button 'left')"; button="$WINDOW_BUTTON"
  count="$(flag_value count '1')"
  case "$count" in ''|*[!0-9]*) fail E_TYPE "<count> must be an integer, got '$count'" ;; esac
  [ "$count" -ge 1 ] || fail E_RANGE "<count> must be at least 1, got '$count'"
  cm="$(window_clearmod_flag)"

  # EVERY argument is validated before anything is injected. An earlier version validated the button and
  # count after moving the cursor, so a bad --count still moved the pointer: a rejected call had already
  # changed the machine's state. The Windows side validates first for the same reason, and a test that
  # asserted "nothing was injected" is what caught it.
  xdotool mousemove --sync "$x" "$y" >/dev/null 2>&1 || fail E_IO "xdotool could not move the cursor to $x,$y"
  # xdotool click takes a repeat count, which is one process instead of a loop of one process per click.
  # shellcheck disable=SC2086
  xdotool click $cm --repeat "$count" "$button" >/dev/null 2>&1 || fail E_IO "xdotool could not click button $button at $x,$y"
  printf '{"point":{"x":%s,"y":%s},"button":%s,"count":%s,"clearedModifiers":%s,"tool":"xdotool"}' \
    "$x" "$y" "$button" "$count" "$( [ -n "$cm" ] && echo true || echo false )"
}

cmd_mouse_context() {
  require_min 2 'mouse context'
  require_allow 'mouse context' "${#POSITIONALS[@]}"
  window_require_display
  window_require_tool "$HAVE_XDOTOOL" xdotool 'mouse context'
  local x y cm
  window_int_arg "$(pos 0)" x; x="$WINDOW_INT"
  window_int_arg "$(pos 1)" y; y="$WINDOW_INT"
  cm="$(window_clearmod_flag)"
  xdotool mousemove --sync "$x" "$y" >/dev/null 2>&1 || fail E_IO "xdotool could not move the cursor to $x,$y"
  # Button 3 is the right button, which is what opens a context menu.
  # shellcheck disable=SC2086
  xdotool click $cm 3 >/dev/null 2>&1 || fail E_IO "xdotool could not open a context menu at $x,$y"
  printf '{"point":{"x":%s,"y":%s},"button":3,"clearedModifiers":%s,"tool":"xdotool"}' \
    "$x" "$y" "$( [ -n "$cm" ] && echo true || echo false )"
}

cmd_mouse_wheel() {
  require_min 2 'mouse wheel'
  require_allow 'mouse wheel' "${#POSITIONALS[@]}"
  window_require_display
  window_require_tool "$HAVE_XDOTOOL" xdotool 'mouse wheel'
  local x y
  window_int_arg "$(pos 0)" x; x="$WINDOW_INT"
  window_int_arg "$(pos 1)" y; y="$WINDOW_INT"

  # The x argument carries the scroll distance, exactly as it does on Windows, where the wheel delta IS
  # x. --space overrides how many notches that distance is worth, for a caller that wants a smaller
  # movement than the sample points it has; omitting it means one notch per notch.
  local delta="$x"
  local count
  count="$(flag_value space '')"
  if [ -z "$count" ]; then
    # One notch by default. A magnitude is reduced to notches rather than multiplied, because the
    # Windows delta is a multiple of 120 and a caller porting the same numbers would otherwise scroll
    # hundreds of notches.
    local mag="$delta"
    case "$mag" in -*) mag="${mag#-}" ;; esac
    if [ "$mag" -ge 120 ]; then
      count=$((mag / 120))
      [ "$count" -ge 1 ] || count=1
    else
      count=1
    fi
  fi
  case "$count" in ''|*[!0-9]*|0) fail E_TYPE "<space> must be a positive integer, got '$count'" ;; esac

  # X11 has no wheel event: buttons 4 and 5 are one notch up and down. A positive value scrolls up,
  # which is the same sign convention the Windows side uses for its WHEEL delta.
  local button
  case "$delta" in
    -*) button=5 ;;
    *)  button=4 ;;
  esac
  if [ "$delta" -eq 0 ]; then
    fail E_RANGE '<x> must not be zero: the x argument carries the scroll distance'
  fi

  xdotool mousemove --sync "$x" "$y" >/dev/null 2>&1 || fail E_IO "xdotool could not move the cursor to $x,$y"
  xdotool click --repeat "$count" "$button" >/dev/null 2>&1 || fail E_IO "xdotool could not scroll at $x,$y"
  printf '{"action":"wheel","delta":%s,"notches":%s,"direction":%s,"at":{"x":%s,"y":%s},"tool":"xdotool"}' \
    "$delta" "$count" "$( [ "$button" = "4" ] && echo '"up"' || echo '"down"' )" "$x" "$y"
}
cmd_mouse_down() {
  require_min 2 'mouse down'
  require_allow 'mouse down' "${#POSITIONALS[@]}"
  window_require_display
  window_require_tool "$HAVE_XDOTOOL" xdotool 'mouse down'
  local x y button
  window_int_arg "$(pos 0)" x; x="$WINDOW_INT"
  window_int_arg "$(pos 1)" y; y="$WINDOW_INT"
  window_button_number "$(flag_value button 'left')"; button="$WINDOW_BUTTON"
  xdotool mousemove --sync "$x" "$y" >/dev/null 2>&1 || fail E_IO "xdotool could not move the cursor to $x,$y"
  xdotool mousedown "$button" >/dev/null 2>&1 || fail E_IO "xdotool could not press button $button"
  # The button is deliberately NOT released: that is what mouse up is for. A drag is down, move, up.
  printf '{"point":{"x":%s,"y":%s},"button":%s,"held":true,"note":"the button stays down until mouse up","tool":"xdotool"}' \
    "$x" "$y" "$button"
}

cmd_mouse_up() {
  require_allow 'mouse up' "${#POSITIONALS[@]}"
  window_require_display
  window_require_tool "$HAVE_XDOTOOL" xdotool 'mouse up'
  local button
  window_button_number "$(flag_value button 'left')"; button="$WINDOW_BUTTON"
  xdotool mouseup "$button" >/dev/null 2>&1 || fail E_IO "xdotool could not release button $button"
  printf '{"button":%s,"held":false,"tool":"xdotool"}' "$button"
}

# ---------------------------------------------------------------------------
# keyboard.*
#
# xdotool takes X keysym NAMES, not virtual key codes, so a caller writing portable code needs the two
# to line up. The names below are the intersection that means the same thing on both platforms, and the
# mapping is applied before every call. Anything not listed is passed through unchanged, which lets a
# caller use any X keysym name ('XF86AudioMute', 'Greek_alpha') without this layer having to enumerate
# the whole keyboard.
#
# The reason the mapping exists at all is the same reason the Windows side sends Unicode events for
# keyboard type: a key is not a character, and 'Return' versus 'Enter' is exactly the kind of difference
# that makes a script work on one machine and silently do nothing on another.
# ---------------------------------------------------------------------------
WINDOW_KEY=""
window_key_name() {
  local key="$1"
  case "$key" in
    '' ) fail E_TYPE '<code> must not be empty' ;;
    # Single characters and function keys are already keysyms.
    [A-Za-z0-9]) WINDOW_KEY="$key" ;;
    F[0-9]|F1[0-2]) WINDOW_KEY="$key" ;;
    # Windows spelling -> X keysym spelling.
    enter|Enter|ENTER|return|Return|RETURN) WINDOW_KEY='Return' ;;
    esc|Esc|ESC|escape|Escape|ESCAPE) WINDOW_KEY='Escape' ;;
    backspace|Backspace|BACKSPACE|back|Back|BACK) WINDOW_KEY='BackSpace' ;;
    del|Del|DEL|delete|Delete|DELETE) WINDOW_KEY='Delete' ;;
    ins|Ins|INS|insert|Insert|INSERT) WINDOW_KEY='Insert' ;;
    space|Space|SPACE) WINDOW_KEY='space' ;;
    tab|Tab|TAB) WINDOW_KEY='Tab' ;;
    ctrl|Ctrl|CTRL|control|Control|CONTROL) WINDOW_KEY='ctrl' ;;
    shift|Shift|SHIFT) WINDOW_KEY='shift' ;;
    alt|Alt|ALT) WINDOW_KEY='alt' ;;
    win|Win|WIN|super|Super|SUPER|meta|Meta|META) WINDOW_KEY='super' ;;
    up|Up|UP) WINDOW_KEY='Up' ;;
    down|Down|DOWN) WINDOW_KEY='Down' ;;
    left|Left|LEFT) WINDOW_KEY='Left' ;;
    right|Right|RIGHT) WINDOW_KEY='Right' ;;
    home|Home|HOME) WINDOW_KEY='Home' ;;
    end|End|END) WINDOW_KEY='End' ;;
    pageup|PageUp|PAGEUP|pgup|PgUp|PGUP) WINDOW_KEY='Prior' ;;
    pagedown|PageDown|PAGEDOWN|pgdn|PgDn|PGDN) WINDOW_KEY='Next' ;;
    printscreen|PrintScreen|PRINTSCREEN) WINDOW_KEY='Print' ;;
    capslock|CapsLock|CAPSLOCK) WINDOW_KEY='Caps_Lock' ;;
    numlock|NumLock|NUMLOCK) WINDOW_KEY='Num_Lock' ;;
    scrolllock|ScrollLock|SCROLLLOCK) WINDOW_KEY='Scroll_Lock' ;;
    pause|Pause|PAUSE) WINDOW_KEY='Pause' ;;
    # A Windows virtual key number means nothing to X, so saying so beats sending a literal "13".
    [0-9]*) fail E_TYPE "<code> '$key' is a virtual key number, which has no X equivalent" \
        'use a name such as Return, Escape, ctrl or F5' ;;
    *) WINDOW_KEY="$key" ;;
  esac
}

# The interval between injected keys, in milliseconds, as a fractional sleep. xdotool has --delay but
# it is per character in milliseconds and its handling differs between versions, so the delay is applied
# here where its meaning is unambiguous.
window_key_delay() {
  local interval; interval="$(flag_value interval '')"
  [ -z "$interval" ] && return 0
  case "$interval" in ''|*[!0-9]*) fail E_TYPE "<interval> must be an integer, got '$interval'" ;; esac
  if [ "$interval" -gt 0 ]; then
    local secs=$((interval / 1000))
    local rem=$((interval % 1000))
    if [ "$rem" -ne 0 ] && sleep "0.$rem" 2>/dev/null; then
      :
    elif [ "$rem" -ne 0 ]; then
      secs=$((secs + 1))
    fi
    [ "$secs" -gt 0 ] && sleep "$secs"
  fi
  return 0
}

cmd_keyboard_codes() {
  window_require_display
  window_require_tool "$HAVE_XDOTOOL" xdotool 'keyboard codes'
  # The names this layer maps, plus the fact that xdotool resolves anything else itself. Reported as a
  # sorted list so a caller can check a name without guessing.
  printf '{"platform":"x11","count":32,"names":["Alt","BackSpace","Caps_Lock","Control","Delete","Down","End","Enter","Escape","F1","F2","F3","F4","F5","F6","F7","F8","F9","F10","F11","F12","Home","Insert","Left","Next","Num_Lock","Pause","Print","Prior","Return","Right","Tab","Up"],"note":"any X keysym name is also accepted and passed through unchanged","tool":"xdotool"}'
}

cmd_keyboard_down() {
  require_min 1 'keyboard down'
  require_allow 'keyboard down' "${#POSITIONALS[@]}"
  window_require_display
  window_require_tool "$HAVE_XDOTOOL" xdotool 'keyboard down'
  local key; window_key_name "$(pos 0)"; key="$WINDOW_KEY"
  local cm; cm="$(window_clearmod_flag)"
  # shellcheck disable=SC2086
  xdotool keydown $cm "$key" >/dev/null 2>&1 || fail E_IO "xdotool could not press '$key' down"
  printf '{"code":%s,"held":true,"note":"the key stays down until keyboard up","tool":"xdotool"}' "$(jstr "$key")"
}

cmd_keyboard_up() {
  require_min 1 'keyboard up'
  require_allow 'keyboard up' "${#POSITIONALS[@]}"
  window_require_display
  window_require_tool "$HAVE_XDOTOOL" xdotool 'keyboard up'
  local key; window_key_name "$(pos 0)"; key="$WINDOW_KEY"
  local cm; cm="$(window_clearmod_flag)"
  # shellcheck disable=SC2086
  xdotool keyup $cm "$key" >/dev/null 2>&1 || fail E_IO "xdotool could not release '$key'"
  printf '{"code":%s,"held":false,"tool":"xdotool"}' "$(jstr "$key")"
}

cmd_keyboard_press() {
  require_min 1 'keyboard press'
  require_allow 'keyboard press' "${#POSITIONALS[@]}"
  window_require_display
  window_require_tool "$HAVE_XDOTOOL" xdotool 'keyboard press'
  # The key name and the interval are validated before the injection, so a rejected call has not already
  # pressed something.
  local key; window_key_name "$(pos 0)"; key="$WINDOW_KEY"
  local interval; interval="$(flag_value interval '')"
  if [ -n "$interval" ]; then
    case "$interval" in ''|*[!0-9]*) fail E_TYPE "<interval> must be an integer, got '$interval'" ;; esac
  fi
  local cm; cm="$(window_clearmod_flag)"
  # A press is xdotool key, which presses AND releases. The key is always released even if the
  # injection fails, because a key left down makes the machine unusable until it is pressed again.
  # shellcheck disable=SC2086
  if ! xdotool key $cm "$key" >/dev/null 2>&1; then
    xdotool keyup "$key" >/dev/null 2>&1 || true
    fail E_IO "xdotool could not press '$key'"
  fi
  window_key_delay
  printf '{"code":%s,"pressed":true,"released":true,"intervalMs":%s,"tool":"xdotool"}' \
    "$(jstr "$key")" "$( [ -n "$interval" ] && printf '%s' "$interval" || printf 'null' )"
}

cmd_keyboard_combination() {
  require_min 2 'keyboard combination'
  require_allow 'keyboard combination' "${#POSITIONALS[@]}"
  window_require_display
  window_require_tool "$HAVE_XDOTOOL" xdotool 'keyboard combination'
  local phase; phase="$(pos 0)"
  local cm; cm="$(window_clearmod_flag)"
  local interval; interval="$(flag_value interval '')"
  # The keys may be one space-separated argument or several arguments, because both are natural to write.
  local keys_raw="" i=1
  while :; do
    local v; v="$(pos $i)"
    [ -z "$v" ] && break
    keys_raw="$keys_raw $v"
    i=$((i + 1))
  done
  local keys=()
  local k
  for k in $keys_raw; do window_key_name "$k"; keys+=("$WINDOW_KEY"); done
  [ "${#keys[@]}" -eq 0 ] && fail E_TYPE '<keys> must name at least one key'

  local chord; chord="$(printf '%s+' "${keys[@]}")"; chord="${chord%+}"
  case "$phase" in
    down)
      # Modifiers first, then the final key: the reverse order in a chord is what produces the
      # combination for a key that needs the modifier held.
      local first=1
      for k in "${keys[@]}"; do
        if [ "$first" = "1" ]; then first=0; else chord=""; fi
        # shellcheck disable=SC2086
        xdotool keydown $cm "$k" >/dev/null 2>&1 || { for u in "${keys[@]}"; do xdotool keyup "$u" >/dev/null 2>&1 || true; done; fail E_IO "xdotool could not hold '$k'"; }
      done
      printf '{"phase":"down","keys":[%s],"held":true,"tool":"xdotool"}' "$(window_json_keys "${keys[@]}")"
      ;;
    up)
      # Released in REVERSE order, which is what a real chord does and what applications expect.
      local idx=$((${#keys[@]} - 1))
      while [ "$idx" -ge 0 ]; do
        xdotool keyup "${keys[$idx]}" >/dev/null 2>&1 || true
        idx=$((idx - 1))
      done
      printf '{"phase":"up","keys":[%s],"held":false,"tool":"xdotool"}' "$(window_json_keys "${keys[@]}")"
      ;;
    press|"")
      # A whole chord in one call. xdotool releases what it pressed, and modifiers the USER is holding
      # are handled by --clearmodifiers rather than being released unconditionally.
      # shellcheck disable=SC2086
      if ! xdotool key $cm "$chord" >/dev/null 2>&1; then
        for u in "${keys[@]}"; do xdotool keyup "$u" >/dev/null 2>&1 || true; done
        fail E_IO "xdotool could not send the chord '$chord'"
      fi
      window_key_delay
      printf '{"phase":"press","keys":[%s],"chord":%s,"intervalMs":%s,"tool":"xdotool"}' \
        "$(window_json_keys "${keys[@]}")" "$(jstr "$chord")" \
        "$( [ -n "$interval" ] && printf '%s' "$interval" || printf 'null' )"
      ;;
    *)
      fail E_TYPE "<phase> must be down, up or press, got '$phase'"
      ;;
  esac
}

window_json_keys() {
  local out="" k
  for k in "$@"; do
    [ -n "$out" ] && out="$out,"
    out="$out$(jstr "$k")"
  done
  printf '%s' "$out"
}

cmd_keyboard_type() {
  require_min 1 'keyboard type'
  require_allow 'keyboard type' "${#POSITIONALS[@]}"
  window_require_display
  window_require_tool "$HAVE_XDOTOOL" xdotool 'keyboard type'
  local text; text="$(pos 0)"
  if [ -z "$text" ]; then
    fail E_NOT_TEXT '<text> must not be empty'
  fi
  local method; method="$(flag_value method 'type')"
  case "$method" in
    type|key)
      # --clearmodifiers matters more here than anywhere else: a modifier the user is physically holding
      # would otherwise combine with every injected character.
      # shellcheck disable=SC2086
      xdotool type --clearmodifiers --delay "${XDOTOOL_TYPE_DELAY:-12}" -- "$text" >/dev/null 2>&1 \
        || fail E_IO 'xdotool could not type the text'
      ;;
    *)
      fail E_TYPE "<method> must be type or key, got '$method'"
      ;;
  esac
  window_key_delay
  local chars; chars="$(printf '%s' "$text" | wc -c | tr -d ' ')"
  printf '{"text":%s,"characters":%s,"method":%s,"tool":"xdotool"}' \
    "$(jstr "$text")" "$chars" "$(jstr "$method")"
}
# ---------------------------------------------------------------------------
# wait ms
#
# The sleep is performed in whole seconds plus a fractional remainder where the shell supports one.
# `sleep 0.05` is a GNU/busybox extension rather than POSIX, so the fractional form is used only when
# the value is not a whole number of seconds AND the shell's sleep accepts it; otherwise the wait is
# rounded UP to the next second. Rounding up rather than down is deliberate: a caller that asked to wait
# 1500 ms is pacing something, and returning early is the failure mode that breaks it.
# ---------------------------------------------------------------------------
cmd_wait_ms() {
  require_min 1 'wait ms'
  local ms; ms="$(pos 0)"
  # A leading '-' is not "not an integer", it is a negative number: reporting E_TYPE for -5 said the
  # wrong thing, and the Windows side reports E_RANGE for it. The sign is checked first so the caller
  # gets the same code on both platforms.
  case "$ms" in
    -*) fail E_RANGE "ms must not be negative, got $ms" ;;
  esac
  case "$ms" in ''|*[!0-9]*) fail E_TYPE "<ms> must be an integer, got '$ms'" ;; esac
  if [ "$ms" -gt 3600000 ]; then
    # An hour is a generous ceiling. Beyond it the caller almost certainly passed seconds by mistake,
    # and silently sleeping for hours is worse than saying so.
    fail E_RANGE "ms must be at most 3600000 (one hour), got $ms" \
      'the value is milliseconds; 1000 ms is one second'
  fi

  # Elapsed is measured in MILLISECONDS with date, not from $SECONDS. $SECONDS is a whole-second
  # counter, so a 250 ms wait reported elapsedMs 0, which is a false measurement rather than a rounding
  # detail: the field exists to tell a caller how long it actually waited. The same expression the entry
  # point uses is used here so the two agree. The %3N form is GNU; the fallback reports whole seconds.
  local started; started="$(date +%s%3N 2>/dev/null || date +%s000)"
  local secs=$((ms / 1000))
  local rem=$((ms % 1000))
  if [ "$rem" -eq 0 ]; then
    [ "$secs" -gt 0 ] && sleep "$secs"
  else
    # `sleep 0.25` is a GNU/busybox extension, not POSIX, so it is tried and the wait rounds UP to the
    # next whole second if the shell refuses it. Rounding up is deliberate: a caller that asked to wait
    # 1500 ms is pacing something, and returning early is the failure mode that breaks it.
    if sleep "0.$rem" 2>/dev/null; then
      [ "$secs" -gt 0 ] && sleep "$secs"
    else
      sleep "$((secs + 1))"
    fi
  fi
  local end_ms; end_ms="$(date +%s%3N 2>/dev/null || date +%s000)"
  local elapsed=$((end_ms - started))

  printf '{"requestedMs":%s,"elapsedMs":%s,"note":"fractional sleep is used when the shell supports it; otherwise the wait rounds up to the next whole second"}' \
    "$ms" "$elapsed"
}

# ===== dispatch.sh =================================================


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

# ===== entry.sh ====================================================


main() {
  local start_ms
  start_ms="$(date +%s%3N 2>/dev/null || date +%s000)"
  # parse_args populates globals (POSITIONALS, FLAGS, NAMED), so it cannot run in a subshell. It
  # therefore RETURNS its error instead of calling fail(), and the failure is reported here where the
  # entry point can still re-emit the envelope. Calling fail() inside it exited before any output
  # could be produced, which is why a bad flag used to return a bare exit code.
  parse_args "$@"
  local parse_status=$?
  if [ "$parse_status" -ne 0 ]; then
    # Routed through dispatch, not called directly. fail() ends with `exit`, and an exit raised in the
    # main shell terminates the script before the entry point can re-emit the envelope it just wrote.
    # Inside dispatch's command substitution that exit only ends the substitution, so the status
    # returns to main and the entry point gets to run. Every failing path must go through here.
    dispatch cmd_arg_error
    return "$MAIN_STATUS"
  fi
  # resolve_verb must also run in the CURRENT shell, for the same reason: it reassigns POSITIONALS.
  resolve_verb
  local verb_status=$?
  if [ "$verb_status" -ne 0 ]; then
    if [ "$verb_status" -eq 2 ]; then
      fail E_USAGE 'no verb given' 'run: dsh-os.sh selfcheck   (lists the full verb table)'
    fi
    # Reporting through fail() is what writes the envelope; setting the status alone would leave the
    # caller with a non-zero exit and nothing to parse.
    local reported="${UNKNOWN_VERB:-}"
    if [ -z "$reported" ]; then reported="${POSITIONALS[0]:-}"; fi
    fail E_NOT_SUPPORTED "verb '$reported' is not implemented in this build" \
      'run: dsh-os.sh selfcheck   (implemented verbs are listed in its "implemented" field)'
  fi
  # Normalise the two calling forms before dispatch, so no verb body has to care which was used.
  merge_named_args "$CURRENT_VERB"
  local merge_status=$?
  if [ "$merge_status" -ne 0 ]; then
    dispatch cmd_arg_error
    return "$MAIN_STATUS"
  fi

  # Each verb body is invoked through this wrapper rather than directly.
  #
  # `result="$(cmd_x)"` would be fatal under `set -e` the moment cmd_x exits non-zero, aborting main
  # BEFORE the envelope is emitted. Catching the status here keeps main in control.
  #
  # dispatch and RESULT are top-level (defined above main) so the argument-error path can reach them
  # too. An `exit` raised while the verb body runs in dispatch's command substitution is contained
  # there; the status travels back via MAIN_STATUS and the entry point performs the single exit.
  case "$CURRENT_VERB" in
    'selfcheck') dispatch cmd_selfcheck ;;
    'file.create') dispatch cmd_file_create ;;
    'file.charset') dispatch cmd_file_charset ;;
    'file.information') dispatch cmd_file_information ;;
    'file.length') dispatch cmd_file_length ;;
    'file.list') dispatch cmd_file_list ;;
    'file.delete') dispatch cmd_file_delete ;;
    'file.move') dispatch cmd_file_move ;;
    'file.copy') dispatch cmd_file_copy ;;
    'file.mkdir') dispatch cmd_file_mkdir ;;
    'file.append') dispatch cmd_file_append ;;
    'file.insert') dispatch cmd_file_insert ;;
    'file.view') dispatch cmd_file_view ;;
    'file.search') dispatch cmd_file_search ;;
    'file.verify.charset') dispatch cmd_file_verify_charset ;;
    'file.verify.encoding') dispatch cmd_file_verify_encoding ;;
    'file.verify.completion') dispatch cmd_file_verify_completion ;;
    'system.brand') dispatch cmd_system_brand ;;
    'system.cpu') dispatch cmd_system_cpu ;;
    'system.gpu') dispatch cmd_system_gpu ;;
    'system.version') dispatch cmd_system_version ;;
    'system.info') dispatch cmd_system_info ;;
    'task.list') dispatch cmd_task_list ;;
    'task.query') dispatch cmd_task_query ;;
    'task.show') dispatch cmd_task_show ;;
    'task.kill') dispatch cmd_task_kill ;;
    'execute.query') dispatch cmd_execute_query ;;
    'execute.kill') dispatch cmd_execute_kill ;;
    'environment.list') dispatch cmd_environment_list ;;
    'environment.get') dispatch cmd_environment_get ;;
    'environment.add') dispatch cmd_environment_add ;;
    'environment.set') dispatch cmd_environment_set ;;
    'environment.delete') dispatch cmd_environment_delete ;;
    'environment.attribute.list') dispatch cmd_environment_attribute_list ;;
    'environment.attribute.get') dispatch cmd_environment_attribute_get ;;
    'environment.attribute.add') dispatch cmd_environment_attribute_add ;;
    'environment.attribute.set') dispatch cmd_environment_attribute_set ;;
    'environment.attribute.delete') dispatch cmd_environment_attribute_delete ;;
    # wait ms is the one verb of the desktop group that needs nothing from a display server, so it is
    # implemented here. The other window/mouse/keyboard/clipboard/observe verbs are deliberately absent
    # from this table and fall through to the default arm, which reports a typed E_NOT_SUPPORTED.
    'wait.ms') dispatch cmd_wait_ms ;;
    # mouse.* drives X11 through xdotool. Each verb checks for a display and for the tool before it
    # injects anything, so on a machine without either it reports E_NO_DISPLAY or E_NOT_SUPPORTED rather
    # than appearing to act.
    'mouse.click') dispatch cmd_mouse_click ;;
    'mouse.context') dispatch cmd_mouse_context ;;
    'mouse.over') dispatch cmd_mouse_over ;;
    'mouse.wheel') dispatch cmd_mouse_wheel ;;
    'mouse.down') dispatch cmd_mouse_down ;;
    'mouse.up') dispatch cmd_mouse_up ;;
    'mouse.cursor') dispatch cmd_mouse_cursor ;;
    # keyboard.* drives X11 through xdotool, with the same capability gate as mouse.*. Key names are
    # translated from the Windows spelling to the X keysym spelling before injection, because 'Return'
    # and 'Enter' are the same key and a script must not work on one machine and silently do nothing on
    # another.
    'keyboard.down') dispatch cmd_keyboard_down ;;
    'keyboard.up') dispatch cmd_keyboard_up ;;
    'keyboard.press') dispatch cmd_keyboard_press ;;
    'keyboard.combination') dispatch cmd_keyboard_combination ;;
    'keyboard.type') dispatch cmd_keyboard_type ;;
    'keyboard.codes') dispatch cmd_keyboard_codes ;;
    'permission.list') dispatch cmd_permission_list ;;
    'permission.query') dispatch cmd_permission_query ;;
    'permission.audit') dispatch cmd_permission_audit ;;
    'permission.grant') dispatch cmd_permission_grant ;;
    'permission.revoke') dispatch cmd_permission_revoke ;;
    'permission.acl.init') dispatch cmd_permission_acl_init ;;
    'execute.command') dispatch cmd_execute_command ;;
    'execute.synchronous') dispatch cmd_execute_synchronous ;;
    'execute.asynchronous') dispatch cmd_execute_asynchronous ;;
    *)
      # Routed through dispatch like every other verb: calling fail() directly here would exit from
      # inside main, before the entry point can re-emit the envelope fail() just wrote to the scratch
      # file. Wrapping it keeps the status in MAIN_STATUS so main returns normally.
      dispatch cmd_not_implemented
      ;;
  esac
  local end_ms
  end_ms="$(date +%s%3N 2>/dev/null || date +%s000)"
  ELAPSED_MS=$((end_ms - start_ms))
  if [ "$MAIN_STATUS" -ne 0 ]; then
    # A verb failed: its envelope is already in the scratch file, written by fail(). Returning here
    # without emitting the success envelope is what lets the entry point report the failure.
    return "$MAIN_STATUS"
  fi
  emit_envelope "$CURRENT_VERB" "$RESULT" "" "$ELAPSED_MS"
  return 0
}

CURRENT_VERB=""
ELAPSED_MS=0
MAIN_STATUS=0

# Entry point.
#
# fail() stashes the failure envelope in a scratch file because the verb bodies run inside $(...)
# command substitutions that would swallow anything written to stdout. The file is read back here and
# re-emitted on the real stdout, so a caller always receives exactly one parseable envelope whether
# the invocation succeeded or failed.
#
# The scratch path is written by fail() itself from $ROOT_DIR, so the entry point only has to read the
# same stable location back. Deriving the path in both places is what makes this robust: the earlier
# attempt passed the path through a shell variable, which was empty by the time the check ran.
DSH_ERR_FILE="$ROOT_DIR/.temporary/dsh-os.err"
mkdir -p "$ROOT_DIR/.temporary" 2>/dev/null || true
: >"$DSH_ERR_FILE" 2>/dev/null || true

set +e
main "$@"
STATUS=$?
set -e

if [ "$STATUS" -ne 0 ]; then
  if [ -s "$DSH_ERR_FILE" ]; then
    cat "$DSH_ERR_FILE"
    # The exit status is taken from the ENVELOPE's error code, not from the status the process happened
    # to end with.
    #
    # This matters because fail() is reachable from inside a command substitution, and an `exit` there
    # ends only the subshell: the caller carries on, usually hits a second unrelated failure, and that
    # second status is what the process would otherwise report. A bad --scope produced an
    # E_NOT_SUPPORTED envelope (class 4) with exit 5, so the two halves of the same reply disagreed
    # about the failure class. The envelope is the documented authority, so it decides.
    envelope_code="$(sed -n 's/.*"error":{"code":"\([A-Z_]*\)".*/\1/p' "$DSH_ERR_FILE" | head -1)"
    if [ -n "$envelope_code" ]; then
      STATUS="$(exit_code_for "$envelope_code")"
    fi
  else
    # A failure that produced no envelope would leave the caller with nothing to parse, so one is
    # synthesised rather than returning a bare non-zero exit.
    printf '{"ok":false,"verb":%s,"error":{"code":"E_INTERNAL","message":"the command failed without producing an envelope"},"meta":{"platform":%s,"shell":"sh"}}\n' \
      "$(jstr "${CURRENT_VERB:-}")" "$(jstr "$(platform_name)")"
  fi
fi
rm -f "$DSH_ERR_FILE" 2>/dev/null || true
exit "$STATUS"
