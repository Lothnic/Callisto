# Callisto logos

The orbital identity follows the existing Callisto website mark. The blue core,
warm white orbit and satellite are drawn as vectors and exported as PNGs.

- `callisto-icon-512.png`: primary icon with a dark rounded tile; use the 128 px
  export for the Mozilla Add-ons listing.
- `callisto-mark-512.png`: transparent mark for dark backgrounds.
- `callisto-mark-blue-512.png`: single-colour transparent mark for light backgrounds.
- SVG sources preserve scalable geometry. The 16 and 32 px exports use a heavier
  orbit and satellite for small-size legibility.

The extension includes `icon-16.png` through `icon-512.png`, declared in its
manifest. The website uses the same icon as its favicon and touch icon.

Regenerate from the repository root after installing Mini's dependencies and
Chromium:

```sh
python3 scripts/generate-brand-icons.py --export /path/to/exports
```

Set `CHROMIUM_PATH` when Chromium is not at `/snap/bin/chromium`. Add `--font`
with a font file to produce a PNG overview; that step also requires Pillow.
The preview uses Instrument Sans, the existing website body family. Icons have
no font dependency. The extension uses committed PNGs without a build step.
