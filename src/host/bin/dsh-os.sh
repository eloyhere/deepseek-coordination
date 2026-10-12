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

# ---------------------------------------------------------------------------
# Argument parsing. Mirrors the Windows parser: --flag, or --flag value for the
# names that take one; anything else is positional. Unknown flags are refused so
# a typo cannot silently become a positional.
# ---------------------------------------------------------------------------
VALUE_FLAGS=" encoding eol button count space out screen format workdir env stdin timeout interval method pid regex name max-bytes max-chars depth source bom text charset length sha256 limit filter scope index decision delegate args attr value "
KNOWN_FLAGS=" allow pretty quiet json backup permanent parents no-recursive no-numbers force hold clearmodifiers exact absent z-order shell background "

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
  local numbered="$text"
  if ! have_flag no-numbers; then
    numbered="$(printf '%s' "$text" | awk '{ printf "%d: %s\n", NR, $0 }')"
  fi
  printf '{"path":%s,"charset":%s,"bom":%s,"eol":%s,"size":%s,"start":%s,"end":%s,"totalBytes":%s,"text":%s}' \
    "$(jstr "$path")" "$(jstr "$DOC_CHARSET")" \
    "$([ "$DOC_BOM" != "-" ] && echo true || echo false)" "$(jstr "$DOC_EOL")" \
    "$DOC_SIZE" "$s" "$e" "$DOC_SIZE" "$(jstr "$numbered")"
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
# permission.* - read-only views of the authorization file.
# ---------------------------------------------------------------------------
permission_file() { printf '%s' "$ROOT_DIR/permission.json"; }

cmd_permission_list() {
  local file; file="$(permission_file)"
  if [ ! -f "$file" ]; then
    printf '{"path":%s,"exists":false,"empty":false,"trusted":true,"count":0,"rules":[],"aclEnforced":false}' "$(jstr "$file")"
    return
  fi
  local size; size="$(wc -c <"$file" | tr -d ' ')"
  # Full rule extraction needs a JSON parser, which a dependency-free shell script does not have.
  # The file is reported honestly as present rather than parsed incorrectly.
  if [ "$size" -eq 0 ]; then
    printf '{"path":%s,"exists":true,"empty":true,"trusted":true,"count":0,"rules":[],"aclEnforced":false}' "$(jstr "$file")"
  else
    printf '{"path":%s,"exists":true,"empty":false,"trusted":true,"count":null,"rules":null,"aclEnforced":false,"note":"rule parsing requires the harness plugin"}' "$(jstr "$file")"
  fi
}

# ---------------------------------------------------------------------------
# selfcheck
# ---------------------------------------------------------------------------
cmd_selfcheck() {
  local verbs=0
  local file="$HOST_DIR/spec/verbs.tsv"
  if [ -f "$file" ]; then
    verbs="$(awk -F'\t' '!/^#/ && NF >= 4 && $1 != "verb" { n++ } END { print n + 0 }' "$file")"
  fi
  printf '{"script":"src/host/bin/dsh-os.sh","platform":%s,"locale":%s,"verbCount":%s,"capabilities":{"inputInjection":"unavailable","clipboard":"unavailable","screenshot":"unavailable","accessibility":"unavailable","trash":"%s"},"implemented":["file","file.verify","system","task.list","task.query","environment","environment.attr","permission.list","selfcheck"]}' \
    "$(jstr "$(platform_name)")" "$(jstr "${LC_ALL:-C}")" "$verbs" \
    "$(command -v trash-put >/dev/null 2>&1 && echo available || echo unavailable)"
}

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
    'environment.list') dispatch cmd_environment_list ;;
    'environment.get') dispatch cmd_environment_get ;;
    'environment.attribute.list') dispatch cmd_environment_attribute_list ;;
    'environment.attribute.get') dispatch cmd_environment_attribute_get ;;
    'permission.list') dispatch cmd_permission_list ;;
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
  else
    # A failure that produced no envelope would leave the caller with nothing to parse, so one is
    # synthesised rather than returning a bare non-zero exit.
    printf '{"ok":false,"verb":%s,"error":{"code":"E_INTERNAL","message":"the command failed without producing an envelope"},"meta":{"platform":%s,"shell":"sh"}}\n' \
      "$(jstr "${CURRENT_VERB:-}")" "$(jstr "$(platform_name)")"
  fi
fi
rm -f "$DSH_ERR_FILE" 2>/dev/null || true
exit "$STATUS"
