const NAV_TIMEOUT_MS = 30000;

function matches(url) {
    try {
        return /(^|\.)amazon\.[a-z.]+$/i.test(new URL(url).hostname);
    } catch {
        return false;
    }
}

async function isInterstitial(page) {
    const [hasContinueButton, hasProductTitle] = await Promise.all([
        page.$('button:has-text("Continue shopping")'),
        page.$('#productTitle'),
    ]);
    return !!hasContinueButton && !hasProductTitle;
}

/**
 * Amazon's bot-check interstitial appears on first load of a fresh context.
 * Clicking its "Continue shopping" button redirects to the homepage instead
 * of back to the product page, so instead we re-navigate directly to the
 * same URL — the interstitial visit is enough to set the session cookie
 * that lets the second direct request through. Clicking is kept as a
 * last-resort fallback if the re-navigation doesn't clear it.
 */
async function navigateToProduct(page, url, context) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

    if (await isInterstitial(page)) {
        context.log('Interstitial detected on first load; re-navigating directly to product URL...');
        await page.waitForTimeout(1500 + Math.random() * 1000);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    }

    if (await isInterstitial(page)) {
        context.log('Interstitial still present after re-navigation; falling back to clicking through...');
        const continueButton = await page.$('button:has-text("Continue shopping")');
        if (continueButton) {
            await continueButton.click();
            await page.waitForLoadState('domcontentloaded');
            await page.waitForTimeout(1500);
        }
    }

    return page.url();
}

function extractProductData(page) {
    return page.evaluate(() => {
        const getText = (sel) => document.querySelector(sel)?.innerText?.trim() || null;

        // Amazon has (at least) two review-card markups in the wild: an older
        // one (review-title/review-body/avp-badge) and a newer one
        // (reviewTitle/reviewText/review-badges) — confirmed live this
        // session, the product tested served the newer markup exclusively.
        // Try both so either variant works.
        const reviews = Array.from(document.querySelectorAll('[data-hook="review"]'))
            .slice(0, 15)
            .map((card) => {
                const badgeText =
                    card.querySelector('[data-hook="review-badges"], [data-hook="avp-badge"]')?.innerText || '';
                return {
                    title:
                        card.querySelector('[data-hook="reviewTitle"], [data-hook="review-title"]')?.innerText?.trim() ||
                        null,
                    text:
                        card.querySelector('[data-hook="reviewText"], [data-hook="review-body"]')?.innerText?.trim() ||
                        null,
                    rating: card.querySelector('[data-hook="review-star-rating"]')?.innerText?.trim() || null,
                    author: card.querySelector('.a-profile-name')?.innerText?.trim() || null,
                    verified: /verified purchase/i.test(badgeText),
                };
            })
            .filter((r) => r.text);

        // #bylineInfo reads "Visit the <Brand> Store" (or occasionally just
        // "Brand: <Brand>") — strip the wrapper text down to the brand name.
        const bylineText = getText('#bylineInfo');
        const brand = bylineText
            ? bylineText.replace(/^Visit the\s+/i, '').replace(/\s+Store$/i, '').replace(/^Brand:\s*/i, '').trim()
            : null;

        // In-stock items show "In Stock" under #availability; out-of-stock/
        // unavailable items render under #outOfStock instead — confirmed live,
        // both against the same real product page in different states.
        const availability = getText('#availability span') || getText('#outOfStock span');

        // #altImages thumbnails are tiny (often ~40px) — stretched to fill a
        // normal card width, that's what reads as "blurry". Amazon's own
        // hover-zoom feature swaps in a full-resolution image on hover, and
        // it gets there via each thumbnail's data-old-hires attribute — a
        // long-standing, well-documented convention (not guessed this
        // session, but not live-verified either while Amazon is blocking
        // navigation — worth a spot check once a scrape succeeds). Falls
        // back to the thumbnail src itself when a given thumbnail lacks it
        // (e.g. color-swatch icons), and includes the large main image too.
        // Amazon media URLs embed a size directive ("71abc._AC_SX466_.jpg").
        // The thumbnail strip serves ~40px variants, which look blurry blown up
        // to card/gallery size — stripping the directive yields the original
        // full-resolution asset ("71abc.jpg").
        const upgrade = (url) =>
            typeof url === 'string'
                ? url.replace(/\._[^/]+?(\.(?:jpe?g|png|gif|webp))(?=$|\?)/i, '$1')
                : url;
        const getHiRes = (img) => {
            // #landingImage carries data-a-dynamic-image: a JSON map of
            // {url: [w, h]} for the main image — take the widest.
            const dyn = img.getAttribute('data-a-dynamic-image');
            if (dyn) {
                try {
                    const entries = Object.entries(JSON.parse(dyn));
                    entries.sort((a, b) => (b[1]?.[0] || 0) - (a[1]?.[0] || 0));
                    if (entries[0]) return entries[0][0];
                } catch {
                    /* fall through */
                }
            }
            return img.getAttribute('data-old-hires') || upgrade(img.src);
        };
        const mainImage = document.querySelector('#landingImage, #imgTagWrapperId img');
        const galleryImages = Array.from(document.querySelectorAll('#altImages img'))
            .map(getHiRes)
            .filter((src) => src && !src.includes('sprite'))
            .map(upgrade);

        return {
            title: getText('#productTitle'),
            price: getText('.a-price .a-offscreen') || getText('#priceblock_ourprice'),
            rating: getText('#acrPopover')?.match(/[\d.]+/)?.[0] || null,
            reviewCount: getText('#acrCustomerReviewText'),
            brand,
            availability,
            images: [
                ...new Set(
                    [mainImage && getHiRes(mainImage), ...galleryImages].filter(Boolean).map(upgrade)
                ),
            ],
            bulletPoints: Array.from(document.querySelectorAll('#feature-bullets li'))
                .map((li) => li.innerText.trim())
                .filter(Boolean),
            specs: Array.from(
                document.querySelectorAll(
                    '#productDetails_techSpec_section_1 tr, #productDetails_techSpec_section_2 tr, #productDetails_detailBullets_sections1 tr, #productDetails_db_sections tr'
                )
            ).reduce((acc, row) => {
                const key = row.querySelector('th')?.innerText?.trim();
                const val = row.querySelector('td')?.innerText?.trim();
                if (key && val) acc[key] = val;
                return acc;
            }, {}),
            reviews,
        };
    });
}

/**
 * `options.html`, when provided, is page source saved from a real browser
 * session (DevTools "Copy outerHTML" after the page loaded, or "Save As
 * Webpage, Complete"). A real browser rarely trips the interstitial the way
 * our automated traffic does, so this is the practical workaround: skip live
 * navigation and the whole interstitial dance, and just extract from the
 * HTML the user already has.
 */
async function scrape(page, url, context, options = {}) {
    let finalUrl;

    if (options.html) {
        await page.setContent(options.html, { waitUntil: 'domcontentloaded' });
        finalUrl = url;
    } else {
        finalUrl = await navigateToProduct(page, url, context);

        if (await isInterstitial(page)) {
            const err = new Error('Blocked by Amazon bot-check interstitial');
            err.status = 503;
            err.finalUrl = finalUrl;
            throw err;
        }
    }

    const data = await extractProductData(page);

    if (!data.title) {
        // Page loaded but not on the expected product layout (redirected, CAPTCHA, dead listing, etc).
        const err = new Error('Could not locate product data on the page (unexpected page layout or redirect)');
        err.status = 502;
        err.finalUrl = finalUrl;
        throw err;
    }

    return { finalUrl, data };
}

module.exports = { name: 'amazon', matches, scrape };
