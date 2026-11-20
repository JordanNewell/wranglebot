# wranglebot-site

Product site for **wranglebot.com** — WrangleBot, a local supervisor for
coding agents (loop breaking, AST diff guardrails, `.curt` session
emission). v0.1.1 shipped, live on npm as `@wranglebot/cli`.

## Contents

- `index.html` — the entire page: inline CSS, tiny inline copy-button JS, no
  build step. WrangleBot brand system (ink `#0E1116`, bone `#ECEFF4`, halt
  amber `#FFB224`), Space Grotesk display + JetBrains Mono, canonical
  interleaf-pattern header geometry + footer N logo.
- `404.html` / `changelog.html` / `docs.html` / `license.html` — subpages
  served at clean URLs (`/docs`, `/changelog`, `/license`).
- `brand/` — canonical WrangleBot SVGs (mark, lockups, app icon) + lockup PNG.
- `n-logo.png` — white N mark (footer house canon).
- `favicon.png` — 512px app icon (rasterized from `brand/` SVG).
- `apple-touch-icon.png` — 180px, same source.
- `og.png` — 1200×630 Open Graph card.
- `sitemap.xml` / `robots.txt` — bump `lastmod` in the sitemap when pages change.

## Deploy

Automatic: `.github/workflows/deploy.yml` deploys `site/` to Cloudflare
Pages on every push — `main` → wranglebot.com (production), any other
branch → `<branch>.wranglebot.pages.dev` preview — and smoke-checks
`/`, `/docs.html`, `/changelog.html`, `/license.html` after each deploy.

Manual fallback (project `wranglebot`, domain wranglebot.com):

```
npx wrangler pages deploy site --project-name wranglebot
```

© 2026 Jordan Newell
