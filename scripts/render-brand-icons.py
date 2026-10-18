"""Render the original Moyu book/island vector geometry into Windows icon sizes."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent / 'src-tauri/icons'
scale = 8
image = Image.new('RGBA', (128 * scale, 128 * scale))
draw = ImageDraw.Draw(image)
ink, mint, gold = '#1b3035', '#b9dfd2', '#d9b477'
def points(values): return [(round(x*scale), round(y*scale)) for x,y in values]
def cubic(a,b,c,d):
    return [((1-t)**3*a[0]+3*(1-t)**2*t*b[0]+3*(1-t)*t*t*c[0]+t**3*d[0],
             (1-t)**3*a[1]+3*(1-t)**2*t*b[1]+3*(1-t)*t*t*c[1]+t**3*d[1]) for t in [i/40 for i in range(41)]]
def stroke(values, color, width): draw.line(points(values), fill=color, width=round(width*scale), joint='curve')
draw.rounded_rectangle((6*scale,6*scale,122*scale,122*scale),radius=30*scale,fill=ink)
outline = cubic((64,43),(52,34),(39,32),(27,35)) + [(27,83)] + cubic((27,83),(41,80),(53,84),(64,92))
outline += cubic((64,92),(75,84),(87,80),(101,83)) + [(101,35)] + cubic((101,35),(88,32),(77,34),(64,43))
stroke(outline,mint,5);stroke([(64,43),(64,91)],mint,3.5)
for path in [((38,49),(44,49),(49,51),(54,54)),((38,61),(44,61),(49,63),(54,66)),((76,54),(81,51),(86,49),(91,49)),((76,66),(81,63),(86,61),(91,61))]: stroke(cubic(*path),mint,3.5)
draw.polygon(points([(81,33),(81,48),(87,44),(93,46),(93,33)]),fill=gold)
stroke(cubic((45,102),(58,107),(72,107),(84,102)),gold,3)
for size,name in [(32,'32x32.png'),(128,'128x128.png'),(256,'128x128@2x.png')]: image.resize((size,size),Image.Resampling.LANCZOS).save(root/name)
image.resize((256,256),Image.Resampling.LANCZOS).save(root/'icon.ico',sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
print('Rendered Moyu PNG and ICO icons from original vector geometry')
