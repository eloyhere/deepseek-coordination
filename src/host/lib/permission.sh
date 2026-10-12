
# ---------------------------------------------------------------------------
# permission.* - read-only views of the authorization file.
# ---------------------------------------------------------------------------
permission_file() { printf '%s' "$ROOT_DIR/permission.json"; }

cmd_permission_list() {
  local file; file="$(permission_file)"
  if [ ! -f "$file" ]; then
    printf '{"path":%s,"exists":false,"empty":false,"trusted":true,"count":0,"rules":[],"aclEnforced":false}' "$(jstr "$file")"
    return
  fi
  local size; size="$(wc -c <"$file" | tr -d ' ')"
  # Full rule extraction needs a JSON parser, which a dependency-free shell script does not have.
  # The file is reported honestly as present rather than parsed incorrectly.
  if [ "$size" -eq 0 ]; then
    printf '{"path":%s,"exists":true,"empty":true,"trusted":true,"count":0,"rules":[],"aclEnforced":false}' "$(jstr "$file")"
  else
    printf '{"path":%s,"exists":true,"empty":false,"trusted":true,"count":null,"rules":null,"aclEnforced":false,"note":"rule parsing requires the harness plugin"}' "$(jstr "$file")"
  fi
}

# ---------------------------------------------------------------------------
# selfcheck
# ---------------------------------------------------------------------------
cmd_selfcheck() {
  local verbs=0
  local file="$HOST_DIR/spec/verbs.tsv"
  if [ -f "$file" ]; then
    verbs="$(awk -F'\t' '!/^#/ && NF >= 4 && $1 != "verb" { n++ } END { print n + 0 }' "$file")"
  fi
  printf '{"script":"src/host/bin/dsh-os.sh","platform":%s,"locale":%s,"verbCount":%s,"capabilities":{"inputInjection":"unavailable","clipboard":"unavailable","screenshot":"unavailable","accessibility":"unavailable","trash":"%s"},"implemented":["file","file.verify","system","task.list","task.query","environment","environment.attr","permission.list","selfcheck"]}' \
    "$(jstr "$(platform_name)")" "$(jstr "${LC_ALL:-C}")" "$verbs" \
    "$(command -v trash-put >/dev/null 2>&1 && echo available || echo unavailable)"
}
