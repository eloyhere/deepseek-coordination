# Module: window.sh - window.* / mouse.* / keyboard.* / clipboard.* / wait.* / observe.
#
# The desktop verbs need synthetic input, which on POSIX means XTest (X11) or compositor protocols
# (Wayland), and screen capture via import/scrot. Those are NOT implemented here, and they are
# deliberately not dispatched: an unimplemented verb falls through dispatch's default arm and gets a
# typed E_NOT_SUPPORTED, which is the required behaviour. An unavailable capability must be an explicit
# error, never an empty success.
#
# wait ms IS implemented, because it needs nothing from the display server: it is a sleep, and the
# contract (bounds, envelope, elapsed measurement) is fully specified by the Windows side. Implementing
# it here also means a portable script that paces itself keeps working when it moves to POSIX.

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
