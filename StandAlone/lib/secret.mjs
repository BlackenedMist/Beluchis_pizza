// Secrets in .env can be stored two ways:
//
//   SOURCE_PIN=<the pin>                 plain, readable by anyone with the file
//   SOURCE_PIN_ENC=AQAAANCMnd8BF...      protected with Windows DPAPI
//
// DPAPI (Data Protection API) encrypts the value against this Windows machine
// and this Windows user account. Nothing else can decrypt it: not a backup on
// another PC, not a shared folder, not a copy of the zip. That is the point -
// .env is the one file in this app that holds the website admin PIN and the
// kitchen page password, and it should not survive being copied anywhere.
//
// Only LocalMachine scope is used, because the bridge runs as SYSTEM via the
// scheduled task and a per-user blob could not be decrypted by it. That also
// means any account on this PC could decrypt it - this protects the file in
// transit and at rest, not against a local attacker.
//
// If a value is already stored as KEY_ENC it is used as-is, and a plain KEY=
// line is left alone, so an unencrypted .env keeps working. Run
// protect-secrets.bat to encrypt the plain ones.
import { execFileSync } from 'node:child_process';

// Any KEY that may be stored protected. The bridge reads these straight out of
// process.env, so all this has to do is put the plaintext back before anything
// else looks at it.
export const SECRET_KEYS = ['SOURCE_PIN', 'BRIDGE_PASSWORD'];

// DPAPI is reached through PowerShell because Node has no built-in binding for
// it and the app carries no dependencies on purpose. The plaintext comes back
// base64-encoded so that a password containing quotes, newlines or non-ASCII
// characters cannot be mangled by the shell or by PowerShell's output encoding.
const UNPROTECT = [
  'Add-Type -AssemblyName System.Security',
  '$b = [Convert]::FromBase64String($env:BELUCHIS_B64)',
  '$p = [Security.Cryptography.ProtectedData]::Unprotect($b, $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)',
  'if ($null -eq $p) { throw "DPAPI returned nothing - the value was not protected on this machine." }',
  '[Convert]::ToBase64String($p)'
].join('; ');

function unprotect(ciphertext) {
  const stdout = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', UNPROTECT],
    { env: { ...process.env, BELUCHIS_B64: ciphertext }, encoding: 'utf8', windowsHide: true }
  );
  return Buffer.from(String(stdout).trim(), 'base64').toString('utf8');
}

// Decrypts every KEY_ENC into its plain KEY. Runs before the rest of the
// server module body, so BRIDGE_PASSWORD is already correct by the time it is
// read at the top of server.mjs, and SOURCE_PIN is correct by the time the
// poller logs in.
export function restoreSecrets() {
  const restored = [];
  for (const key of SECRET_KEYS) {
    const ciphertext = process.env[`${key}_ENC`];
    if (!ciphertext) continue;
    let plain;
    try {
      plain = unprotect(ciphertext.trim());
    } catch (err) {
      const detail = String(err.stderr || err.message).split(/\r?\n/).find((l) => l.trim()) || err.message;
      throw new Error(
        `Cannot decrypt ${key}_ENC from .env: ${detail.trim()}\n` +
        'This file was protected on a different Windows machine or account, or the\n' +
        'value is damaged. Open .env in Notepad, delete the ' + key + '_ENC= line, type\n' +
        `${key}= followed by the real value, then double-click start-kitchen.bat.`
      );
    }
    process.env[key] = plain;
    restored.push(key);
  }
  return restored;
}