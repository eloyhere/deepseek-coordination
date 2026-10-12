
is_protected() {
  local candidate
  candidate="$(normalize_path "$1")"
  local rel
  for rel in "${PROTECTED_RELATIVE[@]}"; do
    local prot
    prot="$(normalize_path "$ROOT_DIR/$rel")"
    if [ "$candidate" = "$prot" ]; then return 0; fi
    # A temporary staged beside a protected path is protected too.
    if [ "${candidate%/*}" = "${prot%/*}" ]; then
      case "${candidate##*/}" in
        "${prot##*/}".*) return 0 ;;
      esac
    fi
  done
  return 1
}

assert_not_protected() {
  # assert_not_protected <path> <verb>
  if is_protected "$1"; then
    fail E_PERMISSION_PROTECTED_PATH \
      "$2 may not modify '$1': it is part of the authorization layer" \
      'authorization changes go through the consent delegate, which requires a user-accepted dialog; see docs/permission-model.md'
  fi
}
