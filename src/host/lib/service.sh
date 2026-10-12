# Module: service.sh - service.* (systemd, launchd, SysV init).
#
# Intentionally empty. Service management is per-init-system on POSIX (systemctl, launchctl, service),
# and start/stop/restart need privilege. The verb table already declares these verbs and dispatch
# reports E_NOT_SUPPORTED for them until an implementation lands.
