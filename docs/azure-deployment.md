# Deploying web-scraper to Azure

A complete reference for how this service runs on Azure: the resources, the
permissions, the CI/CD pipeline, why it's built this way, and how to operate it.

- **Service:** Azure Container Apps
- **Resource group:** `web-scraper-rg`
- **Environment:** `managedEnvironment-webscraperrg-a52b`
- **Public URL:** `https://web-scraper.ashyfield-e469a673.eastus.azurecontainerapps.io`
- **Image:** `ghcr.io/manushadananjaya/web-scraper` (GitHub Container Registry, public)
- **Deploy trigger:** GitHub Actions on push to `main`

---

## Table of contents

1. [The Azure hierarchy](#1-the-azure-hierarchy)
2. [Azure Functions vs Azure Container Apps](#2-azure-functions-vs-azure-container-apps)
3. [Container Apps, part by part](#3-container-apps-part-by-part)
4. [Identity: the app registration](#4-identity-the-app-registration)
5. [IAM & RBAC](#5-iam--rbac)
6. [Granting access without a stored password (OIDC)](#6-granting-access-without-a-stored-password-oidc)
7. [The GitHub Actions workflow](#7-the-github-actions-workflow)
8. [One push, end to end](#8-one-push-end-to-end)
9. [The application itself](#9-the-application-itself)
10. [Operating it](#10-operating-it)
11. [Cost](#11-cost)
12. [Setup from scratch (reproducing this)](#12-setup-from-scratch-reproducing-this)
13. [Troubleshooting log](#13-troubleshooting-log)
14. [Glossary](#14-glossary)

---

## 1. The Azure hierarchy

Everything in Azure sits in a four-level nested structure:

```
Tenant (Microsoft Entra directory)          identities live here: humans + apps
 └─ Subscription  (3412605e-…)               billing + the root of all resources
     └─ Resource group  (web-scraper-rg)     a folder; also the unit of delete & permissions
         └─ Resources  (Container App, its environment, Log Analytics workspace…)
```

Two separate planes run through this:

| Plane | What it is | Answers |
|---|---|---|
| **Identity plane** | the tenant (Entra directory) | "who are you?" |
| **Resource plane** | subscription and everything below | "what exists, and who is billed?" |

They are deliberately independent. **RBAC** (section 5) is the bridge between them.

Definitions:

- **Tenant** — your Microsoft Entra directory (`…onmicrosoft.com`). Holds identities. No compute.
- **Subscription** — the billing boundary and the container for all resources. Yours: `3412605e-7633-44f0-8da4-6bf9a56e1205`.
- **Resource group** — `web-scraper-rg`. A folder for related resources. Also the unit you delete as a batch and the unit you scope permissions to.
- **Resource** — the actual things: the Container App, its environment, the Log Analytics workspace it created.

---

## 2. Azure Functions vs Azure Container Apps

The service first ran on **Azure Functions** and failed. Understanding why is the
reason it now runs on **Container Apps**.

| | Azure Functions | Azure Container Apps |
|---|---|---|
| You ship | **code** (a handler function) | a **Docker image** (a whole Linux filesystem + your app) |
| Azure supplies | the OS, runtime, web server, scaling | the orchestrator only — the OS is yours |
| Control over system libraries | none — no root, read-only filesystem | total — your Dockerfile *is* the machine |
| Billing model | per execution + memory-time | per vCPU-second + GiB-second, scale to zero |
| Best for | lightweight event / HTTP glue code | anything needing a real environment (a browser, a binary, an apt package) |

### Why Functions broke

Headless Chromium is not self-contained. It dynamically links OS shared
libraries — `libnspr4.so` (part of NSS, for TLS), plus fontconfig, X11 libs, and
~30 others. The Functions-managed Linux host does not have them, and the
Consumption / Flex Consumption plans give you no root and a read-only filesystem,
so you cannot install them.

`@sparticuz/chromium` (a package built for AWS Lambda) tries to work around this
by unpacking a bundle of libraries into `/tmp` and setting `LD_LIBRARY_PATH`. That
bundle is compiled for Amazon Linux and does not fully work on Azure's host —
`libnspr4.so` still could not be found, and Chromium exited with code 127.

A container fixes this permanently: the **Playwright base image**
(`mcr.microsoft.com/playwright:v1.62.1-noble`) ships Chromium and every library it
needs, tested together.

### The rule of thumb

- **Functions** — your code is a thin reaction to an event.
- **Container** — you need control over what lives *below* your code.

---

## 3. Container Apps, part by part

### Environment

`managedEnvironment-webscraperrg-a52b`

The shared boundary one or more container apps live in. It owns:

- the virtual network
- the ingress layer (an Envoy proxy)
- the logging sink — a **Log Analytics workspace** it created automatically

One environment per project or stage is normal.

### Container App

`web-scraper` — the service itself. Its important settings, all set by the deploy
pipeline:

| Setting | Value | Meaning |
|---|---|---|
| Image | `ghcr.io/manushadananjaya/web-scraper:<sha>` | what to run |
| Target port | `3000` | the port the Node process listens on inside the container |
| Ingress | External | reachable from the internet; HTTPS URL + managed TLS cert, free |
| CPU / memory | 1 vCPU / 2 GiB per replica | the 0.25 / 0.5 default is too small to launch Chromium |
| Min replicas | 0 | scale to zero — no traffic means no running container, no charge |
| Max replicas | 3 | burst ceiling |
| Env vars | `SCRAPER_MIN_INTERVAL_MS`, `API_KEY` | injected into the process |

### Revision

`web-scraper--0000001`, `--0000002`, …

Every image or config change mints an **immutable revision** — a snapshot. In
single-revision mode (this setup), 100% of traffic goes to the newest healthy
revision; the previous one stays parked so a rollback is instant. This is why the
Portal button everywhere is "Save as a new revision."

### Replica

A running copy of the container. Between min and max, the platform adds and
removes replicas based on load (HTTP concurrency by default).

### Health probes

Per container, three checks:

| Probe | Purpose |
|---|---|
| **Startup** | wait for the app to boot before other probes run |
| **Readiness** | send traffic to this replica only when it passes |
| **Liveness** | restart the replica if it stops passing |

> **This caused an hour-long `404`.** The Portal's quickstart placeholder set all
> three probes to TCP **port 80**. The real app listens on **3000**, so every probe
> failed, the new revision never became "ready," ingress had no healthy target,
> and the URL returned a bare `404 page not found`. Fix: repoint all three probe
> ports to 3000 (liveness cannot be disabled while ingress is on). That config now
> persists across future image-only deploys.

### Scale to zero and cold starts

With min replicas 0, no traffic means no running container and no compute charge.
The cost: the first request after an idle period must start a container, pull the
~1.7 GB image (cached after the first pull), and boot Node — a **10–30 second cold
start**. That trade is what keeps this near free.

---

## 4. Identity: the app registration

GitHub Actions runs on GitHub's servers. Azure has never heard of it. Before a
workflow can deploy anything, it needs an *identity* in your tenant.

An **app registration** is a user account for a piece of software. This one:

- Name: `github-web-scraper-deploy`
- Client ID: `7c6c9b05-7fa5-48e3-894c-8197d35f67af`

It lives in the identity plane and, on its own, can do **nothing** — it is a "who"
with no "what" yet.

**Terminology:** the **app registration** is the global definition. Its local
instance inside your tenant — the object that actually holds permissions and signs
in — is the **service principal** (also called an *enterprise application*). In
casual use people say "the service principal" for the whole thing.

---

## 5. IAM & RBAC

**RBAC** — role-based access control — is the bridge between the identity plane and
the resource plane. Every grant is always the same three parts:

| Part | This deployment's value | Meaning |
|---|---|---|
| **Who** | the `github-web-scraper-deploy` service principal | the identity being granted access |
| **What** | the **Contributor** role | create / read / update / delete any resource — but *not* grant access to others (that is **Owner**), and *not* read secret data inside services (those are separate data-plane roles) |
| **Where** | scope = `web-scraper-rg` | the grant covers everything in that resource group and nothing outside it |

You set this in the Portal at **web-scraper-rg → Access control (IAM) → Add role
assignment**. The screen's tabs — Role, Members — are literally those parts (scope
is fixed by where you opened the blade).

A **role** is a named bundle of allowed operations. There are ~600 built-in ones
(`Reader`, `Owner`, `Contributor`, `Container Apps Contributor`, …). **Scope** can be
a management group, a subscription, a resource group, or a single resource;
permissions inherit downward.

**Least privilege note:** Contributor on one resource group is already fairly
tight. `Container Apps Contributor` scoped the same way would be tighter still —
the pipeline only ever runs one command against one app.

---

## 6. Granting access without a stored password (OIDC)

**The old way:** create a client secret on the app registration, paste it into
GitHub as a secret. A long-lived password sitting in two places is a standing
risk.

**What this uses instead — workload identity federation over OpenID Connect
(OIDC):**

On the app registration, under **Certificates & secrets → Federated credentials**,
one credential was added:

- **Issuer:** `https://token.actions.githubusercontent.com` — trust tokens signed by GitHub Actions
- **Subject:** `repo:manushadananjaya/web-scraper:ref:refs/heads/main` — but only from this repo, this branch

### The exchange at deploy time

```
Workflow run (push to main)
      │  requests a token
      ▼
GitHub OIDC ── signs a short-lived JWT ("I am repo X, branch main") ──▶ Microsoft Entra ID
                                                                          │  checks:
                                                                          │   - GitHub's signature valid?
                                                                          │   - issuer + subject match the
                                                                          │     federated credential?
                                                                          ▼
                                                        Azure access token  (~1 hour, then dead)
                                                                          │
                                                        every subsequent API call is still
                                                        authorized per-call by the RBAC
                                                        assignment from section 5
```

**No secret is stored anywhere.** GitHub mints a fresh signed token each run; Entra
validates it against GitHub's public keys and the federated credential's subject
filter, then issues a short-lived Azure token. That token is *authenticated* but
still gets *authorized* per call by RBAC.

### The three GitHub secrets

They are **not passwords** — they are pointers that tell `azure/login` which
identity to assume:

| Secret | Value | Meaning |
|---|---|---|
| `AZURE_CLIENT_ID` | `7c6c9b05-7fa5-48e3-894c-8197d35f67af` | which app registration |
| `AZURE_TENANT_ID` | (from the app's Overview page) | which directory it lives in |
| `AZURE_SUBSCRIPTION_ID` | `3412605e-7633-44f0-8da4-6bf9a56e1205` | which subscription to act against |

Anyone can read these values; they are useless without a GitHub Actions run on
`main` of this repo to produce a matching token.

---

## 7. The GitHub Actions workflow

`.github/workflows/deploy.yml` runs on every push to `main`. One job, in order:

1. **Checkout** — pull the repo onto the runner.
2. **Log in to GHCR** — authenticate to GitHub's container registry using the automatic `GITHUB_TOKEN`, so the next step can push.
3. **Build and push image** — `docker build` against the `Dockerfile` (Playwright base image + `src/`), tagged with the commit SHA and `latest`, pushed to `ghcr.io/manushadananjaya/web-scraper`.
4. **Azure login** — the OIDC exchange from section 6. Requires `permissions: id-token: write` in the workflow — that is why that line is present.
5. **Deploy** — `az containerapp update` sets the new image plus CPU, memory, and replica bounds; `az containerapp ingress update` pins the port to 3000.

### Why the image lives on GHCR, not Azure Container Registry

Azure Container Registry's cheapest tier (Basic) is ~$5/month. GitHub Container
Registry is free for public images. Container Apps pulls happily from any public
registry, so the image goes to GHCR and the package is set to **public**. Making
the package public is what unblocked the initial `UNAUTHORIZED` pull error.

### The workflow file

```yaml
name: Build and deploy to Azure Container Apps

on:
  push:
    branches: [main]
  workflow_dispatch:

env:
  IMAGE: ghcr.io/${{ github.repository }}
  CONTAINER_APP: web-scraper
  RESOURCE_GROUP: web-scraper-rg

permissions:
  contents: read
  packages: write
  id-token: write        # required for azure/login OIDC

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Log in to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push image
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: |
            ${{ env.IMAGE }}:${{ github.sha }}
            ${{ env.IMAGE }}:latest

      - name: Azure login
        uses: azure/login@v2
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}

      - name: Deploy new image to Container App
        uses: azure/cli@v2
        with:
          azcliversion: latest
          inlineScript: |
            az containerapp update \
              --name "$CONTAINER_APP" \
              --resource-group "$RESOURCE_GROUP" \
              --image "${IMAGE}:${GITHUB_SHA}" \
              --cpu 1.0 --memory 2.0Gi \
              --min-replicas 0 --max-replicas 3
            az containerapp ingress update \
              --name "$CONTAINER_APP" \
              --resource-group "$RESOURCE_GROUP" \
              --target-port 3000
```

---

## 8. One push, end to end

```
git push origin main
      │
      ▼
GitHub Actions runner:
   docker build  →  push to GHCR  →  azure/login (OIDC)  →  az containerapp update
      │
      ▼
Container Apps creates revision web-scraper--00000N
   pull image → start replica → run health probes
      │
      ▼
When probes pass → 100% traffic shifts to the new revision
(if probes never pass → traffic stays on the old revision; a bad deploy
 cannot take the site down)
```

The runner does all the building. Azure only receives a pointer to a finished
image plus a handful of settings.

---

## 9. The application itself

Plain Node / Express HTTP server. Not Azure Functions any more.

```
src/
  server.js                 Express app; 3 routes; body parsed as raw text
  routes/
    health.js               GET  /api/health
    scrapeProduct.js        GET/POST /api/scrapeProduct
    discoverTrending.js     GET/POST /api/discoverTrending  (gated by API_KEY)
  lib/
    browser.js              launches Playwright chromium (--no-sandbox, --disable-dev-shm-usage)
    stealth.js              init script + context options to blunt bot detection
    log.js                  console-backed shim for the old Functions `context.log`
    platforms/              amazon.js, target.js, screwfix.js, index.js (detectPlatform)
    trending/amazonCharts.js
Dockerfile                  FROM mcr.microsoft.com/playwright:v1.62.1-noble
.dockerignore
```

### Endpoints

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/health` | GET | none | confirms the chromium binary resolves |
| `/api/scrapeProduct` | GET / POST | none | scrape one product URL (`?url=` or body `{url, html}`) |
| `/api/discoverTrending` | GET / POST | `API_KEY` | walk Amazon "new releases" category pages for candidates |

`API_KEY` is checked as the `X-API-Key` header or `?code=` query param. If the env
var is unset, the route is open.

### Environment variables

| Name | Purpose |
|---|---|
| `SCRAPER_MIN_INTERVAL_MS` | minimum ms between live scrapes (default 8000) — best-effort per-replica throttle to avoid tripping rate-based bot detection |
| `API_KEY` | gates `/api/discoverTrending` |
| `SCRAPER_PROXY_SERVER` / `_USERNAME` / `_PASSWORD` | optional; route scrape traffic through a proxy (the real fix once the datacenter IP is rate-flagged) |
| `DISCOVER_CATEGORIES` | optional JSON array of `{key, label, url}` to override the default Amazon categories |
| `PORT` | set to 3000 by the Dockerfile |

### Dockerfile

```dockerfile
FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/server.js"]
```

The base image tag must track the `playwright` version in `package.json`.

---

## 10. Operating it

### Deploy

Push to `main`. That is the whole process.

```bash
git push origin main
```

Watch: `https://github.com/manushadananjaya/web-scraper/actions`

### Verify

```bash
curl https://web-scraper.ashyfield-e469a673.eastus.azurecontainerapps.io/api/health
# {"success":true,"runtime":"container","chromiumExecutablePath":"/ms-playwright/chromium-.../chrome-linux64/chrome"}
```

### Test a scrape

```bash
# Screwfix — reliable, structured JSON-LD, no bot-check
curl "https://web-scraper.ashyfield-e469a673.eastus.azurecontainerapps.io/api/scrapeProduct?url=https://www.screwfix.com/p/..."

# discoverTrending — needs the key
curl "https://web-scraper.ashyfield-e469a673.eastus.azurecontainerapps.io/api/discoverTrending?code=<API_KEY>&limit=10"
```

Amazon and Target frequently bot-block requests from datacenter IPs. Options:
set the `SCRAPER_PROXY_*` env vars, or use the POST `{url, html}` paste fallback
with page source captured from a real browser.

### Logs

- Portal → Container App `web-scraper` → **Monitoring → Log stream** (live)
- Portal → Container App → **Monitoring → Logs** (Log Analytics queries)

### Change an env var or scaling

Portal → Container App → **Application → Containers → Edit and deploy** →
**Environment variables** (or **Scale**) → **Save as a new revision**. Values set
here persist when the workflow later swaps in a new image.

### Roll back

Portal → Container App → **Application → Revisions and replicas** → pick a
previous revision → **Activate**.

### Change resources / port / replica bounds permanently

Edit the `az containerapp update` / `az containerapp ingress update` flags in
`.github/workflows/deploy.yml` and push.

---

## 11. Cost

Azure Container Apps monthly **free grant** (per subscription, resets monthly):

- 180,000 vCPU-seconds
- 360,000 GiB-seconds
- 2,000,000 requests

With **min replicas 0** and low volume, a few hundred scrapes a day stays well
inside the grant. Each scrape uses roughly 15–40 vCPU-seconds. You would need
thousands of scrapes a month before compute costs anything.

| Item | Cost |
|---|---|
| Container Apps compute (scale to zero, low volume) | ~$0 (within free grant) |
| GitHub Container Registry (public image) | free |
| Storage account (Container Apps environment) | a few cents / month |
| Log Analytics workspace | free under 5 GB ingest / month |
| **Total at low volume** | **~$0–1 / month** |

The only ways this gets expensive: pinning an always-on replica (`min-replicas 1`
≈ $30–60/month), or thousands of scrapes a day.

---

## 12. Setup from scratch (reproducing this)

Portal-only, no local CLI.

### A. Identity

1. **Microsoft Entra ID → App registrations → New registration.** Name
   `github-web-scraper-deploy`, single tenant, no redirect URI. Register.
2. On the app: **Certificates & secrets → Federated credentials → Add credential.**
   Scenario "GitHub Actions deploying Azure resources". Organization
   `manushadananjaya`, Repository `web-scraper`, Entity type **Branch**, Branch
   `main`. (If the blade asks for numeric Organization ID / Repository ID, click
   **Edit** on the Subject identifier and enter it directly:
   `repo:manushadananjaya/web-scraper:ref:refs/heads/main`.)
3. **Resource groups → `web-scraper-rg` → Access control (IAM) → Add role
   assignment.** Role **Contributor** (Privileged administrator roles tab), assign
   to the `github-web-scraper-deploy` app.

### B. GitHub secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

- `AZURE_CLIENT_ID` — the app's Application (client) ID
- `AZURE_TENANT_ID` — the app's Directory (tenant) ID
- `AZURE_SUBSCRIPTION_ID` — Portal → Subscriptions

### C. Container App

1. **Container Apps → Create.** RG `web-scraper-rg`, name `web-scraper`, region
   East US. Create a new **Container Apps environment** (defaults are fine).
2. **Container** tab: use the quickstart image (the workflow replaces it).
3. **Ingress** tab: Enabled, "Accepting traffic from anywhere", target port
   (locked to 80 with the quickstart image — the workflow fixes it to 3000).
4. Create.
5. After creation: **Application → Scale** → Min replicas `0`. **Application →
   Containers → Health probes** → set all three probe ports to `3000`.
   **Environment variables** → add `SCRAPER_MIN_INTERVAL_MS=8000` and
   `API_KEY=<random>`. Save as a new revision.

### D. First deploy

1. Push to `main`. The build + push steps succeed and create the GHCR package.
   The deploy step fails with `UNAUTHORIZED` (package is private).
2. **github.com/manushadananjaya?tab=packages → web-scraper → Package settings →
   Danger Zone → Change visibility → Public.**
3. Re-run the failed job. It now pulls the image and rolls out.

---

## 13. Troubleshooting log

Problems hit while setting this up, and their fixes.

| Symptom | Cause | Fix |
|---|---|---|
| `/tmp/chromium: error while loading shared libraries: libnspr4.so` (on Functions) | `@sparticuz/chromium` libraries are built for AWS Lambda, not Azure's Functions host | Migrated to a container on the Playwright base image |
| `/api/health` returned `"runtime":"local"` (on Functions) | Flex Consumption does not set `WEBSITE_INSTANCE_ID`, which the old detection keyed on | N/A — replaced by the container migration |
| `chromium.executablePath is not a function` | `@sparticuz/chromium` v149 is ESM; `require()` on Node 20.19+ returns the namespace, real object is on `.default` | N/A — replaced by the container migration |
| Workflow deploy: `UNAUTHORIZED: authentication required` pulling from ghcr.io | GHCR package was private; Container Apps pulled anonymously | Set the package visibility to Public |
| Live URL returned `404 page not found` after a successful deploy | Quickstart placeholder left health probes on TCP port 80; app listens on 3000, so revisions never became ready | Repointed all three probe ports to 3000 |
| `az login` step: Node 20 deprecation warning | GitHub Actions runner internals, not the app | Harmless, ignore |

---

## 14. Glossary

| Term | Meaning |
|---|---|
| **Tenant** | Your Microsoft Entra directory. Holds identities, not compute. |
| **Subscription** | Billing boundary and top-level container for all resources. |
| **Resource group** | A folder for related resources; the unit of bulk-delete and of permission scope. |
| **App registration** | An identity for software. Its in-tenant instance is the service principal. |
| **Service principal** | The object that actually holds role assignments and signs in. |
| **RBAC** | Role-based access control: who (principal) + what (role) + where (scope). |
| **Role** | A named bundle of permitted actions. Contributor, Owner, Reader, and hundreds of scoped ones. |
| **Scope** | The slice of the resource tree a role assignment applies to. Inherits downward. |
| **Federated credential** | A trust rule: accept OIDC tokens from an external issuer matching a subject filter, instead of a stored secret. |
| **OIDC** | OpenID Connect. The token format and exchange behind passwordless CI login. |
| **Container Apps environment** | Shared network, ingress, and logging boundary for one or more container apps. |
| **Revision** | An immutable snapshot of a container app's image and config. |
| **Replica** | One running instance of the container. Scales between min and max. |
| **Ingress** | The managed HTTPS front door: URL, TLS certificate, traffic splitting. |
| **Health probe** | Startup / readiness / liveness check that gates whether a replica receives traffic. |
| **GHCR** | GitHub Container Registry. Free hosting for public container images. |
| **Cold start** | The delay on the first request after idle, while a replica starts and the image is pulled. |

---

## Related

- `.github/workflows/deploy.yml` — the pipeline
- `Dockerfile` — the image
- `src/server.js` — the app entrypoint
- Memory: `azure-deployment.md` in the Claude project memory dir
