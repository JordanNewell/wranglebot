# wranglebot-holding

Product site for **wranglebot.com** — WrangleBot, a local supervisor daemon for
autonomous coding agents (loop breaking, AST diff guardrails, `.curt` session
emission). Announces v0.1, in development.

## Contents

- `index.html` — the entire page: inline CSS, tiny inline copy-button JS, no
  build step. WrangleBot brand system (ink `#0E1116`, bone `#ECEFF4`, halt
  amber `#FFB224`), Space Grotesk display + JetBrains Mono, canonical
  interleaf-pattern header geometry + footer N logo.
- `brand/` — canonical WrangleBot SVGs (mark, lockups, app icon) + lockup PNG.
- `n-logo.png` — white N mark (footer house canon).
- `n-mark.svg` — legacy N mark (unused, kept for reference).
- `favicon.png` — 512px app icon (rasterized from `brand/` SVG).
- `apple-touch-icon.png` — 180px, same source.
- `og.png` — 1200×630 Open Graph card.
- `_dev/` — `og-card.html` (OG source, re-render via headless Chrome) + QC
  screenshots in `qc2/`. Not deployed.

## Deploy

Cloudflare Pages, direct upload (project `wranglebot`, domain wranglebot.com):

```
npx wrangler pages deploy . --project-name wranglebot
```

© 2026 Jordan Newell
