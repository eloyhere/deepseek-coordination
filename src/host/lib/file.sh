
# ---------------------------------------------------------------------------
# file.* verbs
# ---------------------------------------------------------------------------
cmd_file_create() {
  require_min 3 'file create'
  require_allow 'file create' 3 "${#POSITIONALS[@]}"
  local path content charset
  path="$(pos 0)"; content="$(pos 1)"; charset="$(pos 2)"
  assert_not_protected "$path" 'file create'
  if [ -e "$path" ]; then
    fail E_EXISTS "cannot create '$path': it already exists" \
      'use file view to read it, file append/file insert to extend it, or file delete then create'
  fi
  local dir
  dir="$(dirname "$path")"
  [ -d "$dir" ] || mkdir -p "$dir"
  local iana
  iana="$(resolve_charset "$charset")"
  local textfile payload
  textfile="$(mktemp)"; payload="$(mktemp)"
  printf '%s' "$content" >"$textfile"
  local eol
  eol="$(flag_value eol '')"
  if [ "$eol" = "crlf" ]; then
    LC_ALL=C awk '{ printf "%s\r\n", $0 }' "$textfile" >"$payload"
  else
    cp "$textfile" "$payload"
  fi
  if [ "$iana" = "utf-8-bom" ]; then
    local withbom; withbom="$(mktemp)"
    printf '\357\273\277' >"$withbom"; cat "$payload" >>"$withbom"; mv "$withbom" "$payload"
  elif [ "$iana" != "utf-8" ]; then
    local conv; conv="$(mktemp)"
    iconv -f UTF-8 -t "$(iconv_name_for "$iana")" "$payload" >"$conv" 2>/dev/null || {
      rm -f "$textfile" "$payload" "$conv"
      fail E_ENCODING_INVALID "content cannot be represented in $iana"
    }
    mv "$conv" "$payload"
  fi
  write_doc_bytes "$path" "$payload"
  local size; size="$(wc -c <"$path" | tr -d ' ')"
  rm -f "$textfile" "$payload"
  printf '{"path":%s,"operation":"create","charset":%s,"bom":%s,"eol":%s,"bytes":%s}' \
    "$(jstr "$path")" "$(jstr "$iana")" "$([ "$iana" = "utf-8-bom" ] && echo true || echo false)" \
    "$(jstr "${eol:-lf}")" "$size"
}

cmd_file_charset() {
  require_min 1 'file charset'
  local path; path="$(pos 0)"
  load_doc "$path"
  local textfile lines
  textfile="$(mktemp)"
  doc_text >"$textfile"
  lines="$(awk 'END { n = NR; if (NR == 0) n = 0; print n }' "$textfile")"
  rm -f "$textfile"
  printf '{"path":%s,"charset":%s,"bom":%s,"eol":%s,"size":%s,"lines":%s}' \
    "$(jstr "$DOC_PATH")" "$(jstr "$DOC_CHARSET")" \
    "$([ "$DOC_BOM" != "-" ] && echo true || echo false)" \
    "$(jstr "$DOC_EOL")" "$DOC_SIZE" "$lines"
}

cmd_file_information() {
  require_min 1 'file information'
  local path; path="$(pos 0)"
  [ -e "$path" ] || fail E_NOT_FOUND "cannot inspect '$path': not found"
  if [ -d "$path" ]; then
    printf '{"path":%s,"type":"directory"}' "$(jstr "$path")"
    return
  fi
  load_doc "$path"
  local textfile lines
  textfile="$(mktemp)"; doc_text >"$textfile"
  lines="$(awk 'END { print NR }' "$textfile")"
  rm -f "$textfile"
  local mtime
  mtime="$(date -u -r "$path" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf '{"path":%s,"type":"file","size":%s,"charset":%s,"bom":%s,"eol":%s,"lines":%s,"modified":%s,"realpath":%s}' \
    "$(jstr "$path")" "$DOC_SIZE" "$(jstr "$DOC_CHARSET")" \
    "$([ "$DOC_BOM" != "-" ] && echo true || echo false)" \
    "$(jstr "$DOC_EOL")" "$lines" "$(jstr "$mtime")" "$(jstr "$path")"
}

cmd_file_length() {
  require_min 1 'file length'
  local path; path="$(pos 0)"
  [ -e "$path" ] || fail E_NOT_FOUND "cannot measure '$path': not found"
  if [ -d "$path" ]; then
    if have_flag no-recursive; then
      printf '{"path":%s,"type":"directory","bytes":0,"files":0,"directories":0}' "$(jstr "$path")"
      return
    fi
    local total files dirs
    total="$(find "$path" -type f -printf '%s\n' 2>/dev/null | awk '{ s += $1 } END { printf "%d", s + 0 }')"
    files="$(find "$path" -type f 2>/dev/null | wc -l | tr -d ' ')"
    dirs="$(find "$path" -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
    printf '{"path":%s,"type":"directory","bytes":%s,"files":%s,"directories":%s,"recursive":true}' \
      "$(jstr "$path")" "$total" "$files" "$dirs"
    return
  fi
  local size; size="$(wc -c <"$path" | tr -d ' ')"
  printf '{"path":%s,"type":"file","bytes":%s,"recursive":false}' "$(jstr "$path")" "$size"
}

cmd_file_list() {
  require_min 1 'file list'
  local path; path="$(pos 0)"
  [ -e "$path" ] || fail E_NOT_FOUND "cannot list '$path': not found"
  [ -d "$path" ] || fail E_NOT_A_DIR "cannot list '$path': not a directory"
  local out="" count=0
  local entry
  for entry in "$path"/* "$path"/.[!.]*; do
    [ -e "$entry" ] || continue
    local name type size
    name="$(basename "$entry")"
    if [ -d "$entry" ]; then type="directory"; size=0; else type="file"; size="$(wc -c <"$entry" | tr -d ' ')"; fi
    [ "$count" -gt 0 ] && out="$out,"
    out="$out{\"name\":$(jstr "$name"),\"type\":$(jstr "$type"),\"size\":$size}"
    count=$((count + 1))
  done
  printf '{"path":%s,"entries":[%s],"count":%s}' "$(jstr "$path")" "$out" "$count"
}

cmd_file_delete() {
  require_min 1 'file delete'
  require_allow 'file delete' 1 "${#POSITIONALS[@]}"
  local path; path="$(pos 0)"
  assert_not_protected "$path" 'file delete'
  [ -e "$path" ] || fail E_NOT_FOUND "cannot delete '$path': not found"
  if have_flag permanent; then
    rm -rf -- "$path"
    printf '{"path":%s,"operation":"unlink","permanent":true}' "$(jstr "$path")"
    return
  fi
  # No standard trash facility on POSIX. Refuse rather than silently destroying data, which is the
  # opposite of the Windows behaviour where the Recycle Bin is always available.
  if command -v trash-put >/dev/null 2>&1; then
    trash-put -- "$path"
    printf '{"path":%s,"operation":"recycle","permanent":false}' "$(jstr "$path")"
    return
  fi
  fail E_NOT_SUPPORTED \
    "cannot recycle '$path': no trash facility (trash-put) is available" \
    'pass --permanent to delete irreversibly, or install trash-cli'
}

cmd_file_move() {
  require_min 2 'file move'
  require_allow 'file move' 2 "${#POSITIONALS[@]}"
  local src dst
  src="$(pos 0)"; dst="$(pos 1)"
  assert_not_protected "$src" 'file move'
  assert_not_protected "$dst" 'file move'
  [ -e "$src" ] || fail E_NOT_FOUND "cannot move '$src': not found"
  [ -e "$dst" ] && fail E_EXISTS "cannot move to '$dst': it already exists"
  local dir; dir="$(dirname "$dst")"
  [ -d "$dir" ] || fail E_NO_PARENT "cannot move to '$dst': directory '$dir' does not exist"
  mv -- "$src" "$dst"
  printf '{"source":%s,"destination":%s,"operation":"move"}' "$(jstr "$src")" "$(jstr "$dst")"
}

cmd_file_copy() {
  require_min 2 'file copy'
  require_allow 'file copy' 2 "${#POSITIONALS[@]}"
  local src dst
  src="$(pos 0)"; dst="$(pos 1)"
  assert_not_protected "$src" 'file copy'
  assert_not_protected "$dst" 'file copy'
  [ -e "$src" ] || fail E_NOT_FOUND "cannot copy '$src': not found"
  [ -e "$dst" ] && fail E_EXISTS "cannot copy to '$dst': it already exists"
  local dir; dir="$(dirname "$dst")"
  [ -d "$dir" ] || fail E_NO_PARENT "cannot copy to '$dst': directory '$dir' does not exist"
  cp -R -- "$src" "$dst"
  printf '{"source":%s,"destination":%s,"operation":"copy"}' "$(jstr "$src")" "$(jstr "$dst")"
}

cmd_file_mkdir() {
  require_min 1 'file mkdir'
  require_allow 'file mkdir' 1 "${#POSITIONALS[@]}"
  local path; path="$(pos 0)"
  assert_not_protected "$path" 'file mkdir'
  [ -e "$path" ] && fail E_EXISTS "cannot create directory '$path': it already exists"
  if have_flag parents; then
    mkdir -p -- "$path"
  else
    local parent; parent="$(dirname "$path")"
    [ -d "$parent" ] || fail E_NO_PARENT "cannot create '$path': parent '$parent' does not exist" \
      'pass --parents to create intermediate directories'
    mkdir -- "$path"
  fi
  printf '{"path":%s,"operation":"mkdir"}' "$(jstr "$path")"
}

cmd_file_append() {
  require_min 2 'file append'
  require_allow 'file append' 3 "${#POSITIONALS[@]}"
  local path content charset
  path="$(pos 0)"; content="$(pos 1)"; charset="$(pos 2)"
  assert_not_protected "$path" 'file append'
  load_doc "$path"
  if [ -n "$charset" ]; then
    local expect; expect="$(resolve_charset "$charset")"
    if [ "$expect" != "$DOC_CHARSET" ] && ! { [ "$expect" = "utf-8" ] && [ "$DOC_CHARSET" = "utf-8-bom" ]; }; then
      fail E_CHARSET_MISMATCH "'$path' is $DOC_CHARSET, not $expect"
    fi
  fi
  local textfile
  textfile="$(mktemp)"
  doc_text >"$textfile"
  local add; add="$(mktemp)"
  printf '%s' "$content" >"$add"
  if [ "$DOC_EOL" = "crlf" ]; then
    local crlf; crlf="$(mktemp)"
    LC_ALL=C sed 's/\r$//' "$add" | LC_ALL=C awk '{ printf "%s\r\n", $0 }' >"$crlf"
    mv "$crlf" "$add"
  fi
  cat "$add" >>"$textfile"
  local before="$DOC_SIZE"
  rewrite_doc "$textfile"
  rm -f "$textfile" "$add"
  local size; size="$(wc -c <"$path" | tr -d ' ')"
  printf '{"path":%s,"operation":"append","charset":%s,"bom":%s,"eol":%s,"offset":%s,"bytes":%s}' \
    "$(jstr "$path")" "$(jstr "$DOC_CHARSET")" \
    "$([ "$DOC_BOM" != "-" ] && echo true || echo false)" "$(jstr "$DOC_EOL")" "$before" "$size"
}

cmd_file_insert() {
  require_min 3 'file insert'
  require_allow 'file insert' 3 "${#POSITIONALS[@]}"
  local path content offset charset
  path="$(pos 0)"; content="$(pos 1)"; offset="$(pos 2)"
  charset="$(flag_value charset '')"
  assert_not_protected "$path" 'file insert'
  case "$offset" in
    ''|*[!0-9]*) fail E_TYPE "<offset> must be an integer, got '$offset'" ;;
  esac
  load_doc "$path"
  if [ -n "$charset" ]; then
    local expect; expect="$(resolve_charset "$charset")"
    if [ "$expect" != "$DOC_CHARSET" ] && ! { [ "$expect" = "utf-8" ] && [ "$DOC_CHARSET" = "utf-8-bom" ]; }; then
      fail E_CHARSET_MISMATCH "'$path' is $DOC_CHARSET, not $expect"
    fi
  fi
  if [ "$offset" -gt "$DOC_SIZE" ]; then
    fail E_RANGE "offset $offset is out of range for '$path' (0..$DOC_SIZE)"
  fi
  # Character-boundary check for UTF-8: a continuation byte is 10xxxxxx.
  if [ "$offset" -gt 0 ] && [ "$offset" -lt "$DOC_SIZE" ]; then
    case "$DOC_CHARSET" in
      utf-8|utf-8-bom)
        local byte
        byte="$(LC_ALL=C od -An -tx1 -j "$offset" -N1 "$path" | tr -d ' \n')"
        case "$byte" in
          8*|9*|a*|b*) fail E_BOUNDARY "offset $offset falls inside a multi-byte character in '$path'" \
                         'offsets are byte offsets and must land on a character boundary' ;;
        esac
        ;;
      utf-16le|utf-16be)
        [ $((offset % 2)) -eq 0 ] || fail E_BOUNDARY "offset $offset falls inside a UTF-16 code unit in '$path'"
        ;;
    esac
  fi
  # Splice on the byte level: the head keeps the BOM, the inserted bytes come from a fresh
  # encoding pass, and the tail is copied verbatim.
  local head tail add full tmp
  tmp="$(mktemp -d)"
  head="$tmp/head"; tail="$tmp/tail"; add="$tmp/add"
  head -c "$offset" "$path" >"$head"
  tail -c "+$((offset + 1))" "$path" >"$tail"
  printf '%s' "$content" >"$add"
  if [ "$DOC_EOL" = "crlf" ]; then
    local crlf; crlf="$tmp/crlf"
    LC_ALL=C sed 's/\r$//' "$add" | LC_ALL=C awk '{ printf "%s\r\n", $0 }' >"$crlf"
    mv "$crlf" "$add"
  fi
  if [ "$DOC_CHARSET" != "utf-8" ] && [ "$DOC_CHARSET" != "utf-8-bom" ]; then
    local conv; conv="$tmp/conv"
    iconv -f UTF-8 -t "$(iconv_name_for "$DOC_CHARSET")" "$add" >"$conv" 2>/dev/null || {
      rm -rf "$tmp"; fail E_ENCODING_INVALID "content cannot be represented in $DOC_CHARSET"
    }
    mv "$conv" "$add"
  fi
  full="$tmp/full"
  cat "$head" "$add" "$tail" >"$full"
  local addsize; addsize="$(wc -c <"$add" | tr -d ' ')"
  write_doc_bytes "$path" "$full"
  local size; size="$(wc -c <"$path" | tr -d ' ')"
  rm -rf "$tmp"
  printf '{"path":%s,"operation":"insert","charset":%s,"bom":%s,"eol":%s,"offset":%s,"written":%s,"bytes":%s}' \
    "$(jstr "$path")" "$(jstr "$DOC_CHARSET")" \
    "$([ "$DOC_BOM" != "-" ] && echo true || echo false)" "$(jstr "$DOC_EOL")" "$offset" "$addsize" "$size"
}

cmd_file_view() {
  require_min 1 'file view'
  local path charset start end
  path="$(pos 0)"; charset="$(pos 1)"; start="$(pos 2)"; end="$(pos 3)"
  load_doc "$path"
  if [ -n "$charset" ]; then
    local expect; expect="$(resolve_charset "$charset")"
    [ "$expect" = "$DOC_CHARSET" ] || fail E_CHARSET_MISMATCH "'$path' is $DOC_CHARSET, not $expect"
  fi
  local s=0 e="$DOC_SIZE"
  [ -n "$start" ] && s="$start"
  [ -n "$end" ] && e="$end"
  case "$s" in ''|*[!0-9]*) fail E_TYPE "<start> must be an integer, got '$s'" ;; esac
  case "$e" in ''|*[!0-9]*) fail E_TYPE "<end> must be an integer, got '$e'" ;; esac
  [ "$e" -ge "$s" ] || fail E_RANGE "end $e precedes start $s"
  [ "$e" -le "$DOC_SIZE" ] || fail E_RANGE "range [$s,$e) is out of bounds for a $DOC_SIZE-byte file"
  local slice
  slice="$(mktemp)"
  head -c "$e" "$path" | tail -c "+$((s + 1))" >"$slice"
  local from text
  from="$(iconv_name_for "$DOC_CHARSET")"
  text="$(iconv -f "$from" -t UTF-8 "$slice" 2>/dev/null || cat "$slice")"
  rm -f "$slice"
  # Strip a leading BOM character if the slice carried the preamble.
  text="${text#$'\xef\xbb\xbf'}"

  # Agent-first output, mirroring the PowerShell implementation. `text` carries the raw slice with no
  # line-number prefix, and `lines` carries the same content as structured objects, so a caller never
  # has to strip a human rendering back off or parse it. --with-numbers is opt-in for a human.
  local linesJson="" lineCount=0
  local numbered="$text"
  if have_flag with-numbers; then
    numbered="$(printf '%s' "$text" | awk '{ printf "%d: %s\n", NR, $0 }')"
  fi
  # Build the structured array. IFS is scoped so an embedded newline cannot split a record early.
  while IFS= read -r one || [ -n "$one" ]; do
    linesJson="$linesJson$( [ "$lineCount" -gt 0 ] && printf ',' )$(printf '{"number":%s,"text":%s}' "$((lineCount + 1))" "$(jstr "$one")")"
    lineCount=$((lineCount + 1))
  done <<<"$text"

  printf '{"path":%s,"charset":%s,"bom":%s,"eol":%s,"size":%s,"start":%s,"end":%s,"totalBytes":%s,"lineCount":%s,"lines":[%s],"truncated":false,"text":%s}' \
    "$(jstr "$path")" "$(jstr "$DOC_CHARSET")" \
    "$([ "$DOC_BOM" != "-" ] && echo true || echo false)" "$(jstr "$DOC_EOL")" \
    "$DOC_SIZE" "$s" "$e" "$DOC_SIZE" "$lineCount" "$linesJson" "$(jstr "$numbered")"
}

# ---------------------------------------------------------------------------
# file.verify.* - assertions that report rather than throw.
# ---------------------------------------------------------------------------
cmd_file_verify_charset() {
  require_min 2 'file verify charset'
  local path expect
  path="$(pos 0)"; expect="$(resolve_charset "$(pos 1)")"
  load_doc "$path"
  printf '{"path":%s,"assertion":"charset","expected":%s,"observed":%s,"match":%s,"bom":%s,"eol":%s,"size":%s}' \
    "$(jstr "$path")" "$(jstr "$expect")" "$(jstr "$DOC_CHARSET")" \
    "$([ "$expect" = "$DOC_CHARSET" ] && echo true || echo false)" \
    "$([ "$DOC_BOM" != "-" ] && echo true || echo false)" "$(jstr "$DOC_EOL")" "$DOC_SIZE"
}

cmd_file_verify_encoding() {
  require_min 2 'file verify encoding'
  local path charset
  path="$(pos 0)"; charset="$(resolve_charset "$(pos 1)")"
  local skip=0
  case "$charset" in
    utf-16le|utf-16be|utf-32le|utf-32be) : ;;
  esac
  local from; from="$(iconv_name_for "$charset")"
  local legal=true
  if ! iconv -f "$from" -t UTF-8 "$path" >/dev/null 2>&1; then legal=false; fi
  printf '{"path":%s,"assertion":"encoding","charset":%s,"legal":%s}' \
    "$(jstr "$path")" "$(jstr "$charset")" "$legal"
}

cmd_file_verify_completion() {
  require_min 1 'file verify completion'
  local path; path="$(pos 0)"
  if [ ! -e "$path" ]; then
    printf '{"path":%s,"assertion":"completion","complete":false,"missing":true}' "$(jstr "$path")"
    return
  fi
  load_doc "$path"
  local asserted=false allmatch=true checks=""
  local want got
  want="$(flag_value length '')"
  if [ -n "$want" ]; then
    asserted=true
    got="$DOC_SIZE"
    [ "$want" = "$got" ] || allmatch=false
    checks="$checks$( [ -n "$checks" ] && echo , )\"length\":{\"expected\":$want,\"observed\":$got,\"match\":$([ "$want" = "$got" ] && echo true || echo false)}"
  fi
  want="$(flag_value sha256 '')"
  if [ -n "$want" ]; then
    asserted=true
    got="$(sha256_of "$path")"
    [ "$want" = "$got" ] || allmatch=false
    checks="$checks$( [ -n "$checks" ] && echo , )\"sha256\":{\"expected\":$(jstr "$want"),\"observed\":$(jstr "$got"),\"match\":$([ "$want" = "$got" ] && echo true || echo false)}"
  fi
  want="$(flag_value bom '')"
  if [ -n "$want" ]; then
    asserted=true
    got=false; [ "$DOC_BOM" != "-" ] && got=true
    [ "$want" = "$got" ] || allmatch=false
    checks="$checks$( [ -n "$checks" ] && echo , )\"bom\":{\"expected\":$want,\"observed\":$got,\"match\":$([ "$want" = "$got" ] && echo true || echo false)}"
  fi
  want="$(flag_value eol '')"
  if [ -n "$want" ]; then
    asserted=true
    got="$DOC_EOL"
    [ "$want" = "$got" ] || allmatch=false
    checks="$checks$( [ -n "$checks" ] && echo , )\"eol\":{\"expected\":$(jstr "$want"),\"observed\":$(jstr "$got"),\"match\":$([ "$want" = "$got" ] && echo true || echo false)}"
  fi
  local complete
  if [ "$asserted" = "true" ]; then complete="$allmatch"; else complete=null; fi
  printf '{"path":%s,"assertion":"completion","asserted":%s,"complete":%s,"charset":%s,"bom":%s,"eol":%s,"size":%s,"checks":{%s}}' \
    "$(jstr "$path")" "$asserted" "$complete" "$(jstr "$DOC_CHARSET")" \
    "$([ "$DOC_BOM" != "-" ] && echo true || echo false)" "$(jstr "$DOC_EOL")" "$DOC_SIZE" "$checks"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else openssl dgst -sha256 "$1" | awk '{print $NF}'
  fi
}

# ---------------------------------------------------------------------------
# file.search - matches as a JSON ARRAY, mirroring the Windows implementation so an agent can parse
# either platform's answer identically.
# ---------------------------------------------------------------------------
cmd_file_search() {
  require_min 2 'file search'
  local dir name
  dir="$(pos 0)"; name="$(pos 1)"
  if [ ! -e "$dir" ]; then
    fail E_NOT_FOUND "cannot search '$dir': not found"
  fi
  if [ ! -d "$dir" ]; then
    fail E_NOT_A_DIR "cannot search '$dir': not a directory"
  fi
  local use_regex=0 recursive=0
  have_flag regex && use_regex=1
  have_flag recursive && recursive=1
  local maxdepth; maxdepth="$(flag_value max-depth '0')"
  local limit; limit="$(flag_value limit '500')"
  local typefilter; typefilter="$(flag_value type '*')"

  local out="" count=0 truncated=false
  local findargs=()
  if [ "$recursive" -eq 1 ] || [ "$maxdepth" -gt 0 ] 2>/dev/null; then
    findargs+=("-mindepth" "1")
    if [ "${maxdepth:-0}" -gt 0 ] 2>/dev/null; then
      findargs+=("-maxdepth" "$maxdepth")
    fi
  else
    findargs+=("-mindepth" "1" "-maxdepth" "1")
  fi

  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    local base itemtype size matched=0
    base="$(basename "$entry")"
    if [ -d "$entry" ]; then itemtype="directory"; size=0; else itemtype="file"; size="$(wc -c <"$entry" 2>/dev/null | tr -d ' ')"; fi
    [ -n "$size" ] || size=0
    if [ "$typefilter" != "*" ] && [ "$typefilter" != "" ] && [ "$itemtype" != "$typefilter" ]; then continue; fi
    if [ "$use_regex" -eq 1 ]; then
      if printf '%s' "$base" | grep -Eq -- "$name"; then matched=1; fi
    else
      case "$base" in
        *"$name"*) matched=1 ;;
      esac
    fi
    [ "$matched" -eq 1 ] || continue
    # Strip the leading directory so the caller gets a path relative to what it asked about.
    local rel="$entry"
    case "$entry" in
      "$dir"/*) rel="${entry#*/}" ;;
    esac
    # Built with printf rather than an escaped literal: backslash-escaped quotes inside a double
    # quoted string are where this kind of JSON assembly silently goes wrong.
    local one
    one="$(printf '{"path":%s,"name":%s,"type":%s,"size":%s,"relative":%s}' \
      "$(jstr "$entry")" "$(jstr "$base")" "$(jstr "$itemtype")" "$size" "$(jstr "$rel")")"
    if [ "$count" -gt 0 ]; then out="$out,$one"; else out="$one"; fi
    count=$((count + 1))
    if [ "$count" -ge "$limit" ]; then truncated=true; break; fi
  done < <(find "$dir" "${findargs[@]}" -print 2>/dev/null | LC_ALL=C sort)

  printf '{"matches":[%s],"count":%s,"truncated":%s,"limit":%s,"directory":%s,"pattern":%s,"regex":%s,"recursive":%s}' \
    "$out" "$count" "$truncated" "$limit" "$(jstr "$dir")" "$(jstr "$name")" \
    "$([ "$use_regex" -eq 1 ] && echo true || echo false)" \
    "$([ "$recursive" -eq 1 ] && echo true || echo false)"
}
