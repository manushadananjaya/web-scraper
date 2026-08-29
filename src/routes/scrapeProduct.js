const { launchBrowser, getProxyConfig } = require('../lib/browser');
const { applyStealth, newContextOptions } = require('../lib/stealth');
const { detectPlatform, PLATFORMS } = require('../lib/platforms');
const { logger } = require('../lib/log');

// Rapid back-to-back scrapes from the same IP are what actually trips
// bot-check on adversarial sites like Amazon (confirmed by testing: a single
// cold request often sails through, several in quick succession reliably get
// blocked). This is a best-effort, single-instance throttle — process state
// isn't shared across concurrent Container App replicas, so it helps but
// doesn't guarantee spacing under real scale-out.
const MIN_REQUEST_INTERVAL_MS = Number(process.env.SCRAPER_MIN_INTERVAL_MS) || 8000;
let lastRequestAt = 0;

async function throttle() {
    const elapsed = Date.now() - lastRequestAt;
    const waitMs = MIN_REQUEST_INTERVAL_MS - elapsed;
    if (waitMs > 0) {
        logger.log(`Throttling ${waitMs}ms before scrape to avoid tripping rate-based bot detection`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    lastRequestAt = Date.now();
}

/** GET/POST /api/scrapeProduct — ?url=... or body {url, html} / plain-text URL. */
async function scrapeProduct(req, res) {
    let productUrl = req.query.url || null;
    let html = null;

    // A JSON body of {url, html} carries pasted page source (see
    // platforms/amazon.js) for sites whose live navigation gets blocked.
    // Falls back to treating the whole body as a plain-text URL.
    if (req.method === 'POST' && typeof req.body === 'string' && req.body.trim()) {
        const bodyText = req.body;
        try {
            const parsed = JSON.parse(bodyText);
            if (parsed && typeof parsed === 'object') {
                productUrl = productUrl || parsed.url;
                html = typeof parsed.html === 'string' && parsed.html.trim() ? parsed.html : null;
            }
        } catch {
            productUrl = productUrl || bodyText.trim();
        }
    }

    if (!productUrl) {
        return res.status(400).json({ error: 'Product URL required (pass as ?url=... or in body)' });
    }

    const platform = detectPlatform(productUrl);
    if (!platform) {
        const supported = PLATFORMS.map((p) => p.name).join(', ');
        return res
            .status(400)
            .json({ error: `Unsupported platform for URL: ${productUrl}. Supported: ${supported}` });
    }

    if (!html) {
        // No point throttling a request that never actually hits the source site.
        await throttle();
    }

    let browser;
    try {
        browser = await launchBrowser();
    } catch (err) {
        console.error('Browser launch failed:', err.message);
        return res.status(500).json({ success: false, error: `Browser launch failed: ${err.message}` });
    }

    try {
        const browserContext = await browser.newContext({
            ...newContextOptions(),
            proxy: getProxyConfig(),
        });
        const page = await browserContext.newPage();
        await applyStealth(page);

        let result;
        try {
            result = await platform.scrape(page, productUrl, logger, { html });
        } catch (err) {
            return res
                .status(err.status || 502)
                .json({ success: false, error: err.message, finalUrl: err.finalUrl });
        }

        return res.status(200).json({
            success: true,
            url: productUrl,
            finalUrl: result.finalUrl,
            platform: platform.name,
            scrapedAt: new Date().toISOString(),
            data: result.data,
        });
    } catch (err) {
        console.error('Scrape failed:', err.message);
        return res.status(500).json({ success: false, error: err.message });
    } finally {
        await browser.close().catch((err) => console.error('Browser close failed:', err.message));
    }
}

module.exports = { scrapeProduct };
