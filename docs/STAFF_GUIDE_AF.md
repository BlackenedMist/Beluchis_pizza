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

## 4. Spyskaartbestuur (stap vir stap)

### 4.1 Voeg 'n kategorie by
1. Maak die admin-portaal oop -> **Menu -> Categories**.
2. Klik **+ Add category**.
3. Voer 'n naam in (bv. "Pizzas") en 'n opsionele aanbod-teksmerker (bv. "2 for 1").
4. Stel die sorteerorde, dan **Save**.

### 4.2 Voeg 'n item by
1. Gaan na **Menu -> Items** -> **+ Add item**.
2. Vul in: naam, beskrywing, slug (URL-vriendelik, bv. `bbq-chicken`), kategorie.
3. Laai 'n beeld op (gestoor onder `/uploads`).
4. Voeg groottes by: klik **+ Size**, voer etiket (Small/Medium/Large) en prys vir elk in.
5. Skakel **Active** (sigbaar op die spyskaart) en **Show on home** (verskyn op die tuisblad-teëls) aan.
6. **Save**.

### 4.3 Wysig / deaktiveer 'n item
1. Vind die item in die lys (gebruik die soekboks bo).
2. Klik **Edit**, verander velde, **Save**.
3. Om 'n item tydelik te versteek, skakel **Active** af (dit bly in die databasis maar verdwyn van die spyskaart).

### 4.4 Pasgemaakte items (basisse & ekstra toppings)
1. Maak 'n item oop -> **Customise**-afdeling.
2. **Basisse**: voeg elke basisopsie by met sy per-grootte prys (0 vir die verstekbasis).
3. **Ekstra toppings**: voeg elke topping by met sy per-grootte prys.
4. Vir seisoenale items, merk "out of season" op 'n topping - kliënte sal 'n gratis ruil vir 'n in-seisoen topping van dieselfde waarde aangebied word.
5. **Save**.

### 4.5 Herorden
Sleep items/kategorieë met hul handvatsel, of stel die sorteerorde-nommer en stoor.

### 4.6 Beelde
- Laai JPG/PNG op. Aanbeveel: vierkantig, minstens 600x600 px vir teëls.
- Die eerste beeld word as miniatuur gebruik; veelvuldige beelde wys as 'n gallery in die aanpasser.

## 5. Spesiale (aanbiedinge) - stap vir stap

### 5.1 Skep 'n spesiale
1. Maak **Menu -> Specials** oop -> **+ Add Special**.
2. Die akkordeonvorm open. Vou elke afdeling uit deur op die kop te klik.

### 5.2 Afdeling 1 - Naam & tipe
1. Voer 'n **Naam** in (wys op die kaart, bv. "2 Large for R200").
2. Kies die **Kind**:
   - **Combo (vaste prys)** - 'n stel items vir een prys. Voer prys en hoeveelheid in.
   - **BOGO** - "Kies N, betaal N/2". Stel die telling (bv. 2 = kies 2, betaal 1).
   - **Deal (outomaties)** - pas outomaties toe wanneer die regte items in die mandjie is. Stel telling en prys.
   - **Pick (koop N kry 1 gratis)** - kliënt kies N pizzas, betaal vir N-1. Stel koop-telling en betaal-telling.
3. Vou die volgende afdeling uit.

### 5.3 Afdeling 2 - Kategorie & grootte
1. Kies die **Kategorie** waarop die aanbod van toepassing is (bv. Pizzas).
2. Kies 'n **Grootte** (of "any size").
3. Vir pick-aanbiedinge, merk opsioneel "Curated items" om te beperk watter pizzas kwalifiseer.

### 5.4 Afdeling 3 - Itemkeuse (slegs pick-aanbiedinge)
1. Merk die pizzas wat kwalifiseer.
2. In **vaste** betaalmodus, merk die **Pay**-boksie op items wat die kliënt moet betaal; ongemerkte items is gratis. In **cheapest**-modus (verstek), is die goedkoopste keuses outomaties gratis.
3. **Save** die keuse.

### 5.5 Afdeling 4 - Beskrywing
Voer 'n kort beskrywing in wat onder die naam op die kaart wys (opsioneel).

### 5.6 Afdeling 5 - Skedule
1. Merk die **weekdae** waarop die spesiale aktief is (Ma-So).
2. Stel opsioneel 'n **begin-** en **einddatum** vir 'n beperkte lopie.
3. Laat albei leeg vir 'n altyd-aan spesiale.
4. Slegs spesiale wat op die huidige dag aktief is, verskyn op die voorkant.

### 5.7 Afdeling 6 - Tuisblad & sosiaal
1. Kies **Vertoningstipe**: **Tile** (vierkantig, in die rooster) of **Banner** (volwydte ry bo die rooster).
2. Merk **Show on home** om na die tuisblad te publiseer.
3. Merk **Post to Facebook** om die spesiale na die gekoppelde Facebook-bladsy te publiseer by stoor.
4. **Save** die spesiale.

### 5.8 Wysig / verwyder
- Klik 'n spesiale in die lys -> **Edit** om enige veld te verander, dan **Save**.
- Klik **Delete** om te verwyder (bevestig eers).

## 6. Drukkers

Oortjie **Printers** onder Store. Elke drukker: naam, tipe (netwerk/lêer), gasheer, poort, kopieë per bestelling, geaktiveer, sorteerorde.

- **Add / Edit / Delete** — vinnige redigering via boodskappe.
- **Test** — plaas 'n toetsdruk in die tou; die kombuis-daemon druk 'n toetsstrook.
- **Scan network** — vra die daemon om die plaaslike subnet vir drukkers op poort 9100 te skandeer.
- **Vanlyn-waarskuwing** — 'n rooi baniere verskyn op admin en kassier wanneer enige drukker vanlyn is of 'n druk misluk het.
- Die kombuis-daemon peil hierdie konfig by opstart en elke peiling; dit los 'n veranderde IP outomaties op deur die subnet te skandeer en die bediener by te werk.

### 6.1 Kombuis-daemon auth-wagwoord
Boaan die Printers-oortjie is 'n **Kitchen daemon auth password**-veld.
1. Voer die wagwoord in wat die daemon gebruik (sy `PRINT_KEY`-omgewingsveranderlike).
2. Klik **Save key**. Die waarde word op die bediener en in jou blaaier gestoor.
3. Laat leeg om auth te deaktiveer (daemon moet ook geen `PRINT_KEY` gestel hê).
4. Die **Scan network**-knoppie stuur hierdie wagwoord na die daemon. As skanderings met 403 misluk, stem die wagwoord nie ooreen met die daemon se `PRINT_KEY` nie.

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
