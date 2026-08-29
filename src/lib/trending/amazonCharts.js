const NAV_TIMEOUT_MS = 30000;

/**
 * Amazon's zg (Zeitgeist) chart family — Movers & Shakers, Best Sellers, New
 * Releases, Most Wished For — all share the same page template and the
 * same category URL scheme (/gp/{chart}/{slug}), so this module works
 * against any of them; only DEFAULT_CATEGORIES' URLs below pick which one.
 *
 * History of what was tried, in order:
 *   1. Movers & Shakers (biggest 24h rank gainers) — returns an empty "no
 *      movers and shakers available" state for any non-US-resolving IP,
 *      confirmed even through a VPN. Abandoned.
 *   2. Best Sellers (top 100 by current sales rank) — renders real content,
 *      but is dominated by the same perennial handful of items (AirPods,
 *      Fire TV Stick) for months at a time, since sales-rank leaders don't
 *      turn over quickly. Bad fit for "discover new things to review".
 *   3. New Releases (current default) — tied to launch date rather than
 *      sales history, so the list structurally rotates as products age out
 *      and new ones launch. Confirmed live: same three category URLs work,
 *      and the returned titles are meaningfully different/more varied
 *      (OURA Ring, Roku QLED TV, Polaroid camera, niche earbud brands) than
 *      Best Sellers' repeat-heavy list.
 * Best Sellers URLs still work if you want to mix sources — see
 * resolveCategories() below; just point a category's url at
 * /gp/bestsellers/... instead via the DISCOVER_CATEGORIES env var.
 */
const DEFAULT_CATEGORIES = [
    { key: 'electronics', label: 'Electronics', url: 'https://www.amazon.com/gp/new-releases/electronics' },
    { key: 'computers', label: 'Computers', url: 'https://www.amazon.com/gp/new-releases/pc' },
    { key: 'headphones', label: 'Headphones', url: 'https://www.amazon.com/gp/new-releases/electronics/172541' },
];

/** DISCOVER_CATEGORIES, if set, must be a JSON array of {key, label, url}. */
function resolveCategories() {
    const override = process.env.DISCOVER_CATEGORIES;
    if (!override) return DEFAULT_CATEGORIES;

    try {
        const parsed = JSON.parse(override);
        if (Array.isArray(parsed) && parsed.every((c) => c && c.key && c.url)) {
            return parsed;
        }
    } catch {
        // fall through to default
    }
    return DEFAULT_CATEGORIES;
}

async function isInterstitial(page) {
    const hasContinueButton = await page.$('button:has-text("Continue shopping")');
    return !!hasContinueButton;
}

/**
 * Amazon's zg (Zeitgeist) chart family — Best Sellers, Movers & Shakers, New
 * Releases — shares a common template. Rather than lean on that template's
 * specific class names (the kind of thing that silently drifts — see
 * amazon.js's review-markup lesson from earlier this project), this anchors
 * only on the one thing guaranteed stable: every ranked entry links to a
 * product page via /dp/{ASIN}. Rank is taken from list position (confirmed
 * live: top-to-bottom DOM order matches displayed rank), not a badge class,
 * since position is the only signal here immune to markup churn.
 */
async function scrapeCategory(page, category, limit, options = {}) {
    if (options.html) {
        // Manual fallback (mirrors amazon.js's product-page paste option): an
        // admin pastes the chart page source captured from their own
        // browser session, skipping live navigation entirely — useful if
        // Amazon ever starts blocking this chart too.
        await page.setContent(options.html, { waitUntil: 'domcontentloaded' });
    } else {
        await page.goto(category.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        await page.waitForTimeout(1500);

        if (await isInterstitial(page)) {
            throw new Error('Blocked by Amazon bot-check interstitial');
        }
    }

    return page.evaluate((limit) => {
        const container =
            document.querySelector('#zg-ordered-list') ||
            document.querySelector('.p13n-desktop-grid') ||
            document.body;

        const seen = new Set();
        const results = [];

        for (const link of container.querySelectorAll('a[href*="/dp/"]')) {
            const match = link.href.match(/\/dp\/([A-Z0-9]{10})/);
            if (!match) continue;
            const asin = match[1];
            if (seen.has(asin)) continue;

            const title =
                link.querySelector('img[alt]')?.getAttribute('alt')?.trim() ||
                link.innerText?.trim() ||
                link.getAttribute('title')?.trim() ||
                null;
            if (!title) continue;

            seen.add(asin);
            results.push({
                productUrl: `https://www.amazon.com/dp/${asin}`,
                title,
                rank: results.length + 1,
            });
            if (results.length >= limit) break;
        }

        return results;
    }, limit);
}

module.exports = { DEFAULT_CATEGORIES, resolveCategories, scrapeCategory };
