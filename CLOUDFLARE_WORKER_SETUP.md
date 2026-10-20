# ExpiryGuard Smart Recipe Proxy

Ask AI is intentionally **not ready until this Worker is deployed, configured, and tested**. The PWA keeps working without it because the 39 built-in recipes and local matching logic remain offline-first.

## What this proxy does

The frontend sends a recipe question and the current pantry context to `POST /api/ask-recipe`. The Worker validates and bounds the request, applies a Cloudflare Rate Limiting binding, calls OpenRouter with the `openrouter/free` router, and returns only the assistant answer. The OpenRouter key is read from the Worker secret named `OPENROUTER_API_KEY`; it is never placed in frontend code, browser storage, GitHub Actions logs, or Git history.

The initial protection is deliberately conservative: 10 requests per IP per 60 seconds, a 500-character question limit, a 24 KB request limit, at most 50 pantry items and recipe titles, and a 500-token upstream response limit. This is abuse reduction, not a complete security boundary. A shared public AI endpoint can still be abused, and free-model availability can change.

## One-time Cloudflare setup

Run these commands from the Worker directory:

```bash
cd worker
npx wrangler@latest login
npx wrangler@latest secret put OPENROUTER_API_KEY
```

When prompted, paste the OpenRouter key. Do not put the key in `wrangler.jsonc`, `.env`, `.dev.vars`, GitHub, or chat. OpenRouter recommends a strict spending limit on every key. Set the limit to the smallest amount that is acceptable for this demo and disable automatic top-ups if they are not needed.

Edit `worker/wrangler.jsonc` and replace both placeholder values:

```json
"ALLOWED_ORIGINS": "https://YOUR-PAGES-DOMAIN.example",
"APP_URL": "https://YOUR-PAGES-DOMAIN.example"
```

For a GitHub Pages project site, the origin is normally the scheme plus host only, without the repository path. For example, if the full site URL is `https://example.github.io/expiryguard/`, use `https://example.github.io` as `ALLOWED_ORIGINS` and `APP_URL`.

Deploy the Worker:

```bash
npx wrangler@latest deploy
```

Copy the resulting Worker URL, for example:

```text
https://expiryguard-recipe-proxy.<your-subdomain>.workers.dev
```

Test configuration without sending an AI request:

```bash
curl -sS https://expiryguard-recipe-proxy.<your-subdomain>.workers.dev/health
```

A configured deployment should return JSON containing `"ok":true` and `"configured":true`. This health response does not reveal the secret.

Test the actual route after configuring the PWA URL and deploying the frontend:

```bash
curl -i -X OPTIONS \
  -H 'Origin: https://YOUR-PAGES-DOMAIN.example' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type' \
  https://expiryguard-recipe-proxy.<your-subdomain>.workers.dev/api/ask-recipe
```

The preflight should return `204`. Then test one bounded request from the browser or with a temporary request body. Do not include a real user’s sensitive information in a test prompt.

## Connect GitHub Pages to the Worker

The frontend defaults to `/api/ask-recipe`, which works when the Worker is routed on the same origin. For a separate `workers.dev` URL, add a repository variable in GitHub:

1. Open the repository’s **Settings → Secrets and variables → Actions → Variables**.
2. Add the variable `EXPIRYGUARD_RECIPE_PROXY_URL`.
3. Set its value to the full Worker route:

```text
https://expiryguard-recipe-proxy.<your-subdomain>.workers.dev/api/ask-recipe
```

4. Run the GitHub Pages workflow again.

The workflow writes this value into the production Vite environment. The URL is public configuration; the OpenRouter key is not.

## Operational safeguards

Keep the OpenRouter key’s spending limit strict and monitor the OpenRouter usage page. Rotate the key immediately if it is ever exposed. The Worker has no login system, so the rate limiter is intentionally low and uses the Cloudflare connecting IP as a coarse abuse signal. Cloudflare’s native rate-limit binding is fast and eventually consistent, so it is not an exact billing or accounting mechanism.

If the Worker is not configured, the PWA shows a friendly unavailable message in Ask AI and keeps local recipe search available. Do not describe Ask AI as live until the `/health` response is configured and a real bounded request succeeds.
