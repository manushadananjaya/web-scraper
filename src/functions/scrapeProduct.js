const { app } = require('@azure/functions');
const { launchBrowser, getProxyConfig } = require('../lib/browser');
const { applyStealth, newContextOptions } = require('../lib/stealth');
const { detectPlatform, PLATFORMS } = require('../lib/platforms');

// Rapid back-to-back scrapes from the same IP are what actually trips
// bot-check on adversarial sites like Amazon (confirmed by testing: a single
// cold request often sails through, several in quick succession reliably get
// blocked). This is a best-effort, single-instance throttle — module state
// resets on cold start and isn't shared across concurrent Azure instances,
// so it helps but doesn't guarantee spacing under real scale-out.
const MIN_REQUEST_INTERVAL_MS = Number(process.env.SCRAPER_MIN_INTERVAL_MS) || 8000;
let lastRequestAt = 0;

async function throttle(context) {
    const elapsed = Date.now() - lastRequestAt;
    const waitMs = MIN_REQUEST_INTERVAL_MS - elapsed;
    if (waitMs > 0) {
        context.log(`Throttling ${waitMs}ms before scrape to avoid tripping rate-based bot detection`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    lastRequestAt = Date.now();
}

app.http('scrapeProduct', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        let productUrl = request.query.get('url');
        let html = null;

        // A JSON body of {url, html} carries pasted page source (see
        // platforms/amazon.js) for sites whose live navigation gets blocked.
        // Falls back to treating the whole body as a plain-text URL, which
        // is the existing behavior callers already rely on.
        if (request.method === 'POST') {
            const bodyText = await request.text().catch(() => null);
            if (bodyText) {
                try {
                    const parsed = JSON.parse(bodyText);
                    if (parsed && typeof parsed === 'object') {
                        productUrl = productUrl || parsed.url;
                        html = typeof parsed.html === 'string' && parsed.html.trim() ? parsed.html : null;
                    }
                } catch {
                    productUrl = productUrl || bodyText;
                }
            }
        }

        if (!productUrl) {
            return {
                status: 400,
                jsonBody: { error: 'Product URL required (pass as ?url=... or in body)' },
            };
        }

        const platform = detectPlatform(productUrl);
        if (!platform) {
            const supported = PLATFORMS.map((p) => p.name).join(', ');
            return {
                status: 400,
                jsonBody: { error: `Unsupported platform for URL: ${productUrl}. Supported: ${supported}` },
            };
        }

        if (!html) {
            // No point throttling a request that never actually hits the
            // source site — the whole reason to throttle is to avoid
            // tripping their rate-based bot detection.
            await throttle(context);
        }

        let browser;
        try {
            browser = await launchBrowser();
        } catch (err) {
            context.error('Browser launch failed:', err.message);
            return {
                status: 500,
                jsonBody: { success: false, error: `Browser launch failed: ${err.message}` },
            };
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
                result = await platform.scrape(page, productUrl, context, { html });
            } catch (err) {
                return {
                    status: err.status || 502,
                    jsonBody: { success: false, error: err.message, finalUrl: err.finalUrl },
                };
            }

            return {
                status: 200,
                jsonBody: {
                    success: true,
                    url: productUrl,
                    finalUrl: result.finalUrl,
                    platform: platform.name,
                    scrapedAt: new Date().toISOString(),
                    data: result.data,
                },
            };
        } catch (err) {
            context.error('Scrape failed:', err.message);
            return {
                status: 500,
                jsonBody: { success: false, error: err.message },
            };
        } finally {
            await browser.close().catch((err) => context.error('Browser close failed:', err.message));
        }
    },
});
