#!/usr/bin/env bash
#
# git.sh - interactive git runner for bash.
#
# Standalone tool. It is NOT one of the dsh-os modules listed in tools/build.ps1, so it is never
# concatenated into bin/dsh-os.sh and it emits no JSON envelope: it is meant to be run by a person,
# who wants to see what will run before it runs. It follows dsh-os house rules anyway: no command
# string is ever assembled for a shell, arguments stay separate argv elements, and git is located by
# explicit search rather than assumed to be on PATH.
#
# Contract:
#   * git is located deliberately, in this order, and never assumed:
#       1. "environment"  GIT_EXE / GIT_HOME, then git already on PATH
#       2. "known paths"  the Git-for-Windows registry keys (MSYS/Cygwin only), then the usual
#                         install roots: /usr, /usr/local, /opt, /opt/homebrew, /opt/local, /snap,
#                         /Applications, ~/scoop, %LOCALAPPDATA%\Programs\Git
#       3. "full disk"    every mounted file system, walked with a depth cap and a time budget
#                         (skip with --no-deep-search). Every mounted root is visited, not just "/",
#                         so a Windows drive mounted under /mnt or /cygdrive is covered too.
#     When nothing is found the script exits 127 and lists what it searched, rather than reporting
#     some unrelated failure.
#   * Every argument reaches git as a SEPARATE argv element. No command line is ever assembled: a
#     path or message containing spaces, quotes, &, | or $ is executed literally. The quoted command
#     line that is printed is for reading and copy-paste only; it is never the thing that runs.
#   * Trailing arguments are taken as given and are NOT re-split, so
#       ./git.sh commit "fix: a message with spaces"
#     commits exactly that message. Only interactive text input is split into argv words (honouring
#     "double" and 'single' quotes), because there it is the only structure available.
#   * Prompts and the echoed command line go to stderr, so stdout carries git's output alone and
#     "./git.sh log > out.txt" stays clean.
#   * "git add" with an empty answer is "git add ." - pressing Enter stages everything. When the
#     input is not a terminal, the same empty answer is refused with an instruction instead of
#     hanging on a read that can never complete.
#   * Nothing runs until the command line has been echoed and confirmed, unless --yes is given.
#
# Usage:
#   ./git.sh                        # numbered menu, then prompts
#   ./git.sh add                    # asks for the paths, Enter means "."
#   ./git.sh add "src/a b.txt"      # no prompt: the argument is taken as given
#   ./git.sh commit "fix: spaces"   # trailing words are joined into one message
#   ./git.sh status --dry-run       # print the command, run nothing
#   ./git.sh log --yes              # skip the confirmation prompt
#   ./git.sh add . --git-path /usr/bin/git
#
# Exit codes: git's own exit code, plus 2 usage error, 3 declined, 64 not interactive,
#             127 git not found or not startable.
#
# Encoding: ASCII only, LF only, no BOM - the same contract tests/encoding.ps1 enforces on every
# other module under src/host/lib. Prompt text is therefore English here, while the PowerShell
# counterparts carry Chinese labels: those are saved UTF-8 with BOM, which is mandatory for
# Windows PowerShell 5.1 but would violate the shell module contract, so the two cannot match.

# No `set -e` on purpose: this runner must survive a non-zero status from git and from the search
# helpers without aborting midway, and it exits with git's own code at the end. Every failure path
# checks explicitly instead. `set -u` is kept, so every variable is initialised before use.
set -u

# ---------------------------------------------------------------------------
# Streams. stdout carries git's output only; prompts, the echoed command line and diagnostics all
# go to stderr.
# ---------------------------------------------------------------------------
USE_COLOR=1
if [ -n "${NO_COLOR:-}" ] || [ ! -t 2 ]; then USE_COLOR=0; fi
case "${TERM:-}" in dumb|'') USE_COLOR=0 ;; esac

say() { printf '%s\n' "$*"; }
err() { printf '%s\n' "$*" >&2; }
fail() { printf 'git.sh: %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# Git location helpers.
# ---------------------------------------------------------------------------
has() { command -v "$1" >/dev/null 2>&1; }

# probe_git <path> - run "<path> --version" and keep the result in GIT_VERSION. Prints nothing, so
# it can be used directly in a condition without polluting stdout.
GIT_VERSION=''
probe_git() {
  local candidate="${1:-}" probe
  [ -n "$candidate" ] || return 1
  [ -f "$candidate" ] || return 1
  [ -x "$candidate" ] || return 1
  # The bare name "git" is required, so a shell alias, a directory or an unrelated binary cannot be
  # mistaken for the executable.
  case "$(basename "$candidate")" in
    git|git.exe) ;;
    *) return 1 ;;
  esac
  probe="$(LC_ALL=C "$candidate" --version 2>/dev/null | head -n 1)"
  case "$probe" in
    git\ version*) GIT_VERSION="$probe"; return 0 ;;
    *) return 1 ;;
  esac
}

# A git executable found outside a Git install tree must also sit directly in a bin or cmd
# directory, otherwise a project that happens to ship a file called git would be reported as the
# installation. Used only for the messages of the full-disk phase.
is_git_install_location() {
  case "$(basename "$1")" in
    cmd|bin) return 0 ;;
    *) return 1 ;;
  esac
}

is_msys_like() {
  case "$(uname -s 2>/dev/null || printf unknown)" in
    MINGW*|MSYS*|CYGWIN*) return 0 ;;
    *) return 1 ;;
  esac
}

# C:\Program Files\Git  ->  /c/Program Files/Git
# The explicit substr() is used instead of the bash-only ${var:1} so this helper also works under a
# plain sh during the MSYS detection path.
windows_path_to_shell() {
  printf '%s' "$1" | awk '{
    d = substr($0, 1, 1)
    r = substr($0, 3)
    gsub(/\\/, "/", r)
    printf "/%s%s", tolower(d), r
  }'
}

# query_git_registry - Windows only. Git for Windows records its install root in the registry, which
# is exactly the case a hardcoded path list misses when someone installed it to D:\Git. One
# candidate path per line; nothing at all elsewhere.
query_git_registry() {
  is_msys_like || return 0
  has reg.exe || return 0
  local key value win
  for key in \
    'HKLM\SOFTWARE\GitForWindows' \
    'HKLM\SOFTWARE\WOW6432Node\GitForWindows' \
    'HKCU\SOFTWARE\GitForWindows'; do
    for value in InstallPath InstallDir; do
      win="$(reg.exe query "$key" /v "$value" 2>/dev/null |
        sed -n 's/.*REG_SZ[[:space:]]*//p' | head -n 1 | tr -d '\r')"
      [ -n "$win" ] || continue
      case "$win" in
        [A-Za-z]:*) win="$(windows_path_to_shell "$win")" ;;
      esac
      printf '%s\n' \
        "$win/cmd/git.exe" \
        "$win/bin/git.exe" \
        "$win/git.exe" \
        "$win/mingw64/bin/git.exe"
    done
  done
  return 0
}

# ---------------------------------------------------------------------------
# Discovery, phase 1: the environment decides. GIT_EXE wins outright; GIT_HOME is an install root
# whose cmd/git.exe (Windows) or bin/git (elsewhere) is the launcher; PATH is the last word here.
# ---------------------------------------------------------------------------
discover_from_environment() {
  local value dir leaf candidate
  value="${GIT_EXE:-}"
  if [ -n "$value" ]; then
    if probe_git "$value"; then GIT_EXE="$value"; GIT_SOURCE='environment (GIT_EXE)'; return 0; fi
    err "  note: GIT_EXE is set to \"$value\" but that is not a runnable git"
  fi
  value="${GIT_HOME:-}"
  if [ -n "$value" ]; then
    for leaf in cmd/git.exe bin/git.exe git.exe mingw64/bin/git.exe bin/git; do
      candidate="$value/$leaf"
      if probe_git "$candidate"; then GIT_EXE="$candidate"; GIT_SOURCE='environment (GIT_HOME)'; return 0; fi
    done
    err "  note: GIT_HOME is set to \"$value\" but it holds no runnable git"
  fi
  # PATH is split here rather than with IFS, because an entry may contain spaces and because a
  # Windows-style entry contains backslashes that `read` would consume. IFS is saved and restored
  # around the loop rather than set once, so no later `read -r` is affected.
  local saved_ifs="$IFS" entry
  for entry in $(printf '%s' "$PATH" | tr ':' '\n'); do
    IFS="$saved_ifs"
    [ -n "$entry" ] || continue
    for leaf in git git.exe; do
      candidate="$entry/$leaf"
      if probe_git "$candidate"; then GIT_EXE="$candidate"; GIT_SOURCE='environment (PATH)'; IFS="$saved_ifs"; return 0; fi
    done
  done
  IFS="$saved_ifs"
  return 1
}

# ---------------------------------------------------------------------------
# Discovery, phase 2: the known install roots.
# ---------------------------------------------------------------------------
discover_from_known_paths() {
  local roots candidate found
  roots=""
  # Windows roots, which exist under MSYS/Cygwin.
  [ -d /c ] && roots="$roots /c"
  [ -d /mnt/c ] && roots="$roots /mnt/c"
  [ -d /cygdrive/c ] && roots="$roots /cygdrive/c"
  # POSIX roots. Homebrew uses /opt/homebrew on Apple silicon and /usr/local on Intel macOS;
  # MacPorts uses /opt/local.
  roots="$roots /usr /usr/local /opt /opt/homebrew /opt/local /snap /Applications"
  if [ -n "${HOME:-}" ]; then
    roots="$roots $HOME/scoop $HOME/scoop/shims $HOME/scoop/apps/git"
    roots="$roots $HOME/AppData/Local/Programs/Git"
  fi

  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    if probe_git "$candidate"; then GIT_EXE="$candidate"; GIT_SOURCE='known paths (registry)'; return 0; fi
  done <<EOF
$(query_git_registry)
EOF

  found="$(find_git_in "$roots" 4 45 'known install roots')"
  if [ -n "$found" ]; then GIT_EXE="$found"; GIT_SOURCE='known install paths'; return 0; fi
  return 1
}

# ---------------------------------------------------------------------------
# Discovery, phase 3: every mounted file system.
# ---------------------------------------------------------------------------
discover_from_full_disk() {
  local candidates candidate roots found
  roots=""
  # df -P lists one line per mounted file system, which is what catches a Windows drive mounted
  # under /mnt/d: a plain walk of "/" would never reach it.
  if has df; then
    candidates="$(df -P 2>/dev/null | awk 'NR > 1 { print $6 }' | sort -u)"
    for candidate in $candidates; do
      case "$candidate" in
        /proc|/sys|/dev|/run|/proc/*|/sys/*|/dev/*|/run/*) continue ;;
      esac
      [ -d "$candidate" ] && roots="$roots $candidate"
    done
  fi
  if [ -z "$roots" ]; then roots="/"; fi
  err '  searching every mounted file system for git (depth 6; this can take a while)'
  found="$(find_git_in "$roots" 6 180 'full-disk search')"
  if [ -n "$found" ]; then GIT_EXE="$found"; GIT_SOURCE='full-disk search'; return 0; fi
  return 1
}

# find_git_in <roots> <max-depth> <budget-seconds> <label> - prints the first runnable git found.
#
# GNU find is used when available because -maxdepth, -xdev and -quit bound the walk to one file
# system and stop it the moment a hit appears. POSIX find has none of those, and a plain `find /`
# descends into /proc, so the fallback is an explicit directory walk instead of a second find
# invocation. Both paths are bounded by depth and by a time budget: an unbounded walk of a whole
# system disk is a hang that looks like a bug in the script.
find_git_in() {
  local roots="$1" maxdepth="$2" budget="$3" label="$4" root found status
  local -a prune
  prune=(.git node_modules .cache .npm .gradle .m2 AppData Windows WinSxS 'System Volume Information' '$Recycle.Bin' proc sys dev run)

  if has find && find --version >/dev/null 2>&1; then
    for root in $roots; do
      [ -d "$root" ] || continue
      # -xdev keeps the walk on this file system; without it a mounted network share or /proc is
      # walked too. The prune list is emitted as an expression so those directories are never
      # entered. The result is read with `read -d ''` because a path may contain spaces.
      status=0
      while IFS= read -r -d '' candidate; do
        if probe_git "$candidate"; then printf '%s' "$candidate"; return 0; fi
        err "  note: found \"$candidate\" but it is not a runnable git; continuing"
      done < <(find "$root" -xdev -maxdepth "$maxdepth" \
        \( -type d -name .git -o -type d -name node_modules -o -type d -name proc -o -type d -name sys -o -type d -name dev \) -prune -o \
        -type f \( -name git -o -name git.exe \) -print0 2>/dev/null) || status=$?
      if [ "$status" -ne 0 ] && [ "$status" -ne 1 ]; then
        err "  note: the $label walk under $root did not complete cleanly; continuing"
      fi
    done
    return 1
  fi

  # No GNU find: walk the tree with the shell itself, iteratively and depth-capped.
  for root in $roots; do
    [ -d "$root" ] || continue
    found="$(walk_for_git "$root" "$maxdepth")"
    if [ -n "$found" ]; then printf '%s' "$found"; return 0; fi
  done
  return 1
}

# walk_for_git <root> <max-depth> - POSIX fallback. An explicit stack is used rather than a
# recursive function so that a deep tree cannot exhaust the shell's call stack. The stack is kept
# as a single newline-separated string, which avoids the array-index arithmetic that bash performs
# before unset can see the subscript.
walk_for_git() {
  local root="$1" maxdepth="$2" dir depth child name entry rest
  local stack="$root" depths="0"
  while [ -n "$stack" ]; do
    dir="${stack%%$'\n'*}"
    if [ "$stack" = "$dir" ]; then rest=''; else rest="${stack#*$'\n'}"; fi
    stack="$rest"
    depth="${depths%%$'\n'*}"
    if [ "$depths" = "$depth" ]; then depths=''; else depths="${depths#*$'\n'}"; fi
    case "$(basename "$dir")" in
      .git|node_modules|proc|sys|dev|run|Windows|WinSxS|AppData|.cache|.npm|.gradle|.m2) continue ;;
    esac
    for name in git git.exe; do
      entry="$dir/$name"
      if [ -f "$entry" ] && [ -x "$entry" ] && probe_git "$entry"; then
        printf '%s' "$entry"
        return 0
      fi
    done
    [ "$depth" -ge "$maxdepth" ] && continue
    # The trailing slash makes the glob match directories only, so an unreadable directory simply
    # contributes no matches instead of being tested separately.
    for child in "$dir"/*/; do
      [ -d "$child" ] || continue
      if [ -n "$stack" ]; then stack="$stack"$'\n'"${child%/}"; else stack="${child%/}"; fi
      if [ -n "$depths" ]; then depths="$depths"$'\n'"$((depth + 1))"; else depths="$((depth + 1))"; fi
    done
  done
  return 1
}

# ---------------------------------------------------------------------------
# Interactive input. Each prompt reports whether an answer was available, so a non-interactive
# caller is told to pass arguments rather than left waiting on a read that cannot complete.
# ---------------------------------------------------------------------------
can_prompt() { [ -t 0 ]; }

# read_prompt <label> [default] - sets ANSWER. An empty answer from a real terminal is a legitimate
# "the user pressed Enter"; no terminal at all is an error instead.
ANSWER=''
read_prompt() {
  local label="$1" default="${2:-}" suffix line
  ANSWER=''
  if ! can_prompt; then
    fail "no value for \"$label\" and stdin is not a terminal: pass the value as an argument instead, for example: git.sh add \"path\""
    exit 64
  fi
  suffix=''
  [ -n "$default" ] && suffix=" [$default]"
  printf '\n' >&2
  if [ "$USE_COLOR" -eq 1 ]; then
    printf '  \033[36m%s%s\033[0m\n' "$label" "$suffix" >&2
  else
    printf '  %s%s\n' "$label" "$suffix" >&2
  fi
  printf '  > ' >&2
  IFS= read -r line || line=''
  if [ -z "$line" ] && [ -n "$default" ]; then line="$default"; fi
  ANSWER="$line"
}

read_confirm() {
  local question="$1" default="${2:-y}" hint line
  if [ "$OPT_YES" -eq 1 ]; then return 0; fi
  if ! can_prompt; then
    fail "confirmation is required for \"$question\" and stdin is not a terminal: re-run with --yes"
    exit 64
  fi
  if [ "$default" = 'y' ]; then hint='[Y/n]'; else hint='[y/N]'; fi
  printf '  %s %s ' "$question" "$hint" >&2
  IFS= read -r line || line=''
  case "$line" in
    '') [ "$default" = 'y' ] && return 0; return 1 ;;
    y|Y|yes|YES|Yes) return 0 ;;
    *) return 1 ;;
  esac
}

# split_words <text> - turn one line of interactive input into argv words.
#
# This is the ONLY place a line of text becomes several arguments, and it is quote-aware so that
# "a b.txt" stays one argument. It exists because a prompt can only produce a string; every other
# path into this script carries the caller's own "$@", which needs no splitting at all.
#
# The result is left in SPLIT_WORDS rather than echoed, because a command substitution would run
# this in a subshell. The scan is substring-based rather than per-character: a per-character loop
# that shells out to cut(1) once per character is slow enough to be noticeable on a long path list.
SPLIT_WORDS=()
split_words() {
  local rest="$1" word='' quote='' ch
  SPLIT_WORDS=()
  while [ -n "$rest" ]; do
    ch="${rest:0:1}"
    rest="${rest:1}"
    if [ -n "$quote" ]; then
      if [ "$ch" = "$quote" ]; then quote=''; else word="$word$ch"; fi
      continue
    fi
    case "$ch" in
      '"') quote='"' ;;
      "'") quote="'" ;;
      ' '|'	')
        if [ -n "$word" ]; then SPLIT_WORDS+=("$word"); word=''; fi
        ;;
      *) word="$word$ch" ;;
    esac
  done
  if [ -n "$word" ]; then SPLIT_WORDS+=("$word"); fi
}

# ---------------------------------------------------------------------------
# Display. Every argument is shown double quoted: one rule, with no judgement call about which
# argument "needs" quoting. Embedded double quotes and backslashes are escaped the way a POSIX shell
# expects, because that is where such a line would be pasted. git never sees this string - the real
# call is an argv array - so the escaping cannot corrupt an argument.
# ---------------------------------------------------------------------------
quote_display() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

format_display_command() {
  local out arg
  out="$(quote_display "$GIT_EXE")"
  for arg in "$@"; do
    out="$out $(quote_display "$arg")"
  done
  printf '%s' "$out"
}

# ---------------------------------------------------------------------------
# Command table. One case arm per property keeps the data in one place without requiring an
# associative array, so the script stays readable and every lookup is a single switch.
# ---------------------------------------------------------------------------
MENU_ORDER='add commit status diff log branch checkout switch merge pull push fetch clone restore reset stash tag remote rm mv'

command_usage() {
  case "$1" in
    add) printf 'add [path...]' ;;
    commit) printf 'commit [message]' ;;
    status) printf 'status' ;;
    diff) printf 'diff [path...]' ;;
    log) printf 'log [count]' ;;
    branch) printf 'branch [name]' ;;
    checkout) printf 'checkout [ref]' ;;
    switch) printf 'switch [branch]' ;;
    merge) printf 'merge [ref]' ;;
    pull) printf 'pull [remote] [branch]' ;;
    push) printf 'push [remote] [branch]' ;;
    fetch) printf 'fetch [remote]' ;;
    clone) printf 'clone <repository> [directory]' ;;
    restore) printf 'restore <path...>' ;;
    reset) printf 'reset [mode] <target>' ;;
    stash) printf 'stash [push|pop|list|drop]' ;;
    tag) printf 'tag [name] [message]' ;;
    remote) printf 'remote [-v]' ;;
    rm) printf 'rm [-r] [-f] <path...>' ;;
    mv) printf 'mv <source> <destination>' ;;
    *) printf '' ;;
  esac
}

command_help() {
  case "$1" in
    add) printf 'stage changes' ;;
    commit) printf 'record staged changes' ;;
    status) printf 'show the working tree state' ;;
    diff) printf 'show unstaged changes' ;;
    log) printf 'show recent history' ;;
    branch) printf 'list or create a branch' ;;
    checkout) printf 'switch branch or restore files' ;;
    switch) printf 'switch branch' ;;
    merge) printf 'merge a branch into the current one' ;;
    pull) printf 'fetch and integrate' ;;
    push) printf 'publish local commits' ;;
    fetch) printf 'download refs without merging' ;;
    clone) printf 'copy a repository' ;;
    restore) printf 'discard working-tree changes' ;;
    reset) printf 'move HEAD or unstage' ;;
    stash) printf 'shelve working-tree changes' ;;
    tag) printf 'list or create a tag' ;;
    remote) printf 'list or manage remotes' ;;
    rm) printf 'remove files and stage the removal' ;;
    mv) printf 'move or rename and stage it' ;;
    *) printf '' ;;
  esac
}

# command_accept <name> - how the caller's trailing arguments are consumed.
#   s    one value: the arguments are joined into a single argument
#   list several arguments: each one is handed through as its own argument
#   none the command takes no input at all
command_accept() {
  case "$1" in
    add|diff|restore|reset|rm|pull|push|remote) printf 'list' ;;
    status) printf 'none' ;;
    # Every remaining command takes exactly one value. The single-value form is listed positively as
    # well, and an unknown name is a bug in this table rather than something to guess at, so it says
    # so on stderr instead of silently behaving like a prompt.
    commit|log|branch|checkout|switch|merge|fetch|clone|stash|tag|mv) printf 's' ;;
    *) printf 'git.sh: internal error: no accept mode for "%s"\n' "$1" >&2; printf 's' ;;
  esac
}

# prompt_label <name> <round> - the label for that prompt, empty when the round is not needed.
prompt_label() {
  case "$1:$2" in
    add:1) printf 'path / pathspec' ;;
    diff:1) printf 'path (optional)' ;;
    commit:1) printf 'commit message' ;;
    log:1) printf 'count (Enter = 20)' ;;
    branch:1) printf 'branch name (Enter = list all)' ;;
    checkout:1) printf 'branch / commit / file' ;;
    switch:1) printf 'branch' ;;
    merge:1) printf 'branch / commit' ;;
    pull:1) printf 'remote (Enter = origin)' ;;
    pull:2) printf 'branch (optional)' ;;
    push:1) printf 'remote (Enter = origin)' ;;
    push:2) printf 'branch (optional)' ;;
    push:3) printf 'extra options, e.g. -u or --force-with-lease (optional)' ;;
    fetch:1) printf 'remote (optional)' ;;
    clone:1) printf 'repository' ;;
    clone:2) printf 'directory (optional)' ;;
    restore:1) printf 'path' ;;
    reset:1) printf 'mode (Enter = --mixed)' ;;
    reset:2) printf 'target' ;;
    stash:1) printf 'action (Enter = push)' ;;
    stash:2) printf 'message (optional)' ;;
    tag:1) printf 'tag name (Enter = list all)' ;;
    tag:2) printf 'annotation (optional)' ;;
    remote:1) printf 'action (Enter = -v)' ;;
    remote:2) printf 'remote name' ;;
    remote:3) printf 'url' ;;
    rm:1) printf 'path' ;;
    mv:1) printf 'source' ;;
    mv:2) printf 'destination' ;;
    *) printf '' ;;
  esac
}

prompt_default() {
  case "$1" in
    add) printf '.' ;;
    log) printf '20' ;;
    reset) printf '--mixed' ;;
    stash) printf 'push' ;;
    remote) printf '-v' ;;
    *) printf '' ;;
  esac
}

# ---------------------------------------------------------------------------
# Main.
# ---------------------------------------------------------------------------
OPT_DRY_RUN=0
OPT_YES=0
OPT_NO_DEEP_SEARCH=0
OPT_QUIET=0
OPT_WANT_GIT_PATH=0
END_OF_OPTIONS=0
GIT_EXE=''
GIT_SOURCE=''
GIT_VERSION=''

usage() {
  cat >&2 <<'USAGE'
git.sh - interactive git runner

  git.sh [command] [arguments...] [options]

Options:
  --git-path <path>    use this git executable instead of searching
  --dry-run            print the command and run nothing
  --yes                skip the confirmation prompt
  --no-deep-search     skip the full-disk phase when git is not found elsewhere
  --quiet              no colour
  --help               this text

Commands:
  add commit status diff log branch checkout switch merge pull push
  fetch clone restore reset stash tag remote rm mv

With no command a numbered menu is shown.
USAGE
}

COMMAND=''
ARGS=()
POSITIONAL=()
# The whole command line is scanned, because this script's options are accepted both before and
# after the command ("./git.sh add --dry-run"). Stopping the scan at the first non-option, as an
# earlier revision did, silently pushed --dry-run and --yes into git's argv - visible in the echoed
# command line as trailing junk and, worse, actually passed to git.
#
# Everything that is not one of this script's own options is a positional and keeps its original
# order, so "./git.sh commit -m "msg"" reaches git as ("commit" "-m" "msg"). "--" ends option
# scanning, which is the only way to reach git with an argument that collides with an option name.
for arg in "$@"; do
  if [ "$END_OF_OPTIONS" -eq 1 ]; then
    POSITIONAL+=("$arg")
    continue
  fi
  case "$arg" in
    --)
      END_OF_OPTIONS=1
      ;;
    --git-path)
      OPT_WANT_GIT_PATH=1
      ;;
    --git-path=*)
      GIT_EXE="${arg#--git-path=}"
      ;;
    --dry-run) OPT_DRY_RUN=1 ;;
    --yes) OPT_YES=1 ;;
    --no-deep-search) OPT_NO_DEEP_SEARCH=1 ;;
    --quiet) OPT_QUIET=1 ;;
    --help) usage; exit 0 ;;
    *)
      if [ "$OPT_WANT_GIT_PATH" -eq 1 ]; then
        OPT_WANT_GIT_PATH=0
        GIT_EXE="$arg"
      else
        POSITIONAL+=("$arg")
      fi
      ;;
  esac
done
if [ "$OPT_WANT_GIT_PATH" -eq 1 ]; then
  fail '--git-path needs a value: --git-path /usr/bin/git'
  exit 2
fi
if [ "$OPT_QUIET" -eq 1 ]; then USE_COLOR=0; fi

if [ "${#POSITIONAL[@]}" -gt 0 ]; then
  COMMAND="${POSITIONAL[0]}"
  if [ "${#POSITIONAL[@]}" -gt 1 ]; then
    ARGS=("${POSITIONAL[@]:1}")
  fi
fi
if [ "$OPT_QUIET" -eq 1 ]; then USE_COLOR=0; fi

# --- locate git ---------------------------------------------------------------------------------
if [ -n "$GIT_EXE" ]; then
  if ! probe_git "$GIT_EXE"; then fail "--git-path \"$GIT_EXE\" is not a runnable git"; exit 127; fi
  GIT_SOURCE='argument --git-path'
else
  say '  git.sh - locating git'
  if discover_from_environment; then :; elif discover_from_known_paths; then :; else
    if [ "$OPT_NO_DEEP_SEARCH" -eq 1 ]; then
      err '  not in the known install locations (--no-deep-search was given, so the walk was skipped)'
    elif discover_from_full_disk; then :; fi
  fi
fi

if [ -z "$GIT_EXE" ]; then
  err ''
  fail 'git was not found anywhere on this machine.'
  err '  searched, in order:'
  err '    1. environment   GIT_EXE, GIT_HOME, PATH'
  err '    2. known paths   the Git-for-Windows registry keys, /usr, /usr/local, /opt,'
  err '                     /opt/homebrew, /opt/local, /snap, /Applications, ~/scoop'
  if [ "$OPT_NO_DEEP_SEARCH" -eq 1 ]; then
    err '    3. full disk     SKIPPED (--no-deep-search)'
  else
    err '    3. full disk     every mounted file system, depth 6, 180s budget'
  fi
  err '  install git, put it on PATH, or point at it directly:'
  err '    ./git.sh add . --git-path /usr/bin/git'
  exit 127
fi

# --- resolve the command ------------------------------------------------------------------------
if [ -z "$COMMAND" ]; then
  if ! can_prompt; then
    fail 'no command given and stdin is not a terminal: pass one as the first argument (git.sh add)'
    exit 64
  fi
  printf '\n' >&2
  if [ "$USE_COLOR" -eq 1 ]; then printf '  \033[36mavailable commands\033[0m\n' >&2; else printf '  available commands\n' >&2; fi
  index=0
  for name in $MENU_ORDER; do
    index=$((index + 1))
    printf '   %2d. %-9s %s\n' "$index" "$name" "$(command_help "$name")" >&2
  done
  printf '\n' >&2
  read_prompt 'command name or number'
  COMMAND="$ANSWER"
  case "$COMMAND" in
    '') fail 'no command selected'; exit 2 ;;
  esac
  # A bare number selects the menu entry at that position. The menu holds 20 entries, so the range
  # check is exact rather than a guess; anything else is treated as a command name and validated
  # against the table below.
  if [ "$COMMAND" -ge 1 ] 2>/dev/null && [ "$COMMAND" -le 20 ] 2>/dev/null; then
    index=0
    for name in $MENU_ORDER; do
      index=$((index + 1))
      if [ "$index" -eq "$COMMAND" ]; then COMMAND="$name"; break; fi
    done
  fi
fi

known=0
for name in $MENU_ORDER; do
  if [ "$name" = "$COMMAND" ]; then known=1; break; fi
done
if [ "$known" -eq 0 ]; then
  fail "unknown command \"$COMMAND\"; known: $(printf '%s' "$MENU_ORDER" | tr ' ' ', ')"
  exit 2
fi

# --- build git's argv ---------------------------------------------------------------------------
# ARGV[0] is the subcommand; every later element is one argument, exactly as git will receive it.
ARGV=("$COMMAND")
accept="$(command_accept "$COMMAND")"

if [ "$accept" = 'none' ]; then
  if [ "${#ARGS[@]}" -gt 0 ]; then
    fail "$COMMAND takes no arguments, but got: ${ARGS[*]}"
    exit 2
  fi
elif [ "${#ARGS[@]}" -gt 0 ]; then
  # Arguments were supplied, so there is nothing to ask: a prompt exists only for the case where the
  # caller gave no value at all. This is what makes
  #   git.sh add "src/a b.txt" "src/c.txt"
  # stage exactly those two paths instead of prompting and then ignoring what was typed.
  if [ "$accept" = 's' ]; then
    # 's': the caller's arguments become one value, joined so that both
    #   commit "fix: a b"   (one element) and
    #   commit fix: a b     (three elements)
    # produce the one message the caller meant. Nothing is re-split afterwards.
    joined=''
    for arg in "${ARGS[@]}"; do
      if [ -z "$joined" ]; then joined="$arg"; else joined="$joined $arg"; fi
    done
    ARGV+=("$joined")
  else
    # 'list': every element is handed through as its own argument, so a caller-supplied path
    # containing spaces survives untouched.
    ARGV+=("${ARGS[@]}")
  fi
else
  # Interactive: one prompt per field. A field answered with Enter keeps its default, or drops out
  # of the argument list entirely when it has none - which is what turns "git add" + Enter into
  # "git add ." while leaving "git push" + Enter as a plain "git push".
  round=1
  while :; do
    label="$(prompt_label "$COMMAND" "$round")"
    [ -n "$label" ] || break
    default=''
    if [ "$round" -eq 1 ]; then default="$(prompt_default "$COMMAND")"; fi
    read_prompt "$label" "$default"
    if [ -n "$ANSWER" ]; then
      if [ "$accept" = 'list' ]; then
        split_words "$ANSWER"
        for word in "${SPLIT_WORDS[@]}"; do ARGV+=("$word"); done
      else
        ARGV+=("$ANSWER")
      fi
    fi
    round=$((round + 1))
  done
fi

# --- show, confirm, run -------------------------------------------------------------------------
version_text=''
[ -n "$GIT_VERSION" ] && version_text="  ($GIT_VERSION)"
say ''
if [ "$USE_COLOR" -eq 1 ]; then
  printf '  \033[32mgit: %s%s\033[0m\n' "$GIT_EXE" "$version_text"
else
  printf '  git: %s%s\n' "$GIT_EXE" "$version_text"
fi
say "  found via: $GIT_SOURCE"
say "  command: git $(command_usage "$COMMAND")"
err ''
err '  equivalent command line (every argument double quoted):'
err "    $(format_display_command "${ARGV[@]}")"
err ''

if [ "$OPT_DRY_RUN" -eq 1 ]; then
  err '  --dry-run: nothing was executed.'
  exit 0
fi
if ! read_confirm 'run it?'; then
  err '  declined; nothing was executed.'
  exit 3
fi
err ''
"$GIT_EXE" "${ARGV[@]}"
status=$?
err ''
err "  git exited with code $status"
exit "$status"
