# yt-xd

Minimal Advanced Physics thumbnail site:

- one text box
- one generate button
- worker-managed Google auth
- headless render + upload

Runtime rendering uses the committed asset pack in [assets/templates.json](C:\Personal Projects\yt-xd\assets\templates.json).

## Main files

- [index.html](C:\Personal Projects\yt-xd\index.html)
  Static frontend for GitHub Pages.
- [app.js](C:\Personal Projects\yt-xd\app.js)
  One-field browser flow. If auth is missing, it redirects to Google and then resumes automatically.
- [worker.mjs](C:\Personal Projects\yt-xd\worker.mjs)
  Cloudflare Worker API. It stores the YouTube refresh token in an encrypted cookie, renders the thumbnail, and uploads it.
- [smoke-render.mjs](C:\Personal Projects\yt-xd\smoke-render.mjs)
  Local renderer smoke test.
- [dev-site.mjs](C:\Personal Projects\yt-xd\dev-site.mjs)
  Simple local static server for npm-based validation.

## Local workflow

1. Install dependencies:

```bash
npm install
```

2. Copy [.dev.vars.example](C:\Personal Projects\yt-xd\.dev.vars.example) to `.dev.vars` and fill in:
   - `SESSION_SECRET`
   - `YOUTUBE_CLIENT_ID`
   - `YOUTUBE_CLIENT_SECRET`
   - `ALLOWED_ORIGIN`
   - `FRONTEND_FALLBACK_URL`

3. Run the static site:

```bash
npm run dev:site
```

4. Run the worker in another terminal:

```bash
npm run dev:worker
```

5. Open `http://127.0.0.1:4173`, paste the local worker URL once when prompted, then test the generate flow.

## Deploy

1. Set the worker vars in [wrangler.toml](C:\Personal Projects\yt-xd\wrangler.toml) or Cloudflare:
   - `FALLBACK_COURSE_NAME`
   - `ALLOWED_ORIGIN`
   - `FRONTEND_FALLBACK_URL`

2. Add these worker secrets:
   - `SESSION_SECRET`
   - `YOUTUBE_CLIENT_ID`
   - `YOUTUBE_CLIENT_SECRET`

3. In Google Cloud, add your worker callback URL as an authorized redirect URI:

```text
https://YOUR-WORKER/auth/callback
```

4. Deploy the worker:

```bash
npm run deploy:worker
```

5. Publish the static frontend on GitHub Pages.

6. On first use, the site prompts once for the worker URL if it is not hardcoded in [index.html](C:\Personal Projects\yt-xd\index.html).

For the smoothest mobile auth flow, put the worker on a custom subdomain of the same site as the frontend instead of leaving it on `workers.dev`.

## Verify

```bash
npm run check
npm run smoke:render
```
