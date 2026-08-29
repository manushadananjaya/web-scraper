// WEBSITE_INSTANCE_ID is set on most Azure Functions plans, but NOT on Flex
// Consumption, so also honor an explicit RUNNING_ON_AZURE app setting.
const isAzure = !!process.env.WEBSITE_INSTANCE_ID || process.env.RUNNING_ON_AZURE === '1';

/**
 * @sparticuz/chromium v149 ships as ESM. Node 20.19+ (the Azure Functions
 * runtime) lets us require() it, but it resolves to the module namespace —
 * the chromium object with .args / .executablePath() lives on .default.
 */
function loadSparticuzChromium() {
    const mod = require('@sparticuz/chromium');
    return mod.default || mod;
}

async function launchBrowser() {
    const launchOptions = {
        headless: true,
        args: ['--disable-blink-features=AutomationControlled'],
    };

    if (isAzure) {
        const chromium = loadSparticuzChromium();
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
        const chromium = loadSparticuzChromium();
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
