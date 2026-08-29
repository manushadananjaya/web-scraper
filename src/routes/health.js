const { resolveExecutablePath } = require('../lib/browser');

/** GET /api/health — confirms the chromium binary is present and resolvable. */
async function health(req, res) {
    try {
        const chromiumExecutablePath = await resolveExecutablePath();
        res.json({ success: true, runtime: 'container', chromiumExecutablePath });
    } catch (err) {
        console.error('Health check failed to resolve chromium:', err.message);
        res.status(503).json({ success: false, runtime: 'container', error: err.message });
    }
}

module.exports = { health };
