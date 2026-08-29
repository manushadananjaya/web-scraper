const express = require('express');
const { health } = require('./routes/health');
const { scrapeProduct } = require('./routes/scrapeProduct');
const { discoverTrending } = require('./routes/discoverTrending');

const app = express();

// Every body arrives as a raw string — scrapeProduct/discoverTrending accept
// either JSON ({url, html}) or a plain-text URL, so they parse it themselves.
// 25mb covers a pasted full-page HTML source.
app.use(express.text({ type: () => true, limit: '25mb' }));

/**
 * discoverTrending is the expensive endpoint (spins up a browser, walks several
 * Amazon category pages). Gate it behind API_KEY when that env var is set;
 * leave it open otherwise (local dev). Pass the key as `X-API-Key` header or
 * `?code=` query param.
 */
function requireApiKey(req, res, next) {
    const expected = process.env.API_KEY;
    if (!expected) return next();
    const provided = req.get('x-api-key') || req.query.code;
    if (provided === expected) return next();
    return res.status(401).json({ success: false, error: 'Unauthorized' });
}

app.get('/api/health', health);
app.all('/api/scrapeProduct', scrapeProduct);
app.all('/api/discoverTrending', requireApiKey, discoverTrending);

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`web-scraper listening on :${port}`));
