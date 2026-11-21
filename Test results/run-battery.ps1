param([switch]$Scheduled)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root       = Split-Path -Parent $MyInvocation.MyCommand.Path
$Base       = 'https://beluchis.co.za'
$PinFile    = Join-Path $Root '.secrets\admin-pin.txt'
$RenderScript = Join-Path $Root 'lib\Render-Slips.mjs'
$Node = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $Node)) { $Node = 'node' }
$RunId      = Get-Date -Format 'yyyyMMdd-HHmmss'
$RunDir     = Join-Path $Root (Get-Date -Format 'yyyy-MM-dd_HH-mm-ss')
$RawDir     = Join-Path $RunDir 'raw'
$SlipsDir   = Join-Path $RunDir 'slips'
$LogFile    = Join-Path $RunDir 'log.txt'
foreach ($d in @($RunDir, $RawDir, $SlipsDir)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }

$script:log = New-Object System.Collections.Generic.List[string]
function Log([string]$msg) {
  $line = "$(Get-Date -Format 'HH:mm:ss')  $msg"
  $script:log.Add($line)
  Write-Host $line
}
function Flush-Log { $script:log -join "`n" | Set-Content -Path $LogFile -Encoding UTF8 }

$script:results = New-Object System.Collections.Generic.List[object]
function Add-Result([string]$test, [bool]$ok, [string]$detail) {
  $script:results.Add([pscustomobject]@{ test = $test; pass = $ok; detail = $detail })
  Log ("{0} {1}: {2}" -f ($(if($ok){'PASS'}else{'FAIL'})), $test, $detail)
}

function Invoke-Api {
  param([string]$Method, [string]$Path, $Body, [switch]$NoSession)
  $uri = $Base + $Path
  $json = if ($null -ne $Body) { $Body | ConvertTo-Json -Depth 30 -Compress } else { $null }
  try {
    $p = @{ Method = $Method; Uri = $uri; TimeoutSec = 40; UseBasicParsing = $true }
    if ($json) { $p.ContentType = 'application/json'; $p.Body = $json }
    if (-not $NoSession) { $p.WebSession = $script:session }
    $r = Invoke-WebRequest @p
    $parsed = $null; try { $parsed = $r.Content | ConvertFrom-Json } catch { $parsed = $r.Content }
    return @{ Status = [int]$r.StatusCode; Body = $parsed }
  } catch {
    $st = 0; $txt = ''
    if ($_.Exception.Response) { $st = [int]$_.Exception.Response.StatusCode.value__ }
    if ($_.ErrorDetails) { $txt = $_.ErrorDetails.Message }
    $obj = $null; try { $obj = $txt | ConvertFrom-Json } catch { $obj = $txt }
    return @{ Status = $st; Body = $obj; Error = $txt }
  }
}

function Save-Slip {
  param($Order, [string]$Name, [int]$Index, [switch]$NoOrder, $ErrorBody)
  $prefix = "{0:d2}-{1}" -f $Index, $Name
  $dir = Join-Path $SlipsDir $prefix
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  if ($NoOrder) {
    @{ error = $ErrorBody; note = 'No slip: request was rejected by design.' } | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $dir 'no-slip.json') -Encoding UTF8
    return @{ Checks = $null; SlipOk = $true; Dir = $dir }
  }
  $file = Join-Path $RawDir ($prefix + '.json')
  $Order | ConvertTo-Json -Depth 40 | Set-Content $file -Encoding UTF8
  $output = & $Node $RenderScript $file $dir 2>&1
  $ok = ($LASTEXITCODE -eq 0)
  $checks = $null
  $af = Join-Path $dir 'asserts.json'
  if (Test-Path $af) { $checks = Get-Content $af -Raw | ConvertFrom-Json }
  Log ("  slip [{0}] {1}" -f $prefix, $(if($ok){'ok'}else{"FAILED: $output"}))
  return @{ Checks = $checks; SlipOk = $ok; Dir = $dir; Raw = $file }
}

function New-OrderBody {
  param([string]$Name, $Items, [switch]$Delivery, [int]$Tip = 0, [string]$Status = 'placed', $Extra = @{})
  $body = [ordered]@{
    firstName   = 'Test_Data'
    lastName    = 'Battery'
    cellphone   = '0600000000'
    customerId  = $script:testCustomerId
    notes       = "Test_Data | $Name | $RunId"
    couponCode  = 'TESTDATA100'
    items       = $Items
    paymentMethod = 'cod_cash'
    status      = $Status
  }
  if ($Delivery) {
    $body.deliveryLat = -33.6647163838895
    $body.deliveryLng = 19.4619794527411
    $body.deliveryAddress = 'Test_Data address'
    $body.tip = $Tip
    $body.paymentMethod = 'cod_card'
  }
  if ($Extra) { foreach ($k in $Extra.Keys) { $body[$k] = $Extra[$k] } }
  return $body
}

try {
  Log "Battery start: $RunId  ($Base)"

  # ---- auth -------------------------------------------------------------
  if (-not (Test-Path $PinFile)) { throw "PIN file missing: $PinFile" }
  $pin = (Get-Content $PinFile -Raw).Trim()
  $login = Invoke-Api -Method Post -Path '/api/auth/login' -Body @{ username = 'admin'; pin = $pin } -NoSession
  if ($login.Status -ne 200) { throw "Admin login failed: $($login.Status)" }
  $r = Invoke-WebRequest -Uri "$Base/api/auth/login" -Method Post -ContentType 'application/json' `
        -Body (@{ username='admin'; pin=$pin } | ConvertTo-Json -Compress) -SessionVariable session -UseBasicParsing -TimeoutSec 40
  $script:session = $session
  Log "Admin login OK"

  # ---- reference data ---------------------------------------------------
  $specials = (Invoke-Api -Method Get -Path '/api/specials' -NoSession).Body
  $items    = (Invoke-Api -Method Get -Path '/api/items' -NoSession).Body
  $customers = (Invoke-Api -Method Get -Path '/api/customers').Body
  $existing = $customers | Where-Object { $_.username -eq 'testdata_battery_customer' } | Select-Object -First 1
  if ($existing) { $script:testCustomerId = $existing.id }
  else {
    $new = Invoke-Api -Method Post -Path '/api/customers' -Body @{
      firstName='Test_Data'; lastName='Battery'; username='testdata_battery_customer'
      password=('TD' + $RunId + '!'); cellphone='0600000000'; email=$null
    }
    if ($new.Status -in 200,201) { $script:testCustomerId = $new.Body.id } else { throw "Test customer create failed: $($new.Status) $($new.Error)" }
  }
  $coupons = Invoke-Api -Method Get -Path '/api/loyalty/coupons'
  if (-not ($coupons.Body | Where-Object { $_.code -eq 'TESTDATA100' })) {
    $c = Invoke-Api -Method Post -Path '/api/loyalty/coupons' -Body @{
      kind='percent'; value=100; label='Test_Data 100%'; note='Nightly test battery'; usageLimit=$null
    }
    if ($c.Status -notin 200,201) { throw "Coupon create failed: $($c.Status) $($c.Error)" }
  }
  Log "Test customer #$script:testCustomerId and coupon TESTDATA100 ready"

  $allSlipChecks = @()
  $n = 0

  # ---- 1. collection basic ---------------------------------------------
  $n++
  $body = New-OrderBody -Name 'collection_basic' -Items @(@{ itemId=6; sizeLabel='L'; quantity=1 })
  $resp = Invoke-Api -Method Post -Path '/api/orders' -Body $body
  $ok = ($resp.Status -eq 201) -and ($resp.Body.grandTotal -eq 0) -and ($resp.Body.discountAmount -gt 0)
  $slip = Save-Slip -Order $resp.Body -Name 'collection_basic' -Index $n
  $allSlipChecks += $slip.Checks
  Add-Result '01_collection_basic' ($ok -and $slip.SlipOk) "status=$($resp.Status) total=$($resp.Body.grandTotal) discount=$($resp.Body.discountAmount)"

  # ---- 2. delivery with tip --------------------------------------------
  $n++
  $body = New-OrderBody -Name 'delivery_tip' -Delivery -Tip 31 -Items @(@{ itemId=6; sizeLabel='L'; quantity=1 })
  $resp = Invoke-Api -Method Post -Path '/api/orders' -Body $body
  $ok = ($resp.Status -eq 201) -and ($resp.Body.tipAmount -eq 31) -and ($resp.Body.grandTotal -eq 31)
  $slip = Save-Slip -Order $resp.Body -Name 'delivery_tip' -Index $n
  $allSlipChecks += $slip.Checks
  Add-Result '02_delivery_tip' ($ok -and $slip.SlipOk) "status=$($resp.Status) tip=$($resp.Body.tipAmount) grand=$($resp.Body.grandTotal)"

  # ---- 3. automatic deal ------------------------------------------------
  $n++
  $deal = $specials | Where-Object { $_.kind -eq 'deal' -and $_.isActive } | Select-Object -First 1
  $body = New-OrderBody -Name 'automatic_deal' -Items @(@{ itemId=6; sizeLabel='L'; quantity=2 })
  $resp = Invoke-Api -Method Post -Path '/api/orders' -Body $body
  $label = [string]$resp.Body.discountLabel
  $ok = ($resp.Status -eq 201) -and ($resp.Body.discounts.Count -gt 0) -and ($label -match 'Traditional|deal|Special')
  $slip = Save-Slip -Order $resp.Body -Name 'automatic_deal' -Index $n
  $allSlipChecks += $slip.Checks
  Add-Result '03_automatic_deal' ($ok -and $slip.SlipOk) "deal=$($deal.name) discountLabel=$label discounts=$($resp.Body.discounts.Count)"

  # ---- 4. Black Friday bundle ------------------------------------------
  $n++
  $bf = $specials | Where-Object { $_.name -like 'Black Friday*' } | Select-Object -First 1
  if ($bf) {
    $picks = @(@{ itemId=16; sizeLabel='L' }, @{ itemId=21; sizeLabel='L' }, @{ itemId=6; sizeLabel='L' })
    $body = New-OrderBody -Name 'bundle_blackfriday' -Items @(@{ specialId=$bf.id; pizzas=$picks })
    $resp = Invoke-Api -Method Post -Path '/api/orders' -Body $body
    $line = $resp.Body.items | Select-Object -First 1
    $extras = @(); if ($line.extras) { $extras = $line.extras | ConvertFrom-Json }
    $freeCount = @($extras | Where-Object { $_.free -eq $true }).Count
    $paidCount = @($extras | Where-Object { $_.paid -eq $true }).Count
    $ok = ($resp.Status -eq 201) -and ($freeCount -eq 1) -and ($paidCount -eq 2) -and
          ([string]$resp.Body.discountLabel -match 'Black Friday') -and
          (@($resp.Body.discounts | Where-Object { $_.name -like 'Black Friday*' }).Count -gt 0)
    $slip = Save-Slip -Order $resp.Body -Name 'bundle_blackfriday' -Index $n
    $allSlipChecks += $slip.Checks
    Add-Result '04_bundle_blackfriday' ($ok -and $slip.SlipOk) "free=$freeCount paid=$paidCount discountLabel=$($resp.Body.discountLabel)"
  } else {
    Add-Result '04_bundle_blackfriday' $false 'Black Friday special not found in /api/specials'
  }

  # ---- 5. BOGO / pick special (dynamic) --------------------------------
  $n++
  $sp = $specials | Where-Object { $_.kind -in @('bogo','pick') -and $_.isActive } | Select-Object -First 1
  if ($sp) {
    $candidates = @($items | Where-Object { $_.categoryId -eq $sp.categoryId -and $_.isActive -ne $false })
    $size = if ($sp.sizeLabel) { $sp.sizeLabel } else { 'L' }
    $picks = @($candidates | Select-Object -First ([int]$sp.count) | ForEach-Object { @{ itemId=$_.id; sizeLabel=$size } })
    if ($picks.Count -ge [int]$sp.count) {
      $body = New-OrderBody -Name 'bogo_pick' -Items @(@{ specialId=$sp.id; pizzas=$picks })
      $resp = Invoke-Api -Method Post -Path '/api/orders' -Body $body
      $ok = ($resp.Status -eq 201)
      $slip = Save-Slip -Order $resp.Body -Name 'bogo_pick' -Index $n
      $allSlipChecks += $slip.Checks
      Add-Result '05_bogo_pick' ($ok -and $slip.SlipOk) "special=$($sp.name) status=$($resp.Status)"
    } else { Add-Result '05_bogo_pick' $false "Not enough items for $($sp.name)" }
  } else { Add-Result '05_bogo_pick' $true 'SKIPPED: no active bogo/pick special' }

  # ---- 6. collection-only special on delivery --------------------------
  $n++
  $co = $specials | Where-Object { $_.collectionOnly -eq $true -and $_.isActive } | Select-Object -First 1
  if ($co) {
    # Explicit line-level specialId must be rejected.
    $explicit = Invoke-Api -Method Post -Path '/api/orders' -Body (New-OrderBody -Name 'collection_only_rejected' -Delivery -Items @(@{ specialId=$co.id; pizzas=@(@{ itemId=6; sizeLabel='L' }) }))
    # Automatic collection-only deals are skipped on delivery rather than rejected.
    $auto = Invoke-Api -Method Post -Path '/api/orders' -Body (New-OrderBody -Name 'collection_only_auto' -Delivery -Items @(@{ itemId=6; sizeLabel='L'; quantity=2 }))
    $label = [string]$auto.Body.discountLabel
    $ok = (($explicit.Status -eq 400) -and ([string]$explicit.Body.code -eq 'special_collection_only')) -or
          ($auto.Status -eq 201 -and $label -notlike "*$($co.name)*")
    Save-Slip -Order $null -Name 'collection_only_rejected' -Index $n -NoOrder -ErrorBody @{ explicit = $explicit.Body; automatic = $auto.Body } | Out-Null
    Add-Result '06_collection_only_rejected' $ok "explicit=$($explicit.Status)/$($explicit.Body.code) autoLabel=$label"
  } else { Add-Result '06_collection_only_rejected' $true 'SKIPPED: no collection-only special' }

  # ---- 7. negative extras rejected -------------------------------------
  $n++
  $body = New-OrderBody -Name 'negative_extras_rejected' -Items @(@{ itemId=6; sizeLabel='L'; quantity=1; extras=@(@{ name='Test_Data bad'; price=-5 }) })
  $resp = Invoke-Api -Method Post -Path '/api/orders' -Body $body
  $ok = ($resp.Status -eq 400)
  $slip = Save-Slip -Order $null -Name 'negative_extras_rejected' -Index $n -NoOrder -ErrorBody $resp.Body
  Add-Result '07_negative_extras_rejected' $ok "status=$($resp.Status) error=$($resp.Body.error)"

  # ---- 8. status lifecycle ---------------------------------------------
  $n++
  $body = New-OrderBody -Name 'status_lifecycle' -Items @(@{ itemId=6; sizeLabel='L'; quantity=1 }) -Status 'placed'
  $created = Invoke-Api -Method Post -Path '/api/orders' -Body $body
  $id = $created.Body.id
  $states = @('preparing','out_for_delivery','delivered')
  $stateOk = ($created.Status -eq 201)
  foreach ($s in $states) {
    $u = Invoke-Api -Method Put -Path "/api/orders/$id" -Body @{ status = $s }
    if ($u.Status -ne 200) { $stateOk = $false; Log "  state $s failed: $($u.Status) $($u.Error)" }
  }
  $final = Invoke-Api -Method Get -Path "/api/orders/$id"
  $stateOk = $stateOk -and ($final.Body.status -eq 'delivered')
  $slip = Save-Slip -Order $created.Body -Name 'status_lifecycle' -Index $n
  $allSlipChecks += $slip.Checks
  Add-Result '08_status_lifecycle' ($stateOk -and $slip.SlipOk) "order=$id states=$($states -join '>') final=$($final.Body.status)"

  # ---- 9. cancelled state ----------------------------------------------
  $n++
  $body = New-OrderBody -Name 'cancelled_state' -Items @(@{ itemId=6; sizeLabel='L'; quantity=1 }) -Status 'cancelled'
  $resp = Invoke-Api -Method Post -Path '/api/orders' -Body $body
  $ok = ($resp.Status -eq 201) -and ($resp.Body.status -eq 'cancelled')
  $slip = Save-Slip -Order $resp.Body -Name 'cancelled_state' -Index $n
  $allSlipChecks += $slip.Checks
  Add-Result '09_cancelled_state' ($ok -and $slip.SlipOk) "status=$($resp.Body.status)"

  # ---- 10. card on delivery payment ------------------------------------
  $n++
  $body = New-OrderBody -Name 'payment_card' -Delivery -Tip 0 -Items @(@{ itemId=6; sizeLabel='L'; quantity=1 })
  $resp = Invoke-Api -Method Post -Path '/api/orders' -Body $body
  $ok = ($resp.Status -eq 201) -and ($resp.Body.paymentMethod -eq 'cod_card')
  $slip = Save-Slip -Order $resp.Body -Name 'payment_card' -Index $n
  $allSlipChecks += $slip.Checks
  Add-Result '10_payment_card' ($ok -and $slip.SlipOk) "payment=$($resp.Body.paymentMethod)"

  # ---- 11. isolation ----------------------------------------------------
  $orders = (Invoke-Api -Method Get -Path '/api/orders').Body
  $mine = @($orders | Where-Object { $_.notes -like "Test_Data | $RunId*" })
  $bad = @($mine | Where-Object { $_.grandTotal -ne 0 -and $_.tipAmount -eq 0 })
  Add-Result '11_isolation' ($mine.Count -ge 5 -and $bad.Count -eq 0) "test_orders=$($mine.Count) non_zero=$($bad.Count)"

  # ---- 12. slip integrity ----------------------------------------------
  $failedChecks = @()
  foreach ($c in $allSlipChecks) {
    if ($null -eq $c) { continue }
    foreach ($p in $c.PSObject.Properties) { if ($p.Value -eq $false) { $failedChecks += $p.Name } }
  }
  Add-Result '12_slip_integrity' ($failedChecks.Count -eq 0) "failed=$($failedChecks -join ',')"

  # ---- report -----------------------------------------------------------
  $passed = @($script:results | Where-Object { $_.pass }).Count
  $failed = $script:results.Count - $passed
  $summary = [ordered]@{
    run_id = $RunId
    started = (Get-Date).ToString('o')
    base_url = $Base
    total = $script:results.Count
    passed = $passed
    failed = $failed
    results = @($script:results)
    slip_folders = @(Get-ChildItem $SlipsDir -Directory | ForEach-Object { $_.Name })
  }
  $summary | ConvertTo-Json -Depth 12 | Set-Content (Join-Path $RunDir 'summary.json') -Encoding UTF8
  $md = @("# Test battery $RunId", "", "Result: **$passed passed / $failed failed**", "", "| Test | Result | Detail |", "|---|---|---|")
  foreach ($r in $script:results) { $md += "| $($r.test) | $(if($r.pass){'PASS'}else{'FAIL'}) | $($r.detail) |" }
  $md += @('', 'Slip data: slips\ — one folder per test with both receipt texts, segments, card.txt and asserts.json.')
  $md -join "`n" | Set-Content (Join-Path $RunDir 'summary.md') -Encoding UTF8
  Log "DONE: $passed passed / $failed failed"

  # one-shot cleanup
  Remove-Item $PinFile -Force -ErrorAction SilentlyContinue
  if ($Scheduled) {
    try { Unregister-ScheduledTask -TaskName 'BeluchisTestBattery' -Confirm:$false -ErrorAction Stop; Log 'One-shot task removed' } catch { Log "Task removal failed: $($_.Exception.Message)" }
  }
  Flush-Log
  if ($failed -gt 0) { exit 1 }
} catch {
  Log "FATAL: $($_.Exception.Message)"
  Flush-Log
  exit 2
}
