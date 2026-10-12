
# ---------------------------------------------------------------------------
# system.* - pure queries, each field degrading on its own.
# ---------------------------------------------------------------------------
cmd_system_brand() {
  local platform vendor product
  platform="$(platform_name)"
  vendor=""; product=""
  if [ -r /sys/devices/virtual/dmi/id/sys_vendor ]; then
    vendor="$(cat /sys/devices/virtual/dmi/id/sys_vendor 2>/dev/null || true)"
  fi
  if [ -r /sys/devices/virtual/dmi/id/product_name ]; then
    product="$(cat /sys/devices/virtual/dmi/id/product_name 2>/dev/null || true)"
  fi
  if [ "$platform" = "darwin" ]; then
    product="$(sysctl -n hw.model 2>/dev/null || true)"
    vendor="Apple"
  fi
  printf '{"platform":%s,"vendor":%s,"product":%s,"family":%s}' \
    "$(jstr "$platform")" "$(jstr "$vendor")" "$(jstr "$product")" "$(jstr "$platform")"
}

cmd_system_cpu() {
  local name="" cores="" model=""
  if [ -r /proc/cpuinfo ]; then
    model="$(awk -F: '/^model name/ { gsub(/^ +/, "", $2); print $2; exit }' /proc/cpuinfo)"
    cores="$(grep -c '^processor' /proc/cpuinfo 2>/dev/null || echo '')"
  fi
  if [ "$(platform_name)" = "darwin" ]; then
    model="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || true)"
    cores="$(sysctl -n hw.logicalcpu 2>/dev/null || true)"
  fi
  name="$model"
  printf '{"count":1,"processors":[{"name":%s,"cores":%s,"threads":%s}]}' \
    "$(jstr "$name")" "${cores:-null}" "${cores:-null}"
}

cmd_system_gpu() {
  # A machine with no usable driver legitimately reports an empty list.
  printf '{"count":0,"adapters":[]}'
}

cmd_system_version() {
  local caption="" version="" kernel="" arch
  arch="$(uname -m 2>/dev/null || echo unknown)"
  kernel="$(uname -r 2>/dev/null || echo unknown)"
  if [ -r /etc/os-release ]; then
    caption="$(awk -F= '/^PRETTY_NAME=/ { gsub(/"/, "", $2); print $2; exit }' /etc/os-release)"
    version="$(awk -F= '/^VERSION_ID=/ { gsub(/"/, "", $2); print $2; exit }' /etc/os-release)"
  fi
  if [ "$(platform_name)" = "darwin" ]; then
    caption="macOS $(sw_vers -productVersion 2>/dev/null || true)"
    version="$(sw_vers -buildVersion 2>/dev/null || true)"
  fi
  local uid_is_root=false
  [ "$(id -u 2>/dev/null || echo 0)" = "0" ] && uid_is_root=true
  printf '{"platform":%s,"caption":%s,"version":%s,"kernel":%s,"architecture":%s,"isElevated":%s,"user":%s}' \
    "$(jstr "$(platform_name)")" "$(jstr "$caption")" "$(jstr "$version")" "$(jstr "$kernel")" \
    "$(jstr "$arch")" "$uid_is_root" "$(jstr "$(id -un 2>/dev/null || echo unknown)")"
}

cmd_system_info() {
  local brand cpu gpu ver
  brand="$(cmd_system_brand)"; cpu="$(cmd_system_cpu)"; gpu="$(cmd_system_gpu)"; ver="$(cmd_system_version)"
  printf '{"brand":%s,"cpu":%s,"gpu":%s,"version":%s}' "$brand" "$cpu" "$gpu" "$ver"
}
