
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
