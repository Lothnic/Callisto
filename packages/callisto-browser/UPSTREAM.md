# Upstream BrowserOS pin

Callisto Browser is **option B** from RFC 0006: a branded fork of BrowserOS.

## Default local path

```text
BROWSEROS_ROOT=$HOME/Desktop/OpenSource/BrowserOS
BROWSEROS_BROWSER=$BROWSEROS_ROOT/packages/browseros
```

Override with:

```bash
export BROWSEROS_SRC=/path/to/BrowserOS/packages/browseros
```

## Observed pins (sync when upgrading)

| Field | Value |
|-------|--------|
| Chromium | 148.0.7778.97 (`CHROMIUM_VERSION`) |
| BrowserOS product | 0.46.25.0 (`resources/BROWSEROS_VERSION`) |
| Base commit file | `BASE_COMMIT` in browseros package |

## Sync process

```bash
./scripts/sync-upstream.sh
# creates .work/browseros/ as a working copy of packages/browseros
# then overlays branding/ and chromium_patches/
```

Do **not** commit the full Chromium tree or the full BrowserOS copy into Callisto.
Only Callisto deltas live in git under `packages/callisto-browser/`.

## Upgrade checklist

1. Update `BROWSEROS_SRC` checkout (git pull).
2. Diff `CHROMIUM_VERSION` / `BASE_COMMIT` vs our files; update pins.
3. Re-run `sync-upstream.sh`.
4. Re-apply Callisto overlays; fix patch conflicts.
5. Build Linux; run smoke (open About, check `navigator.webdriver`, CDP connect).
6. Note AGPL source tag for the release.
