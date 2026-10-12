#!/usr/bin/env bash
# smoke-desktop-sh.sh - verify what the POSIX desktop verbs actually INJECT, using fake tools.
#
# tests/golden-sh.sh asserts that these verbs report a typed error when there is no display, which is
# all that could be checked on a machine with no X server. This goes further: it puts a recording
# xdotool on PATH and a DISPLAY in the environment, so the capability gate opens and the verbs run their
# real code path. Every assertion is then about the exact argument vector handed to xdotool - which
# button number a name became, which keysym spelling a Windows key name became, whether --clearmodifiers
# and --repeat are present - and about the envelope fields.
#
# This does NOT prove the verbs work against a real X server: nothing here touches X. It proves
# everything up to the injection, which is the part that review cannot see.
#
# Usage: bash tests/smoke-desktop-sh.sh     (exit 0 when every case passes)

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$TESTS_DIR/.." && pwd)"
SH="$ROOT_DIR/src/host/bin/dsh-os.sh"
BOX="$ROOT_DIR/.temporary/smoke-desktop"
FAKEBIN="$BOX/bin"
LOG="$BOX/xdotool.log"
POS="$BOX/cursor.pos"

rm -rf "$BOX"; mkdir -p "$FAKEBIN"
# No position file yet, so the fake starts at its configured position.
cp "$TESTS_DIR/fake-xdotool" "$FAKEBIN/xdotool"
cp "$TESTS_DIR/fake-wmctrl"  "$FAKEBIN/wmctrl"
chmod +x "$FAKEBIN/xdotool" "$FAKEBIN/wmctrl" 2>/dev/null || true

PASS=0; FAIL=0
FAILED_NAMES=""

# dv <description> <expect-exit> <expect-field> <expect-value> -- <args...>
#
# Runs one verb with the fake tools on PATH and a DISPLAY set, then checks the exit class and a field of
# the envelope, read with a dependency-free single-key sed the way golden-sh.sh does.
dv() {
  local desc="$1"; shift
  local want_rc="$1"; shift
  local field="$1"; shift
  local want_val="$1"; shift
  [ "$1" = "--" ] && shift
  : >"$LOG"
  local out rc
  out="$(cd "$ROOT_DIR" && PATH="$FAKEBIN:$PATH" DISPLAY=:99 FAKE_XDOTOOL_LOG="$LOG" FAKE_XDOTOOL_POS="$POS" \
    bash "$SH" "$@" 2>/dev/null)"
  rc=$?
  local ok=1 why=""
  [ -n "$out" ] || { ok=0; why="no envelope"; }
  case "$out" in '{'*) ;; *) ok=0; why="stdout is not an envelope" ;; esac
  if [ "$ok" = "1" ] && [ "$want_rc" != "-" ] && [ "$rc" != "$want_rc" ]; then
    ok=0; why="rc=$rc want=$want_rc"
  fi
  if [ "$ok" = "1" ] && [ -n "$field" ]; then
    # Read with tools/json-field.mjs. sed was wrong twice: it cannot see into nested objects, so
    # result.cursor.x was impossible, and a same-named field in `meta` won - it reported meta's
    # "platform":"windows" where the answer was result.platform "x11". Two failures were blamed on
    # working code because of it. An unparseable envelope yields the empty string, so a broken envelope
    # fails the assertion rather than passing by coincidence.
    local got
    got="$(printf '%s' "$out" | node "$ROOT_DIR/tools/json-field.mjs" "$field" 2>/dev/null)"
    if [ "$got" != "$want_val" ]; then ok=0; why="$field=$got want=$want_val"; fi
  fi
  if [ "$ok" = "1" ]; then
    PASS=$((PASS+1)); printf '  PASS  %-52s rc=%-3s\n' "$desc" "$rc"
  else
    FAIL=$((FAIL+1)); FAILED_NAMES="$FAILED_NAMES
  - $desc ($why)"
    printf '  FAIL  %-52s rc=%-3s %s\n' "$desc" "$rc" "$why"
    printf '        out=%s\n' "$(printf '%s' "$out" | cut -c1-150)"
  fi
}

# dx <description> -- the expected argument vector must appear in the recorded log.
#
# It is searched for rather than taken from the first line, because a verb that positions the cursor
# before acting makes two calls (mousemove, then the action), so "the first line" is only right for the
# verbs that act immediately. An earlier version of this file assumed the first line and reported
# failures for mouse context and mouse down that were not real.
dx() {
  local desc="$1"; shift
  [ "$1" = "--" ] && shift
  local want="$*"
  local got
  got="$(grep -Fx -- "$want" "$LOG" 2>/dev/null | head -1)"
  [ -n "$got" ] || got="$(head -1 "$LOG" 2>/dev/null)"
  if [ "$got" = "$want" ]; then
    PASS=$((PASS+1)); printf '  PASS  %-52s [%s]\n' "$desc" "$got"
  else
    FAIL=$((FAIL+1)); FAILED_NAMES="$FAILED_NAMES
  - $desc (got [$got], want [$want])"
    printf '  FAIL  %-52s\n        got  [%s]\n        want [%s]\n' "$desc" "$got" "$want"
  fi
}

# dlog <description> <expected-line-number> <expected>
dlog() {
  local desc="$1" n="$2" want="$3"
  local got
  got="$(sed -n "${n}p" "$LOG" 2>/dev/null)"
  if [ "$got" = "$want" ]; then
    PASS=$((PASS+1)); printf '  PASS  %-52s [%s]\n' "$desc" "$got"
  else
    FAIL=$((FAIL+1)); FAILED_NAMES="$FAILED_NAMES
  - $desc (line $n got [$got], want [$want])"
    printf '  FAIL  %-52s\n        line %s got  [%s]\n        want [%s]\n' "$desc" "$n" "$got" "$want"
  fi
}

echo "== with a display and a recording xdotool, the verbs inject =="

echo
echo "-- mouse: the tool sees the translated arguments --"
dv "mouse cursor reports the fake position" 0 "result.cursor.x" "100" -- mouse cursor
dx "mouse cursor asks for the location" -- getmouselocation --shell

dv "mouse over moves to 10,20" 0 "result.moved" "true" -- mouse over 10 20 --allow
dx "mouse over uses mousemove --sync" -- mousemove --sync 10 20

dv "mouse click defaults to left (button 1)" 0 "result.button" "1" -- mouse click 10 20 --allow
dlog "mouse click repeats once" 2 "click --repeat 1 1"

dv "mouse click button=right becomes 3" 0 "result.button" "3" -- mouse click 10 20 --button right --allow
dlog "right button reaches the tool as 3" 2 "click --repeat 1 3"

dv "mouse click count=3 repeats three times" 0 "result.count" "3" -- mouse click 10 20 --count 3 --allow
dlog "count reaches the tool as a repeat" 2 "click --repeat 3 1"

dv "mouse click --clearmodifiers is passed through" 0 "result.clearedModifiers" "true" -- mouse click 10 20 --clearmodifiers --allow
dlog "clearmodifiers flag position" 2 "click --clearmodifiers --repeat 1 1"

dv "mouse context uses button 3" 0 "result.button" "3" -- mouse context 10 20 --allow
dx "mouse context is a plain right click" -- click 3

dv "mouse wheel positive scrolls up (button 4)" 0 "result.direction" "up" -- mouse wheel 120 20 --allow
dlog "wheel up uses button 4" 2 "click --repeat 1 4"

dv "mouse wheel negative scrolls down (button 5)" 0 "result.direction" "down" -- mouse wheel -120 20 --allow
dlog "wheel down uses button 5" 2 "click --repeat 1 5"

dv "mouse wheel 120 is one notch" 0 "result.notches" "1" -- mouse wheel 120 20 --allow
dv "mouse wheel explicit --space wins" 0 "result.notches" "3" -- mouse wheel 10 20 --space 3 --allow
dlog "explicit space reaches the tool" 2 "click --repeat 3 4"

dv "mouse down holds the button" 0 "result.held" "true" -- mouse down 10 20 --allow
dx "mouse down is a mousedown" -- mousedown 1
dv "mouse up releases it" 0 "result.held" "false" -- mouse up --allow
dx "mouse up is a mouseup" -- mouseup 1

echo
echo "-- keyboard: Windows key names become X keysyms --"
dv "keyboard codes reports names" 0 "result.platform" "x11" -- keyboard codes
dv "keyboard down Return" 0 "result.held" "true" -- keyboard down Return --allow
dx "Return is passed as a keysym" -- keydown Return
dv "keyboard up Return" 0 "result.held" "false" -- keyboard up Return --allow
dx "keyup receives the keysym" -- keyup Return

dv "Enter is translated to Return" 0 "result.code" "Return" -- keyboard down Enter --allow
dx "Enter became Return" -- keydown Return
dv "Esc is translated to Escape" 0 "result.code" "Escape" -- keyboard down Esc --allow
dx "Esc became Escape" -- keydown Escape
dv "Backspace is translated to BackSpace" 0 "result.code" "BackSpace" -- keyboard down Backspace --allow
dx "Backspace became BackSpace" -- keydown BackSpace
dv "PgUp is translated to Prior" 0 "result.code" "Prior" -- keyboard down PgUp --allow
dx "PgUp became Prior" -- keydown Prior
dv "PgDn is translated to Next" 0 "result.code" "Next" -- keyboard down PgDn --allow
dx "PgDn became Next" -- keydown Next
dv "an unknown name is passed through unchanged" 0 "result.code" "XF86AudioMute" -- keyboard down XF86AudioMute --allow
dx "a keysym outside the table is not mangled" -- keydown XF86AudioMute

dv "keyboard press releases what it pressed" 0 "result.released" "true" -- keyboard press F5 --allow
dx "press is one xdotool key call" -- key F5

dv "keyboard combination press sends a chord" 0 "result.chord" "ctrl+c" -- keyboard combination press ctrl c --allow
dx "the chord is joined for the tool" -- key ctrl+c

dv "keyboard type sends the text" 0 "result.text" "hello world" -- keyboard type "hello world" --allow
dx "type passes clearmodifiers and a delay" -- type --clearmodifiers --delay 12 -- hello world

echo
echo "-- an xdotool failure must be E_IO, not a false success --"
: >"$LOG"
out="$(cd "$ROOT_DIR" && PATH="$FAKEBIN:$PATH" DISPLAY=:99 FAKE_XDOTOOL_LOG="$LOG" FAKE_XDOTOOL_POS="$POS" FAKE_XDOTOOL_FAIL=1 \
  bash "$SH" mouse click 10 20 --allow 2>/dev/null)"
rc=$?
if [ "$rc" = "5" ] && printf '%s' "$out" | grep -q '"code":"E_IO"'; then
  PASS=$((PASS+1)); printf '  PASS  %-52s rc=%s E_IO\n' "a failed injection reports E_IO" "$rc"
else
  FAIL=$((FAIL+1)); FAILED_NAMES="$FAILED_NAMES
  - a failed injection reports E_IO (rc=$rc, out=$(printf '%s' "$out" | cut -c1-120))"
  printf '  FAIL  %-52s rc=%s\n' "a failed injection reports E_IO" "$rc"
fi

echo
echo "-- argument validation happens before anything is injected --"
for bad in "mouse over abc 20 --allow:x" "mouse click 10 20 --count abc --allow:y" "keyboard press 13 --allow:z"; do
  args="${bad%:*}"; tag="${bad##*:}"
  : >"$LOG"
  out="$(cd "$ROOT_DIR" && PATH="$FAKEBIN:$PATH" DISPLAY=:99 FAKE_XDOTOOL_LOG="$LOG" FAKE_XDOTOOL_POS="$POS" \
    bash "$SH" $args 2>/dev/null)"
  rc=$?
  # Nothing may have been injected, and the envelope must carry a typed code.
  logged="$(wc -l <"$LOG" | tr -d ' ')"
  if [ "$logged" = "0" ] && printf '%s' "$out" | grep -q '"code":"E_'; then
    PASS=$((PASS+1)); printf '  PASS  %-52s rejected, nothing injected\n' "$args"
  else
    FAIL=$((FAIL+1)); FAILED_NAMES="$FAILED_NAMES
  - $args must be rejected without injecting (logged=$logged rc=$rc)"
    printf '  FAIL  %-52s logged=%s rc=%s\n' "$args" "$logged" "$rc"
  fi
done

rm -rf "$BOX"
echo
printf 'passed=%s failed=%s\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then printf 'failures:%s\n' "$FAILED_NAMES"; exit 1; fi
exit 0
