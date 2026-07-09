# Callisto Browser — bot-detection strategy

## Principle

**Product mode:** user runs Callisto Browser with a normal profile.  
The agent **attaches via CDP**. We do not look like Selenium.

**Eval/CI mode:** may spawn a disposable profile with explicit flags; expect more blocks.

## Layers

### L0 — BrowserOS baseline (inherited)

- `Navigator::webdriver()` always returns `false` (Blink patch).
- Native agent/CDP control plane (not WebDriver).
- Real Chromium browser chrome, not headless-only.

### L1 — Launch posture (Callisto Host / Mini)

- Prefer **connect** to running browser over `chrome-launcher` spawn.
- Persistent profile (`~/.callisto/browser-profile` or browser default).
- Match UA / Client Hints to binary major (see Mini `DEFAULT_USER_AGENT`).
- Avoid `--enable-automation`, mute-audio test flags, empty extension sets.
- Prefer headed for hard e-commerce / Cloudflare.

### L2 — Callisto Chromium patches (this package)

Priority list in RFC 0006 and `features.yaml`:

1. Branding consistency (no mixed BrowserOS/Callisto strings).
2. Agent viewport lock 1440×900 for agent targets.
3. Background tabs do not steal focus.
4. Fingerprint consistency (brands, full version).

### L3 — Operational

- Warm profiles (real logins).
- Optional user-configured proxies.
- Measure before adding more “stealth” surface area.

## Validation checklist

```text
[ ] about:blank console: navigator.webdriver === false
[ ] bot.sannysoft.com / similar — no WebDriver true
[ ] Callisto Host CDP connect without chrome-launcher
[ ] Hard site smoke (e.g. Wrogn product page) headed profile
```

## Anti-patterns

- Spawning a new temp profile every task in product mode.
- Headless-only for login/shopping.
- Cargo-cult canvas noise without a failing test.
