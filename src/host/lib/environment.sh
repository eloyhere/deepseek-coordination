
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
