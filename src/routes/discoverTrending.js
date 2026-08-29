const { launchBrowser, getProxyConfig } = require('../lib/browser');
const { applyStealth, newContextOptions } = require('../lib/stealth');
const { resolveCategories, scrapeCategory } = require('../lib/trending/amazonCharts');
const { logger } = require('../lib/log');

const DEFAULT_LIMIT_PER_CATEGORY = 15;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseLimit(req) {
    const limitParam = req.query.limit;
    return limitParam
        ? Math.max(1, Math.min(50, parseInt(limitParam, 10) || DEFAULT_LIMIT_PER_CATEGORY))
        : DEFAULT_LIMIT_PER_CATEGORY;
}

/** GET: live-navigate every configured category and return combined candidates. */
async function handleDiscoverAll(req, res) {
    const limit = parseLimit(req);
    const categories = resolveCategories();

    let browser;
    try {
        browser = await launchBrowser();
    } catch (err) {
        console.error('Browser launch failed:', err.message);
        return res.status(500).json({ success: false, error: `Browser launch failed: ${err.message}` });
    }

    const candidates = [];
    const errors = [];

    try {
        for (const category of categories) {
            const browserContext = await browser.newContext({
                ...newContextOptions(),
                proxy: getProxyConfig(),
            });
            const page = await browserContext.newPage();
            await applyStealth(page);

            try {
                const items = await scrapeCategory(page, category, limit);
                for (const item of items) {
                    candidates.push({ ...item, category: category.key });
                }
                logger.log(`discoverTrending: "${category.key}" → ${items.length} candidates`);
            } catch (err) {
                logger.log(`discoverTrending: category "${category.key}" failed: ${err.message}`);
                errors.push({ category: category.key, error: err.message });
            } finally {
                await browserContext.close();
            }

            // Space out category requests — a burst of back-to-back navigations
            // from one IP is what actually trips Amazon's bot detection.
            await sleep(2000 + Math.random() * 1500);
        }
    } finally {
        await browser.close().catch((err) => console.error('Browser close failed:', err.message));
    }

    return res
        .status(200)
        .json({ success: true, scrapedAt: new Date().toISOString(), candidates, errors });
}

/**
 * POST {category, html}: manual fallback for one category, page source pasted
 * from an admin's own browser session. Skips live navigation entirely.
 */
async function handleDiscoverFromPaste(req, res) {
    const limit = parseLimit(req);
    let body = null;
    try {
        body = JSON.parse(req.body);
    } catch {
        body = null;
    }
    const category = typeof body?.category === 'string' ? body.category.trim() : '';
    const html = typeof body?.html === 'string' ? body.html.trim() : '';

    if (!category || !html) {
        return res.status(400).json({ success: false, error: 'Both "category" and "html" are required' });
    }

    let browser;
    try {
        browser = await launchBrowser();
    } catch (err) {
        console.error('Browser launch failed:', err.message);
        return res.status(500).json({ success: false, error: `Browser launch failed: ${err.message}` });
    }

    try {
        const browserContext = await browser.newContext(newContextOptions());
        const page = await browserContext.newPage();
        await applyStealth(page);

        try {
            const items = await scrapeCategory(page, { key: category, url: null }, limit, { html });
            const candidates = items.map((item) => ({ ...item, category }));
            logger.log(`discoverTrending (paste): "${category}" → ${candidates.length} candidates`);
            return res
                .status(200)
                .json({ success: true, scrapedAt: new Date().toISOString(), candidates, errors: [] });
        } catch (err) {
            return res.status(502).json({ success: false, error: err.message });
        } finally {
            await browserContext.close();
        }
    } finally {
        await browser.close().catch((err) => console.error('Browser close failed:', err.message));
    }
}

async function discoverTrending(req, res) {
    if (req.method === 'POST') {
        return handleDiscoverFromPaste(req, res);
    }
    return handleDiscoverAll(req, res);
}

module.exports = { discoverTrending };
