const { app } = require('@azure/functions');
const { launchBrowser, getProxyConfig } = require('../lib/browser');
const { applyStealth, newContextOptions } = require('../lib/stealth');
const { resolveCategories, scrapeCategory } = require('../lib/trending/amazonCharts');

const DEFAULT_LIMIT_PER_CATEGORY = 15;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseLimit(request) {
    const limitParam = request.query.get('limit');
    return limitParam
        ? Math.max(1, Math.min(50, parseInt(limitParam, 10) || DEFAULT_LIMIT_PER_CATEGORY))
        : DEFAULT_LIMIT_PER_CATEGORY;
}

/** GET: live-navigate every configured category and return combined candidates. */
async function handleDiscoverAll(request, context) {
    const limit = parseLimit(request);
    const categories = resolveCategories();

    let browser;
    try {
        browser = await launchBrowser();
    } catch (err) {
        context.error('Browser launch failed:', err.message);
        return { status: 500, jsonBody: { success: false, error: `Browser launch failed: ${err.message}` } };
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
                context.log(`discoverTrending: "${category.key}" → ${items.length} candidates`);
            } catch (err) {
                context.log(`discoverTrending: category "${category.key}" failed: ${err.message}`);
                errors.push({ category: category.key, error: err.message });
            } finally {
                await browserContext.close();
            }

            // Space out category requests the same way individual product
            // scrapes are throttled — a burst of back-to-back navigations
            // from one IP is what actually trips Amazon's bot detection.
            await sleep(2000 + Math.random() * 1500);
        }
    } finally {
        await browser.close().catch((err) => context.error('Browser close failed:', err.message));
    }

    return { status: 200, jsonBody: { success: true, scrapedAt: new Date().toISOString(), candidates, errors } };
}

/**
 * POST {category, html}: manual fallback for one category, page source
 * pasted from an admin's own browser session — mirrors amazon.js's
 * product-page paste option. Skips live navigation entirely.
 */
async function handleDiscoverFromPaste(request, context) {
    const limit = parseLimit(request);
    const body = await request.json().catch(() => null);
    const category = typeof body?.category === 'string' ? body.category.trim() : '';
    const html = typeof body?.html === 'string' ? body.html.trim() : '';

    if (!category || !html) {
        return { status: 400, jsonBody: { success: false, error: 'Both "category" and "html" are required' } };
    }

    let browser;
    try {
        browser = await launchBrowser();
    } catch (err) {
        context.error('Browser launch failed:', err.message);
        return { status: 500, jsonBody: { success: false, error: `Browser launch failed: ${err.message}` } };
    }

    try {
        const browserContext = await browser.newContext(newContextOptions());
        const page = await browserContext.newPage();
        await applyStealth(page);

        try {
            const items = await scrapeCategory(page, { key: category, url: null }, limit, { html });
            const candidates = items.map((item) => ({ ...item, category }));
            context.log(`discoverTrending (paste): "${category}" → ${candidates.length} candidates`);
            return {
                status: 200,
                jsonBody: { success: true, scrapedAt: new Date().toISOString(), candidates, errors: [] },
            };
        } catch (err) {
            return { status: 502, jsonBody: { success: false, error: err.message } };
        } finally {
            await browserContext.close();
        }
    } finally {
        await browser.close().catch((err) => context.error('Browser close failed:', err.message));
    }
}

app.http('discoverTrending', {
    methods: ['GET', 'POST'],
    authLevel: 'function',
    handler: async (request, context) => {
        if (request.method === 'POST') {
            return handleDiscoverFromPaste(request, context);
        }
        return handleDiscoverAll(request, context);
    },
});
