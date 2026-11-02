# Beluchi's Pizzas — Personeel / Operateur Gids

Hierdie gids is vir administrateurs, kassiere, kombuispersoneel en bestuurders. Dit verduidelik die admin-portaal, kassier-skerm, kombuis-daemon en StandAlone-brug.

## 1. Inteken

Maak `/admin` oop en teken in met jou admin-rekening (gebruikersnaam + PIN). Kassiere gebruik `/cashier`. Bestuurders gebruik `/driver`.

## 2. Admin-portaal oorsig

Die admin-portaal het 'n sybalk van oortjies. Die hoofstes:

- **Orders** — lewendige bestellingry.
- **Users** — kliëntrekeninge.
- **Menu / Items** — geregte, kategorieë, groottes, beelde.
- **Specials** — aanbiedinge en promosies.
- **Printers** — drukkerbestuur.
- **Shop (Delivery)** — winkelinstellings, ure, afleweringskonfig, sosiaal, e-poswaarskuwings.
- **Deliveries** — afleweringopsporing.

## 3. Bestellingry

- Bestellings verskyn nuutste eerste met status, items, totaal en betaalmetode.
- **Aanlyn-betaalde bestellings** wys "Total R… · Paid online R…" in plaas van R0.00.
- **Statusfilter** — wys alles of 'n spesifieke status.
- **Datumfilter** — kies 'n dag of "All days".
- Verander 'n bestelling se status soos dit vorder (placed → preparing → out for delivery → delivered). Kanselleer indien nodig.
- Nuwe-bestelling-kennisgewings vuur slegs terwyl 'n bestelling nog verwerk word.

## 4. Spyskaartbestuur

- **Kategorieë** — skep/hernoem/herorden; stel 'n aanbod-teksmerker per kategorie.
- **Items** — naam, beskrywing, slug, kategorie, beeld, groottes en pryse, aktiewe skakelaar, "show on home".
- **Pasgemaakte items** — voeg basisse en ekstra toppings by met per-grootte pryse; seisoenale ruil vir buite-seisoen toppings.
- Beelde laai op na `/uploads`.

## 5. Spesiale (aanbiedinge)

Tik **+ Add Special** om die akkordeonvorm oop te maak. Afdelings (klik om uit te vou):

1. **Naam & tipe** — kies die aanbodtipe:
   - **Kombo (vaste prys)** — 'n stel items vir een prys.
   - **BOGO (koop een kry een)** — kies N, betaal N/2.
   - **Deal (outomaties)** — pas toe wanneer die regte items in die mandjie is.
   - **Pick (koop N kry 1 gratis)** — kliënt kies N pizzas uit 'n kategorie (of 'n gekuurde lys), betaal vir N−1.
2. **Kategorie & grootte** — watter kategorie en grootte die aanbod op van toepassing is.
3. **Itemkeuse** (slegs pick-aanbiedinge) — gekuurde lys van in aanmerking komende pizzas; skakel **Pay** per item in vaste modus (anders is die goedkoopste gratis).
4. **Beskrywing** — kort teks op die kaart.
5. **Skedule** — weekdae (Ma–So) en/of 'n begin/einddatum-reeks. Slegs aktiewe spesiale op die huidige dag wys op die voorkant.
6. **Tuisblad & sosiaal** — teël- of banniervertoning, "Show on home", "Post to Facebook".

Tik **Save**. Merk "Post to Facebook" om die spesiale na die gekoppelde bladsy te publiseer.

## 6. Drukkers

Oortjie **Printers** onder Store. Elke drukker: naam, tipe (netwerk/lêer), gasheer, poort, kopieë per bestelling, geaktiveer, sorteerorde.

- **Add / Edit / Delete** — vinnige redigering via boodskappe.
- **Test** — plaas 'n toetsdruk in die tou; die kombuis-daemon druk 'n toetsstrook.
- **Scan network** — vra die daemon om die plaaslike subnet vir drukkers op poort 9100 te skandeer.
- **Vanlyn-waarskuwing** — 'n rooi baniere verskyn op admin en kassier wanneer enige drukker vanlyn is of 'n druk misluk het.
- Die kombuis-daemon peil hierdie konfig by opstart en elke peiling; dit los 'n veranderde IP outomaties op deur die subnet te skandeer en die bediener by te werk.

## 7. Winkelinstellings

Oortjie **Shop (Delivery)**:

- **Ure** — oop/sluit tyd, aanlyn bestellings skakelaar. Veranderinge e-pos die eienaar (as 'n waarskuwings-e-pos gestel is).
- **Oop/gesluit** — skakel die winkelvlag op die tuisblad.
- **Afleweringskonfig** — aktiveer, winkel-ligging (lat/lng), gratis radius, fooi, maksimum radius, verder-fooi, minimum bestelling vir gratis aflewering.
- **Sosiaal** — Facebook Bladsy-ID, Bladsy-toegangstoken, Instagram Gebruiker-ID, eienaar-waarskuwings-e-pos.
- **Connect with Facebook** — open die FB-inteken-dialoog om 'n token te verkry (vereis dat die FB-app gekonfigureer is).

## 8. Gebruikers

Bekyk kliëntrekeninge, herstel wagwoorde, bekyk bestellingtellings.

## 9. Aflewerings

Spoor aflewerings, ken bestuurders toe, merk as afgelewer.

## 10. Kassierblad (`/cashier`)

- Lewendige bestellingry met dieselfde filters.
- **Nuwe-bestelling-waarskuwing** — klank/kennisgewing wanneer 'n nuwe bestelling aankom.
- **Drukker-vanlyn-baniere** — rooi waarskuwing as 'n drukker af is.
- Herdruk-knoppie per bestelling.

## 11. Kombuis-daemon (`kitchen/`)

Koplose Node-diens (poort 3101) wat die bediener vir nuwe bestellings peil en strokies druk.

Omgewingsveranderlikes:
- `SOURCE_BASE_URL` — bediener-URL (verstek http://localhost:3100)
- `PRINT_KEY` — gedeelde sleutel vir drukker-eindpunte
- `POLL_SECONDS` — peilinterval (verstek 15)
- `AUTO_PRINT` — true/false (verstek true)
- `AUTO_MARK_PREPARING` — true/false (verstek true)

Eindpunte: `/health`, `/api/print/:id`, `/api/scan?port=9100`.

Gedrag:
- Peil bestellings; druk elke nuwe bestelling op alle geaktiveerde drukkers, met respek vir kopieë.
- Merk bestelling outomaties as "preparing" na 'n suksesvolle druk.
- By drukmislukking, skandeer die subnet om die drukker-IP outomaties op te los en probeer weer.
- Rapporteer hartklop (per-drukker-status) aan die bediener.

## 12. StandAlone-brug (`StandAlone/`)

Plaaslike brug (poort 3102) wat gebruik word wanneer die kombuis-PC die drukbron is. Stoor drukkers plaaslik in `data/printers.json` en sinkroniseer met die bediener. Plaaslike wysigings stoot na die bediener; bediener-konfig oorskryf plaaslik by peiling.

## 13. Strokies

Kombuis- en StandAlone-strokies sluit in:
- Winkelnaam, webwerf, telefoon, BTW-nommer.
- Bestellingsnommer, tipe (aflewering/afhaal), tyd, betaalmetode.
- Items met hoeveelhede en pryse (gratis items wys R0).
- Kliënt, telefoon, afleweringsadres.
- Subtotaal, afslag, **TOTAL AMOUNT**, en vir aanlyn-betaalde bestellings: "Paid online R…" + "No balance due".
- BTW-opsplitsing: Total Excl VAT / VAT Incl. (15%).

## 14. Wenke

- Hou die daemon aan die gang tydens diensure.
- As 'n drukker vanlyn gaan, wys die admin en kassier 'n rooi baniere — kontroleer die Printers-oortjie.
- Gebruik die datumfilter op die Orders-oortjie om vorige dae te hersien.
- Geskeduleerde spesiale wys slegs op die voorkant op hul aktiewe dae.

*Beluchi's Pizzas — Authentic & Hand Crafted. © 2026*
