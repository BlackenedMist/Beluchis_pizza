# Encrypt the secrets in .env using Windows DPAPI.
#
# Rewrites any plain value in .env as KEY_ENC=<protected>, so the website admin
# PIN and the kitchen page password are not sitting in the file in readable
# text. The bridge decrypts them at startup - see lib/secret.mjs.
#
# DPAPI binds the value to THIS Windows machine and account, so an encrypted
# .env cannot be copied to another computer (each machine runs this once on its
# own file). Values already stored as KEY_ENC are left alone, and the script is
# safe to run more than once.
#
# To see or change a secret afterwards, open .env in Notepad: replace the
# KEY_ENC= line with KEY= and the real value, then run this again.
#
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File protect-secrets.ps1
#         (or just double-click protect-secrets.bat)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

# ProtectedData lives in System.Security.dll, which PowerShell does not load by
# default.
Add-Type -AssemblyName System.Security

$envFile = Join-Path $PSScriptRoot '.env'

if (-not (Test-Path -LiteralPath $envFile)) {
  Write-Host '.env is missing. Run start-kitchen.bat once to create it.' -ForegroundColor Red
  exit 1
}

# Keep these in step with SECRET_KEYS in lib/secret.mjs.
$secretKeys = @('SOURCE_PIN', 'BRIDGE_PASSWORD')

# Values are written back as plain KEY= lines, so a hand-edited .env (or one
# carrying Windows line endings with stray spaces) has to be read as-is rather
# than through Node's .env parser.
$lines = [IO.File]::ReadAllLines($envFile)
$changed = @()

for ($i = 0; $i -lt $lines.Count; $i++) {
  foreach ($key in $secretKeys) {
    $encKey = "$key`_ENC"
    if ($lines[$i] -match "^\s*$([regex]::Escape($key))\s*=") {
      $value = ($lines[$i] -split '=', 2)[1].Trim()
      if ($value -eq '') { continue }
      if ($value.StartsWith('"') -and $value.EndsWith('"')) { $value = $value.Substring(1, $value.Length - 2) }
      if ($value -eq '') { continue }

      $plain = [Text.Encoding]::UTF8.GetBytes($value)
      $blob = [Security.Cryptography.ProtectedData]::Protect(
        $plain, $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)

      $lines[$i] = "$encKey=$([Convert]::ToBase64String($blob))"
      $changed += "$key -> $encKey"
    }
  }
}

if ($changed.Count -eq 0) {
  Write-Host 'Nothing to do - no plain secrets left in .env.' -ForegroundColor Green
  exit 0
}

[IO.File]::WriteAllLines($envFile, $lines)

Write-Host ''
foreach ($c in $changed) { Write-Host "  protected: $c" -ForegroundColor Green }
Write-Host ''
Write-Host 'Done. Restart the bridge (restart-service.bat) to use them.' -ForegroundColor Green
exit 0