/**
 * Chromium comes from the Playwright base image (mcr.microsoft.com/playwright),
 * which ships the browser and every shared library it links. So there is no
 * @sparticuz/chromium / Lambda-style dance any more — just launch Playwright's
 * bundled chromium. `--no-sandbox` / `--disable-dev-shm-usage` are the standard
 * flags for running headless chromium inside a container.
 */
async function launchBrowser() {
    const { chromium } = require('playwright');
    return chromium.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
        ],
    });
}

/** Resolves the chromium executable path without launching a browser. Used by the health check. */
async function resolveExecutablePath() {
    const { chromium } = require('playwright');
    return chromium.executablePath();
}

/**
 * Reads proxy settings from env vars, for routing scrape traffic through a
 * residential/rotating proxy instead of the container's own outbound IP —
 * the only real fix once that IP has been rate-flagged by Amazon (see
 * SCRAPER_PROXY_SERVER etc). Returns undefined when unconfigured, which
 * Playwright treats as "no proxy".
 */
function getProxyConfig() {
    const server = process.env.SCRAPER_PROXY_SERVER;
    if (!server) return undefined;

    const proxy = { server };
    if (process.env.SCRAPER_PROXY_USERNAME) proxy.username = process.env.SCRAPER_PROXY_USERNAME;
    if (process.env.SCRAPER_PROXY_PASSWORD) proxy.password = process.env.SCRAPER_PROXY_PASSWORD;
    return proxy;
}

module.exports = { launchBrowser, resolveExecutablePath, getProxyConfig };
