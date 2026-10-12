
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
