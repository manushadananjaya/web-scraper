# Auto-Publish Pipeline — Execution Plan

Status: **not started** · Drafted 2026-08-30 · Architecture overview: https://claude.ai/code/artifact/731030b2-33cb-4d18-a7b7-fd20e6b5d4c0

## Goal

Remove both manual gates from the TrendGear flow so the system discovers, dedupes,
generates, quality-gates and **auto-publishes ~20 products/day unattended**. The
admin reviews *after* publish via a queue and deletes bad items.

## Fixed constraints (decided with the user)

| Decision | Choice |
|---|---|
| Budget | **Near-free.** Free retailer APIs (Best Buy, Walmart) are the primary data source. Scraping is fallback only. Amazon is best-effort / signal-only. |
| Reporting | **Admin dashboard only.** No email/webhook. Monitor = a red banner when the last run is >36h old or published 0. |
| Publish mode | **Fully live on publish.** Auto-published items are indexed immediately, same as manual ones. (24h `noindex` window is a known one-line fallback if ever needed.) |
| Cadence | 20/day target, 25/day hard max. |
| Execution host | **GitHub Actions cron** (free). Orchestrator lives in this repo. Vercel discover cron is retired. |

## Repos involved

- **web-scraper** (this repo) — scraper service on Azure Container Apps + the new `src/orchestrator/`.
- **trendgearreview** — Next.js site on Vercel + Supabase. Owns migrations, admin UI, data model.

---

## Pipeline stages (target design)

```
Discover ─▶ Dedupe ─▶ Acquire ─▶ Generate ─▶ Quality gate ─▶ Publish ─▶ Review
 (rank)    (key +     (API →      (reuse      (all pass →      (20/day,   (/admin/
           pg_trgm)   scrape →    Gemini)     live; any        category   review
                      cross-                  fail → draft)    spread)     queue)
                      retailer)
```

Candidate state machine on `trending_candidates.status`:
`pending → claimed → acquired → generated → published`
side exits: `duplicate`, `unavailable`, `rejected_by_gate`, `failed`, `rejected`

---

## Phase 1 — Data model (trendgearreview/supabase)

All additive migrations, numbered `005_`+. No rewrites. Ship, verify, move on.

### 005_pipeline_columns.sql

New columns on `products`:

| Column | Type | Notes |
|---|---|---|
| `published_at` | timestamptz | Backfill `= updated_at` where `status='published'`. |
| `auto_published` | boolean default false | Pipeline output vs manual. |
| `review_state` | text default 'unreviewed' check in (`unreviewed`,`approved`,`removed`) | |
| `quality_score` | integer | Gate score 0–100. |
| `quality_report` | jsonb | Per-check pass/fail. |
| `dedupe_key` | text | Stable identity. Backfill for existing rows (see helper below). |
| `discovery_source` | text | `bestbuy` / `walmart` / `amazon` / … |
| `resolved_url` | text | Where data was actually pulled if cross-retailer resolve fired. |

New columns on `trending_candidates`:

| Column | Type | Notes |
|---|---|---|
| `dedupe_key` | text | Same construction as products. |
| `trend_score` | numeric default 0 | Orchestrator pulls top-N by this. |
| `discovery_source` | text | |
| `hard_id` | text | UPC / ASIN / SKU when known. |

Widen `trending_candidates.status` check to add:
`claimed`, `acquired`, `generated`, `duplicate`, `unavailable`, `rejected_by_gate`, `failed`.

### 006_pipeline_tables.sql

- `pipeline_runs` — `id`, `started_at`, `finished_at`, `outcome` text, counts:
  `discovered`, `deduped_out`, `acquired`, `gated_out`, `published`, `failed`. jsonb `detail`.
- `pipeline_events` — `id`, `candidate_id`, `from_status`, `to_status`, `reason`, `at`.
- `rejected_keys` — `dedupe_key` pk, `reason`, `at`. Written on product removal; checked by discovery.

All three: internal only — `enable row level security` with **no policies** (service-role bypasses, anon/auth denied), same pattern as `004_trending_candidates.sql`.

### 007_indexes.sql

```sql
create extension if not exists pg_trgm;
create index products_name_trgm_idx on products using gin (product_name gin_trgm_ops);
create index products_dedupe_key_idx on products (dedupe_key);
create index products_review_state_idx on products (review_state) where status = 'published';
create index trending_candidates_trend_score_idx on trending_candidates (trend_score desc) where status = 'pending';
create index trending_candidates_dedupe_key_idx on trending_candidates (dedupe_key);
```

### Backfill

One-off script (or SQL) to set `products.dedupe_key` for existing rows using the
same `buildDedupeKey()` the app will use (Phase 3). Until Phase 3 exists, can be a
placeholder from `source_url` normalization.

**Acceptance:** migrations apply cleanly to prod DB; existing site unaffected;
`select` on new tables works with service key, fails with anon key.

---

## Phase 2 — Discovery breadth (trendgearreview + web-scraper)

Still fully manual publish. Goal: a richer, ranked candidate queue. Watch quality
for ~3–5 days before trusting it.

### Tasks

1. **Best Buy API client** — `trendgearreview/src/lib/sources/bestbuy.ts`.
   Register free key. Pull `trendingViewed`, `mostViewed`, `bestSellers`, new-release
   feeds. Map to `DiscoveredCandidate` + `hard_id` (SKU) + full detail payload for Acquire.
2. **Walmart API client** — `src/lib/sources/walmart.ts`. Affiliate signup → key.
   Trending Items endpoint + keyword/UPC lookup.
3. **Trend signals (non-blocking):**
   - Reuse existing Amazon charts scraper (`web-scraper /api/discoverTrending`) — titles + ASINs only.
   - Amazon autocomplete: `completion.amazon.com/api/2017/suggestions?prefix=` — cheap "what people search".
   - Google Trends via `google-trends-api` npm — rising queries, filtered to shopping terms.
   - Each wrapped so failure logs a warning and yields `[]`.
4. **Trend score** — `src/lib/trending.ts`, computed at discovery:
   ```
   trend_score =
       3 × (distinct sources the product appears in)
     + 2 × (normalized inverse rank in its best source)
     + 2 × (release date within 30 days ? 1 : 0)
     + 2 × (title matches a rising Google query / autocomplete hit ? 1 : 0)
     + 1 × (seen in today's pull vs stale row)
     − category_saturation_penalty
   ```
5. **Discovery job** — extend `dedupeAndInsertCandidates` to write `trend_score`,
   `discovery_source`, `hard_id`. Can run every 6h (discovery ≠ publishing).

**Open decision:** editorial scope — "consumer tech" vs "everything". Affects source
weighting and category tree coherence. Decide before tuning weights.

**Acceptance:** candidate queue fills from ≥2 non-Amazon sources; `trend_score`
populated and visibly ranks sensible items above filler; Amazon/Trends outages
don't break the run.

---

## Phase 3 — Dedupe hardening (trendgearreview)

### Tasks

1. **`buildDedupeKey(input)`** — `src/lib/dedupe.ts`:
   - If `hard_id` present → `id:<type>:<value>` (`id:upc:0193...`, `id:asin:B0...`).
   - Else → `title:<brand-slug>:<first 6 sorted significant title tokens>`.
     Strip punctuation + marketing words (`new`,`2024`,`2025`,`best`,`official`,`sale`),
     keep model tokens (`wh-1000xm5`).
2. Wire into candidate insert: drop if key matches any `products` row (**any status**),
   any pending candidate, or `rejected_keys`.
3. **Fuzzy backstop** — before a candidate is acquired, run
   `similarity(product_name, candidate.title)` (pg_trgm) against all products.
   `> 0.55` → set candidate `status='duplicate'`, don't publish.
4. **Dashboard tab** — "Possible duplicates": flagged candidates beside their
   suspected match, with a "Not a dupe — queue it" override button.
5. Backfill real `dedupe_key` on all existing products.

**Acceptance:** same product from Best Buy + Walmart collapses to one; a deleted
product's item does not re-enter the queue; fuzzy near-dupes get flagged, not published.

---

## Phase 4 — Orchestrator, dry-run (web-scraper)

New: `src/orchestrator/run.js` (+ `src/orchestrator/*` modules). Plain Node, reuses
this repo's Playwright setup and platform scrapers, talks to Supabase with the
service key.

### run.js loop (dry-run = writes `draft`, never `published`)

```
open pipeline_runs row
claim top N pending candidates by trend_score
  (conditional update: set status='claimed' where status='pending')
for each claimed candidate:
  ── ACQUIRE (stop at first success) ──
   1. API detail   — if discovery_source is bestbuy/walmart, fetch full detail
   2. native scrape — POST/GET web-scraper /api/scrapeProduct on its own URL
   3. cross-retailer resolve — search brand+title on the OTHER stores;
        accept match iff title similarity ≥ 0.6 AND brand agrees AND price ±40%;
        scrape/fetch that instead; record resolved_url
   4. none worked → status='unavailable', log event, next candidate
  ── GENERATE ── reuse generateReviewContent(); 4s spacing; 2 retries;
        still nothing → gate failure (not a crash)
  ── GATE ── run all checks (see below); compute quality_score + quality_report
  ── WRITE ── insert/update product as status='draft' with quality_report,
        auto_published=false           ← DRY RUN: no publish yet
  write pipeline_events for every transition
close pipeline_runs row with counts
```

### Quality gate checks (all must pass for eventual auto-publish)

| Check | Rule |
|---|---|
| title | present, 8–200 chars |
| images | ≥3 distinct HTTPS URLs; primary returns 200 + `image/*` |
| price | present, parses to number in $3–$8000 |
| brand | present |
| detail | ≥4 combined bullet points + spec rows |
| social proof | a rating OR ≥2 customer reviews |
| review text | `gemini_output` schema-valid; `reviewBody` 900–4000 chars, ≥3 paragraphs; no refusal markers ("as an AI", "insufficient information", "I cannot", "unable to") |
| category | resolves to a real subcategory |
| not duplicate | passed Phase 3 checks |
| allowed | title/category not on denylist: weapons & ammo, vapes, prescription/supplement health claims, adult, recalled-item terms, counterfeit tells ("replica", "AAA copy") |
| demand floor | `trend_score` ≥ configured minimum |

All thresholds in **one config object** — not scattered.

### GitHub Actions workflow — `.github/workflows/pipeline.yml`

```yaml
on:
  schedule:
    - cron: '0 6 * * *'
  workflow_dispatch: {}
jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: node src/orchestrator/run.js
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
          BESTBUY_API_KEY: ${{ secrets.BESTBUY_API_KEY }}
          WALMART_API_KEY: ${{ secrets.WALMART_API_KEY }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
          SCRAPER_URL: ${{ secrets.SCRAPER_URL }}
          PIPELINE_DRY_RUN: 'true'   # Phase 4; remove in Phase 5
```

**Acceptance:** runs green daily for ~1 week; you review the drafts it *would* have
published; gate thresholds tuned; `pipeline_events` explains every non-publish.

---

## Phase 5 — Flip auto-publish on (web-scraper + trendgearreview)

### Tasks

1. Remove `PIPELINE_DRY_RUN`. Gate pass → `status='published'`, `published_at=now()`,
   `auto_published=true`, `review_state='unreviewed'`. Gate fail → stays `draft`.
2. **Quota** — count `products` where `auto_published and published_at::date = today`;
   publish until `DAILY_PUBLISH_TARGET=20` or queue dry; never exceed `DAILY_PUBLISH_MAX=25`
   (also bounds Gemini calls).
3. **Category spread** — ≤ ~1/3 of a day's batch per main category; enforce via a
   running per-category count while pulling the ranked queue.
4. **`/admin/review` page** (trendgearreview) — list `published AND review_state='unreviewed'`,
   newest first. Per row: hero image, title, price, category, `trend_score`,
   `quality_report` chips, live-page link (new tab), buttons:
   - **Looks good** → `review_state='approved'`
   - **Remove** → `status='draft'`, `review_state='removed'`, write `dedupe_key` to `rejected_keys`
   - secondary **Delete permanently** → existing hard-delete route + `rejected_keys`
5. **Dashboard rework** (trendgearreview `/admin`) tiles:
   Published today · Awaiting your review · Needs a human (gate-failed drafts) ·
   Possible duplicates · Queue depth · Last run (**red banner if >36h or published 0**).
6. Wire product removal (both soft + hard) to always insert into `rejected_keys`.
7. Retire / demote Vercel `/api/cron/discover` — either delete or reduce to a thin
   "refill candidate queue" job (keep as backup discovery path).

**Acceptance:** ~20 items/day go live automatically; bad item → Remove → gone from
site and never rediscovered; leaving the dashboard shut for 2 days then opening it
makes the backlog + any stale-run state obvious.

---

## Phase 6 — Cross-retailer resolve (web-scraper)

Acquire rung 3, built for real. Only after P1–P5 are stable.

- `resolveAcrossRetailers(brand, title, priceHint)`:
  - Best Buy API search + Walmart API search + (optionally) Target/Screwfix site
    search via the scraper.
  - Score candidates: title trigram ≥ 0.6 AND brand match AND price within ±40%.
  - Best match wins; acquire *that* listing; set `resolved_url` + `resolved_source`.
- Dedupe uses the resolved identity, not the original candidate URL.

**Acceptance:** a candidate whose own URL is blocked/dead still publishes from a
matched listing on another store, with the review page pointing at the real product.

---

## Risks to keep in view

- **Indexed-before-review** — you chose fully-live. `noindex`-for-24h is a one-line
  change in sitemap/robots if a bad item ever slips and you reconsider.
- **Unofficial endpoints** (Google Trends, Amazon autocomplete) break silently —
  they only ever *boost* score, never gate; warn on zero yield.
- **Category skew** — free sources lean tech/tools; revisit if scope is meant broad.
- **Legal** — automated scrape + republish at volume is more visible. Keep Gemini
  paraphrasing, no named-individual quotes, honor takedowns via delete. Join Best Buy
  + Walmart affiliate programs (gets the API keys *and* legitimizes it).
- **Gemini daily cap** — fine at 20; `DAILY_PUBLISH_MAX` prevents a runaway backfill.
- **Scraper cold start** — 10–30s on first call of a run; don't set a tight timeout on it.

---

## Pre-Google launch

Before submitting candorpick.com to Google Search Console:

1. **Wipe the DB** — `trendgearreview/supabase/reset.sql` in the Supabase SQL Editor
   (`truncate products, categories, trending_candidates cascade`), or
   `node --env-file=.env scripts/reset-db.mjs`. Keeps schema, drops all rows.
2. In Vercel: point the `candorpick.com` domain at the project, set
   `NEXT_PUBLIC_SITE_URL=https://candorpick.com` in env vars.
3. Re-populate via admin (dedupe guard + image upgrades + category tools are in place).
4. **Redeploy** — `/reviews/[slug]` pages are SSG with no `revalidate`, so old
   cached pages linger until the next deploy. Home/category self-heal in 5 min.
5. Verify `/sitemap.xml`, `/robots.txt`, favicon, one review page.
6. Search Console: add the property, submit `https://candorpick.com/sitemap.xml`.

## Progress log

- 2026-08-30 — plan drafted, not started.
- 2026-08-30 — shipped some near-term fixes in `trendgearreview` ahead of the phases:
  - `src/lib/sanitize.ts` — strips retailer boilerplate ("cannot be shipped to your selected
    delivery location", cart-gated pricing, sign-in walls) from scraped bullets/availability/
    specs and Gemini output, at both ingest (`/api/add-product`) and render (review page, cards).
  - `src/lib/dedupe.ts` — `canonicalUrl` / `titleKey` / `buildExistingIndex`. `/api/add-product`
    now rejects a duplicate (409) on canonical URL or loose title match unless `force:true`.
    Trending admin page flags candidates that already exist (draft/published badge).
  - `/api/add-product` accepts `autoPublish:true` → inserts `status:'published'` directly.
    `TrendingCandidateActions` gained a "Paste DOM" box → "Publish from paste" / "Save as draft"
    (since Amazon blocks the live scrape most of the time).
  - Card consistency — `MasonryProductCard` now uses a fixed 4:3 contained image; the three
    masonry grids (home / search / subcategory) switched from CSS `columns` to CSS `grid`.
  - `ProsConsBlock` renders a "we didn't find any…" note instead of hiding an empty side.
  - New `ProductGallery` client component — hero image + thumbnail strip for multi-image scrapes.
    Later gained eBay/AliExpress-style hover-to-zoom (cursor-tracked `scale(2.5)`, real pointers
    only, off under reduced-motion) and thumbnail image-swap on hover.
  - NOTE: existing DB already has duplicate published rows (e.g. the "Universal Thread jeans"
    ×3 seen at build). The guard only prevents new ones — old dupes need a manual cleanup.
- 2026-08-30 — category fixing tools in `trendgearreview` admin (Gemini often misfiles items):
  - New `/admin/categories` page + sidebar link. Shows the full two-level tree with counts
    (all statuses), an "Uncategorized" bucket, and per-subcategory expandable product lists.
  - New `CategoryPicker` (dropdowns of existing categories + explicit "New…" option) — shown
    prominently on every product page and beside each product in the categories screen. Replaces
    the free-text inputs as the normal path so typos stop spawning near-duplicate categories.
  - `PATCH /api/products/[id]` now accepts `category_id` (existing leaf) or `null` (uncategorize),
    alongside the existing `mainCategory`/`subCategory` create-path.
  - New `PATCH/DELETE /api/categories/[id]` (rename, move a subcategory under a different main,
    delete-if-empty) and `POST /api/categories/merge` (fold a duplicate category into another,
    reassigning its products). `proxy.ts` matcher extended to gate `/api/categories/*`.
- 2026-08-30 — renamed site "Verdict" → **CandorPick** (candorpick.com). `src/lib/site.ts` is the
  source of truth (`SITE_NAME`, `SITE_URL` default `https://candorpick.com`, tagline, description);
  hardcoded "Verdict" strings in header/footer/page titles replaced. `.env` gains
  `NEXT_PUBLIC_SITE_URL`. Need to point the domain + set the env var in Vercel.
- 2026-08-30 — favicons + logo wired. User-supplied RealFaviconGenerator set moved to `public/`
  (`favicon.ico/.svg/-96x96.png`, `apple-touch-icon.png`, `web-app-manifest-{192,512}.png`,
  `site.webmanifest` — manifest name set to CandorPick, theme `#c1440e` / bg `#f7f4ee`). Default
  `src/app/favicon.ico` deleted. `layout.tsx` declares `metadata.icons` + `manifest` +
  `appleWebApp.title` + `viewport.themeColor`. Header wordmark replaced with
  `/logo/candorpick_logo.svg` (`public/logo/` also has `candorpick_favicon.svg`).
- 2026-08-30 — mobile header fixed: `SiteHeader` reflows to logo + menu on row 1 and a
  full-width search bar (input `flex-1`) on row 2; desktop unchanged (logo left, nav +
  `w-56` search right, one row). Bigger tap targets + focus ring on mobile.
- 2026-08-30 — blurry gallery images fixed:
  - Cause: scraper captured the ~40px thumbnail-strip variant of each image (Amazon size
    directive `._AC_SX38_.jpg`; Target scene7 `?wid=80`), which blows up blurry.
  - `web-scraper` `amazon.js` — main image now taken from `#landingImage`'s
    `data-a-dynamic-image` (widest variant); all URLs get the size directive stripped
    (`71abc._AC_SX466_.jpg` → `71abc.jpg`). `target.js` — scene7 URLs forced to `wid/hei=1200`.
  - `trendgearreview` `src/lib/sanitize.ts` — `upgradeImageUrl` / `upgradeImages`, applied in
    `cleanScrapedData` so **existing** products render sharp too, not just newly scraped ones.
    Covered by `src/lib/sanitize.test.ts`.
