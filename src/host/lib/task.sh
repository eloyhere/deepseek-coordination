
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
