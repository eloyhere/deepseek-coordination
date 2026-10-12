
main() {
  local start_ms
  start_ms="$(date +%s%3N 2>/dev/null || date +%s000)"
  # parse_args populates globals (POSITIONALS, FLAGS, NAMED), so it cannot run in a subshell. It
  # therefore RETURNS its error instead of calling fail(), and the failure is reported here where the
  # entry point can still re-emit the envelope. Calling fail() inside it exited before any output
  # could be produced, which is why a bad flag used to return a bare exit code.
  parse_args "$@"
  local parse_status=$?
  if [ "$parse_status" -ne 0 ]; then
    # Routed through dispatch, not called directly. fail() ends with `exit`, and an exit raised in the
    # main shell terminates the script before the entry point can re-emit the envelope it just wrote.
    # Inside dispatch's command substitution that exit only ends the substitution, so the status
    # returns to main and the entry point gets to run. Every failing path must go through here.
    dispatch cmd_arg_error
    return "$MAIN_STATUS"
  fi
  # resolve_verb must also run in the CURRENT shell, for the same reason: it reassigns POSITIONALS.
  resolve_verb
  local verb_status=$?
  if [ "$verb_status" -ne 0 ]; then
    if [ "$verb_status" -eq 2 ]; then
      fail E_USAGE 'no verb given' 'run: dsh-os.sh selfcheck   (lists the full verb table)'
    fi
    # Reporting through fail() is what writes the envelope; setting the status alone would leave the
    # caller with a non-zero exit and nothing to parse.
    local reported="${UNKNOWN_VERB:-}"
    if [ -z "$reported" ]; then reported="${POSITIONALS[0]:-}"; fi
    fail E_NOT_SUPPORTED "verb '$reported' is not implemented in this build" \
      'run: dsh-os.sh selfcheck   (implemented verbs are listed in its "implemented" field)'
  fi
  # Normalise the two calling forms before dispatch, so no verb body has to care which was used.
  merge_named_args "$CURRENT_VERB"
  local merge_status=$?
  if [ "$merge_status" -ne 0 ]; then
    dispatch cmd_arg_error
    return "$MAIN_STATUS"
  fi

  # Each verb body is invoked through this wrapper rather than directly.
  #
  # `result="$(cmd_x)"` would be fatal under `set -e` the moment cmd_x exits non-zero, aborting main
  # BEFORE the envelope is emitted. Catching the status here keeps main in control.
  #
  # dispatch and RESULT are top-level (defined above main) so the argument-error path can reach them
  # too. An `exit` raised while the verb body runs in dispatch's command substitution is contained
  # there; the status travels back via MAIN_STATUS and the entry point performs the single exit.
  case "$CURRENT_VERB" in
    'selfcheck') dispatch cmd_selfcheck ;;
    'file.create') dispatch cmd_file_create ;;
    'file.charset') dispatch cmd_file_charset ;;
    'file.information') dispatch cmd_file_information ;;
    'file.length') dispatch cmd_file_length ;;
    'file.list') dispatch cmd_file_list ;;
    'file.delete') dispatch cmd_file_delete ;;
    'file.move') dispatch cmd_file_move ;;
    'file.copy') dispatch cmd_file_copy ;;
    'file.mkdir') dispatch cmd_file_mkdir ;;
    'file.append') dispatch cmd_file_append ;;
    'file.insert') dispatch cmd_file_insert ;;
    'file.view') dispatch cmd_file_view ;;
    'file.search') dispatch cmd_file_search ;;
    'file.verify.charset') dispatch cmd_file_verify_charset ;;
    'file.verify.encoding') dispatch cmd_file_verify_encoding ;;
    'file.verify.completion') dispatch cmd_file_verify_completion ;;
    'system.brand') dispatch cmd_system_brand ;;
    'system.cpu') dispatch cmd_system_cpu ;;
    'system.gpu') dispatch cmd_system_gpu ;;
    'system.version') dispatch cmd_system_version ;;
    'system.info') dispatch cmd_system_info ;;
    'task.list') dispatch cmd_task_list ;;
    'task.query') dispatch cmd_task_query ;;
    'task.show') dispatch cmd_task_show ;;
    'task.kill') dispatch cmd_task_kill ;;
    'execute.query') dispatch cmd_execute_query ;;
    'execute.kill') dispatch cmd_execute_kill ;;
    'environment.list') dispatch cmd_environment_list ;;
    'environment.get') dispatch cmd_environment_get ;;
    'environment.add') dispatch cmd_environment_add ;;
    'environment.set') dispatch cmd_environment_set ;;
    'environment.delete') dispatch cmd_environment_delete ;;
    'environment.attribute.list') dispatch cmd_environment_attribute_list ;;
    'environment.attribute.get') dispatch cmd_environment_attribute_get ;;
    'environment.attribute.add') dispatch cmd_environment_attribute_add ;;
    'environment.attribute.set') dispatch cmd_environment_attribute_set ;;
    'environment.attribute.delete') dispatch cmd_environment_attribute_delete ;;
    # wait ms is the one verb of the desktop group that needs nothing from a display server, so it is
    # implemented here. The other window/mouse/keyboard/clipboard/observe verbs are deliberately absent
    # from this table and fall through to the default arm, which reports a typed E_NOT_SUPPORTED.
    'wait.ms') dispatch cmd_wait_ms ;;
    # mouse.* drives X11 through xdotool. Each verb checks for a display and for the tool before it
    # injects anything, so on a machine without either it reports E_NO_DISPLAY or E_NOT_SUPPORTED rather
    # than appearing to act.
    'mouse.click') dispatch cmd_mouse_click ;;
    'mouse.context') dispatch cmd_mouse_context ;;
    'mouse.over') dispatch cmd_mouse_over ;;
    'mouse.wheel') dispatch cmd_mouse_wheel ;;
    'mouse.down') dispatch cmd_mouse_down ;;
    'mouse.up') dispatch cmd_mouse_up ;;
    'mouse.cursor') dispatch cmd_mouse_cursor ;;
    # keyboard.* drives X11 through xdotool, with the same capability gate as mouse.*. Key names are
    # translated from the Windows spelling to the X keysym spelling before injection, because 'Return'
    # and 'Enter' are the same key and a script must not work on one machine and silently do nothing on
    # another.
    'keyboard.down') dispatch cmd_keyboard_down ;;
    'keyboard.up') dispatch cmd_keyboard_up ;;
    'keyboard.press') dispatch cmd_keyboard_press ;;
    'keyboard.combination') dispatch cmd_keyboard_combination ;;
    'keyboard.type') dispatch cmd_keyboard_type ;;
    'keyboard.codes') dispatch cmd_keyboard_codes ;;
    'permission.list') dispatch cmd_permission_list ;;
    'permission.query') dispatch cmd_permission_query ;;
    'permission.audit') dispatch cmd_permission_audit ;;
    'permission.grant') dispatch cmd_permission_grant ;;
    'permission.revoke') dispatch cmd_permission_revoke ;;
    'permission.acl.init') dispatch cmd_permission_acl_init ;;
    'execute.command') dispatch cmd_execute_command ;;
    'execute.synchronous') dispatch cmd_execute_synchronous ;;
    'execute.asynchronous') dispatch cmd_execute_asynchronous ;;
    *)
      # Routed through dispatch like every other verb: calling fail() directly here would exit from
      # inside main, before the entry point can re-emit the envelope fail() just wrote to the scratch
      # file. Wrapping it keeps the status in MAIN_STATUS so main returns normally.
      dispatch cmd_not_implemented
      ;;
  esac
  local end_ms
  end_ms="$(date +%s%3N 2>/dev/null || date +%s000)"
  ELAPSED_MS=$((end_ms - start_ms))
  if [ "$MAIN_STATUS" -ne 0 ]; then
    # A verb failed: its envelope is already in the scratch file, written by fail(). Returning here
    # without emitting the success envelope is what lets the entry point report the failure.
    return "$MAIN_STATUS"
  fi
  emit_envelope "$CURRENT_VERB" "$RESULT" "" "$ELAPSED_MS"
  return 0
}

CURRENT_VERB=""
ELAPSED_MS=0
MAIN_STATUS=0

# Entry point.
#
# fail() stashes the failure envelope in a scratch file because the verb bodies run inside $(...)
# command substitutions that would swallow anything written to stdout. The file is read back here and
# re-emitted on the real stdout, so a caller always receives exactly one parseable envelope whether
# the invocation succeeded or failed.
#
# The scratch path is written by fail() itself from $ROOT_DIR, so the entry point only has to read the
# same stable location back. Deriving the path in both places is what makes this robust: the earlier
# attempt passed the path through a shell variable, which was empty by the time the check ran.
DSH_ERR_FILE="$ROOT_DIR/.temporary/dsh-os.err"
mkdir -p "$ROOT_DIR/.temporary" 2>/dev/null || true
: >"$DSH_ERR_FILE" 2>/dev/null || true

set +e
main "$@"
STATUS=$?
set -e

if [ "$STATUS" -ne 0 ]; then
  if [ -s "$DSH_ERR_FILE" ]; then
    cat "$DSH_ERR_FILE"
    # The exit status is taken from the ENVELOPE's error code, not from the status the process happened
    # to end with.
    #
    # This matters because fail() is reachable from inside a command substitution, and an `exit` there
    # ends only the subshell: the caller carries on, usually hits a second unrelated failure, and that
    # second status is what the process would otherwise report. A bad --scope produced an
    # E_NOT_SUPPORTED envelope (class 4) with exit 5, so the two halves of the same reply disagreed
    # about the failure class. The envelope is the documented authority, so it decides.
    envelope_code="$(sed -n 's/.*"error":{"code":"\([A-Z_]*\)".*/\1/p' "$DSH_ERR_FILE" | head -1)"
    if [ -n "$envelope_code" ]; then
      STATUS="$(exit_code_for "$envelope_code")"
    fi
  else
    # A failure that produced no envelope would leave the caller with nothing to parse, so one is
    # synthesised rather than returning a bare non-zero exit.
    printf '{"ok":false,"verb":%s,"error":{"code":"E_INTERNAL","message":"the command failed without producing an envelope"},"meta":{"platform":%s,"shell":"sh"}}\n' \
      "$(jstr "${CURRENT_VERB:-}")" "$(jstr "$(platform_name)")"
  fi
fi
rm -f "$DSH_ERR_FILE" 2>/dev/null || true
exit "$STATUS"
