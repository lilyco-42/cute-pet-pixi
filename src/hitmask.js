// 逐层 alpha 缓存 + 命中测试。
// 不做「整画布预合成」——立绘画布可以是 1800x2550（460 万像素），每帧合成成本不可接受。
// 改成按需取单个图层自己的 alpha（每层只有一两百像素见方），并用 WeakMap 缓存。
const cache = new WeakMap();

export function layerAlpha(bitmap) {
  let e = cache.get(bitmap);
  if (e) return e;
  const w = bitmap.width;
  const h = bitmap.height;
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  const a = new Uint8Array(w * h);
  for (let i = 0; i < a.length; i++) a[i] = data[i * 4 + 3];
  e = { w, h, a };
  cache.set(bitmap, e);
  return e;
}

// 从最上层往下找第一个命中且不透明的层；全不命中 = 命中失败（点击穿透）
export function hitTestLayers(layers, bitmaps, cx, cy, threshold, pickBitmap) {
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    const bmp = pickBitmap(l);
    if (!bmp) continue;
    const w = l.w || bmp.width;
    const h = l.h || bmp.height;
    if (cx < l.x || cy < l.y || cx >= l.x + w || cy >= l.y + h) continue;
    const mask = layerAlpha(bmp);
    const mx = Math.floor(((cx - l.x) / w) * mask.w);
    const my = Math.floor(((cy - l.y) / h) * mask.h);
    if (mx < 0 || my < 0 || mx >= mask.w || my >= mask.h) continue;
    if (mask.a[my * mask.w + mx] >= threshold) return true;
  }
  return false;
}
