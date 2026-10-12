# Module: command.ps1 - argument parsing, named-argument folding, assertions and int coercion.

# ---------------------------------------------------------------------------
# Argument parsing.
#   positionals: every token that is not a flag and not a flag value.
#   flags:       --name, or --name value when the name is a known value-taking flag.
#   named:       name="value", folded into the positional list by Merge-NamedArguments below.
# Unknown flags are a usage error so typos cannot silently become positionals.
# ---------------------------------------------------------------------------

$script:ValueFlags = @(
  'encoding', 'eol', 'button', 'count', 'space', 'out', 'screen', 'format',
  'workdir', 'env', 'stdin', 'timeout', 'interval', 'method', 'pid',
  'name', 'max-bytes', 'max-chars', 'depth', 'source', 'bom', 'text', 'charset',
  # round 2
  'length', 'sha256', 'limit', 'filter', 'scope', 'index', 'decision', 'delegate', 'args',
  # round 3: environment attributes
  'attr', 'value'
)

# Every accepted flag, value-taking or boolean. Kept next to ValueFlags so a new verb cannot add a
# flag without registering it here; spec/verbs.tsv is the documented counterpart.
$script:KnownFlags = @(
  $script:ValueFlags +
  'allow', 'pretty', 'quiet', 'json', 'backup', 'permanent', 'parents', 'no-recursive',
  'no-numbers', 'with-numbers', 'force', 'hold', 'clearmodifiers', 'exact', 'absent', 'z-order', 'shell',
  'background', 'regex', 'recursive'
)

# Membership tests for flag and verb names are ORDINAL, not `-contains`.
#
# From .NET 5 an ignorable character compares equal to almost anything on PowerShell 7, so
# @('allow') -contains "allow`a" is True: a typo carrying a stray control byte would be accepted as
# --allow, and a name that is not in the table could select a flag that is. Verified on 7.6.6.
# The explicit loop is [string]::Equals(...Ordinal) because [System.Array]::IndexOf does not bind its
# 3-argument (Array, object, IComparer) overload from PowerShell here - the array arrives wrapped in
# PSObject - and this is the same shape dispatch.ps1 already uses for its verb-key scan.
function Test-FlagName {
  param($Set, [string]$Name)
  foreach ($item in $Set) {
    if ([string]::Equals($item, $Name, [System.StringComparison]::Ordinal)) { return $true }
  }
  return $false
}

function Parse-Arguments {
  param([string[]]$Argv)
  $positionals = [System.Collections.ArrayList]::new()
  # A plain hashtable stays the right container: PowerShell hashtables are case-insensitive, which is
  # what flag and named-argument lookup has always relied on, and the 5.1 code did the same.
  $flags = @{}
  $named = @{}
  $i = 0
  while ($i -lt $Argv.Length) {
    $tok = $Argv[$i]
    # if/elseif is kept here rather than switch. The 5.1 code needed it because `switch` on a STRING
    # iterates the string character by character in its wildcard/regex forms, so a token such as
    # "--allow" could match a pattern it should not. That is a PowerShell language behaviour, not a
    # 5.1 quirk, so it is unchanged in 7.6 and the if/elseif form remains the safer one.
    #
    # The two tests here are safe from the ignorable-character trap: StartsWith is an ordinal .NET
    # call, and `-match` was verified on 7.6.6 not to ignore control characters (unlike -eq, -ceq,
    # -like and -contains, which all do). The flag table lookups below are the ones that had to change.
    if ($tok.Length -ge 2 -and $tok.StartsWith('--')) {
      $name = $tok.Substring(2)
      if ($name.Length -eq 0) { throw (New-OsError -Code 'E_USAGE' -Message 'empty flag "--"' ) }
      if (-not (Test-FlagName -Set $script:KnownFlags -Name $name)) {
        # A typo such as --alow must not silently become a no-op: it would look like a successful
        # call that did nothing, which is exactly the class of failure this layer exists to remove.
        throw (New-OsError -Code 'E_USAGE' -Message ("unknown flag --{0}" -f $name) `
            -Hint 'run: dsh-os7 selfcheck   (lists every accepted flag)')
      }
      if (Test-FlagName -Set $script:ValueFlags -Name $name) {
        if ($i + 1 -ge $Argv.Length) {
          throw (New-OsError -Code 'E_USAGE' -Message ("flag --{0} requires a value" -f $name))
        }
        $val = $Argv[$i + 1]
        # One occurrence stores a string, a repeat stores an array of them. Callers depend on that
        # exact shape (a single --style is a string, several are an array), so the accumulation is
        # preserved as written rather than normalised to always-array.
        if ($flags.ContainsKey($name)) { $flags[$name] = @($flags[$name]) + $val } else { $flags[$name] = $val }
        $i += 2
      } else {
        $flags[$name] = $true
        $i += 1
      }
    } elseif ($tok -match '^([A-Za-z][A-Za-z0-9_-]*)=(.*)$') {
      # Named argument form: file create path="./a.txt" content="123" charset="utf-8-bom".
      # The value keeps whatever the caller passed after '=' (quotes are consumed by the shell or by
      # the caller's own quoting, exactly as for a positional).
      $key = $Matches[1]
      $val = $Matches[2]
      if ($named.ContainsKey($key)) {
        throw (New-OsError -Code 'E_USAGE' -Message ("named argument '{0}' was given more than once" -f $key))
      }
      $named[$key] = $val
      $i += 1
    } else {
      [void]$positionals.Add($tok)
      $i += 1
    }
  }
  return @{ positionals = $positionals.ToArray(); flags = $flags; named = $named }
}

# Declared positional names for a verb, in order, from spec/verbs.tsv.
$script:VerbParams = @{}

function Get-VerbParams {
  param([string]$VerbKey)
  if ($script:VerbParams.Count -eq 0) {
    $path = Join-Path $script:HostDir 'spec\verbs.tsv'
    if (Test-Path -LiteralPath $path) {
      foreach ($line in [System.IO.File]::ReadAllLines($path, $script:NoBom)) {
        if ($line -eq '' -or $line.StartsWith('#') -or $line.StartsWith('verb')) { continue }
        $f = $line -split "`t"
        if ($f.Count -lt 2) { continue }
        $names = @()
        if ($f[1] -ne '-') { $names = @($f[1] -split '\|') }
        $script:VerbParams[$f[0]] = $names
      }
    }
  }
  # Return the array plainly and let the caller wrap it in @(). Doing BOTH (unary comma here plus
  # @() at the call site) nests the array, so $declared[0] becomes the whole array and every name
  # lookup misses. The @() at the call site is what protects against a single-name verb's list
  # being unwrapped into a bare string.
  if ($script:VerbParams.ContainsKey($VerbKey)) { return $script:VerbParams[$VerbKey] }
  return @()
}

# Merge named arguments into the positional list so every verb body can keep reading by index.
# Order comes from the verb table, so "file create charset=utf-8 path=x content=y" is equivalent to
# the positional form regardless of the order the names were written in.
function Merge-NamedArguments {
  param($Parsed, [string]$VerbKey)
  # The guard is on named arguments alone. An earlier version also entered this function for a
  # --strict-args flag and then rejected every argument that lacked literal quote characters; that
  # check could never work, because PowerShell and bash both consume an argument's quotes while
  # parsing, so a correctly quoted call is indistinguishable from an unquoted one by the time the
  # script sees it. The flag has been removed rather than left as a validator that rejects valid input.
  if ($Parsed.named.Count -eq 0) { return $Parsed }
  $declared = @(Get-VerbParams -VerbKey $VerbKey)
  if ($Parsed.named.Count -gt 0) {
    if ($declared.Count -eq 0) {
      throw (New-OsError -Code 'E_USAGE' -Message ("verb '{0}' takes no named arguments" -f $VerbKey) `
          -Hint 'named arguments are declared in spec/verbs.tsv')
    }
    # Start from the caller's positionals, then place each named value at its declared index.
    # [type]::new() rather than New-Object: the array length is known here and this is the direct
    # constructor call. Either form works; this is the house style for 7.6.
    $slots = [string[]]::new($declared.Count)
    $filled = [bool[]]::new($declared.Count)
    $posIdx = 0
    foreach ($name in $declared) {
      if ($posIdx -lt $Parsed.positionals.Length) {
        $slots[$posIdx] = [string]$Parsed.positionals[$posIdx]
        $filled[$posIdx] = $true
        $posIdx++
      }
    }
    if ($posIdx -lt $Parsed.positionals.Length) {
      throw (New-OsError -Code 'E_USAGE' -Message ("unexpected extra argument <{0}>" -f $Parsed.positionals[$posIdx]))
    }
    for ($k = 0; $k -lt $declared.Count; $k++) {
      $name = $declared[$k]
      if (-not $Parsed.named.ContainsKey($name)) { continue }
      if ($filled[$k]) {
        throw (New-OsError -Code 'E_USAGE' -Message ("'{0}' was given both positionally and by name" -f $name))
      }
      $slots[$k] = [string]$Parsed.named[$name]
      $filled[$k] = $true
    }
    foreach ($key in $Parsed.named.Keys) {
      if ($declared -notcontains $key) {
        throw (New-OsError -Code 'E_USAGE' -Message ("unknown named argument '{0}' for '{1}'" -f $key, $VerbKey) `
            -Hint ("accepted names, in order: {0}" -f ($declared -join ', ')))
      }
    }
    # Compact the slots: a gap can only appear past the end of the supplied values.
    $out = [System.Collections.ArrayList]::new()
    for ($k = 0; $k -lt $declared.Count; $k++) {
      if ($filled[$k]) { [void]$out.Add($slots[$k]) }
    }
    $Parsed.positionals = $out.ToArray()
  }
  return $Parsed
}

function Get-Positional {
  param($Parsed, [int]$Index, [string]$Name, [switch]$Optional, [string]$Default)
  if ($Index -lt $Parsed.positionals.Length) {
    $v = $Parsed.positionals[$Index]
    if ($v -eq '' -and $Optional) { return $Default }
    return $v
  }
  if ($Optional) { return $Default }
  throw (New-OsError -Code 'E_USAGE' -Message ("missing required argument <{0}>" -f $Name))
}

function Get-FlagValue {
  param($Parsed, [string]$Name, [string]$Default)
  # [string] on the way out is load-bearing: a flag given twice is an array (see Parse-Arguments), and
  # a caller expecting one value gets the joined form rather than an array that breaks its own parse.
  if ($Parsed.flags.ContainsKey($Name)) { return [string]$Parsed.flags[$Name] }
  return $Default
}

function Test-HasFlag {
  param($Parsed, [string]$Name)
  return $Parsed.flags.ContainsKey($Name)
}

function Assert-NoExtra {
  param($Parsed, [int]$Expected)
  if ($Parsed.positionals.Length -gt $Expected) {
    throw (New-OsError -Code 'E_USAGE' -Message ("unexpected extra argument <{0}>" -f $Parsed.positionals[$Expected]))
  }
}

function Assert-MinPositionals {
  param($Parsed, [int]$Min, [string]$Verb)
  if ($Parsed.positionals.Length -lt $Min) {
    throw (New-OsError -Code 'E_USAGE' -Message ("{0} requires {1} argument(s), got {2}" -f $Verb, $Min, $Parsed.positionals.Length) `
        -Hint 'run: dsh-os7 selfcheck   (lists every verb with its arguments and flags)')
  }
}

function Assert-Allowed {
  param($Parsed, [string]$Verb, [string]$Perm, [int]$Positionals = -1)
  # -ne on a single-character permission code is safe: the trap is non-printable characters inside
  # longer compared strings, and 'W'/'R' are fixed literals from the verb table.
  if ($Perm -ne 'W') { return }
  # Arity is decided before authorization: a malformed call is a usage error, and reporting
  # E_PERMISSION for it would hide the real problem and ask for consent to a call that could not
  # have run anyway.
  if ($Positionals -ge 0 -and $Parsed.positionals.Length -gt $Positionals) {
    throw (New-OsError -Code 'E_USAGE' -Message ("unexpected extra argument <{0}>" -f $Parsed.positionals[$Positionals]))
  }
  if (-not (Test-HasFlag -Parsed $Parsed -Name 'allow')) {
    throw (New-OsError -Code 'E_PERMISSION' `
        -Message ("{0} is a mutating operation and requires user authorization" -f $Verb) `
        -Hint 're-run with --allow after the user has accepted the requested operation')
  }
}

function Get-IntArg {
  param([string]$Text, [string]$Name, [switch]$AllowNegative)
  $out = 0
  # TryParse with the invariant default: an int argument is machine input, not localized text, and it
  # must not start accepting a locale's group separators now that the runtime parses them more widely.
  $ok = [int]::TryParse($Text, [ref]$out)
  if (-not $ok) {
    throw (New-OsError -Code 'E_TYPE' -Message ("<{0}> must be an integer, got '{1}'" -f $Name, $Text))
  }
  if (-not $AllowNegative -and $out -lt 0) {
    throw (New-OsError -Code 'E_TYPE' -Message ("<{0}> must not be negative, got {1}" -f $Name, $out))
  }
  return $out
}
