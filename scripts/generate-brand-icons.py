"""Render the existing Callisto orbital identity into committed extension icons.

Requires Node, the Mini Playwright dependency and Chromium.
Preview generation additionally uses Pillow and --font.
The extension itself ships the PNGs and has no image-generation dependency.
"""
import argparse
import json
import shutil
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SIZES = (16, 32, 48, 64, 96, 128, 256, 512)
JOBS = []


def svg(*, tile=True, monochrome=False, small=False):
    ink, blue, cream = '#10171d', '#3b82f6', '#f0ede6'
    orbit = blue if monochrome else cream
    stroke = 3.7 if small else 2.45
    satellite = 3.6 if small else 3.15
    background = f'<rect width="64" height="64" rx="14" fill="{ink}"/>' if tile else ''
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 64 64">
<title>Callisto orbital mark</title>
{background}
<ellipse cx="32" cy="32" rx="24" ry="8.7" fill="none" stroke="{orbit}" stroke-width="{stroke}" transform="rotate(-24 32 32)"/>
<circle cx="32" cy="32" r="11.6" fill="{blue}"/>
<path d="M8 32 A24 8.7 0 0 0 56 32" fill="none" stroke="{orbit}" stroke-width="{stroke}" stroke-linecap="round" transform="rotate(-24 32 32)"/>
<circle cx="51.45" cy="19.8" r="{satellite}" fill="{orbit}"/>
</svg>
'''


def render(source, output, size):
    JOBS.append({'source': str(source), 'output': str(output), 'size': size})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--export', type=Path, help='Also export user-facing PNG files here')
    parser.add_argument('--font', type=Path, help='Optional font for the export preview')
    args = parser.parse_args()
    brand = ROOT / 'assets/brand'
    extension = ROOT / 'packages/firefox-rs/extension'
    brand.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='callisto-icons-') as temporary:
        small = Path(temporary) / 'small.svg'
        small.write_text(svg(small=True))
        master = brand / 'callisto-icon.svg'
        master.write_text(svg())
        for size in SIZES:
            render(small if size <= 32 else master, extension / f'icon-{size}.png', size)
        transparent = brand / 'callisto-mark.svg'
        transparent.write_text(svg(tile=False))
        mono = brand / 'callisto-mark-blue.svg'
        mono.write_text(svg(tile=False, monochrome=True))
        render(master, brand / 'callisto-icon-512.png', 512)
        render(transparent, brand / 'callisto-mark-512.png', 512)
        render(mono, brand / 'callisto-mark-blue-512.png', 512)
        render(master, ROOT / 'site/apple-touch-icon.png', 180)
        subprocess.run(['node', str(ROOT / 'scripts/render-brand-icons.mjs'), json.dumps(JOBS)], check=True)
        shutil.copyfile(master, ROOT / 'site/favicon.svg')
    if not args.export:
        return
    args.export.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        shutil.copyfile(extension / f'icon-{size}.png', args.export / f'callisto-icon-{size}.png')
    for name in ('callisto-mark-512.png', 'callisto-mark-blue-512.png'):
        shutil.copyfile(brand / name, args.export / name)
    shutil.copyfile(brand / 'design.md', args.export / 'design.md')
    if args.font:
        from PIL import Image, ImageDraw, ImageFont
        board = Image.new('RGB', (1400, 840), '#f4f1ea')
        draw = ImageDraw.Draw(board)
        title = ImageFont.truetype(str(args.font), 62)
        body = ImageFont.truetype(str(args.font), 22)
        small_text = ImageFont.truetype(str(args.font), 17)
        draw.text((72, 48), 'Callisto', font=title, fill='#10171d')
        draw.text((74, 127), 'Orbital identity · browser extension', font=body, fill='#50616b')
        icon = Image.open(brand / 'callisto-icon-512.png').convert('RGBA')
        board.paste(icon, (72, 216), icon)
        draw.text((74, 752), 'Primary icon', font=body, fill='#10171d')
        draw.text((74, 787), 'Blue core. Warm orbit. A precise connection.', font=small_text, fill='#50616b')
        draw.rounded_rectangle((664, 208, 1040, 536), radius=24, fill='#10171d')
        mark = Image.open(brand / 'callisto-mark-512.png').convert('RGBA').resize((300, 300), Image.Resampling.LANCZOS)
        board.paste(mark, (702, 222), mark)
        mono = Image.open(brand / 'callisto-mark-blue-512.png').convert('RGBA').resize((260, 260), Image.Resampling.LANCZOS)
        board.paste(mono, (1080, 242), mono)
        draw.text((666, 564), 'Transparent mark', font=body, fill='#10171d')
        draw.text((1080, 564), 'Single colour', font=body, fill='#10171d')
        draw.line((664, 620, 1328, 620), fill='#d3d5d0', width=1)
        x = 666
        for size in (16, 32, 48, 64, 128):
            im = Image.open(extension / f'icon-{size}.png').convert('RGBA')
            board.paste(im, (x, 670 + (128-size)//2), im)
            draw.text((x, 810), str(size), font=small_text, fill='#50616b')
            x += size + 42
        board.save(args.export / 'callisto-logos-preview.png')
    print(args.export)


if __name__ == '__main__':
    main()
