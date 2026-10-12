# -*- coding: utf-8 -*-
"""生成占位待机帧序列（明日方舟 chibi 风格的小人）。"""
from PIL import Image, ImageDraw
import os

OUT = r"D:\demo\desktop_pet\assets\idle"
os.makedirs(OUT, exist_ok=True)
S, N = 128, 8

SKIN   = (255, 226, 205, 255)
SKIN_SH= (235, 190, 168, 255)
HAIR   = (56, 72, 118, 255)
HAIR_HI= (98, 122, 178, 255)
COAT   = (38, 52, 92, 255)
COAT_HI= (216, 228, 248, 255)
ACCENT = (238, 146, 62, 255)
LINE   = (26, 30, 50, 255)
SHOE   = (44, 42, 58, 255)

BOB   = [0, 0, 1, 1, 2, 1, 0, -1]
BLINK = {5, 6}

def draw_frame(i):
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    b = BOB[i % N]
    cx = 64

    # 腿 + 鞋
    d.rounded_rectangle([cx-13, 100+b, cx-2, 114+b], 4, fill=LINE)
    d.rounded_rectangle([cx+2, 100+b, cx+13, 114+b], 4, fill=LINE)
    d.rounded_rectangle([cx-17, 110+b, cx-1, 120+b], 5, fill=SHOE, outline=LINE, width=2)
    d.rounded_rectangle([cx+1, 110+b, cx+17, 120+b], 5, fill=SHOE, outline=LINE, width=2)

    # 手臂
    d.rounded_rectangle([cx-31, 72+b, cx-21, 98+b], 6, fill=COAT, outline=LINE, width=2)
    d.rounded_rectangle([cx+21, 72+b, cx+31, 98+b], 6, fill=COAT, outline=LINE, width=2)

    # 大衣
    d.rounded_rectangle([cx-21, 68+b, cx+21, 106+b], 10, fill=COAT, outline=LINE, width=2)
    d.rectangle([cx-4, 70+b, cx+4, 104+b], fill=COAT_HI)

    # 围巾领
    d.rounded_rectangle([cx-13, 62+b, cx+13, 72+b], 5, fill=ACCENT, outline=LINE, width=2)

    # 后发
    d.ellipse([cx-27, 20+b, cx+27, 78+b], fill=HAIR)
    # 脸
    d.ellipse([cx-21, 28+b, cx+21, 68+b], fill=SKIN, outline=LINE, width=2)
    # 刘海
    d.ellipse([cx-23, 20+b, cx+23, 46+b], fill=HAIR)
    d.ellipse([cx-19, 24+b, cx+19, 50+b], fill=HAIR)
    # 呆毛
    d.line([cx+2, 21+b, cx+9, 12+b], fill=HAIR, width=3)

    # 眼睛
    if i % N in BLINK:
        d.line([cx-13, 48+b, cx-6, 48+b], fill=LINE, width=3)
        d.line([cx+6, 48+b, cx+13, 48+b], fill=LINE, width=3)
    else:
        d.ellipse([cx-13, 43+b, cx-6, 53+b], fill=LINE)
        d.ellipse([cx+6, 43+b, cx+13, 53+b], fill=LINE)
    # 腮红
    d.ellipse([cx-19, 52+b, cx-12, 57+b], fill=(255, 186, 178, 140))
    d.ellipse([cx+12, 52+b, cx+19, 57+b], fill=(255, 186, 178, 140))

    return img

frames = [draw_frame(i) for i in range(N)]
for i, f in enumerate(frames):
    f.save(os.path.join(OUT, "idle_%02d.png" % i))

# 预览拼图（仅供人眼检查，不参与运行）
sheet = Image.new("RGBA", (S * 4, S * 2), (40, 44, 58, 255))
for i, f in enumerate(frames):
    sheet.alpha_composite(f, ((i % 4) * S, (i // 4) * S))
sheet.save(r"D:\demo\desktop_pet\assets\_preview_idle.png")
print("frames:", len(frames), "->", OUT)
