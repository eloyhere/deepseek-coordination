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
window_int_arg() {
  local value="$1" label="$2"
  local digits="$value"
  # A leading '-' is part of a valid coordinate, so it is stripped before the digit test; anything that
  # is then not all digits is a type error. This is the same order the Windows side uses, which is why
  # '-5' is a range or type question rather than "not an integer".
  case "$digits" in -*) digits="${digits#-}" ;; esac
  case "$digits" in ''|*[!0-9]*) fail E_TYPE "<$label> must be an integer, got '$value'" ;; esac
  printf '%s' "$value"
}

# ---------------------------------------------------------------------------
# mouse.*
#
# Button numbering is X11's, and it is NOT the same as the Windows side's names: 1 is left, 2 is middle,
# 3 is right, 4 and 5 are the vertical wheel. The --button flag accepts a name or a number so a caller
# writing portable code can keep using names.
# ---------------------------------------------------------------------------
window_button_number() {
  local b="$1"
  case "$b" in
    ''|left|1) printf '1' ;;
    middle|2) printf '2' ;;
    right|3) printf '3' ;;
    wheel-up|4) printf '4' ;;
    wheel-down|5) printf '5' ;;
    [0-9]*) printf '%s' "$b" ;;
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
  x="$(window_int_arg "$(pos 0)" x)"
  y="$(window_int_arg "$(pos 1)" y)"
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
  x="$(window_int_arg "$(pos 0)" x)"
  y="$(window_int_arg "$(pos 1)" y)"
  button="$(window_button_number "$(flag_value button 'left')")"
  count="$(flag_value count '1')"
  case "$count" in ''|*[!0-9]*) fail E_TYPE "<count> must be an integer, got '$count'" ;; esac
  [ "$count" -ge 1 ] || fail E_RANGE "<count> must be at least 1, got '$count'"
  cm="$(window_clearmod_flag)"

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
  x="$(window_int_arg "$(pos 0)" x)"
  y="$(window_int_arg "$(pos 1)" y)"
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
  x="$(window_int_arg "$(pos 0)" x)"
  y="$(window_int_arg "$(pos 1)" y)"

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
  x="$(window_int_arg "$(pos 0)" x)"
  y="$(window_int_arg "$(pos 1)" y)"
  button="$(window_button_number "$(flag_value button 'left')")"
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
  button="$(window_button_number "$(flag_value button 'left')")"
  xdotool mouseup "$button" >/dev/null 2>&1 || fail E_IO "xdotool could not release button $button"
  printf '{"button":%s,"held":false,"tool":"xdotool"}' "$button"
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
