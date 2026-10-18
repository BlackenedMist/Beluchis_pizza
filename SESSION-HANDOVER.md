# Session Handover — 2026-10-18

Git update + kitchen bridge configuration. **Everything below is done and
verified except the push.** Details and history live in `update_precheck.md`.

## Start here tomorrow

```powershell
cd C:\Beluchis_pizza
git status -sb            # expect: ahead 2
git push origin main      # THE ONE OUTSTANDING TASK
```

Two commits are local and unpushed:

| Commit | What |
|---|---|
| `5ff0492` | Fix task install (LogonType), DPAPI-encrypt `.env`, SMB printer type |
| `61c3e9e` | Fix `check-env.bat` false "bridge not running" |

If you have a real GitHub PAT, paste it and I will do a one-off push without
writing it to disk. Otherwise run the command above yourself — it is instant.

## Is it working right now? Yes

| Check | Result |
|---|---|
| Site | `https://beluchis.co.za` |
| Poll | `ok:true`, `lastError` empty, forced poll `ms:188` |
| Admin PIN | server **and** bridge on the new PIN, both verified |
| Scheduled task | `BeluchisKitchen`, Running, SYSTEM, at system start-up |
| Port 3101 | listening `0.0.0.0`, firewall allow-In |
| Node | 22.23.2 in `StandAlone\bin\`, SHA256 verified |
| `check-env.bat` | every section `[ ok ]` |
| Kitchen page | `http://10.0.0.50:3101/` — password required, see below |

Kitchen page password is unchanged from this session. It is **not** written in
this repo — it is stored encrypted as `BRIDGE_PASSWORD_ENC` in
`StandAlone\.env`, and a plaintext copy sits in the backup folder below. Ask me
for it, or run `protect-secrets` to rotate it.

## Three things to decide, not blockers

1. **Target printer.** Currently `PIZZA (Kitchen)` = `192.168.1.114`. The other
   printer `10.0.0.7` is **not** the target. Only one target is supported by
   design. If you want both printing every order, that needs a small code change
   to `lib/poller.mjs` (`target()` returns one printer; `printOrder` sends one).
2. **Did paper come out of both?** Both test jobs returned `ok:true`, which only
   proves the printer accepted the bytes. `10.0.0.7` took 1962 ms vs 4 ms — check
   it isn't out of paper or ribbon.
3. **Overnight pace.** After 21:00 the bridge polls every 30 min, not every 60s.
   Orders placed overnight wait up to half an hour. Change it in Settings.

## If the server PIN changes again

Change it in `/opt/beluchis/.env` on `154.65.100.89` **and** in
`StandAlone\.env` in the same session, then `restart-service.bat`. Miss the
second half and every poll fails `401` — the kitchen just quietly stops printing.

To change the bridge value: open `StandAlone\.env` in Notepad, delete the
`SOURCE_PIN_ENC=` line, write `SOURCE_PIN=` + the value, save, run
`protect-secrets.bat`, then `restart-service.bat`.

## Things that will bite if forgotten

- **DPAPI is machine-bound.** An encrypted `.env` cannot be unlocked on another
  PC. Moving the bridge to the kitchen machine means typing both values in again.
  This is deliberate, not a fault.
- **`build-windows.sh` does not run here** — no `zip` and `python3` resolves to
  the Windows Store stub. The 1.0.1 zip was built with PowerShell
  `Compress-Archive` instead. Same contents.
- **A GitHub PAT is `ghp_`/`github_pat_` prefixed or 40 hex chars.** The value
  given this session was not, so the push never authenticated.

## Files worth reading

| File | Why |
|---|---|
| `update_precheck.md` | Full state, DNS/TLS status, every bug found, open items |
| `StandAlone/README-WINDOWS.txt` | What the kitchen-PC installer sees |
| `StandAlone/lib/secret.mjs` | How `.env` encryption/decryption works |
| `StandAlone/protect-secrets.ps1` | The `.env` protector |

## Backups

`%TEMP%\opencode\beluchis-backup-20261018\`
- Everything from before the restructure, including the old 34 MB 1.0.0 zip
- `.env.plaintext` — **contains the working PIN and page password in clear
  text.** Delete it once you are satisfied the encrypted setup is solid.

Release package: `StandAlone\dist\Beluchis-Kitchen-1.0.1-windows-x64.zip` (46 KB,
no binaries, fetches Node on first run, no secrets inside).