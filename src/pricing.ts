/**
 * Konkurrentpris-innsamler.
 *
 * Henter alle synlige produkter med registrert EAN via
 * `price-sync-visible-products`, slår dem opp hos Power.no (EAN), Dustin og
 * Komplett (MPN, se hver fetcher for hvorfor ikke EAN der) og Eplehuset (MPN),
 * og sender ALLE funn rå til `price-sync-competitor`. Selve utsalgsprisen
 * regnes ut på Lovable-siden (`apply_competitor_pricing`), som har marginer,
 * undercut-beløp og admin sine ekskluderinger. Dette repoet inneholder ingen
 * prisregel.
 *
 * ⚠️ Elkjøp er ikke med i løkken: IP-basert bot-beskyttelse ga 0 treff fra
 * GitHub Actions selv etter stealth-tiltak, med ~18 s per oppslag.
 * `fetchElkjopByMPN` (i `elkjop.ts`) er urørt og klar til å kobles inn igjen
 * den dagen Elkjøp faktisk fungerer fra CI.
 *
 * Kilder admin har ekskludert for et produkt (`excluded_sources` fra
 * `price-sync-visible-products`) hentes og sendes likevel, med et
 * `excluded`-snapshot, slik at admin ser prisen og kan skru kilden på igjen.
 * Lovable bruker sine egne, live ekskluderinger i utregningen, ikke snapshotet.
 *
 * ⚠️ Kontrakt: ALLE priser som sendes (`price_ex_vat` i hver rad) er EKSKL.
 * MVA, uansett kilde. Hver fetcher konverterer selv før retur. Lovable ganger
 * med 1,25 universelt og skal aldri gjette per kilde.
 *
 * Per-kilde treff-statistikk (sjekket/treff/tilgjengelig) sendes til
 * `price-sync-run-log` etter hver full kjøring og vises i Lovable admin under
 * "Prising" → "Konkurrent-kilder".
 *
 * Miljøvariabler: PRICE_SYNC_SECRET. Valgfritt PRICING_ONLY, se under.
 */

import { fetchPowerByEAN } from './fetchers/power.ts';
import { fetchDustinByMPN } from './fetchers/dustin.ts';
import { fetchKomplettByMPN } from './fetchers/komplett.ts';
import { fetchEplehuset } from './fetchers/market.ts';
import { closeSharedBrowser } from './fetchers/browser-fetch.ts';
import type { MarketPrice } from './types.ts';

const PRICE_SYNC_SECRET = process.env.PRICE_SYNC_SECRET;
const FUNCTIONS_BASE = 'https://umnxckqgnlohvawvfgzv.supabase.co/functions/v1';

// Valgfritt filter: kommaseparert liste av EAN og/eller MPN. Kjører kun for
// disse produktene, for punktsjekk uten en full ~1,5 timers kjøring. Settes via
// `only`-inputen i market-pricing.yml. Kjørelogg-statistikken hoppes over i
// filtrert modus, slik at "siste kjøring" i admin fortsatt speiler en full
// kjøring.
const ONLY_FILTER = new Set(
  (process.env.PRICING_ONLY ?? '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
);

const SOURCES = ['power', 'dustin', 'komplett', 'eplehuset'] as const;

// Responsen fra price-sync-visible-products inneholder flere felt enn dette
// (bl.a. innkjøpspris og margin). De brukes ikke her og ignoreres.
interface VisibleProduct {
  id: string;
  name: string;
  ean: string;
  mpn: string | null;
  // Kilder admin har ekskludert for dette produktet. Valgfritt for
  // bakoverkompatibilitet — mangler feltet, er ingenting ekskludert.
  excluded_sources?: string[];
}

// Én rad per konkurrent som fant produktet. Lagres i sin helhet av
// price-sync-competitor (product_competitor_prices, én rad per produkt per
// kilde, erstattes per kjøring).
interface CompetitorPriceRow {
  source: MarketPrice['source'];
  competitor_name: string | null;
  // Ekskl. mva. — se kontrakt-kommentaren øverst i filen.
  price_ex_vat: number | null;
  available: boolean;
  product_url: string | null;
  source_sku: string | null;
  // Snapshot av ekskluderingsstatus på kjøretidspunktet, kun for visning i
  // admin. Lovable regner med sine egne, live ekskluderinger.
  excluded: boolean;
}

interface PriceUpdate {
  product_id: string;
  competitor_prices: CompetitorPriceRow[];
}

if (!PRICE_SYNC_SECRET) {
  console.error('PRICE_SYNC_SECRET må være satt som miljøvariabel / GitHub Secret');
  process.exit(1);
}

async function fetchVisibleProducts(): Promise<VisibleProduct[]> {
  const resp = await fetch(`${FUNCTIONS_BASE}/price-sync-visible-products`, {
    headers: { 'x-price-sync-secret': PRICE_SYNC_SECRET! },
  });
  if (!resp.ok) {
    throw new Error(`price-sync-visible-products feilet: HTTP ${resp.status} — ${await resp.text()}`);
  }
  // Responsen er `{ products: [...], ... }`, ikke en bar array.
  const data = (await resp.json()) as { products: VisibleProduct[] };
  return data.products;
}

async function pushRunLog(
  runStartedAt: string,
  stats: Record<(typeof SOURCES)[number], { checked: number; matched: number; available: number; durationMs: number }>
): Promise<void> {
  const resp = await fetch(`${FUNCTIONS_BASE}/price-sync-run-log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-price-sync-secret': PRICE_SYNC_SECRET! },
    body: JSON.stringify({
      run_started_at: runStartedAt,
      sources: SOURCES.map(source => ({
        source,
        products_checked: stats[source].checked,
        products_matched: stats[source].matched,
        products_available: stats[source].available,
        duration_ms: Math.round(stats[source].durationMs),
      })),
    }),
  });
  if (!resp.ok) {
    console.error(`⚠️ price-sync-run-log feilet: HTTP ${resp.status} — ${await resp.text()}`);
  }
}

async function pushPrices(items: PriceUpdate[]): Promise<{ updated: number; errors: string[]; competitor_rows?: number }> {
  const resp = await fetch(`${FUNCTIONS_BASE}/price-sync-competitor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-price-sync-secret': PRICE_SYNC_SECRET! },
    body: JSON.stringify({ items }),
  });
  if (!resp.ok) {
    throw new Error(`price-sync-competitor feilet: HTTP ${resp.status} — ${await resp.text()}`);
  }
  return (await resp.json()) as { updated: number; errors: string[]; competitor_rows?: number };
}

console.log('\n💰 shop-impero-market-pricing — konkurrentpris-innsamler');
console.log(`📅 Kjøretidspunkt: ${new Date().toISOString()}\n`);

const runStartedAt = new Date().toISOString();
const allProducts = await fetchVisibleProducts();
console.log(`Fant ${allProducts.length} synlige produkter med registrert EAN.`);

const products =
  ONLY_FILTER.size === 0
    ? allProducts
    : allProducts.filter(
        p => ONLY_FILTER.has(p.ean.toLowerCase()) || (p.mpn !== null && ONLY_FILTER.has(p.mpn.toLowerCase()))
      );
if (ONLY_FILTER.size > 0) {
  console.log(
    `🔎 Filtrert kjøring (PRICING_ONLY=${[...ONLY_FILTER].join(',')}): ${products.length} av ${allProducts.length} produkter. ` +
      `Kjørelogg til admin hoppes over.`
  );
  if (products.length === 0) {
    console.error('Ingen synlige produkter med EAN matchet filteret — sjekk at EAN/MPN er riktig og at produktet er synlig med EAN.');
    process.exit(1);
  }
}
console.log('');

const sourceStats: Record<
  (typeof SOURCES)[number],
  { checked: number; matched: number; available: number; durationMs: number }
> = {
  power: { checked: 0, matched: 0, available: 0, durationMs: 0 },
  dustin: { checked: 0, matched: 0, available: 0, durationMs: 0 },
  komplett: { checked: 0, matched: 0, available: 0, durationMs: 0 },
  eplehuset: { checked: 0, matched: 0, available: 0, durationMs: 0 },
};

function recordResult(source: (typeof SOURCES)[number], startedAt: number, result: MarketPrice | null) {
  const stats = sourceStats[source];
  stats.checked++;
  stats.durationMs += Date.now() - startedAt;
  if (result) {
    stats.matched++;
    if (result.available) stats.available++;
  }
}

// Eplehuset har ingen per-produkt-oppslag — henter hele deres Apple-utvalg
// ÉN gang og slår opp lokalt per MPN i stedet for ett nettverkskall per
// produkt.
console.log('Henter Eplehuset sitt Apple-sortiment (kun MPN-matching, ingen EAN i deres offentlige feed)...');
const eplehusetCatalogue = await fetchEplehuset();
const eplehusetByMpn = new Map(eplehusetCatalogue.map(p => [p.mpn.toLowerCase(), p]));
console.log(`Eplehuset: ${eplehusetCatalogue.length} varianter lastet.\n`);

const updates: PriceUpdate[] = [];
let productsWithHits = 0;

for (let i = 0; i < products.length; i++) {
  const product = products[i];

  // Høflig pause mellom hvert produkt — to av fire kilder (Dustin, Komplett)
  // kjører bot-beskyttelse.
  if (i > 0) {
    await new Promise(r => setTimeout(r, 1000));
  }

  const results: MarketPrice[] = [];

  let t = Date.now();
  const power = await fetchPowerByEAN(product.ean);
  recordResult('power', t, power);
  if (power) results.push(power);

  if (product.mpn) {
    t = Date.now();
    const komplett = await fetchKomplettByMPN(product.mpn, product.ean);
    recordResult('komplett', t, komplett);
    if (komplett) results.push(komplett);

    // Dustin har ingen EAN å verifisere mot (se dustin.ts) — MPN- og
    // sidetittel-verifiseringen der er det eneste sikkerhetsnettet.
    t = Date.now();
    const dustin = await fetchDustinByMPN(product.mpn);
    recordResult('dustin', t, dustin);
    if (dustin) results.push(dustin);

    t = Date.now();
    const eplehuset = eplehusetByMpn.get(product.mpn.toLowerCase()) ?? null;
    recordResult('eplehuset', t, eplehuset);
    if (eplehuset) results.push(eplehuset);
  }

  const excluded = new Set((product.excluded_sources ?? []).map(s => s.toLowerCase()));

  const competitorPrices: CompetitorPriceRow[] = results.map(r => ({
    source: r.source,
    competitor_name: r.name ?? null,
    price_ex_vat: r.price_ex_vat ?? null,
    available: r.available ?? false,
    product_url: r.product_url ?? null,
    source_sku: r.source_sku ?? null,
    excluded: excluded.has(r.source),
  }));

  const availableCount = results.filter(r => r.available && typeof r.price_ex_vat === 'number').length;
  const excludedCount = results.filter(r => excluded.has(r.source)).length;
  if (results.length > 0) productsWithHits++;

  console.log(
    `📦 "${product.name}" — ${results.length} treff, ${availableCount} tilgjengelig` +
      `${excludedCount ? `, ${excludedCount} ekskludert av admin` : ''}`
  );

  // Sendes også når listen er tom: da sletter Lovable gamle rader for
  // produktet, så en konkurrent som har sluttet å føre varen ikke blir stående.
  updates.push({
    product_id: product.id,
    competitor_prices: competitorPrices,
  });
}

await closeSharedBrowser();

if (ONLY_FILTER.size === 0) {
  await pushRunLog(runStartedAt, sourceStats).catch(err =>
    console.error('⚠️ Kunne ikke skrive kjørelogg til price-sync-run-log:', err)
  );
}

if (updates.length > 0) {
  const result = await pushPrices(updates);
  console.log(
    `\n✅ Konkurrentpriser sendt for ${updates.length} produkter` +
      `${typeof result.competitor_rows === 'number' ? ` (${result.competitor_rows} rader)` : ''}, ` +
      `${result.updated} utsalgspriser oppdatert av Lovable.`
  );
  if (result.errors.length) {
    console.error(`⚠️ ${result.errors.length} feil:`, result.errors.slice(0, 20));
  }
} else {
  console.log('\nIngen produkter å sende.');
}

console.log(`\n━━━ Sammendrag ━━━`);
console.log(`Totalt: ${products.length} | Med treff: ${productsWithHits} | Sendt: ${updates.length}`);
