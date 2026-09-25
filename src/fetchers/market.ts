/**
 * Markedspriser — Eplehuset, Dustin (fetch-basert, ingen auth)
 * Komplett og Power krever Playwright — se README for oppsett.
 *
 * Eplehuset: Shopify /products.json (åpent API)
 * Dustin: SSR JSON-LD via /search/{MPN}
 */

import type { MarketPrice } from '../types.ts';

const UA = 'Mozilla/5.0 (compatible; ImperoBot/1.0; +https://shop.impero.no)';
const DELAY_MS = 800;

// ────────────────────────────────
// Eplehuset (Shopify)
// ────────────────────────────────

export async function fetchEplehuset(): Promise<MarketPrice[]> {
  console.log('[Eplehuset] Starter synk via Shopify /products.json...');
  const results: MarketPrice[] = [];
  let page = 1;

  while (true) {
    const resp = await fetch(
      `https://www.eplehuset.no/products.json?limit=250&page=${page}`,
      { headers: { 'User-Agent': UA } }
    );

    if (!resp.ok) {
      console.error(`[Eplehuset] HTTP ${resp.status} på side ${page}`);
      break;
    }

    const data = await resp.json() as { products: ShopifyProduct[] };
    if (!data.products?.length) break;

    // Filtrer kun Apple-produkter
    const appleProducts = data.products.filter(p => p.vendor === 'Apple');

    for (const product of appleProducts) {
      for (const variant of product.variants) {
        const sku = variant.sku?.trim();
        if (!sku) continue;

        results.push({
          mpn: sku, // Apple P/N
          source: 'eplehuset',
          source_sku: String(variant.id),
          name: product.title,
          price_inc_vat: parseFloat(variant.price) || null,
          price_ex_vat: variant.price
            ? Math.round((parseFloat(variant.price) / 1.25) * 100) / 100
            : null,
          available: variant.available,
          image_url: product.images[0]?.src ?? undefined,
          product_url: `https://www.eplehuset.no/products/${product.handle}`,
          updated_at: new Date().toISOString(),
        });
      }
    }

    console.log(`[Eplehuset] Side ${page}: ${appleProducts.length} Apple-produkter`);
    if (data.products.length < 250) break;
    page++;
    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  console.log(`[Eplehuset] Totalt ${results.length} varianter`);
  return results;
}

interface ShopifyProduct {
  id: number;
  title: string;
  handle: string;
  product_type: string;
  vendor: string;
  images: { src: string }[];
  variants: {
    id: number;
    sku: string;
    price: string;
    compare_at_price: string;
    available: boolean;
  }[];
}

// ────────────────────────────────
// Dustin (SSR JSON-LD)
// ────────────────────────────────

/**
 * Hent pris for ett konkret MPN fra Dustin.
 * Bruk for spot-sjekk eller batch av kjente MPN-er.
 */
export async function fetchDustinByMPN(mpn: string): Promise<MarketPrice | null> {
  try {
    const url = `https://www.dustin.no/search/${encodeURIComponent(mpn)}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      redirect: 'follow',
    });

    if (!resp.ok) return null;

    const html = await resp.text();
    const matches = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];

    for (const match of matches) {
      try {
        const data = JSON.parse(match[1]);
        if (data['@type'] === 'Product') {
          const priceExVat = data.offers?.price ?? null;
          return {
            mpn: data.mpn ?? mpn,
            source: 'dustin',
            source_sku: data.sku ?? undefined,
            name: data.name,
            price_ex_vat: priceExVat,
            // Dustin priser er ekskl. MVA (valueAddedTaxIncluded: false)
            price_inc_vat: priceExVat ? Math.round(priceExVat * 1.25) : null,
            available: data.offers?.availability?.includes('InStock') ?? false,
            image_url: Array.isArray(data.image) ? data.image[0] : data.image,
            product_url: data.offers?.url ?? resp.url,
            updated_at: new Date().toISOString(),
          };
        }
      } catch {
        continue;
      }
    }
  } catch (err) {
    console.error(`[Dustin] Feil ved oppslag av ${mpn}:`, err);
  }

  return null;
}

/**
 * Batch-henting av Dustin-priser for liste av MPN-er.
 */
export async function fetchDustinBatch(mpns: string[]): Promise<MarketPrice[]> {
  console.log(`[Dustin] Henter ${mpns.length} produkter...`);
  const results: MarketPrice[] = [];

  for (let i = 0; i < mpns.length; i++) {
    const result = await fetchDustinByMPN(mpns[i]);
    if (result) results.push(result);

    if ((i + 1) % 10 === 0) {
      console.log(`[Dustin] ${i + 1}/${mpns.length} behandlet`);
    }

    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  console.log(`[Dustin] ${results.length} av ${mpns.length} produkter funnet`);
  return results;
}

// Kjør direkte hvis kalt som standalone-script
if (process.argv[1]?.endsWith('market.ts')) {
  const source = process.argv[2] ?? 'eplehuset';

  if (source === 'eplehuset') {
    const products = await fetchEplehuset();
    console.log('[Eplehuset] Eksempel:', JSON.stringify(products[0], null, 2));
  } else if (source === 'dustin') {
    // Eksempel: hent pris for ett kjent MPN
    const result = await fetchDustinByMPN('AD3C6ET#UUW');
    console.log('[Dustin] Resultat:', JSON.stringify(result, null, 2));
  }
}
