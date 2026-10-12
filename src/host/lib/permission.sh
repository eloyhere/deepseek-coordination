
# ---------------------------------------------------------------------------
# permission.* - read-only views of the authorization file, the two verbs that
# must be refused at the verb layer, and idempotent layer-A setup.
# ---------------------------------------------------------------------------
permission_file() { printf '%s' "$ROOT_DIR/permission.json"; }

# Layer A on POSIX means this process cannot write the authorization file. There is no portable
# equivalent of a Windows deny ACE, so the check is the file mode: if the file is not writable by us,
# something outside this process is preventing a rewrite.
#
# Measured, never assumed. A Windows version of this once reported a stored flag instead, which could
# claim protection the kernel was not applying.
acl_enforced() {
  local file; file="$(permission_file)"
  if [ ! -f "$file" ]; then printf 'false'; return; fi
  if [ -w "$file" ]; then printf 'false'; else printf 'true'; fi
}

acl_reason() {
  local file; file="$(permission_file)"
  if [ ! -f "$file" ]; then
    printf '%s' "$(jstr 'permission.json does not exist')"
  elif [ -w "$file" ]; then
    printf '%s' "$(jstr 'the authorization file is writable by this process, so no kernel-level protection is in effect; run: dsh-os.sh permission acl init')"
  else
    printf '%s' "$(jstr 'the authorization file is not writable by this process')"
  fi
}

# What is knowable from the bytes without a JSON parser: whether the file has content, and whether the
# documented writer field is present. Reporting that honestly beats reporting a rule count that might
# be wrong.
permission_trust_state() {
  local file; file="$(permission_file)"
  if [ ! -f "$file" ]; then printf 'missing'; return; fi
  local size; size="$(wc -c <"$file" | tr -d ' ')"
  if [ "$size" -eq 0 ]; then printf 'empty'; return; fi
  if grep -q '"updatedBy"[[:space:]]*:[[:space:]]*"consent-delegate"' "$file" 2>/dev/null; then
    printf 'trusted'
  else
    printf 'untrusted'
  fi
}

# trusted is false when the writer field is absent or says something else, because the delegate is
# supposed to be the only writer: honouring rules somebody else wrote would defeat the arrangement.
permission_trusted_json() {
  case "$(permission_trust_state)" in
    untrusted) printf 'false' ;;
    *) printf 'true' ;;
  esac
}

cmd_permission_list() {
  local file; file="$(permission_file)"
  local enforced; enforced="$(acl_enforced)"
  if [ ! -f "$file" ]; then
    printf '{"path":%s,"exists":false,"empty":false,"trusted":true,"count":0,"rules":[],"aclEnforced":%s,"aclReason":%s}' \
      "$(jstr "$file")" "$enforced" "$(acl_reason)"
    return
  fi
  local size; size="$(wc -c <"$file" | tr -d ' ')"
  if [ "$size" -eq 0 ]; then
    printf '{"path":%s,"exists":true,"empty":true,"trusted":true,"count":0,"rules":[],"aclEnforced":%s,"aclReason":%s}' \
      "$(jstr "$file")" "$enforced" "$(acl_reason)"
  else
    printf '{"path":%s,"exists":true,"empty":false,"trusted":%s,"fileState":%s,"count":null,"rules":null,"aclEnforced":%s,"aclReason":%s,"note":"rule parsing requires the harness plugin; the consent delegate owns writes"}' \
      "$(jstr "$file")" "$(permission_trusted_json)" "$(jstr "$(permission_trust_state)")" "$enforced" "$(acl_reason)"
  fi
}

cmd_permission_query() {
  require_min 1 'permission query'
  local verb; verb="$(pos 0)"
  local target; target="$(pos 1)"
  local file; file="$(permission_file)"
  # The stored rules cannot be evaluated here without a parser, so the answer states its own basis
  # rather than implying a rule was consulted. An untrusted file always answers from defaults.
  local source="defaults"
  local decision="ask"
  printf '{"verb":%s,"target":%s,"decision":%s,"ruleId":null,"source":%s,"trusted":%s,"rulesEvaluated":false,"fileExists":%s,"aclEnforced":%s,"aclReason":%s,"note":"rule evaluation requires the harness plugin; this answer is from defaults"}' \
    "$(jstr "$verb")" "$(jstr "$target")" "$(jstr "$decision")" "$(jstr "$source")" \
    "$(permission_trusted_json)" \
    "$( [ -f "$file" ] && printf 'true' || printf 'false' )" \
    "$(acl_enforced)" "$(acl_reason)"
}

cmd_permission_audit() {
  local file; file="$(permission_file)"
  if [ ! -f "$file" ]; then
    printf '{"path":%s,"count":0,"entries":[],"trusted":true}' "$(jstr "$file")"
    return
  fi
  # An empty list would be a lie and a parsed list is impossible here, so the count is null and the
  # reason is named.
  printf '{"path":%s,"count":null,"entries":null,"trusted":%s,"note":"audit parsing requires the harness plugin"}' \
    "$(jstr "$file")" "$(permission_trusted_json)"
}

# Both write verbs are delegate-only, and the enforcement is that there is no implementation here at
# all: creating a durable grant needs the user approval dialog, which only the plugin can reach. A
# permission check would be something to argue with; an absent implementation is not.
cmd_permission_grant() {
  require_min 3 'permission grant'
  require_allow 'permission grant' "${#POSITIONALS[@]}"
  fail E_PERMISSION_DELEGATE_ONLY 'permission grant can only be performed by the consent delegate' \
    'this verb needs the user approval dialog, which the delegate plugin owns; a script cannot reach it'
}

cmd_permission_revoke() {
  require_min 1 'permission revoke'
  require_allow 'permission revoke' "${#POSITIONALS[@]}"
  fail E_PERMISSION_DELEGATE_ONLY 'permission revoke can only be performed by the consent delegate' \
    'revoking a durable decision also needs the user approval dialog'
}

# permission acl init - idempotently make the authorization file non-writable.
#
# On POSIX this is a mode change, not an ACL rewrite, and the equivalence is weaker than the Windows
# deny ACE: the same user can chmod it back. That limitation is stated in the result rather than
# glossed over, because the reported strength is supposed to mean something.
cmd_permission_acl_init() {
  require_allow 'permission acl init' "${#POSITIONALS[@]}"
  local file; file="$(permission_file)"
  if [ ! -f "$file" ]; then
    fail E_NOT_FOUND "permission.json does not exist at $file" \
      'create the file first; the repository ships an empty one as the documented initial state'
  fi
  if [ "$(acl_enforced)" = "true" ]; then
    printf '{"path":%s,"changed":false,"enforced":true,"reason":%s}' "$(jstr "$file")" "$(acl_reason)"
    return
  fi
  local mode_before mode_after
  mode_before="$(stat -c '%a' "$file" 2>/dev/null || printf '')"
  if ! chmod a-w "$file" 2>/dev/null; then
    fail E_IO 'the authorization file mode could not be changed (insufficient privilege?)'
  fi
  mode_after="$(stat -c '%a' "$file" 2>/dev/null || printf '')"
  printf '{"path":%s,"changed":true,"enforced":%s,"modeBefore":%s,"modeAfter":%s,"reason":%s,"limitation":"a POSIX mode change is weaker than a Windows deny ACE: the same user can restore write access","restore":"chmod u+w permission.json"}' \
    "$(jstr "$file")" "$(acl_enforced)" "$(jstr "$mode_before")" "$(jstr "$mode_after")" "$(acl_reason)"
}

# ---------------------------------------------------------------------------
# selfcheck
# ---------------------------------------------------------------------------
cmd_selfcheck() {
  local verbs=0
  local file="$HOST_DIR/spec/verbs.tsv"
  if [ -f "$file" ]; then
    verbs="$(awk -F'	' '!/^#/ && NF >= 4 && $1 != "verb" { n++ } END { print n + 0 }' "$file")"
  fi
  # The implemented list is DERIVED from this script's own dispatch table, never written by hand. It
  # used to be a hardcoded string that had already drifted from the truth: it named nine groups while
  # the dispatch table answered thirty-six verbs, so a caller reading selfcheck would have concluded
  # that most of the working surface did not exist.
  local impl="" count=0 v=""
  while IFS= read -r v; do
    [ -z "$v" ] && continue
    [ -n "$impl" ] && impl="$impl,"
    impl="$impl$(jstr "$v")"
    count=$((count + 1))
  done <<EOF
$(sed -n "s/^    '\([a-z0-9.-]*\)') dispatch .*/\1/p" "$SELF_PATH")
EOF
  printf '{"script":"src/host/bin/dsh-os.sh","platform":%s,"locale":%s,"verbCount":%s,"implementedCount":%s,"implemented":[%s],"capabilities":{"inputInjection":%s,"clipboard":%s,"screenshot":%s,"accessibility":%s,"trash":%s},"aclEnforced":%s,"aclReason":%s}' \
    "$(jstr "$(platform_name)")" "$(jstr "${LC_ALL:-C}")" "$verbs" "$count" "$impl" \
    "$(capability_input_injection)" "$(capability_clipboard)" "$(capability_screenshot)" \
    "$(capability_accessibility)" \
    "$(command -v trash-put >/dev/null 2>&1 && echo '"available"' || echo '"unavailable"')" \
    "$(acl_enforced)" "$(acl_reason)"
}

# ---------------------------------------------------------------------------
# Capability reporting.
#
# Each of these is MEASURED, not a constant. They were four hardcoded "unavailable" strings, which was
# accurate for input injection and screen capture on a machine with no display server but would have
# stayed "unavailable" on a fully equipped desktop - a caller reading selfcheck would have concluded a
# working capability did not exist. This is the same failure the implemented list above already had and
# was fixed for, so the same rule applies: report what is measured.
#
# The strings are the tool names the verbs actually use, so a caller can act on the answer, and
# "unavailable" is reported only when nothing usable is present.
# ---------------------------------------------------------------------------
capability_input_injection() {
  if [ -z "${DISPLAY:-}" ]; then printf '"unavailable"'; return 0; fi
  if command -v xdotool >/dev/null 2>&1; then printf '"xdotool"'; return 0; fi
  printf '"unavailable"'
}

capability_clipboard() {
  if command -v xclip >/dev/null 2>&1; then printf '"xclip"'; return 0; fi
  if command -v xsel >/dev/null 2>&1; then printf '"xsel"'; return 0; fi
  # wl-copy needs a Wayland session, not merely the binary.
  if [ -n "${WAYLAND_DISPLAY:-}" ] && command -v wl-copy >/dev/null 2>&1; then printf '"wl-copy"'; return 0; fi
  printf '"unavailable"'
}

capability_screenshot() {
  if [ -z "${DISPLAY:-}" ]; then printf '"unavailable"'; return 0; fi
  if command -v import >/dev/null 2>&1; then printf '"import"'; return 0; fi
  if command -v scrot >/dev/null 2>&1; then printf '"scrot"'; return 0; fi
  printf '"unavailable"'
}

capability_accessibility() {
  # The AT-SPI bus is what an accessibility client talks to on Linux. Its presence in the session bus
  # is the evidence; a missing dbus tool means it cannot be determined, which is reported as such
  # rather than guessed at.
  if command -v dbus-send >/dev/null 2>&1; then
    if dbus-send --session --dest=org.a11y.Bus --print-reply /org/a11y/bus org.freedesktop.DBus.Peer.Ping >/dev/null 2>&1; then
      printf '"at-spi2"'; return 0
    fi
    printf '"unavailable"'; return 0
  fi
  printf '"unknown"'
}