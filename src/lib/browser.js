const isAzure = !!process.env.WEBSITE_INSTANCE_ID; // true only when running in Azure

async function launchBrowser() {
    const launchOptions = {
        headless: true,
        args: ['--disable-blink-features=AutomationControlled'],
    };

    if (isAzure) {
        const chromium = require('@sparticuz/chromium');
        const playwright = require('playwright-core');
        launchOptions.args.push(...chromium.args);
        launchOptions.executablePath = await chromium.executablePath();
        return playwright.chromium.launch(launchOptions);
    }

    const { chromium: localChromium } = require('playwright');
    return localChromium.launch(launchOptions);
}

/** Resolves the chromium executable path without launching a browser. Used by the health check. */
async function resolveExecutablePath() {
    if (isAzure) {
        const chromium = require('@sparticuz/chromium');
        return chromium.executablePath();
    }
    const { chromium: localChromium } = require('playwright');
    return localChromium.executablePath();
}

/**
 * Reads proxy settings from env vars, for routing scrape traffic through a
 * residential/rotating proxy instead of the Function's own outbound IP —
 * the only real fix once that IP has been rate-flagged by Amazon (see
 * SCRAPER_PROXY_SERVER etc in local.settings.json / Azure App Settings).
 * Returns undefined when unconfigured, which Playwright treats as "no proxy".
 */
function getProxyConfig() {
    const server = process.env.SCRAPER_PROXY_SERVER;
    if (!server) return undefined;

    const proxy = { server };
    if (process.env.SCRAPER_PROXY_USERNAME) proxy.username = process.env.SCRAPER_PROXY_USERNAME;
    if (process.env.SCRAPER_PROXY_PASSWORD) proxy.password = process.env.SCRAPER_PROXY_PASSWORD;
    return proxy;
}

module.exports = { isAzure, launchBrowser, resolveExecutablePath, getProxyConfig };
