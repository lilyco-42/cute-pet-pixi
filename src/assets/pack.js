// 统一资产包加载器。
// 运行时不解析任何第三方格式：所有素材源（laic/PixelLiner、Spine 3.8、Live2D、
// PNG 帧序列、Ethornell 分层）都由 tools/ 下的离线导入器归一化成 pack.json。
//
// 两种运行时形态：
//   format: "frames"   时间驱动的帧序列（laic / PNG 序列 / 精灵表切图）
//   format: "variants" 可交互的分层立绘（Ethornell .chr：服装 / 表情变体 + 待机浮动）
// 两者共用同一套 layer {src,x,y,w,h,alpha} 与同一套逐像素命中测试。

export const PACK_SCHEMA = 1;

export async function loadPack(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('pack 加载失败: ' + url + ' (' + res.status + ')');
  return normalizePack(await res.json(), url);
}

function absFactory(url) {
  const base = url.slice(0, url.lastIndexOf('/') + 1);
  return (p) => (/^(https?:|data:|blob:|pack:|\/)/.test(p) ? p : base + p);
}

export function normalizePack(raw, url) {
  const abs = absFactory(url);
  const layer = (l) => ({
    src: abs(l.src),
    x: l.x || 0,
    y: l.y || 0,
    w: l.w || 0,
    h: l.h || 0,
    z: l.z === undefined ? 0 : l.z,
    alpha: l.alpha === undefined ? 1 : l.alpha,
  });

  const pack = {
    schema: raw.schema || PACK_SCHEMA,
    id: raw.id || 'unnamed',
    format: raw.format || 'frames',
    canvas: raw.canvas || { width: 160, height: 160 },
    scale: raw.scale === undefined ? 1 : raw.scale,
    anchor: raw.anchor || { x: 0.5, y: 1.0 },
    hitThreshold: raw.hitThreshold === undefined ? 90 : raw.hitThreshold,
    idle: raw.idle || null,
    source: raw.source || null,
    behaviors: raw.behaviors || null,   // 日常行为表也是资产的一部分
    animations: {},
    variants: null,
  };

  for (const [id, clip] of Object.entries(raw.animations || {})) {
    const directions = {};
    for (const [dir, seq] of Object.entries(clip.directions || {})) {
      const frames = (Array.isArray(seq) ? seq : seq.frames || []).map((f) => ({
        ticks: f.ticks === undefined ? 4 : f.ticks,
        name: f.name || null,
        layers: (f.layers || []).map(layer),
      }));
      if (frames.length) directions[dir] = { frames };
    }
    if (Object.keys(directions).length) pack.animations[id] = { loop: clip.loop !== false, directions };
  }

  if (raw.variants) {
    const variants = {};
    for (const [name, group] of Object.entries(raw.variants)) {
      variants[name] = {
        default: group.default,
        options: (group.options || []).map((o) => ({ id: o.id, label: o.label || o.id, diff: o.diff, layers: (o.layers || []).map(layer) })),
      };
    }
    pack.variants = variants;
    pack.format = 'variants';
  }

  if (!Object.keys(pack.animations).length && !pack.variants) throw new Error('pack 既无动画也无变体: ' + url);
  return pack;
}
