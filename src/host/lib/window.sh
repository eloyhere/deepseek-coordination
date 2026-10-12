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
