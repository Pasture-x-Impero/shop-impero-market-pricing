# shop-impero-market-pricing — Claude Code kontekst

> Dette repoet er **offentlig**. Ikke skriv kundenumre, kontaktpersoner, e-poster,
> hemmeligheter, prisregler eller intern driftshistorikk hit. Teknisk arkitektur,
> kontrakter og lærdommer hører hjemme her.

## Hva er dette?

GitHub Actions workflow som to ganger i uken henter konkurrentpriser (Power, Dustin, Komplett,
Eplehuset) for alle synlige produkter i shop.impero.no og sender dem rå til Edge
Functions i Lovable prosjektet `impero-shop`. **Utsalgsprisen regnes ut på Lovable
siden** (`apply_competitor_pricing`), som har marginer, undercut beløp og admin sine
ekskluderinger. Dette repoet inneholder ingen prisregel og leser hverken innkjøpspris
eller margin. Ingen Supabase nøkkel her, kun den delte hemmeligheten `PRICE_SYNC_SECRET`
i header `x-price-sync-secret`.

Søsterrepo: [shop-impero-supplier-sync](https://github.com/Pasture-x-Impero/shop-impero-supplier-sync)
(innkjøpspriser og lager fra distributører, Icecat berikelse). `power.ts`, `komplett.ts`
og `dustin.ts` finnes i begge repoene: her for prisinnsamling, der for navn/bilde
fallback. Endringer i dem må gjøres begge steder.

## Filoversikt

- `src/pricing.ts` — innsamleren: henter produktlisten, spør kildene, sender funnene og
  run log. `PRICING_ONLY` (kommaseparert EAN/MPN) begrenser til enkeltprodukter.
- `src/fetchers/power.ts` — Power.no, åpent JSON API, oppslag på EAN.
- `src/fetchers/komplett.ts` — Komplett, ren `fetch()`, oppslag på MPN.
- `src/fetchers/dustin.ts` — Dustin, ren `fetch()`, oppslag på MPN.
- `src/fetchers/market.ts` — Eplehuset (Shopify `/products.json`), hele Apple sortimentet
  hentes én gang per kjøring og slås opp lokalt på MPN.
- `src/fetchers/elkjop.ts` + `browser-fetch.ts` — Elkjøp via Playwright. Ikke koblet inn,
  se under.
- `src/types.ts` — `MarketPrice` m.fl.
- `.github/workflows/market-pricing.yml` — mandag og torsdag 05:30 UTC, `workflow_dispatch`
  med valgfritt `only` input. Installerer Playwright for Elkjøp sin skyld selv om den er
  parkert.

## Edge Functions (Lovable eier dem)

| Funksjon | Retning | Innhold |
|---|---|---|
| `price-sync-visible-products` | les | `{ products: [...], ... }`, ikke en bar array. Per produkt brukes `id`, `name`, `ean`, `mpn`, `excluded_sources: string[]`. Andre felt i responsen ignoreres. |
| `price-sync-competitor` | skriv | Én POST med alle produkter. Per element kun `product_id` og `competitor_prices[]` (`source`, `competitor_name`, `price_ex_vat`, `available`, `product_url`, `source_sku`, `excluded`). Lovable lagrer radene med RPC i chunker, aldri per produkt, og regner så utsalgspris selv. Svar: `{ updated, errors, competitor_rows }`. |
| `price-sync-run-log` | skriv | Per kilde: sjekket/treff/tilgjengelig. Hoppes over i `only` modus. |

**Ekskl. mva. kontrakten:** `price_ex_vat` er ekskl. mva. for alle kilder, uten unntak.
Lovable ganger med 1,25 universelt. Bakgrunn: en kildespesifikk mva gjetting på Lovable
siden dobbeltkonverterte tidligere Dustin priser, siden Dustin fetcheren allerede
konverterte. Aldri gjeninnfør per kilde logikk på noen av sidene.

**Skjemaet eies av Lovable.** Trengs en endring i Edge Functions eller tabeller, be
Lovable agenten for `impero-shop`. Aldri SQL direkte.

## Kildenotater

- **Power.no** — `/api/v2/search/suggestions` + `/api/v2/products`. Gir pris, lager og
  URL i to kall. Reneste kilden. Bilde URL bygges mot `media.power-cdn.net`.
- **Komplett** — Kasada bot beskyttelse avviser `curl` på TLS nivå, men Node `fetch()`
  (undici) kommer gjennom. Eksakt MPN søk redirecter til produktsiden ved treff, ingen
  treff blir stående på søke URL. JSON-LD tag har HTML entity kodet `type`, bruk
  `id="product-schema-main"`. EAN ligger i `additionalProperty`. Fuzzy navnesøk er
  klient rendret og ikke forsøkt.
- **Dustin** — Next.js RSC app. Product objektet ligger som escaped JSON streng i en
  `self.__next_f.push` chunk, ikke i ld+json. Les med regex fra `"mpn":"<mpn>"` ankeret,
  ikke full `JSON.parse` (tomme tegn i navn bryter parsing). Priser ekskl. mva
  (`valueAddedTaxIncluded`), koden avviser resultatet hvis feltet noen gang er `true`.
  Eksakt MPN søk redirecter ved treff. Cloudflare stopper ikke `fetch()`.
- **Eplehuset** — kun MPN, ingen EAN i offentlig feed. ~2400 varianter hentes én gang
  per kjøring.
- **Elkjøp** — søk er klient rendret, krever Playwright. Fra GitHub Actions IP er gir
  siden aldri ekte innhold (0 treff, ~18 s per oppslag, matcher selector timeout).
  Stealth tiltak i `browser-fetch.ts` hjalp ikke. Parkert for å unngå at gjentatte
  sonderinger strammer inn beskyttelsen. Elkjøp faller også stille tilbake til
  "populære produkter" ved null treff, så MPN verifisering mot JSON-LD er obligatorisk.
- Ingen av kildene indekserer EAN i søk. EAN brukes kun til verifisering av treff.

## Drift og lærdommer

- Kjøretid ~1,5 time for ~850 produkter (Power ~0,7 s, Komplett ~1,1 s, Dustin ~4,5 s,
  1 s pause per produkt). Elkjøp alene var ~18 s per produkt, derfor fjernet fra løkken.
- `price-sync-visible-products` feilet tidligere med HTTP 500 over ~1000 produkter
  (`.in()` ga for lang URL). Lovable henter nå oppslagstabellene paginert og joiner i
  minnet.
- `price-sync-competitor` feilet tidligere med HTTP 504 (per produkt SELECT/UPDATE i én
  request, over Supabase sin 150 s idle timeout). Hele kjøringens resultat gikk tapt.
  Nå bulk skriving i chunker på 250.
- En kilde som aldri lykkes i produksjon er en blindsone: kontraktsendringer rundt den
  ligger latent til den vekkes. Ikke anta at koden rundt en "død" kilde fortsatt stemmer.
- `secrets` konteksten kan ikke brukes i `if:` i workflows. Send via `env:`.
- Punktsjekk: Actions → Konkurrent-prising → Run workflow → `only=<EAN>`. Tar ~1 min.

## Kjørekommandoer

```bash
npm run pricing
PRICING_ONLY=<EAN eller MPN> npm run pricing
npm run sync:market      # Dry run Eplehuset
npm run typecheck
```
