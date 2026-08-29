const NAV_TIMEOUT_MS = 25000;

function matches(url) {
    try {
        return /(^|\.)screwfix\.com$/i.test(new URL(url).hostname);
    } catch {
        return false;
    }
}

/**
 * No bot-check found in testing. Unlike Amazon/Target, screwfix.com product
 * pages embed real schema.org Product JSON-LD (name, description, images,
 * price, aggregateRating) — far more robust than CSS selectors since it's
 * structured data meant to survive redesigns. Screwfix splits it across two
 * <script type="application/ld+json"> Product blocks; we merge them.
 * No individual customer review text was found in the DOM (only the
 * aggregate rating/count), so reviews are left empty rather than guessed.
 */
async function scrape(page, url, context) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(1500);

    const finalUrl = page.url();

    const data = await page.evaluate(() => {
        const jsonBlocks = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
            .map((s) => {
                try {
                    return JSON.parse(s.textContent);
                } catch {
                    return null;
                }
            })
            .filter(Boolean);

        const merged = Object.assign({}, ...jsonBlocks.filter((b) => b['@type'] === 'Product'));

        const offer = Array.isArray(merged.offers) ? merged.offers[0] : merged.offers;
        const price = offer?.price != null ? `£${offer.price}` : null;

        // availability is a schema.org URL like "https://schema.org/InStock" —
        // take the last path segment and space out the words.
        const availability = offer?.availability
            ? offer.availability.split('/').pop().replace(/([a-z])([A-Z])/g, '$1 $2')
            : null;

        // Confirmed live: a real <table> ("Specification" header row, then
        // <td>Label</td><td>Value</td> rows) lives inside
        // #product_additional_details_container — separate from the JSON-LD.
        const specs = Array.from(document.querySelectorAll('#product_additional_details_container table tr'))
            .reduce((acc, row) => {
                const cells = row.querySelectorAll('td');
                if (cells.length !== 2) return acc;
                const label = cells[0].innerText?.trim();
                const value = cells[1].innerText?.trim();
                if (label && value) acc[label] = value;
                return acc;
            }, {});

        return {
            title: merged.name || null,
            price,
            rating: merged.aggregateRating?.ratingValue ? String(merged.aggregateRating.ratingValue) : null,
            reviewCount:
                merged.aggregateRating?.reviewCount != null ? String(merged.aggregateRating.reviewCount) : null,
            brand: merged.brand?.name || null,
            availability,
            images: Array.isArray(merged.image) ? merged.image : merged.image ? [merged.image] : [],
            bulletPoints: merged.description ? [merged.description] : [],
            specs,
            reviews: [],
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

module.exports = { name: 'screwfix', matches, scrape };
