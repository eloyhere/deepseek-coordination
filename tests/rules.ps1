# rules.ps1 - the verb layer's enforcement of the stored permission rules.
#
# WHY THIS SUITE EXISTS
#
# `permission.json` was written by the consent delegate and read by `permission.list` / `permission.query`
# for display only: no verb consulted a rule before acting, so a `deny-always` stopped nothing. Adding the
# enforcement produced two silent faults that only a real end-to-end run could show, and both are pinned
# here:
#
#   1. THE VERB HAS TWO SPELLINGS. Every call site passes the human form with spaces ("file delete"),
#      because that is what the error text shows, while `permission.json` and `permission.query` use the
#      table form with dots ("file.delete"). Comparing them directly made every rule fail to match, and a
#      rule that never matches is indistinguishable from no rule at all.
#   2. DENY MUST WIN OVER `--allow`. A deny that the flag could overrule is a rule that does not deny.
#      The check therefore runs BEFORE the flag, not after it.
#
# The suite drives the ASSEMBLED artefact rather than the modules, because that is what ships and because
# the functions span two modules that are assembled in a specific order.
param(
  # $PSScriptRoot is this file's directory (tests/), so the repository root is ONE level up.
  [string]$Repo = (Split-Path -Parent $PSScriptRoot)
)
$ErrorActionPreference = 'Stop'
$passes = 0
$failures = 0
function Ok  { param($m) $script:passes++;   Write-Host "  PASS  $m" }
function Bad { param($m) $script:failures++; Write-Host "  FAIL  $m" }

$artefact = Join-Path $Repo 'src\host\bin\dsh-os.ps1'
$permissionFile = Join-Path $Repo 'permission.json'
if (-not (Test-Path $artefact)) { Write-Host "artefact missing: $artefact"; exit 1 }

# The original bytes, so the suite can never leave a rule behind for the next run.
$original = [System.IO.File]::ReadAllBytes($permissionFile)

function Write-Rules {
  param([string]$RulesJson, [string]$UpdatedBy = 'consent-delegate')
  $doc = '{"version":1,"updatedAt":"2026-10-13T00:00:00.000Z","updatedBy":"' + $UpdatedBy + '","defaults":{"readOnly":"allow","mutating":"ask"},"rules":' + $RulesJson + ',"audit":[]}'
  [System.IO.File]::WriteAllText($permissionFile, $doc, (New-Object System.Text.UTF8Encoding($false)))
}

function Invoke-Verb {
  param([string[]]$VerbArgs)
  $stdout = & powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $artefact @VerbArgs 2>$null
  $text = ($stdout | Out-String).Trim()
  $code = $null
  if ($text -match '"code":"([^"]+)"') { $code = $matches[1] }
  return [pscustomobject]@{ Text = $text; Code = $code; Ok = ($text -match '"ok":true') }
}

function New-ProbeFile {
  $p = Join-Path $env:TEMP ("dshrules-" + [guid]::NewGuid().ToString('N') + ".txt")
  [System.IO.File]::WriteAllText($p, 'x')
  return $p
}

Write-Host "permission rule enforcement for $Repo"

try {
  # ---------------------------------------------------------------------------
  Write-Host "`n== 1. a deny rule refuses the verb EVEN WITH --allow =="
  $deny = '[{"id":"r-0001","verb":"file.delete","target":{"kind":"any","value":"*"},"scope":{"kind":"user"},"decision":"deny-always","grantedBy":"consent-delegate","grantedAt":"2026-10-13T00:00:00.000Z","expiresAt":null,"note":"t","broad":true}]'
  Write-Rules -RulesJson $deny
  $f = New-ProbeFile
  $r = Invoke-Verb @('file', 'delete', $f, '--allow')
  if ($r.Code -eq 'E_PERMISSION_DENIED_BY_RULE') { Ok "deny-always wins over --allow (E_PERMISSION_DENIED_BY_RULE)" }
  else { Bad "expected E_PERMISSION_DENIED_BY_RULE, got $($r.Code) :: $($r.Text)" }
  if (Test-Path -LiteralPath $f) { Ok 'the denied file was not deleted' } else { Bad 'the denied file WAS deleted' }
  Remove-Item $f -Force -ErrorAction SilentlyContinue

  # The spelling trap, stated as its own case: the rule is stored with a dot and the verb arrives with a
  # space. A suite that only ever fed one spelling would pass while enforcement did nothing.
  if ($r.Code -eq 'E_PERMISSION_DENIED_BY_RULE') { Ok 'the dotted rule matched the space-spelled verb (the two spellings are normalised)' }
  else { Bad 'the dotted rule did not match the space-spelled verb -- the spelling normalisation is gone' }

  # ---------------------------------------------------------------------------
  Write-Host "`n== 2. a namespace rule covers every verb beneath it =="
  $ns = '[{"id":"r-0001","verb":"file.*","target":{"kind":"any","value":"*"},"scope":{"kind":"user"},"decision":"deny-always","grantedBy":"consent-delegate","grantedAt":"2026-10-13T00:00:00.000Z","expiresAt":null,"note":"t","broad":true}]'
  Write-Rules -RulesJson $ns
  $f = New-ProbeFile
  $del = Invoke-Verb @('file', 'delete', $f, '--allow')
  $mkdirTarget = Join-Path $env:TEMP ("dshrules-dir-" + [guid]::NewGuid().ToString('N'))
  $mk = Invoke-Verb @('file', 'mkdir', $mkdirTarget, '--allow')
  Remove-Item $f -Force -ErrorAction SilentlyContinue
  Remove-Item $mkdirTarget -Force -ErrorAction SilentlyContinue
  if ($del.Code -eq 'E_PERMISSION_DENIED_BY_RULE' -and $mk.Code -eq 'E_PERMISSION_DENIED_BY_RULE') { Ok 'file.* denies file.delete and file.mkdir alike' }
  else { Bad "namespace denial incomplete: delete=$($del.Code) mkdir=$($mk.Code)" }

  # ---------------------------------------------------------------------------
  Write-Host "`n== 3. a deny does not leak to verbs it does not name =="
  # The fixture is written HERE rather than inherited from case 2. Case 2 leaves a `file.*` rule behind,
  # and under that rule a denied `file.create` is CORRECT — so a case that asserts the opposite has to
  # state its own rules. Reading a sibling case's leftovers made this fail for the wrong reason.
  Write-Rules -RulesJson $deny
  $f = New-ProbeFile
  # file.delete is denied, so a write to a DIFFERENT path must still succeed.
  $keep = Join-Path $env:TEMP ("dshrules-keep-" + [guid]::NewGuid().ToString('N') + ".txt")
  $create = Invoke-Verb @('file', 'create', $keep, 'hello', 'utf-8', '--allow')
  if ($create.Ok) { Ok 'an unrelated verb is unaffected by a deny on file.delete' } else { Bad "file.create was blocked by a file.delete rule: $($create.Text)" }
  Remove-Item $f, $keep -Force -ErrorAction SilentlyContinue

  # ---------------------------------------------------------------------------
  Write-Host "`n== 4. allow-always still requires --allow (the rule is the standing permission, the flag is the call) =="
  $allow = '[{"id":"r-0001","verb":"file.delete","target":{"kind":"any","value":"*"},"scope":{"kind":"user"},"decision":"allow-always","grantedBy":"consent-delegate","grantedAt":"2026-10-13T00:00:00.000Z","expiresAt":null,"note":"t","broad":true}]'
  Write-Rules -RulesJson $allow
  $f = New-ProbeFile
  $withoutFlag = Invoke-Verb @('file', 'delete', $f)
  if ($withoutFlag.Code -eq 'E_PERMISSION') { Ok 'without --allow the call is still refused (E_PERMISSION)' }
  else { Bad "expected E_PERMISSION without the flag, got $($withoutFlag.Code)" }
  $withFlag = Invoke-Verb @('file', 'delete', $f, '--allow')
  if ($withFlag.Ok) { Ok 'with --allow the allowed verb proceeds' }
  else { Bad "an allow-always rule did not let the call through: $($withFlag.Text)" }
  Remove-Item $f -Force -ErrorAction SilentlyContinue

  # ---------------------------------------------------------------------------
  Write-Host "`n== 5. deny is evaluated before allow, whatever order they were appended in =="
  $bothDenyFirst = '[{"id":"r-0001","verb":"file.delete","target":{"kind":"any","value":"*"},"scope":{"kind":"user"},"decision":"deny-always","grantedBy":"delegate","grantedAt":"2026-10-13T00:00:00.000Z","expiresAt":null,"note":null,"broad":true},{"id":"r-0002","verb":"file.delete","target":{"kind":"any","value":"*"},"scope":{"kind":"user"},"decision":"allow-always","grantedBy":"delegate","grantedAt":"2026-10-13T00:00:00.000Z","expiresAt":null,"note":null,"broad":true}]'
  $bothAllowFirst = '[{"id":"r-0002","verb":"file.delete","target":{"kind":"any","value":"*"},"scope":{"kind":"user"},"decision":"allow-always","grantedBy":"delegate","grantedAt":"2026-10-13T00:00:00.000Z","expiresAt":null,"note":null,"broad":true},{"id":"r-0001","verb":"file.delete","target":{"kind":"any","value":"*"},"scope":{"kind":"user"},"decision":"deny-always","grantedBy":"delegate","grantedAt":"2026-10-13T00:00:00.000Z","expiresAt":null,"note":null,"broad":true}]'
  $results = @()
  foreach ($rules in @($bothDenyFirst, $bothAllowFirst)) {
    Write-Rules -RulesJson $rules
    $f = New-ProbeFile
    $results += (Invoke-Verb @('file', 'delete', $f, '--allow')).Code
    Remove-Item $f -Force -ErrorAction SilentlyContinue
  }
  if (($results | Where-Object { $_ -ne 'E_PERMISSION_DENIED_BY_RULE' }).Count -eq 0) { Ok 'deny wins in both append orders' }
  else { Bad "append order changed the answer: $($results -join ' / ')" }

  # ---------------------------------------------------------------------------
  Write-Host "`n== 6. a rule whose target names one path does not deny every path =="
  $scoped = '[{"id":"r-0001","verb":"file.delete","target":{"kind":"path","value":"C:\\exactly\\this\\one.txt"},"scope":{"kind":"user"},"decision":"deny-always","grantedBy":"delegate","grantedAt":"2026-10-13T00:00:00.000Z","expiresAt":null,"note":null,"broad":false}]'
  Write-Rules -RulesJson $scoped
  $f = New-ProbeFile
  $elsewhere = Invoke-Verb @('file', 'delete', $f, '--allow')
  if ($elsewhere.Ok) { Ok 'a path-scoped rule leaves other paths alone' }
  else { Bad "a path-scoped rule denied an unrelated path: $($elsewhere.Text)" }
  Remove-Item $f -Force -ErrorAction SilentlyContinue

  # ---------------------------------------------------------------------------
  Write-Host "`n== 7. an untrusted file falls back to defaults instead of denying =="
  $forged = '[{"id":"r-0001","verb":"file.delete","target":{"kind":"any","value":"*"},"scope":{"kind":"user"},"decision":"deny-always","grantedBy":"somebody-else","grantedAt":"2026-10-13T00:00:00.000Z","expiresAt":null,"note":null,"broad":true}]'
  Write-Rules -RulesJson $forged -UpdatedBy 'not-the-delegate'
  $f = New-ProbeFile
  $r = Invoke-Verb @('file', 'delete', $f, '--allow')
  if ($r.Ok) { Ok 'a file not written by the delegate is not trusted, so its deny does not apply' }
  else { Bad "an untrusted file was honoured: $($r.Text)" }
  Remove-Item $f -Force -ErrorAction SilentlyContinue
}
finally {
  # Always restore, even on a throw: a suite that leaves a deny rule behind would break every later run.
  [System.IO.File]::WriteAllBytes($permissionFile, $original)
}

Write-Host ''
Write-Host "passed=$passes failed=$failures"
if ($failures -gt 0) { exit 1 }
