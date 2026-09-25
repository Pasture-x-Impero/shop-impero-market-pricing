/**
 * Elkjøp — konkurrent-pris via Playwright (ikke enkelt HTTP-kall som
 * Power.no, se browser-fetch.ts for hvorfor).
 *
 * Verifisert 2026-09-13:
 *   - Søk på EAN gir "Ingen resultater" — Elkjøp indekserer ikke EAN i søket.
 *   - Søk på MPN fungerer (`/search?q={mpn}`), men søkeresultatene er
 *     100% klient-rendret av Next.js — ingenting å parse i rå HTML.
 *   - Søket blander inn brukt-/outlet-varianter av samme produkt. Outlet-
 *     varianter har en egen URL-sti (`/product/outlet/...`) — ekte,
 *     ny-vare-oppføringer bruker `/product/{kategori}/.../{id}`. Filtrerer
 *     bort outlet-lenker og tar den første ekte kategorilenken.
 *   - Selve produktsiden har ordinær schema.org Product JSON-LD med `gtin`
 *     (EAN) og `mpn` — brukes til å verifisere at treffet faktisk er riktig
 *     produkt, ikke bare et MPN-tekst-treff på noe annet.
 */

import type { MarketPrice } from '../types.ts';
import { withPage, extractProductJsonLd, dismissCookieBanner } from './browser-fetch.ts';

export async function fetchElkjopByMPN(mpn: string, expectedEan?: string | null): Promise<MarketPrice | null> {
  return withPage(async page => {
    try {
      // 'networkidle' henger seg opp permanent på Elkjøp — trolig en
      // live-chat/anbefalings-widget som poller i bakgrunnen og aldri lar
      // nettverket bli "idle". Vent i stedet eksplisitt på selve
      // produktlenkene (bekreftet pålitelig 2026-09-13).
      await page.goto(`https://www.elkjop.no/search?q=${encodeURIComponent(mpn)}`, {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
      await dismissCookieBanner(page);
      await page.waitForSelector('a[href*="/product/"]', { timeout: 15000 }).catch(() => {});

      const searchDiag = await page.evaluate(() => ({
        title: document.title,
        productLinkCount: document.querySelectorAll('a[href*="/product/"]').length,
      }));
      const productPath = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/product/"]'));
        const genuine = links.find(a => {
          const href = a.getAttribute('href') || '';
          return href.startsWith('/product/') && !href.startsWith('/product/outlet/');
        });
        return genuine?.getAttribute('href') || null;
      });
      if (!productPath) {
        // Diagnostikk for neste gang dette knekker stille — se CLAUDE.md
        // 2026-09-13-hendelsen (45/45 feilet uten noen synlig feilmelding).
        console.error(
          `[Elkjøp] Ingen produktlenke funnet for ${mpn} — side-tittel: "${searchDiag.title}", ${searchDiag.productLinkCount} produktlenker totalt i DOM.`
        );
        return null;
      }

      await page.goto(`https://www.elkjop.no${productPath}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await dismissCookieBanner(page);
      await page.waitForSelector('script[type="application/ld+json"]', { timeout: 15000 }).catch(() => {});
      const data = await extractProductJsonLd(page);
      if (!data) {
        console.error(`[Elkjøp] Ingen JSON-LD funnet på produktsiden for ${mpn} (${productPath}).`);
        return null;
      }

      // KRITISK: Elkjøp sitt søk gir ALDRI "ingen resultater" for en MPN
      // uten treff — det faller stille tilbake til å vise "populære
      // produkter" i stedet (bekreftet 2026-09-13: søk på en oppdiktet MPN
      // returnerte AirPods Pro). Uten denne sjekken ville funksjonen returnert
      // et helt vilkårlig produkt som om det var et ekte treff. Sammenlign
      // derfor ALLTID MPN fra JSON-LD mot det vi faktisk spurte om.
      const foundMpn = String(data.mpn ?? '').trim().toLowerCase();
      if (foundMpn !== mpn.trim().toLowerCase()) return null;

      // Ekstra verifisering mot forventet EAN når vi har en.
      if (expectedEan) {
        const foundEan = String(data.gtin ?? '').replace(/^0+/, '');
        if (foundEan && foundEan !== expectedEan.replace(/^0+/, '')) return null;
      }

      const offer = Array.isArray(data.offers) ? data.offers[0] : data.offers;

      return {
        ean: expectedEan ?? (data.gtin ? String(data.gtin) : null),
        mpn: data.mpn ?? mpn,
        source: 'elkjop',
        source_sku: data.sku ?? undefined,
        name: data.name,
        price_inc_vat: offer?.price ?? null,
        price_ex_vat: offer?.price ? Math.round((offer.price / 1.25) * 100) / 100 : null,
        available: offer?.availability?.includes('InStock') ?? false,
        product_url: `https://www.elkjop.no${productPath}`,
        updated_at: new Date().toISOString(),
      };
    } catch (err) {
      console.error(`[Elkjøp] Feil ved oppslag av MPN ${mpn}:`, err);
      return null;
    }
  });
}

/**
 * Batch-henting for en liste MPN-er (med tilhørende forventet EAN for
 * verifisering, samme rekkefølge).
 */
export async function fetchElkjopBatch(
  items: Array<{ mpn: string; ean?: string | null }>
): Promise<MarketPrice[]> {
  console.log(`[Elkjøp] Henter ${items.length} produkter...`);
  const results: MarketPrice[] = [];

  for (let i = 0; i < items.length; i++) {
    const result = await fetchElkjopByMPN(items[i].mpn, items[i].ean);
    if (result) results.push(result);

    if ((i + 1) % 10 === 0) {
      console.log(`[Elkjøp] ${i + 1}/${items.length} behandlet`);
    }
  }

  console.log(`[Elkjøp] ${results.length} av ${items.length} produkter funnet`);
  return results;
}

// Kjør direkte hvis kalt som standalone-script
if (process.argv[1]?.endsWith('elkjop.ts')) {
  const { closeSharedBrowser } = await import('./browser-fetch.ts');
  const mpn = process.argv[2] ?? 'MG6J4QN/A'; // Apple iPhone 17 256GB, svart
  const result = await fetchElkjopByMPN(mpn, '195950643510');
  console.log('[Elkjøp] Resultat:', JSON.stringify(result, null, 2));
  await closeSharedBrowser();
}
