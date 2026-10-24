#!/usr/bin/env python3
"""Draws the site's icons and the pictures for social networks and the YouTube channel.

Run by hand after a change of name, colour or figure; the results are committed:
  assets/icons/favicon.svg, favicon.ico (16/32/48), apple-touch-icon.png (180)
  assets/og-default.png (1200x630), assets/youtube-avatar.png (800), youtube-banner.png (2560x1440),
  assets/youtube-watermark.png (150, transparent)

Needs: node, Python with playwright (Chromium), fontTools + brotli (for the letter outline), Pillow.
  python3 tools/brand-images.py
The letters are Old Standard TT from assets/fonts; the field is src/field.js with the canvas enlarged.
"""
import asyncio, base64, io, json, subprocess
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen
from PIL import Image
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent.parent
SITE = json.loads((ROOT / 'data/site.json').read_text('utf-8'))
MARK, WORDS = SITE['mark'], SITE.get('markWords', [])
LETTER = MARK[0]                                   # the icon letter
BG, TEXT, TEXT2, RULE, ACCENT, FIELD = '#070E1A', '#CBD4D1', '#83949A', '#2B3D49', '#4FCDB4', '#4E6068'
ICON_INK = '#E6EBE7'
FONTS = ROOT / 'assets/fonts'


def glyph(ch):
    f = TTFont(FONTS / 'OldStandardTT-Regular.woff2')
    gs = f.getGlyphSet(); name = f.getBestCmap()[ord(ch)]
    pen = SVGPathPen(gs); gs[name].draw(pen)
    bp = BoundsPen(gs); gs[name].draw(bp)
    return pen.getCommands(), bp.bounds, f['OS/2'].sCapHeight


def icon_svg(size=64, stroke=12, ground=True, ink=ICON_INK, dot=False):
    d, (x0, y0, x1, y1), cap = glyph(LETTER)
    s = size * 0.66 / cap                           # cap height = 66 % of the tile, as the former A
    tx = (size - (x1 - x0) * s) / 2 - x0 * s
    ty = (size + cap * s) / 2
    g = f'<path transform="translate({tx:.3f} {ty:.3f}) scale({s:.6f} {-s:.6f})" d="{d}" fill="{ink}" stroke="{ink}" stroke-width="{stroke}" stroke-linejoin="round"/>'
    extra = ''
    if dot:   # the sink, at the tip of the middle arm
        cx = tx + x1 * s + size * 0.07; cy = ty - cap * s * 0.52
        extra = f'<circle cx="{cx:.2f}" cy="{cy:.2f}" r="{size * 0.045:.2f}" fill="{ACCENT}"/>'
    bg = f'<rect width="{size}" height="{size}" fill="{BG}"/>' if ground else ''
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}">{bg}{g}{extra}</svg>'


def field(w, h, sink, scale):
    js = (f"import('{(ROOT / 'src/field.js').as_uri()}').then(m=>process.stdout.write(m.streamlineSvg("
          f"{{w:{w},h:{h},sink:[{sink[0]},{sink[1]}],k:{6200 * scale},u0:7,gamma:{2600 * scale}}})))")
    return subprocess.run(['node', '-e', js], check=True, capture_output=True, text=True).stdout


def page(w, h, body, extra_css=''):
    uri = lambda f: 'data:font/woff2;base64,' + base64.b64encode((FONTS / f).read_bytes()).decode()
    fonts = f"""
@font-face {{ font-family: 'OS'; src: url('{uri('OldStandardTT-Regular.woff2')}'); }}
@font-face {{ font-family: 'OS'; font-style: italic; src: url('{uri('OldStandardTT-Italic.woff2')}'); }}
@font-face {{ font-family: 'Golos'; src: url('{uri('GolosText-Variable.woff2')}'); font-weight: 300 900; }}"""
    return f"""<!doctype html><meta charset="utf-8"><style>{fonts}
html, body {{ margin: 0; width: {w}px; height: {h}px; background: {BG}; overflow: hidden; }}
.fig {{ position: absolute; inset: 0; }}
.fig svg {{ width: 100%; height: 100%; display: block; }}
.fig path {{ fill: none; stroke: {FIELD}; stroke-width: 1.1; opacity: .75; }}
.fig path.lum {{ stroke: {ACCENT}; opacity: .8; stroke-width: 1.2; }}
.fig circle {{ fill: {ACCENT}; r: var(--dot, 5px); }}
.mark {{ position: absolute; display: flex; justify-content: space-between; font: 400 var(--size)/1 'OS'; color: {TEXT}; }}
.mark span {{ position: relative; }}
.mark span[data-w]::after {{ content: attr(data-w); position: absolute; left: .047em; top: 100%; margin-top: .02em;
  font: italic 400 var(--word) 'OS'; color: {TEXT2}; letter-spacing: .01em; white-space: nowrap; }}
.mark span[data-w]:last-child::after {{ left: auto; right: .042em; }}
.sub {{ position: absolute; font-family: 'Golos'; color: {TEXT}; text-wrap: balance; }}
.sub div {{ text-wrap: balance; }}
.sub .b {{ color: {TEXT2}; }}
.rule {{ position: absolute; height: 2px; background: {RULE}; }}
{extra_css}</style><body>{body}</body>"""


def mark_html(left, top, width, size, word):
    spans = ''.join(f'<span data-w="{WORDS[i]}">{c}</span>' if i < len(WORDS) else f'<span>{c}</span>' for i, c in enumerate(MARK))
    # the outer letters' side bearings: their ink meets the edges of the block
    return (f'<div class="mark" style="--size:{size}px;--word:{word}px;left:{left - size * 0.047:.1f}px;top:{top}px;'
            f'width:{width + size * 0.089:.1f}px">{spans}</div>')


async def shoot(pw, html, w, h, out, transparent=False):
    b = await pw.chromium.launch()
    pg = await b.new_page(viewport={'width': w, 'height': h})
    await pg.set_content(html, wait_until='load')
    await pg.evaluate('document.fonts.ready.then(() => document.fonts.size)')
    await pg.wait_for_timeout(200)
    png = await pg.screenshot(omit_background=transparent)
    await b.close()
    Image.open(io.BytesIO(png)).save(out, optimize=True)
    print('wrote', out.relative_to(ROOT))


async def main():
    ICONS = ROOT / 'assets/icons'
    (ICONS / 'favicon.svg').write_text(icon_svg(64, 12) + '\n')
    print('wrote assets/icons/favicon.svg')
    async with async_playwright() as pw:
        # icons: heavier strokes at small sizes so the hairlines survive
        tiles = {}
        for px, stroke in [(16, 46), (32, 30), (48, 22), (180, 10)]:
            svg = icon_svg(64, stroke)
            html = f'<!doctype html><style>html,body{{margin:0;background:{BG}}}svg{{width:{px}px;height:{px}px;display:block}}</style>{svg}'
            tmp = ROOT / f'.icon-{px}.png'
            await shoot(pw, html, px, px, tmp)
            tiles[px] = Image.open(tmp).convert('RGBA'); tiles[px].load(); tmp.unlink()
        tiles[180].convert('RGB').save(ICONS / 'apple-touch-icon.png', optimize=True)
        tiles[48].save(ICONS / 'favicon.ico', sizes=[(16, 16), (32, 32), (48, 48)], append_images=[tiles[16], tiles[32]])
        print('wrote assets/icons/apple-touch-icon.png, favicon.ico')

        conv = SITE['strings']['en']['convenedBy'].replace('{names}', ' and '.join(c['name']['en'] for c in SITE['conveners']))
        sub_en, sub_ru = SITE['strings']['en']['subtitle'], SITE['strings']['ru']['subtitle']

        # Open Graph card
        body = (f'<div class="fig">{field(1200, 630, (940, 300), 1.6)}</div>'
                + mark_html(80, 150, 560, 132, 19)
                + '<div class="rule" style="left:80px;top:338px;width:560px"></div>'
                + f'<div class="sub" style="left:80px;top:362px;width:600px;font-size:26px;line-height:1.45">{sub_en}'
                + f'<div class="b" style="margin-top:14px">{conv}</div></div>')
        fade = '.fig{-webkit-mask-image:linear-gradient(to right,transparent 30%,#000 62%);mask-image:linear-gradient(to right,transparent 30%,#000 62%)}'
        await shoot(pw, page(1200, 630, body, fade), 1200, 630, ROOT / 'assets/og-default.png')

        # YouTube banner: 2560 x 1440, of which phones show only the middle 1546 x 423 (x 507-2053,
        # y 508-931). Everything that matters sits inside it with a margin; the sink is inside it too.
        body = (f'<div class="fig">{field(2560, 1440, (1800, 712), 3.4)}</div>'
                + mark_html(597, 548, 800, 150, 25)
                + '<div class="rule" style="left:597px;top:762px;width:800px"></div>'
                + f'<div class="sub" style="left:597px;top:782px;font-size:32px;line-height:1.4">{sub_en}<div class="b">{sub_ru}</div></div>')
        await shoot(pw, page(2560, 1440, body, ':root{--dot:9px}'), 2560, 1440, ROOT / 'assets/youtube-banner.png')

        # YouTube avatar (shown in a circle) and the video watermark
        d, (x0, y0, x1, y1), cap = glyph(LETTER)
        s = 800 * 0.5 / cap; tx = (800 - (x1 - x0) * s) / 2 - x0 * s; ty = (800 + cap * s) / 2
        sink = (round(tx + x1 * s + 46), round(ty - cap * s * 0.52))
        letter = f'<svg style="position:absolute;inset:0" viewBox="0 0 800 800"><path transform="translate({tx:.2f} {ty:.2f}) scale({s:.5f} {-s:.5f})" d="{d}" fill="{TEXT}"/></svg>'
        body = f'<div class="fig">{field(800, 800, sink, 1.2)}</div>{letter}'
        await shoot(pw, page(800, 800, body, ':root{--dot:9px}'), 800, 800, ROOT / 'assets/youtube-avatar.png')
        wm = icon_svg(150, 0, ground=False, ink=TEXT, dot=True)
        html = f'<!doctype html><style>html,body{{margin:0;background:transparent}}svg{{width:150px;height:150px;display:block}}</style>{wm}'
        await shoot(pw, html, 150, 150, ROOT / 'assets/youtube-watermark.png', transparent=True)

asyncio.run(main())
