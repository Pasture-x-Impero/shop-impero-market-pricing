# shop-impero-market-pricing

Konkurrentpris innsamler for shop.impero.no, kjørt fra GitHub Actions. Sjekker
konkurrentenes priser (Power, Dustin, Komplett, Eplehuset) for alle synlige produkter
to ganger i uken og sender dem rå til Edge Functions i Lovable prosjektet. Selve utsalgsprisen
regnes ut på Lovable siden. Dette repoet har ingen Supabase nøkkel og ingen prisregel,
kun den delte hemmeligheten `PRICE_SYNC_SECRET`.

Leverandør synken (innkjøpspriser og lager fra TD Synnex/ALSO/isicom, Icecat berikelse)
ligger i søsterrepoet
[shop-impero-supplier-sync](https://github.com/Pasture-x-Impero/shop-impero-supplier-sync).
Se `CLAUDE.md` for arkitektur, kontrakter og tekniske lærdommer.

## Arkitektur

```
market-pricing.yml (mandag og torsdag kl. 05:30 UTC, eller manuelt)
│
├── price-sync-visible-products (les)  → alle synlige produkter med EAN/MPN
│     og kilder admin har ekskludert
├── Power (EAN, JSON API) / Komplett (MPN) / Dustin (MPN) / Eplehuset (MPN, Shopify feed)
├── price-sync-competitor (skriv)      → alle funn per produkt, rå.
│     Lovable lagrer dem og regner ut utsalgspris selv.
└── price-sync-run-log (skriv)         → per kilde statistikk, vist i admin
```

Alt som sendes til `price-sync-competitor` er **ekskl. mva.**, for alle kilder.

## Oppsett

```bash
git clone https://github.com/Pasture-x-Impero/shop-impero-market-pricing.git
cd shop-impero-market-pricing
npm install
```

Krever Node 22 eller nyere (koden kjøres med `--experimental-strip-types`).

### GitHub Secrets

| Secret | Beskrivelse |
|---|---|
| `PRICE_SYNC_SECRET` | Delt hemmelighet med Edge Functions i Lovable prosjektet. Samme verdi som i `shop-impero-supplier-sync`. |
| `SLACK_WEBHOOK_URL` | (Valgfritt) Slack varsel ved feil |

Ingen leverandør secrets, innsamleren leser kun offentlige konkurrent nettsider.

### Lokal kjøring

```bash
export PRICE_SYNC_SECRET="..."
npm run pricing                                 # Full kjøring
PRICING_ONLY=<EAN eller MPN> npm run pricing    # Punktsjekk for ett produkt (~1 min)
npm run sync:market                             # Dry run av Eplehuset fetcheren
npm run typecheck
```

## GitHub Actions

| Workflow | Trigger | Hva den gjør |
|---|---|---|
| `market-pricing.yml` | Mandag og torsdag kl. 05:30 UTC, eller manuelt med valgfritt `only` input (kommaseparert EAN/MPN) | Konkurrentpris innsamling. `only` hopper over run log, så admin sin "siste kjøring" fortsatt speiler en full kjøring. |

Full kjøring tar ca. 1,5 time for ~850 produkter. `timeout-minutes: 180`.

## Hva som sendes

Per produkt: `product_id` og `competitor_prices[]`, én rad per kilde som fant produktet,
med navn, pris ekskl. mva., lagerstatus, URL, kildens varenummer og et snapshot av om
admin har ekskludert kilden. Utsolgte og ekskluderte treff sendes også, så admin ser
dem. Tom liste sendes også, da rydder Lovable bort gamle rader for produktet.

Elkjøp er bevisst utelatt: IP basert bot blokkering fra GitHub Actions ga 0 % treff.
Fetcheren i `src/fetchers/elkjop.ts` er klar til å kobles inn igjen.

## Supabase tabeller innsamleren fyller (eies av Lovable)

| Tabell | Rolle |
|---|---|
| `product_competitor_prices` | Alle konkurrentpriser per produkt fra siste kjøring, én rad per kilde. |
| `market_pricing_runs` | Per kilde statistikk per kjøring. |
