
# ---------------------------------------------------------------------------
# Charset table (spec/charsets.tsv is the single source of truth).
# ---------------------------------------------------------------------------
charsets_file() { printf '%s' "$HOST_DIR/spec/charsets.tsv"; }

resolve_charset() {
  # resolve_charset <name> -> echoes the canonical IANA name, or fails.
  local want
  want="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  local file
  file="$(charsets_file)"
  if [ ! -f "$file" ]; then
    fail E_INTERNAL "charset table not found at $file"
  fi
  local line iana aliases
  while IFS=$'\t' read -r iana aliases _rest; do
    case "$iana" in ''|'#'*) continue ;; esac
    [ "$iana" = "iana" ] && continue
    if [ "$iana" = "$want" ]; then printf '%s' "$iana"; return 0; fi
    local a
    local IFS='|'
    for a in $aliases; do
      if [ "$a" = "$want" ]; then printf '%s' "$iana"; return 0; fi
    done
  done <"$file"
  fail E_CHARSET_UNKNOWN "unknown charset '$1'" 'see spec/charsets.tsv for supported names'
}

iconv_name_for() {
  local iana="$1" file
  file="$(charsets_file)"
  local line
  while IFS=$'\t' read -r name _aliases _dotnet iconv _bom _fixed; do
    case "$name" in ''|'#'*) continue ;; esac
    [ "$name" = "iana" ] && continue
    if [ "$name" = "$iana" ]; then printf '%s' "$iconv"; return 0; fi
  done <"$file"
  printf '%s' "$iana"
}

# ---------------------------------------------------------------------------
# Byte-level text model. A document records everything needed to write the file
# back exactly as it was apart from the intended change.
# ---------------------------------------------------------------------------
DOC_PATH=""
DOC_CHARSET=""
DOC_BOM=""
DOC_EOL=""
DOC_SIZE=0

detect_charset() {
  # detect_charset <file> -> prints "<iana> <bom-bytes>" with bom '-' when absent.
  local file="$1"
  local head
  head="$(LC_ALL=C od -An -tx1 -N4 "$file" | tr -d ' \n')"
  case "$head" in
    efbbbf*) printf 'utf-8-bom 3'; return ;;
    fffe0000*) printf 'utf-32le 4'; return ;;
    0000feff*) printf 'utf-32be 4'; return ;;
    fffe*) printf 'utf-16le 2'; return ;;
    feff*) printf 'utf-16be 2'; return ;;
  esac
  # Skip the BOM bytes and test validity as UTF-8, then GBK, then fall back to latin1.
  local body
  body="$(mktemp)"
  tail -c +1 "$file" >"$body"
  if iconv -f UTF-8 -t UTF-8 "$body" >/dev/null 2>&1; then
    rm -f "$body"; printf 'utf-8 -'; return
  fi
  if iconv -f GBK -t UTF-8 "$body" >/dev/null 2>&1; then
    rm -f "$body"; printf 'gbk -'; return
  fi
  rm -f "$body"
  printf 'latin1 -'
}

load_doc() {
  # load_doc <path> - populates the DOC_* globals, failing like the Windows reader.
  local path="$1"
  if [ ! -e "$path" ]; then
    fail E_NOT_FOUND "cannot read '$path': not found"
  fi
  if [ -d "$path" ]; then
    fail E_NOT_A_FILE "cannot read '$path': not a regular file"
  fi
  local detected iana bom
  detected="$(detect_charset "$path")"
  iana="${detected% *}"
  bom="${detected##* }"
  DOC_PATH="$path"
  DOC_CHARSET="$iana"
  DOC_BOM="$bom"
  DOC_SIZE="$(wc -c <"$path" | tr -d ' ')"
  # Binary detection: a NUL byte in the first 8 KiB, once past any BOM.
  #
  # The bytes must stay separated while looking for "00". Joining the od output into one string (the
  # obvious `tr -d ' \n'`) lets a NUL match across a byte boundary -- "b0 0a" becomes "b00a" -- so
  # ordinary UTF-8 text is misreported as binary. Matching per whitespace-delimited token avoids it.
  local skip=0
  [ "$bom" != "-" ] && skip="$bom"
  local nul
  nul="$(LC_ALL=C od -An -v -tx1 -j "$skip" -N 8192 "$path" | LC_ALL=C tr ' ' '\n' | LC_ALL=C grep -c '^00$' || true)"
  if [ "${nul:-0}" -gt 0 ]; then
    case "$iana" in
      utf-16le|utf-16be|utf-32le|utf-32be) : ;;
      *) fail E_BINARY_CONTENT "cannot read '$path' as text: the content looks binary" ;;
    esac
  fi
  # Line ending convention, from the first 4 KiB.
  local crlf
  crlf="$(LC_ALL=C head -c 4096 "$path" | LC_ALL=C tr -cd '\r' | wc -c | tr -d ' ')"
  if [ "$crlf" -gt 0 ]; then DOC_EOL="crlf"; else DOC_EOL="lf"; fi
}

doc_text() {
  # Decode the body (BOM excluded) to UTF-8 on stdout.
  local skip=0
  [ "$DOC_BOM" != "-" ] && skip="$DOC_BOM"
  local tmp
  tmp="$(mktemp)"
  tail -c "+$((skip + 1))" "$DOC_PATH" >"$tmp"
  local from
  from="$(iconv_name_for "$DOC_CHARSET")"
  iconv -f "$from" -t UTF-8 "$tmp" 2>/dev/null || cat "$tmp"
  rm -f "$tmp"
}

write_doc_bytes() {
  # write_doc_bytes <file> <bytes-file> - atomic replace via a sibling temporary.
  local target="$1" src="$2"
  local dir
  dir="$(dirname "$target")"
  if [ ! -d "$dir" ]; then
    fail E_NO_PARENT "cannot write '$target': directory '$dir' does not exist"
  fi
  local tmp="$dir/.dsh-os-$$.tmp"
  cp "$src" "$tmp"
  mv -f "$tmp" "$target"
}

rewrite_doc() {
  # rewrite_doc <text-file> - re-encode using the document's charset, BOM and EOL.
  local textfile="$1"
  local dir tmp payload
  dir="$(dirname "$DOC_PATH")"
  tmp="$(mktemp)"
  # Normalize to LF first so CRLF restoration is idempotent.
  LC_ALL=C sed 's/\r$//' "$textfile" >"$tmp"
  if [ "$DOC_EOL" = "crlf" ]; then
    local crlf
    crlf="$(mktemp)"
    LC_ALL=C awk '{ printf "%s\r\n", $0 }' "$tmp" >"$crlf"
    mv "$crlf" "$tmp"
  fi
  local from
  from="$(iconv_name_for "$DOC_CHARSET")"
  payload="$(mktemp)"
  if [ "$DOC_CHARSET" = "utf-8" ] || [ "$DOC_CHARSET" = "utf-8-bom" ]; then
    cp "$tmp" "$payload"
  else
    iconv -f UTF-8 -t "$from" "$tmp" >"$payload" 2>/dev/null || {
      rm -f "$tmp" "$payload"
      fail E_ENCODING_INVALID "content cannot be represented in $DOC_CHARSET"
    }
  fi
  if [ "$DOC_BOM" != "-" ]; then
    local withbom
    withbom="$(mktemp)"
    case "$DOC_CHARSET" in
      utf-8-bom) printf '\357\273\277' >"$withbom" ;;
      utf-16le) printf '\377\376' >"$withbom" ;;
      utf-16be) printf '\376\377' >"$withbom" ;;
      utf-32le) printf '\377\376\000\000' >"$withbom" ;;
      utf-32be) printf '\000\000\376\377' >"$withbom" ;;
    esac
    cat "$payload" >>"$withbom"
    mv "$withbom" "$payload"
  fi
  write_doc_bytes "$DOC_PATH" "$payload"
  rm -f "$tmp" "$payload"
}
