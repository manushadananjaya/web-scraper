/**
 * Init script injected before any page script runs, to patch the most common
 * signals bot-detection scripts check for (navigator.webdriver, missing
 * chrome runtime, headless-flavored plugins/permissions APIs, etc).
 * Not foolproof, but removes the cheap automated-browser tells.
 */
const STEALTH_INIT_SCRIPT = `
(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    window.chrome = window.chrome || { runtime: {} };

    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
        parameters.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery(parameters);

    Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5].map(() => ({ name: 'Chrome PDF Plugin' })),
    });

    Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
    });

    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (parameter) {
        if (parameter === 37445) return 'Intel Inc.'; // UNMASKED_VENDOR_WEBGL
        if (parameter === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
        return getParameter.call(this, parameter);
    };
})();
`;

const STEALTH_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function newContextOptions(overrides = {}) {
    return {
        userAgent: STEALTH_USER_AGENT,
        viewport: { width: 1280, height: 800 },
        locale: 'en-US',
        timezoneId: 'America/New_York',
        extraHTTPHeaders: {
            'Accept-Language': 'en-US,en;q=0.9',
        },
        ...overrides,
    };
}

async function applyStealth(page) {
    await page.addInitScript(STEALTH_INIT_SCRIPT);
}

module.exports = { applyStealth, newContextOptions, STEALTH_USER_AGENT };
