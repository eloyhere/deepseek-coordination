# Module: 13-window.sh - window.* / mouse.* / keyboard.* / clipboard.* / wait.* / observe.
#
# Intentionally empty. These need synthetic input, which on POSIX means XTest (X11) or compositor
# protocols (Wayland), and screen capture via import/scrot. The verbs are already declared in
# spec/verbs.tsv and dispatch reports a typed E_NOT_SUPPORTED for them, which is the required
# behaviour: an unavailable capability must be an explicit error, never an empty success.
