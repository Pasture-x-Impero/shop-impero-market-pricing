/**
 * Delt Playwright-hjelper for konkurrent-sider som ikke kan hentes med et
 * enkelt HTTP-kall (Elkjøp, Komplett — begge har enten JS-rendrede
 * søkeresultater eller bot-beskyttelse, se CLAUDE.md 2026-09-13).
 *
 * Én delt, gjenbrukt browser-instans på tvers av kall (ikke én per oppslag)
 * — det ville vært unødvendig tregt å starte Chromium på nytt for hvert
 * eneste produkt i en batch på potensielt tusenvis.
 */

import { chromium, type Browser, type Page } from 'playwright';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let browserPromise: Promise<Browser> | null = null;

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true });
  }
  return browserPromise;
}

/**
 * Skjuler de vanligste, billige signalene nettsider bruker til å oppdage
 * headless Chromium (`navigator.webdriver`, tom `plugins`-liste, manglende
 * `window.chrome`, osv.) — lagt til 2026-09-13 etter at Elkjøp sin fetcher
 * feilet 45/45 i produksjon (0 treff, ~15s/oppslag — konsistent med at en
 * bot-beskyttelse serverer en tom/forenklet side til datasenter-IP-er i
 * stedet for de ekte søkeresultatene, se filkommentar i elkjop.ts). Samme
 * klasse tiltak som ble forsøkt for ALSO sin 2FA-automatisering — ingen
 * garanti for at det hjelper mot en server-side IP-vurdering, men billig og
 * risikofritt å legge til, og gjelder nå BEGGE fetcherne som deler denne
 * hjelpefunksjonen (Elkjøp og Dustin).
 */
async function applyStealth(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['nb-NO', 'nb', 'en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    (window as any).chrome = (window as any).chrome || { runtime: {} };
    const originalQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
    // @ts-ignore — spoofer kun notifications-grenen, resten går til original
    window.navigator.permissions.query = (parameters: any) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
        : originalQuery(parameters);
  });
}

/**
 * Klikker bort en cookie-consent-modal hvis en finnes (f.eks. Elkjøp sin
 * "Godta alle"/"Avvis alle"-dialog) — ikke fordi den blokkerer DOM-innholdet
 * (bekreftet 2026-09-13 at produktlenker/JSON-LD finnes uansett), men fordi
 * en ekte besøkende alltid ville interagert med den, og noen bot-
 * beskyttelser bruker nettopp fravær av denne interaksjonen som signal.
 * Trygg no-op hvis ingen modal finnes.
 */
export async function dismissCookieBanner(page: Page): Promise<void> {
  try {
    const button = page.getByRole('button', { name: /godta alle|aksepter alle|accept all/i }).first();
    await button.click({ timeout: 3000 });
  } catch {
    // Ingen modal å lukke — helt normalt, ikke en feil.
  }
}

/**
 * Kjør en funksjon med en fersk side (egen context, egne cookies) i den
 * delte browser-instansen. Siden/konteksten lukkes alltid etterpå, selv ved
 * feil — browseren selv holdes åpen for gjenbruk.
 */
export async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: UA,
    locale: 'nb-NO',
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: { 'Accept-Language': 'nb-NO,nb;q=0.9,en;q=0.8' },
  });
  const page = await context.newPage();
  await applyStealth(page);
  try {
    return await fn(page);
  } finally {
    await context.close();
  }
}

/**
 * Steng den delte browser-instansen. Kall dette når et script er helt
 * ferdig (ellers henger Node-prosessen siden Chromium fortsatt kjører).
 */
export async function closeSharedBrowser(): Promise<void> {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
    browserPromise = null;
  }
}

/**
 * Plukk ut schema.org Product-data fra JSON-LD på siden — håndterer både
 * en flat `{"@type":"Product",...}`-blokk (Elkjøp, Komplett) og en
 * `{"@graph":[...]}`-struktur (Power.no sin nettside, om den noen gang
 * trengs via browser i stedet for deres JSON-API).
 */
export async function extractProductJsonLd(page: Page): Promise<Record<string, any> | null> {
  const scripts = await page.$$eval('script[type="application/ld+json"]', els =>
    els.map(e => e.textContent || '')
  );
  for (const raw of scripts) {
    try {
      const data = JSON.parse(raw);
      if (data['@type'] === 'Product') return data;
      if (Array.isArray(data['@graph'])) {
        const product = data['@graph'].find((n: any) => n['@type'] === 'Product');
        if (product) return product;
      }
    } catch {
      continue;
    }
  }
  return null;
}
