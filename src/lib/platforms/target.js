const NAV_TIMEOUT_MS = 25000;

function matches(url) {
    try {
        return /(^|\.)target\.com$/i.test(new URL(url).hostname);
    } catch {
        return false;
    }
}

/**
 * Unlike Amazon, target.com has not shown any bot-check interstitial in
 * testing — no click-through, no re-navigation trick needed. The only
 * wrinkle is that reviews and some detail sections lazy-render on scroll,
 * so we nudge the page down before reading the DOM.
 */
async function scrape(page, url, context) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(2000);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);

    const finalUrl = page.url();

    // The specifications accordion doesn't render its content until clicked
    // (confirmed live) — a floating promo/location overlay intercepts the
    // click, so we strip overlay elements first, then click to expand.
    await page.evaluate(() => {
        document.querySelectorAll('[class*="overlay"]').forEach((el) => el.remove());
    });
    const specButton = await page.$(
        '[data-test="@web/site-top-of-funnel/ProductDetailCollapsible-Specifications"] button'
    );
    if (specButton) {
        await specButton.click().catch(() => {});
        await page.waitForTimeout(1000);
    }

    const data = await page.evaluate(() => {
        const getText = (sel) => document.querySelector(sel)?.innerText?.trim() || null;

        // "product-price" is rendered twice (responsive breakpoints) — only one has text.
        const priceEl = Array.from(document.querySelectorAll('[data-test="product-price"]')).find(
            (el) => el.innerText.trim().length > 0
        );

        const ratingText = getText('[data-test="ratingFeedbackContainer"]');
        const [ratingLine, countLine] = ratingText ? ratingText.split('\n') : [null, null];

        const description = getText('[data-test="item-details-description"]');

        // "Shop all <Brand>" link text, confirmed live — strip the wrapper phrase.
        const brandText = getText('[data-test="shopAllBrandLink"]');
        const brand = brandText ? brandText.replace(/^Shop all\s+/i, '').trim() : null;

        // Fulfillment cells (pickup/delivery/shipping) are the closest Target
        // gets to a single "availability" line — shipping is the most
        // universally applicable of the three, confirmed live. The cell's
        // text is "Shipping\n<status>" — drop the repeated label.
        const shippingText = getText('[data-test="fulfillment-cell-shipping"]');
        const availability = shippingText ? shippingText.replace(/^Shipping\s*/i, '').trim() : null;

        // Specifications only populate in the DOM after the accordion is
        // clicked open (done before this evaluate() call runs) — each row is
        // a <div><b>Label:</b> Value</div>, confirmed live.
        const specs = Array.from(
            document.querySelectorAll('[data-test="item-details-specifications"] > div')
        ).reduce((acc, row) => {
            const label = row.querySelector('b')?.innerText?.replace(/:$/, '').trim();
            const fullText = row.innerText?.trim();
            if (!label || !fullText) return acc;
            const value = fullText.slice(fullText.indexOf(':') + 1).trim();
            if (label && value) acc[label] = value;
            return acc;
        }, {});

        const reviews = Array.from(document.querySelectorAll('[data-test="reviews-list"] > *'))
            .slice(0, 10)
            .map((card) => ({
                title: card.querySelector('[data-test="review-card--title"]')?.innerText?.trim() || null,
                text: card.querySelector('[data-test="review-card--text"]')?.innerText?.trim() || null,
                rating:
                    card.querySelector('[data-test="review-card--ratings"]')?.getAttribute('aria-label') ||
                    card.querySelector('[data-test="review-card--ratings"]')?.innerText?.trim() ||
                    null,
                author: card.querySelector('[data-test="review-card--username"]')?.innerText?.trim() || null,
            }))
            .filter((r) => r.text);

        return {
            title: getText('[data-test="product-title"]'),
            price: priceEl ? priceEl.innerText.trim() : null,
            rating: ratingLine?.match(/[\d.]+/)?.[0] || null,
            reviewCount: countLine?.trim() || null,
            brand,
            availability,
            // Target images come from scene7, whose render size is set by the
            // wid/hei query params — the gallery <img> src is a small variant.
            // Force a large render so it isn't blurry when shown full-width.
            images: Array.from(document.querySelectorAll('[data-test^="image-gallery-item-"] img'))
                .map((img) => img.src)
                .filter(Boolean)
                .map((src) => {
                    try {
                        const u = new URL(src);
                        if (/(?:^|\.)scene7\.com$/i.test(u.hostname)) {
                            u.searchParams.set('wid', '1200');
                            u.searchParams.set('hei', '1200');
                            u.searchParams.set('qlt', '85');
                            u.searchParams.delete('fmt');
                        }
                        return u.toString();
                    } catch {
                        return src;
                    }
                }),
            bulletPoints: description ? [description] : [],
            specs,
            reviews,
        };
    });

    if (!data.title) {
        const err = new Error('Could not locate product data on the page (unexpected page layout or redirect)');
        err.status = 502;
        err.finalUrl = finalUrl;
        throw err;
    }

    return { finalUrl, data };
}

module.exports = { name: 'target', matches, scrape };
