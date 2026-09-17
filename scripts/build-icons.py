# Rasterises the logo into the favicons and the iOS touch icon. Nothing in the
# Node toolchain draws SVG, so this runs by hand: pip install cairosvg, then
# python3 scripts/build-icons.py, and commit what it writes.
import struct

import cairosvg
from PIL import Image

cairosvg.svg2png(url='public/logo-square.svg', write_to='public/apple-touch-icon.png',
                 output_width=120, output_height=120)
# The app icon is one 1024 image; iOS renders every other size from it. App
# Store submission rejects an icon with an alpha channel, so it is flattened.
app_icon = 'ios/WorkoutsMCP/Assets.xcassets/AppIcon.appiconset/icon-1024.png'
cairosvg.svg2png(url='public/logo-square.svg', write_to=app_icon,
                 output_width=1024, output_height=1024)
Image.open(app_icon).convert('RGB').save(app_icon)
for size in (32, 16):
    cairosvg.svg2png(url='public/favicon.svg', write_to=f'public/favicon-{size}.png',
                     output_width=size, output_height=size)

# Pillow writes a single-size .ico, so the container is assembled here: a header,
# one directory entry per size, then the PNGs the entries point at.
sizes = (16, 32, 48)
pngs = [cairosvg.svg2png(url='public/favicon.svg', output_width=s, output_height=s) for s in sizes]
ico = struct.pack('<HHH', 0, 1, len(sizes))
offset = 6 + 16 * len(sizes)
for size, png in zip(sizes, pngs):
    ico += struct.pack('<BBBBHHII', size, size, 0, 0, 1, 32, len(png), offset)
    offset += len(png)
with open('public/favicon.ico', 'wb') as f:
    f.write(ico + b''.join(pngs))

print('wrote apple-touch-icon.png, favicon-32.png, favicon-16.png, favicon.ico, icon-1024.png')
