# Kesha Voice Kit — Landing Site

Marketing/landing site for [`kesha-voice-kit`](https://github.com/drakulavich/kesha-voice-kit), built as a single static page ready for GitHub Pages.

## What's here

```
.
├── index.html        # Single-page site
├── styles.css        # Design system + components (light + dark mode)
├── script.js         # Theme toggle, copy-to-clipboard, tabs, scroll reveal, GitHub stars
├── assets/
│   ├── logo.png      # Project logo (used as favicon + OG image)
│   └── benchmark.svg # Performance chart from BENCHMARK.md
├── .nojekyll         # Bypass Jekyll on GitHub Pages
└── .github/workflows/pages.yml  # Auto-deploy workflow
```

No build step. Open `index.html` in a browser to preview.

## Design

- **Aesthetic** — dark-tech with electric cyan/mint accent (`#4ee3d3`) and a warm amber highlight, evoking signal-processing and audio waveforms.
- **Type** — Instrument Serif (display) + Inter (body) + JetBrains Mono (code).
- **Themes** — Dark by default, automatic light-mode for users with `prefers-color-scheme: light`, plus a manual toggle.
- **Animations** — Hero waveform, soft scroll reveals, hover lifts. Reduced-motion respected.

## Deploy to GitHub Pages

### Option 1 — `gh-pages` branch (recommended)

This repo is configured to deploy automatically via GitHub Actions on every push to `main`:

1. Copy the contents of this directory into a new branch or directory of your repo (e.g. `docs/` or a dedicated `kesha-voice-kit-site` repo).
2. In **Settings → Pages**, set **Source** to **GitHub Actions**.
3. Push to `main`. The included workflow at `.github/workflows/pages.yml` will build and publish.

### Option 2 — Use the project's `gh-pages` branch directly

```bash
git checkout --orphan gh-pages
git rm -rf .
# copy site files in
cp -R /path/to/kesha-site/. .
git add .
git commit -m "Add landing site"
git push origin gh-pages
```

Then in **Settings → Pages**, set **Source** to **Deploy from a branch**, branch `gh-pages`, folder `/ (root)`.

### Option 3 — Drop into existing repo `docs/`

```bash
mkdir -p docs && cp -R /path/to/kesha-site/. docs/
```

In **Settings → Pages**, set **Source** to **Deploy from a branch**, branch `main`, folder `/docs`.

## Custom domain

To use a custom domain (e.g. `kesha.dev`):

1. Add a `CNAME` file containing your domain (no `https://`, no trailing slash).
2. Add a DNS `CNAME` (subdomain) or apex `A`/`ALIAS` records pointing to GitHub Pages IPs.

## License

Site assets and copy: MIT, matching the upstream project.
