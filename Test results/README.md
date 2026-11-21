# Beluchis order/state test battery

One-shot battery scheduled for **23:50 tonight**. It exercises the live order
API and order states, then renders every resulting order through both receipt
builders and saves all slip data.

## Run

Manual (does not remove the scheduled task or the secrets file):
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Beluchis_pizza\Test results\run-battery.ps1"
```

Install / re-install the one-shot task (needs administrator):
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Beluchis_pizza\Test results\install-task.ps1"
```

## Results

Each run writes `Test results\YYYY-MM-DD_HH-mm-ss\`:

- `summary.md` — pass/fail table
- `summary.json` — machine-readable result, order IDs, slip folder names
- `log.txt` — full run log
- `raw\*.json` — the exact order objects sent to the renderers
- `slips\NN-<test>\` — one folder per test:
  - `receipt-standalone.txt`, `receipt-kitchen.txt`
  - `segments-standalone.json`, `segments-kitchen.json`
  - `card.txt` (kitchen-page card as text)
  - `asserts.json` (PAID/FREE, Promotion, Discount, Tip, no `[object Object]`, etc.)
  - `no-slip.json` for tests that are rejected by design

## Isolation

- All test orders carry `notes = "Test_Data | <test> | <run id>"`.
- A dedicated 100% coupon `TESTDATA100` makes food `R0` (tips remain real only
  in the tip test, where they are asserted).
- A dedicated customer account `testdata_battery_customer` is used for delivery.
- Test records are **kept** and tagged `Test_Data`.

## Cleanup

After the scheduled run, the script deletes `.secrets\admin-pin.txt` and
unregisters `BeluchisTestBattery`, so it runs **once and once only**.
