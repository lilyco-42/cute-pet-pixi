// 从 Ark-Models 的 models_data.json 里挑热门干员（默认服装），输出 key|中文名|皮肤组
import fs from 'node:fs';
const m = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const data = m.data || {};
const POPULAR = ['阿米娅','凯尔希','能天使','银灰','陈','史尔特尔','德克萨斯','拉普兰德','推进之王','艾雅法拉','塞雷娅','煌','温蒂','迷迭香','泥岩','棘刺','令','琴柳','澄闪','澄闪','焰尾','豆苗','假日威龙陈','归溟幽灵鲨','百炼嘉维尔','号角','斥罪','鸿雪','灵知','远牙','夕','灰烬','绮良','蜜蜡','空弦','早露','傀影','罗宾','多萝西','白铁','流明','菲亚梅塔'];
const seen = new Set();
const out = [];
for (const key of Object.keys(data)) {
  const e = data[key];
  if (e.type !== 'Operator') continue;
  if (!POPULAR.includes(e.name)) continue;
  if (String(e.skinGroupId || '').toUpperCase() !== 'DEFAULT') continue;
  if (seen.has(e.name)) continue;
  seen.add(e.name);
  out.push({ key, name: e.name, appellation: e.appellation, files: e.assetList });
}
for (const o of out) console.log(o.key + '|' + o.name + '|' + o.appellation);
console.error('匹配到 ' + out.length + ' 个热门干员');
