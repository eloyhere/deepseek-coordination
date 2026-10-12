# Module: native.sh - platform-native primitives.
#
# Intentionally empty. The PowerShell module declares Add-Type P/Invoke bindings (SendInput, BitBlt,
# GDI, clipboard) because those are the only way to reach them on Windows. On POSIX the equivalents
# are external programs (xdotool, wl-copy, import) rather than a linked library, so there is nothing
# to declare here; the verbs that would use them return a typed E_NOT_SUPPORTED until implemented,
# which is the required behaviour rather than a silent no-op.
