# Callisto-only Chromium patches

Patches here are **in addition** to BrowserOS baseline.

Layout mirrors Chromium (same as BrowserOS `chromium_patches/`).

## Planned / status

| Patch | Status | Notes |
|-------|--------|--------|
| webdriver always false | **Upstream BrowserOS** | `third_party/blink/.../navigator.cc` — do not duplicate |
| Agent fixed viewport 1440×900 | Planned | Agent-owned targets only |
| Agent tabs no focus steal | Planned | Background agent work |
| Executable rename callisto | Branding overlay | Via BRANDING + chrome_constants |

## Adding a patch

1. Build BrowserOS/Callisto worktree once.
2. Edit Chromium sources under `$CHROMIUM_SRC`.
3. `git diff > packages/callisto-browser/chromium_patches/path/to/file.cc` (unified diff with paths relative to src).
4. Register in `features.yaml`.
5. Document measurement (which site / fingerprint test improved).
