# MOBLUEHQ.com — Production Build (v4)

Portfolio refresh April 2026: reconciled `products.json`, SVG marks under `assets/logos/`, tiled portfolio UI.
Originally locked design package, April 22, 2026.
Deployment target: Vercel.

---

## Folder structure

```
mobluehq-site/
├── index.html              # The site (single page, four sections)
├── data/
│   └── products.json       # SOURCE OF TRUTH for the portfolio. Edit this to update.
├── api/
│   ├── triage.js           # Serverless function: AI-evaluates investor submissions
│   └── refresh.js          # Cron handler: monthly indexing + portfolio freshness check
├── assets/
│   ├── style.css           # Shared styles (portfolio tiles, about, investors)
│   ├── logos/*.svg         # Portfolio marks (PNG fallbacks optional)
│   ├── earth_hero.jpg      # Homepage hero photo (ChatGPT-generated, owned by MOBLUEHQ)
│   └── adam_faust.jpg      # Founder portrait
├── robots.txt              # Allow all crawlers
├── sitemap.xml             # Pages + sections for search engines
├── vercel.json             # Vercel config: headers, cron schedule, function timeouts
└── README.md               # This file
```

---

## Initial deployment (one-time, ~20 minutes)

### Step 1: Push to GitHub
```bash
cd mobluehq-site
git init
git add .
git commit -m "MOBLUEHQ.com initial production build"
gh repo create mobluehq-site --private --source=. --push
```

### Step 2: Import to Vercel
1. Go to https://vercel.com/new
2. Import the GitHub repo
3. Framework preset: "Other"
4. Root directory: `./` (default)
5. Click Deploy. First deploy completes in ~30 seconds.

### Step 3: Add environment variables
In Vercel dashboard → Project Settings → Environment Variables, add:

| Variable | Value | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | sk-ant-... | Required. Powers the AI investor triage. |
| `INDEXNOW_KEY` | (any random 32+ char string) | Recommended. Used for IndexNow pings. Generate at https://www.uuidgenerator.net/version4 or similar. |
| `SITE_URL` | https://mobluehq.com | Optional. Defaults to mobluehq.com if not set. |

### Step 4: Connect custom domain
1. Vercel dashboard → Domains → Add `mobluehq.com`
2. Update your registrar's DNS to point at Vercel (Vercel will give you the records)
3. Wait 5–60 minutes for DNS + SSL provisioning

### Step 5: Host the IndexNow key file
After setting `INDEXNOW_KEY` env var, create a file at `<your-key>.txt` in the project root with the same value as the contents. Example: if your key is `a7f3d9e1b2c4f5e6d8b9a0c1f2e3d4b5`, create the file:

```
mobluehq-site/a7f3d9e1b2c4f5e6d8b9a0c1f2e3d4b5.txt
```

with content:
```
a7f3d9e1b2c4f5e6d8b9a0c1f2e3d4b5
```

Then redeploy. Bing/Yandex will fetch this file to verify ownership before honoring IndexNow pings.

### Step 6: Submit sitemap to Google Search Console
1. Go to https://search.google.com/search-console
2. Add `mobluehq.com` as a property (verify via DNS TXT record)
3. Submit `https://mobluehq.com/sitemap.xml` under "Sitemaps"

This is a one-time step. Google will then crawl the site automatically.

---

## How updates work

### To update the portfolio

Edit `data/products.json`. Add new products, change descriptions, flip status from `dev` to `active`, reveal a `classified` cell. Update the `lastReviewed` date. Commit and push:

```bash
git add data/products.json
git commit -m "Portfolio update April 2026"
git push
```

Vercel auto-deploys within 30 seconds. The next time anyone loads the site, the new portfolio is rendered.

**Each product object accepts these fields:**

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Lowercase, no spaces. Used internally. |
| `name` | yes | Display name. Use camelCase per brand convention. |
| `color` | yes | Hex color. From the locked art sheet for existing brands; pick a new one for new brands. |
| `description` | yes | First line of cell text. Keep under 30 chars. |
| `tagline` | yes | Second line of cell text. Keep under 35 chars. |
| `status` | yes | One of: `active`, `dev`, `classified`. |
| `icon` | yes | One of: `circle-rings`, `shield-check`, `envelope`, `document`, `grid`, `layers`, `anchor`, `bars-moon`, `chart`, `lock`. To add a new icon, add a `<symbol>` to the SVG library at the top of `index.html` and reference it by id here. |

### To update other content

| Want to change | Edit |
|---|---|
| Hero tagline | `index.html` → `<div class="hero-tagline">` |
| About headline | `index.html` → `<h2 class="about-headline">` |
| About body paragraphs | `index.html` → `<div class="about-body">` |
| Patent count footer | `index.html` → `<div class="about-footer">` |
| Investors headline | `index.html` → `<h2 class="investors-headline">` |
| Investor process blocks | `index.html` → `<div class="process-blocks">` |
| Footer contact info | `index.html` → `<footer>` |
| Color palette | `index.html` → `:root { --bg: ... }` block at top of style |

---

## Monthly automation

`vercel.json` defines a cron job: `"schedule": "0 9 1 * *"` — runs the 1st of every month at 9am UTC. The cron triggers `/api/refresh` which:

1. Reads `data/products.json` and checks `lastReviewed`. If more than `reviewCadenceDays` (default 30) have passed, logs a `portfolio_stale_warning` to Vercel logs.
2. Pings IndexNow (Bing, Yandex) to re-crawl the homepage and sitemap.
3. Pings Google's sitemap endpoint as a soft signal.
4. Logs the entire run as `REFRESH_RUN` in Vercel logs for review.

You can also trigger it manually any time:
```
https://mobluehq.com/api/refresh?key=YOUR_INDEXNOW_KEY
```

To check what the cron did: Vercel dashboard → your project → Logs → search for `REFRESH_RUN`.

To set the cadence to a different interval, edit `data/products.json` → `reviewCadenceDays` field. The cron itself runs monthly but the staleness warning only fires when the cadence is exceeded.

To change the cron schedule, edit `vercel.json` → `crons[0].schedule` (uses standard cron syntax).

---

## How the AI investor triage works

The form posts to `/api/triage` (a Vercel serverless function). The function:

1. Validates input (rejects messages under 20 chars or over 10K chars)
2. Sends the submission to Claude Sonnet 4 with a triage prompt
3. Parses the model's structured JSON response
4. Logs every submission to Vercel logs (searchable by `TRIAGE`)
5. Returns the evaluation to the frontend, which displays it inline

The `ANTHROPIC_API_KEY` lives only on the server. It is never exposed to the browser.

To see what got submitted: Vercel logs → search `TRIAGE`.

To upgrade the triage to true three-provider Faust (per Adam's "real diversity only" doctrine), modify `api/triage.js` to also call OpenAI and Google APIs, then compute the FDI. This is BB-OutreachReady-02 territory; not required for v2 launch.

To wire up real email notification when route is `"forward"`: add Resend or SendGrid as a dependency, set `TRIAGE_FORWARD_EMAIL` env var, and add a notification block at the marked TODO in `api/triage.js`.

---

## Stealth vs indexed

You requested indexed. The current configuration:
- `robots.txt` allows all crawlers
- `sitemap.xml` is published with all sections
- `<meta name="robots" content="index, follow">` in the HTML head
- IndexNow pings on cron run for Bing/Yandex
- Google Search Console submission needed once (Step 6 above)

To temporarily go stealth (delist):
1. Change `robots.txt` to `User-agent: *\nDisallow: /`
2. Change the meta tag to `<meta name="robots" content="noindex, nofollow">`
3. Push and redeploy
4. Submit a removal request via Google Search Console

---

## Local development

```bash
npm install -g vercel
cd mobluehq-site
vercel dev
```

This boots a local server with the serverless functions wired up. Open http://localhost:3000.

For local triage testing, set `ANTHROPIC_API_KEY` in a `.env.local` file (Vercel's local dev reads it).

---

## License notes

- Earth hero image: ChatGPT-generated, owned by MOBLUEHQ LLC
- Adam Faust portrait: photographed and owned by MOBLUEHQ LLC
- Geist font: SIL Open Font License (commercial use allowed)
- JetBrains Mono font: SIL Open Font License (commercial use allowed)

---

## What to do next

1. **Today:** Push to GitHub, deploy to Vercel, configure env vars, attach domain
2. **Tomorrow:** Submit sitemap to Google Search Console, verify IndexNow key file is accessible
3. **First week:** Test the AI triage end-to-end by submitting your own sample message
4. **First month:** Set a calendar reminder for May 22 to review `data/products.json` and update statuses
5. **Ongoing:** Add the email notification wiring when you're ready to be alerted on `forward` routings
