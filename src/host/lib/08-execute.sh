# Module: 08-execute.sh - execute.command / execute.synchronous / execute.asynchronous.
#
# Intentionally empty. execute.command is deliberately NOT implemented in shell: the POSIX variant
# must not go through a shell string, and the array form needs job control with asynchronous stream
# reads to avoid a deadlock when one pipe fills. Until that is implemented the dispatch table reports
# a typed E_NOT_SUPPORTED, so a caller never mistakes an unimplemented verb for a successful one.
