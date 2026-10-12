
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
