// 水墨写意笔法工具:移植自 component/ 下的水墨研究 demo(brush 变宽毛笔 + 没骨花瓣 + ink 墨色)。
// 这些函数生成 SVG path 的 d 字符串与"墨元素"描述,由 QingjianScroll 的装饰组件确定性地渲染,
// 入场动画交给 CSS(.qj-fired 触发 grow/bloom)。
//
// 关键:变宽笔触不是 stroke,而是沿中心线两侧按 widthFn(t) 外扩成的填充多边形——这才有毛笔的提按粗细。

export type Pt = [number, number];

// 入场揭示方式:枝干自上垂下 / 自下生长 / 横向铺开 / 花叶绽放 / 淡入
export type InkReveal = "growDown" | "growUp" | "growLeft" | "bloom" | "fade";

// 入场后的一次性动效(进入视野播一遍,不循环);drift 例外——云雾持续漂浮
export type InkMotion = "fall" | "sway" | "swim" | "flit" | "drift";

export interface InkEl {
  d: string;
  fill: string;
  reveal: InkReveal;
  // 入场延迟(ms),用于"先枝后花"的笔序
  delay: number;
  // 元素级一次性动效(如花瓣飘落 / 叶摇摆)
  motion?: InkMotion;
  // 该元素需要的 CSS 自定义变量(如飘落方向 --qj-mx)
  vars?: Record<string, string>;
  // 软边晕染(高斯模糊):云雾 / 湿墨晕染用
  soft?: boolean;
}

// ---------- 种子化随机(保证同一装饰每次渲染稳定,不闪烁) ----------
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 131 + str.charCodeAt(i)) >>> 0;
  return h || 1;
}

// ---------- Catmull-Rom 平滑:把折线变成顺滑曲线点列 ----------
function smooth(pts: Pt[], seg = 12): Pt[] {
  if (pts.length < 3) return pts.slice();
  const P: Pt[] = [pts[0]!, ...pts, pts[pts.length - 1]!];
  const cr = (p0: number, p1: number, p2: number, p3: number, t: number) => {
    const t2 = t * t;
    const t3 = t2 * t;
    return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  };
  const out: Pt[] = [];
  for (let i = 0; i < P.length - 3; i++) {
    const p0 = P[i]!;
    const p1 = P[i + 1]!;
    const p2 = P[i + 2]!;
    const p3 = P[i + 3]!;
    for (let s = 0; s < seg; s++) {
      const t = s / seg;
      out.push([cr(p0[0], p1[0], p2[0], p3[0], t), cr(p0[1], p1[1], p2[1], p3[1], t)]);
    }
  }
  out.push(pts[pts.length - 1]!);
  return out;
}

function ringToPath(ring: Pt[]): string {
  let d = `M${ring[0]![0].toFixed(1)} ${ring[0]![1].toFixed(1)}`;
  for (let i = 1; i < ring.length; i++) d += `L${ring[i]![0].toFixed(1)} ${ring[i]![1].toFixed(1)}`;
  return d + "Z";
}

// ---------- 变宽毛笔笔触:核心 ----------
// 沿平滑后的中心线,在每点法向两侧按 widthFn(t) 外扩,得到闭合填充多边形。
export function brushD(pts: Pt[], widthFn: (t: number) => number): string {
  const sm = smooth(pts, 12);
  const n = sm.length;
  const L: Pt[] = [];
  const R: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = sm[Math.max(0, i - 1)]!;
    const b = sm[Math.min(n - 1, i + 1)]!;
    let tx = b[0] - a[0];
    let ty = b[1] - a[1];
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;
    const nx = -ty;
    const ny = tx;
    const w = widthFn(i / (n - 1));
    L.push([sm[i]![0] + nx * w, sm[i]![1] + ny * w]);
    R.push([sm[i]![0] - nx * w, sm[i]![1] - ny * w]);
  }
  return ringToPath(L.concat(R.reverse()));
}

// 冷墨(略带青黑),浓淡靠 alpha——墨分五色
export function ink(a: number): string {
  return `rgba(36,34,32,${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}

// 没骨花瓣形:中部最宽、尖端收,带轻微侧弯
function petalD(cx: number, cy: number, ang: number, len: number, wid: number, cur: number): string {
  const mx = cx + Math.cos(ang) * len * 0.5 - Math.sin(ang) * len * cur;
  const my = cy + Math.sin(ang) * len * 0.5 + Math.cos(ang) * len * cur;
  const tx = cx + Math.cos(ang) * len;
  const ty = cy + Math.sin(ang) * len;
  return brushD([[cx, cy], [mx, my], [tx, ty]], (t) => Math.pow(Math.sin(Math.PI * t), 0.72) * wid + 0.4);
}

// 一朵没骨花:红瓣半透明叠加 + 焦墨点蕊。返回墨元素(花瓣 bloom + 蕊点 bloom)
function inkFlower(
  rng: () => number,
  cx: number,
  cy: number,
  opt: { petals: number; len: number; wid: number; baseDelay: number; petalRgb: [number, number, number] },
): InkEl[] {
  const els: InkEl[] = [];
  const base = rng() * Math.PI * 2;
  const [r, g, b] = opt.petalRgb;
  for (let k = 0; k < opt.petals; k++) {
    const ang = base + (k / opt.petals) * Math.PI * 2 + (rng() - 0.5) * 0.12;
    const len = opt.len * (0.86 + rng() * 0.28);
    const cur = (rng() - 0.5) * 0.5;
    const a = 0.34 + rng() * 0.26;
    els.push({
      d: petalD(cx, cy, ang, len, opt.wid, cur),
      fill: `rgba(${r},${g},${b},${a.toFixed(3)})`,
      reveal: "bloom",
      delay: opt.baseDelay + k * 18,
    });
  }
  // 花心:焦墨点蕊 + 几点赭黄蕊丝
  const dots = 5 + Math.floor(rng() * 4);
  const cr0 = Math.max(1.6, opt.len * 0.16);
  for (let i = 0; i < dots; i++) {
    const ag = rng() * Math.PI * 2;
    const rr = rng() * cr0;
    const dx = cx + Math.cos(ag) * rr;
    const dy = cy + Math.sin(ag) * rr;
    const rad = 0.7 + rng() * 1.0;
    const warm = rng() < 0.4;
    els.push({
      d: `M${(dx - rad).toFixed(1)} ${dy.toFixed(1)}a${rad.toFixed(1)} ${rad.toFixed(1)} 0 1 0 ${(rad * 2).toFixed(1)} 0a${rad.toFixed(1)} ${rad.toFixed(1)} 0 1 0 ${(-rad * 2).toFixed(1)} 0Z`,
      fill: warm ? `rgba(150,96,40,${(0.55 + rng() * 0.3).toFixed(3)})` : ink(0.7 + rng() * 0.22),
      reveal: "bloom",
      delay: opt.baseDelay + 120 + i * 10,
    });
  }
  return els;
}

// ===================== 各装饰生成器 =====================
// 约定:返回墨元素数组,坐标在各自 viewBox 内。绿叶/红瓣用淡彩,枝干用墨。

const GREEN = (a: number) => `rgba(66,86,56,${a.toFixed(3)})`;
const TAN = (a: number) => `rgba(150,120,80,${a.toFixed(3)})`;
const PLUM_RGB: [number, number, number] = [176, 58, 72];

// 尖叶/竹叶/芦叶:窄根、肥腹、利尖(写意撇叶的形)。curve 控制侧弯。
function bladeD(x: number, y: number, ang: number, len: number, wid: number, curve: number): string {
  const mx = x + Math.cos(ang) * len * 0.5 - Math.sin(ang) * len * curve;
  const my = y + Math.sin(ang) * len * 0.5 + Math.cos(ang) * len * curve;
  const tx = x + Math.cos(ang) * len;
  const ty = y + Math.sin(ang) * len;
  return brushD([[x, y], [mx, my], [tx, ty]], (t) => Math.pow(t, 0.5) * Math.pow(1 - t, 0.92) * wid * 3 + 0.3);
}

// 竹叶簇:从一点撇出 2~3 片细长利叶(个/分 字形),角度散开、有长短,sharp
function bambooLeafCluster(rng: () => number, x: number, y: number, baseDir: number, scale: number, delay: number): InkEl[] {
  const n = 2 + Math.floor(rng() * 2);
  const els: InkEl[] = [];
  const spread = 0.9 + rng() * 0.5;
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const ang = baseDir + (t - 0.5) * spread + (rng() - 0.5) * 0.16;
    const len = (40 + rng() * 26) * scale;
    const wid = (2.4 + rng() * 1) * scale;
    els.push({
      d: bladeD(x, y, ang, len, wid, (rng() - 0.5) * 0.36),
      fill: GREEN(0.5 + rng() * 0.26),
      reveal: "bloom",
      delay: delay + i * 36,
    });
  }
  return els;
}

// 松针簇:从一点放射密集细针(车轮状半扇)
function pineTuft(rng: () => number, cx: number, cy: number, dir: number, delay: number): InkEl[] {
  const n = 13 + Math.floor(rng() * 6);
  const spread = 2.0 + rng() * 0.5;
  const els: InkEl[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const ang = dir - spread / 2 + spread * t + (rng() - 0.5) * 0.1;
    const len = 15 + rng() * 11;
    const ex = cx + Math.cos(ang) * len;
    const ey = cy + Math.sin(ang) * len;
    els.push({
      d: brushD([[cx, cy], [ex, ey]], (tt) => (1 - tt) * 0.85 + 0.32),
      fill: `rgba(48,68,50,${(0.32 + rng() * 0.24).toFixed(3)})`,
      reveal: "bloom",
      delay: delay + i * 5,
    });
  }
  return els;
}

// 芦穗:秆顶蓬松羽穗(中脊 + 两侧密集软毛,向下垂)
function reedPlume(rng: () => number, x: number, y: number, dir: number, delay: number): InkEl[] {
  const els: InkEl[] = [];
  const spikeLen = 18 + rng() * 8;
  els.push({ d: bladeD(x, y, dir, spikeLen, 2, 0), fill: TAN(0.5), reveal: "bloom", delay });
  const n = 12 + Math.floor(rng() * 6);
  for (let i = 0; i < n; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    const t = (i / n) * 0.9;
    const bx = x + Math.cos(dir) * spikeLen * t;
    const by = y + Math.sin(dir) * spikeLen * t;
    const ang = dir + side * (0.5 + rng() * 0.5);
    const len = 5 + rng() * 7;
    els.push({
      d: brushD([[bx, by], [bx + Math.cos(ang) * len, by + Math.sin(ang) * len + 2]], (tt) => (1 - tt) * 0.7 + 0.25),
      fill: TAN(0.38 + rng() * 0.22),
      reveal: "bloom",
      delay: delay + 40 + i * 8,
    });
  }
  return els;
}

// 梅(edge top):老干自顶垂下,几条曲折分枝,沿枝缀红梅与花苞
export function genPlum(seed: number, w = 270, h = 170): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  // 主干:从顶边垂入,曲折下行(老梅"之"字形),根粗梢细
  const startX = w * (0.32 + rng() * 0.12);
  const trunk: Pt[] = [[startX, -8]];
  let cx = startX;
  let cy = -8;
  const segs = 4;
  const dir = rng() < 0.5 ? 1 : -1;
  for (let k = 0; k < segs; k++) {
    cx += dir * (18 + rng() * 26) * (k % 2 === 0 ? 1 : -0.6);
    cy += (h - 20) / segs;
    trunk.push([cx, cy]);
  }
  els.push({ d: brushD(trunk, (t) => (1 - t) * 6.2 + 1.4), fill: ink(0.82), reveal: "growDown", delay: 0 });

  // 分枝:从主干中上部斜出 2~3 条
  const branchTips: Pt[] = [];
  const bn = 2 + (rng() < 0.6 ? 1 : 0);
  for (let i = 0; i < bn; i++) {
    const tt = 0.28 + i * 0.24 + rng() * 0.08;
    const bi = Math.min(trunk.length - 1, Math.floor(tt * trunk.length));
    const ox = trunk[bi]![0];
    const oy = trunk[bi]![1];
    const bdir = rng() < 0.5 ? 1 : -1;
    const blen = 46 + rng() * 40;
    const ang = -0.2 + bdir * (0.5 + rng() * 0.5);
    const bx = ox + Math.cos(ang) * blen;
    const by = oy + Math.sin(ang) * blen * 0.7 + 8;
    const bpts: Pt[] = [[ox, oy], [(ox + bx) / 2 + bdir * 6, (oy + by) / 2], [bx, by]];
    els.push({ d: brushD(bpts, (t) => (1 - t) * 2.6 + 0.6), fill: ink(0.7), reveal: "growDown", delay: 220 + i * 120 });
    branchTips.push([bx, by]);
    // 小枝梢
    if (rng() < 0.7) {
      const tx = bx + (rng() - 0.5) * 30;
      const ty = by + 14 + rng() * 16;
      els.push({
        d: brushD([[bx, by], [tx, ty]], (t) => (1 - t) * 1.3 + 0.4),
        fill: ink(0.55),
        reveal: "growDown",
        delay: 360 + i * 120,
      });
      branchTips.push([tx, ty]);
    }
  }

  // 沿枝缀花:在主干下段与各分枝梢附近开 5~7 朵,大小不一
  const anchors: Pt[] = [
    [trunk[trunk.length - 1]![0], trunk[trunk.length - 1]![1]],
    [trunk[Math.floor(trunk.length * 0.6)]![0], trunk[Math.floor(trunk.length * 0.6)]![1]],
    ...branchTips,
  ];
  let fi = 0;
  for (const [ax, ay] of anchors) {
    if (fi >= 7) break;
    const big = rng() < 0.6;
    const len = big ? 9 + rng() * 4 : 5 + rng() * 3;
    els.push(
      ...inkFlower(rng, ax + (rng() - 0.5) * 8, ay + (rng() - 0.5) * 8, {
        petals: 5,
        len,
        wid: len * 0.7,
        baseDelay: 480 + fi * 90,
        petalRgb: PLUM_RGB,
      }),
    );
    fi++;
    // 花苞:小红点
    if (rng() < 0.6) {
      const bx = ax + (rng() - 0.5) * 20;
      const by = ay + (rng() - 0.5) * 18;
      const rad = 1.8 + rng() * 1.4;
      els.push({
        d: `M${(bx - rad).toFixed(1)} ${by.toFixed(1)}a${rad.toFixed(1)} ${rad.toFixed(1)} 0 1 0 ${(rad * 2).toFixed(1)} 0a${rad.toFixed(1)} ${rad.toFixed(1)} 0 1 0 ${(-rad * 2).toFixed(1)} 0Z`,
        fill: `rgba(${PLUM_RGB[0]},${PLUM_RGB[1]},${PLUM_RGB[2]},${(0.5 + rng() * 0.2).toFixed(3)})`,
        reveal: "bloom",
        delay: 560 + fi * 80,
      });
    }
  }
  return els;
}

// 松(edge top):横枝自上方斜垂,松针扇成簇
export function genPine(seed: number, w = 280, h = 190): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  // 主枝:从左上垂入,向右下斜伸,略曲折
  const main: Pt[] = [
    [w * (0.1 + rng() * 0.1), -6],
    [w * 0.34, h * 0.26],
    [w * 0.6, h * 0.42],
    [w * 0.86, h * 0.5],
  ];
  els.push({ d: brushD(main, (t) => (1 - t) * 4.4 + 1.2), fill: ink(0.78), reveal: "growDown", delay: 0 });
  // 两条小分枝
  const subs: Pt[][] = [
    [[w * 0.34, h * 0.26], [w * 0.42, h * 0.08]],
    [[w * 0.6, h * 0.42], [w * 0.7, h * 0.22]],
  ];
  subs.forEach((s, i) => {
    els.push({ d: brushD(s as Pt[], (t) => (1 - t) * 1.8 + 0.5), fill: ink(0.62), reveal: "growDown", delay: 200 + i * 120 });
  });
  // 松针:沿枝撒 4 簇车轮状密针
  const fanAnchors: { p: Pt; dir: number }[] = [
    { p: [w * 0.4, h * 0.16], dir: -Math.PI / 2 - 0.2 },
    { p: [w * 0.55, h * 0.4], dir: -Math.PI / 2 + 0.1 },
    { p: [w * 0.7, h * 0.22], dir: -Math.PI / 2 - 0.1 },
    { p: [w * 0.84, h * 0.5], dir: -Math.PI / 2 + 0.3 },
  ];
  fanAnchors.forEach((a, ai) => {
    els.push(...pineTuft(rng, a.p[0], a.p[1], a.dir, 320 + ai * 90));
  });
  return els;
}

// 竹(edge bottom):瘦高墨竹竿(分节带节痕)+ 中上部多节挑小枝,枝端缀个字形利叶簇
export function genBamboo(seed: number, w = 220, h = 190): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const stalks = [
    { x: w * 0.4, lean: -10, hh: h + 8, wid: 3.4, tone: 0.82 },
    { x: w * 0.62, lean: 8, hh: h * 0.72, wid: 2.6, tone: 0.6 },
  ];
  stalks.forEach((st, si) => {
    const nodes = 5;
    for (let k = 0; k < nodes; k++) {
      const t0 = k / nodes;
      const t1 = (k + 1) / nodes - 0.016;
      const seg: Pt[] = [
        [st.x + st.lean * t0, h + 6 - st.hh * t0],
        [st.x + st.lean * t1, h + 6 - st.hh * t1],
      ];
      els.push({ d: brushD(seg, (t) => st.wid * (1 - (t0 + t * (t1 - t0)) * 0.42)), fill: ink(st.tone), reveal: "growUp", delay: si * 130 + k * 24 });
      const nx = st.x + st.lean * t1;
      const ny = h + 6 - st.hh * t1;
      const ww = st.wid * (1 - t1 * 0.42) + 1;
      els.push({
        d: brushD([[nx - ww, ny + 1], [nx + ww, ny - 1]], () => 1),
        fill: ink(Math.min(0.9, st.tone + 0.08)),
        reveal: "growUp",
        delay: si * 130 + k * 24 + 30,
      });
    }
    // 中上部 2~3 个节挑小枝,枝端散开叶簇(有上挑有下垂)
    const branches = 2 + Math.floor(rng() * 2);
    for (let b = 0; b < branches; b++) {
      const ht = 0.5 + b * 0.17 + rng() * 0.06;
      const bx0 = st.x + st.lean * ht;
      const by0 = h + 6 - st.hh * ht;
      const side = b % 2 === 0 ? 1 : -1;
      const tw = 16 + rng() * 14;
      const bAng = side > 0 ? -0.5 - rng() * 0.3 : Math.PI + 0.5 + rng() * 0.3;
      const bx = bx0 + Math.cos(bAng) * tw;
      const by = by0 + Math.sin(bAng) * tw;
      els.push({ d: brushD([[bx0, by0], [bx, by]], (t) => (1 - t) * 0.9 + 0.32), fill: ink(st.tone * 0.85), reveal: "growUp", delay: 190 + si * 110 + b * 50 });
      const leafDir = side > 0 ? (rng() < 0.5 ? -0.6 : 0.5) : Math.PI + (rng() < 0.5 ? 0.6 : -0.5);
      els.push(...bambooLeafCluster(rng, bx, by, leafDir, 0.74 + (1 - si) * 0.16, 250 + si * 110 + b * 60));
    }
  });
  return els;
}

// 荷(edge bottom):水线 + 荷叶(没骨墨团带脉)+ 茎上没骨粉荷
export function genLotus(seed: number, w = 260, h = 172): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  // 水线
  els.push({
    d: brushD([[w * 0.06, h * 0.9], [w * 0.4, h * 0.86], [w * 0.82, h * 0.9]], (t) => Math.sin(Math.PI * t) * 0.8 + 0.5),
    fill: `rgba(70,96,116,0.34)`,
    reveal: "fade",
    delay: 0,
  });
  // 荷叶:翻卷的没骨叶团(带缺口的扁圆)+ 深色叶心 + 放射叶脉 + 边缘略起伏
  const padCx = w * 0.3;
  const padCy = h * 0.5;
  const padR = 48;
  const notch = Math.PI * 0.5; // 缺口朝下(茎入处)
  const ring: Pt[] = [];
  for (let i = 0; i <= 36; i++) {
    const ag = (i / 36) * Math.PI * 2;
    const dn = Math.abs(((ag - notch + Math.PI) % (Math.PI * 2)) - Math.PI);
    const cut = dn < 0.34 ? 0.4 : 1; // 缺口
    const rr = padR * (1 + Math.sin(ag * 6 + rng()) * 0.05) * cut;
    ring.push([padCx + Math.cos(ag) * rr, padCy + Math.sin(ag) * rr * 0.5]);
  }
  els.push({ d: ringToPath(ring), fill: GREEN(0.34), reveal: "bloom", delay: 120 });
  els.push({
    d: `M${(padCx - 5).toFixed(1)} ${padCy.toFixed(1)}a5 2.4 0 1 0 10 0a5 2.4 0 1 0 -10 0Z`,
    fill: GREEN(0.5),
    reveal: "bloom",
    delay: 200,
  });
  for (let i = 0; i < 7; i++) {
    const ag = (i / 7) * Math.PI * 2;
    if (Math.abs(((ag - notch + Math.PI) % (Math.PI * 2)) - Math.PI) < 0.34) continue;
    els.push({
      d: brushD([[padCx, padCy], [padCx + Math.cos(ag) * padR * 0.88, padCy + Math.sin(ag) * padR * 0.46]], (t) => (1 - t) * 0.7 + 0.3),
      fill: GREEN(0.4),
      reveal: "bloom",
      delay: 280 + i * 24,
    });
  }
  // 荷茎(略带小刺感:细而直)
  const stemX = w * 0.66;
  const fy = h * 0.32;
  const fx = stemX - 8;
  els.push({
    d: brushD([[stemX, h], [stemX - 3, h * 0.62], [fx, fy + 6]], (t) => (1 - t) * 1.3 + 0.6),
    fill: ink(0.46),
    reveal: "growUp",
    delay: 80,
  });
  // 没骨粉荷:瓣基汇于茎顶、围成杯形;外 6 瓣(瓣尖外翻)+ 内 4 瓣收拢 + 莲蓬芯
  const baseX = fx;
  const baseY = fy + 6;
  const outerCol = (a: number) => `rgba(204,116,140,${a.toFixed(3)})`;
  const innerCol = (a: number) => `rgba(226,160,178,${a.toFixed(3)})`;
  for (let k = 0; k < 6; k++) {
    const s = k - 2.5;
    const ang = -Math.PI / 2 + s * 0.42;
    els.push({
      d: petalD(baseX, baseY, ang, 26 + rng() * 6, 8, Math.sin(s * 0.5) * 0.32),
      fill: outerCol(0.3 + rng() * 0.12),
      reveal: "bloom",
      delay: 340 + k * 40,
    });
  }
  for (let k = 0; k < 4; k++) {
    const s = k - 1.5;
    const ang = -Math.PI / 2 + s * 0.26;
    els.push({
      d: petalD(baseX, baseY - 2, ang, 18 + rng() * 4, 6, Math.sin(s * 0.5) * 0.2),
      fill: innerCol(0.36 + rng() * 0.12),
      reveal: "bloom",
      delay: 460 + k * 40,
    });
  }
  // 莲蓬芯:黄绿小点
  els.push({ d: circleD(baseX, baseY - 9, 3), fill: `rgba(186,176,96,0.6)`, reveal: "bloom", delay: 560 });
  return els;
}

// 芦苇(edge bottom):几支曲秆 + 叶 + 暖褐穗
export function genReeds(seed: number, w = 280, h = 178): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const stalks = [
    { x: w * 0.25, top: 0.16, head: true },
    { x: w * 0.4, top: 0.24, head: true },
    { x: w * 0.54, top: 0.34, head: true },
    { x: w * 0.14, top: 0.4, head: false },
  ];
  stalks.forEach((st, si) => {
    const topY = h * st.top;
    const lean = (rng() - 0.5) * 14;
    const pts: Pt[] = [[st.x, h + 6], [st.x + lean * 0.5, (h + topY) / 2], [st.x + lean, topY]];
    els.push({ d: brushD(pts, (t) => (1 - t) * 1.5 + 0.45), fill: ink(0.46 + si * 0.06), reveal: "growUp", delay: si * 110 });
    // 叶:中段斜出 1~2 片长尖叶,弧形上挑
    const leaves = rng() < 0.5 ? 2 : 1;
    for (let k = 0; k < leaves; k++) {
      const side = k % 2 === 0 ? 1 : -1;
      els.push({
        d: bladeD(
          st.x + lean * 0.45,
          h * (0.5 + rng() * 0.2),
          -Math.PI / 2 + side * (0.7 + rng() * 0.4),
          48 + rng() * 26,
          3.2,
          side * (0.18 + rng() * 0.16),
        ),
        fill: GREEN(0.42 + rng() * 0.16),
        reveal: "bloom",
        delay: 200 + si * 80 + k * 50,
      });
    }
    // 穗:秆顶蓬松羽穗
    if (st.head) {
      els.push(...reedPlume(rng, st.x + lean, topY, -Math.PI / 2 + lean * 0.02, 260 + si * 80));
    }
  });
  return els;
}

// ===================== 通用零件(供更多花木复用) =====================
type Col = (a: number) => string;
const rgba = (r: number, g: number, b: number, a: number): string => `rgba(${r},${g},${b},${a.toFixed(3)})`;
const PINK: Col = (a) => rgba(216, 130, 152, a);
const DEEPPINK: Col = (a) => rgba(194, 84, 114, a);
const RED: Col = (a) => rgba(188, 56, 52, a);
const PURPLE: Col = (a) => rgba(128, 102, 176, a);
const YELLOW: Col = (a) => rgba(218, 178, 72, a);
const GOLD: Col = (a) => rgba(198, 150, 58, a);
const ORANGE: Col = (a) => rgba(208, 120, 50, a);
const OFFWHITE: Col = (a) => rgba(238, 234, 224, a);
const DKGREEN: Col = (a) => rgba(52, 74, 50, a);

function circleD(cx: number, cy: number, r: number): string {
  const rr = Math.max(0.3, r);
  return `M${(cx - rr).toFixed(1)} ${cy.toFixed(1)}a${rr.toFixed(1)} ${rr.toFixed(1)} 0 1 0 ${(rr * 2).toFixed(1)} 0a${rr.toFixed(1)} ${rr.toFixed(1)} 0 1 0 ${(-rr * 2).toFixed(1)} 0Z`;
}

// 曲折墨枝(顶部排版 growDown / 底部 growUp / 横向 growLeft)
function inkBranch(rng: () => number, x0: number, y0: number, x1: number, y1: number, w0: number, w1: number, tone: number, reveal: InkReveal, delay: number): InkEl {
  const segs = 3;
  const pts: Pt[] = [[x0, y0]];
  for (let k = 1; k < segs; k++) {
    const t = k / segs;
    pts.push([x0 + (x1 - x0) * t + (rng() - 0.5) * 16, y0 + (y1 - y0) * t + (rng() - 0.5) * 12]);
  }
  pts.push([x1, y1]);
  return { d: brushD(pts, (t) => w0 * (1 - t) + w1 * t), fill: ink(tone), reveal, delay };
}

// 放射细瓣花(菊/葵):多层尖瓣 + 花心 + 蕊点
function radialFlower(rng: () => number, cx: number, cy: number, petals: number, len: number, wid: number, col: Col, center: string, delay: number, layers = 2): InkEl[] {
  const els: InkEl[] = [];
  const base = rng() * Math.PI * 2;
  for (let L = 0; L < layers; L++) {
    const ll = len * (1 - L * 0.26);
    const off = ((L * 0.5) / petals) * Math.PI * 2;
    for (let k = 0; k < petals; k++) {
      const ang = base + off + (k / petals) * Math.PI * 2 + (rng() - 0.5) * 0.06;
      els.push({ d: petalD(cx, cy, ang, ll * (0.88 + rng() * 0.24), wid, (rng() - 0.5) * 0.2), fill: col(0.45 + rng() * 0.3), reveal: "bloom", delay: delay + L * 50 + k * 4 });
    }
  }
  els.push({ d: circleD(cx, cy, Math.max(2, len * 0.2)), fill: center, reveal: "bloom", delay: delay + 130 });
  for (let i = 0; i < 7; i++) {
    const a = rng() * Math.PI * 2;
    const rr = rng() * len * 0.18;
    els.push({ d: circleD(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 0.7 + rng() * 0.8), fill: ink(0.65), reveal: "bloom", delay: delay + 150 });
  }
  return els;
}

// 圆瓣分层花(牡丹/茶/桃/海棠):短肥瓣多层叠
function roundFlower(rng: () => number, cx: number, cy: number, size: number, col: Col, delay: number, rings = 3): InkEl[] {
  const els: InkEl[] = [];
  const base = rng() * Math.PI * 2;
  for (let r = rings - 1; r >= 0; r--) {
    const rr = size * (0.34 + r * 0.3);
    const pc = 5 + r * 2;
    for (let k = 0; k < pc; k++) {
      const ang = base + (k / pc) * Math.PI * 2 + r * 0.3;
      const px = cx + Math.cos(ang) * rr * 0.5;
      const py = cy + Math.sin(ang) * rr * 0.5;
      els.push({ d: petalD(px, py, ang, rr * 0.72, rr * 0.5, (rng() - 0.5) * 0.3), fill: col(0.36 + r * 0.12 + rng() * 0.1), reveal: "bloom", delay: delay + (rings - r) * 45 + k * 5 });
    }
  }
  els.push({ d: circleD(cx, cy, size * 0.16), fill: rgba(184, 152, 70, 0.6), reveal: "bloom", delay: delay + 190 });
  return els;
}

// 一束剑叶(兰/萱草/水仙/草):arch 出 n 片
function strapLeaves(rng: () => number, x: number, y: number, n: number, baseAng: number, len: number, wid: number, col: Col, delay: number): InkEl[] {
  const els: InkEl[] = [];
  for (let i = 0; i < n; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    const spreadT = n > 1 ? i / (n - 1) - 0.5 : 0;
    const ang = baseAng + spreadT * 1.15 + (rng() - 0.5) * 0.12;
    const L = len * (0.7 + rng() * 0.5);
    els.push({ d: bladeD(x + (rng() - 0.5) * 12, y, ang, L, wid, side * (0.22 + rng() * 0.34)), fill: col(0.4 + rng() * 0.22), reveal: "bloom", delay: delay + i * 34 });
  }
  return els;
}

// 宽叶 + 主脉(芭蕉/山茶叶)
function broadLeaf(rng: () => number, x: number, y: number, ang: number, len: number, wid: number, col: Col, delay: number, reveal: InkReveal = "bloom"): InkEl[] {
  const mx = x + Math.cos(ang) * len * 0.5 - Math.sin(ang) * len * 0.08;
  const my = y + Math.sin(ang) * len * 0.5 + Math.cos(ang) * len * 0.08;
  const tx = x + Math.cos(ang) * len;
  const ty = y + Math.sin(ang) * len;
  return [
    { d: brushD([[x, y], [mx, my], [tx, ty]], (t) => Math.pow(Math.sin(Math.PI * t), 0.55) * wid + 0.6), fill: col(0.32), reveal, delay },
    { d: brushD([[x, y], [mx, my], [tx, ty]], () => 0.7), fill: col(0.5), reveal, delay: delay + 40 },
  ];
}

// 掌状裂叶(枫/葡萄)
function lobedLeafEl(cx: number, cy: number, size: number, lobes: number, ang0: number, col: Col, delay: number): InkEl {
  const pts: Pt[] = [];
  for (let i = 0; i < lobes; i++) {
    const a = ang0 + (i / lobes) * Math.PI * 2;
    const am = ang0 + ((i + 0.5) / lobes) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * size, cy + Math.sin(a) * size]);
    pts.push([cx + Math.cos(am) * size * 0.4, cy + Math.sin(am) * size * 0.4]);
  }
  let d = `M${pts[0]![0].toFixed(1)} ${pts[0]![1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) d += `L${pts[i]![0].toFixed(1)} ${pts[i]![1].toFixed(1)}`;
  return { d: d + "Z", fill: col(0.42), reveal: "bloom", delay };
}

// 下垂串(紫藤花 / 葡萄珠)
function hangCluster(rng: () => number, x: number, y: number, len: number, col: Col, delay: number, berry: boolean): InkEl[] {
  const els: InkEl[] = [];
  const n = Math.max(4, Math.floor(len / 7));
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const cx = x + (rng() - 0.5) * ((berry ? 9 : 13) * (1 - t) + 4);
    const cy = y + t * len;
    const r = (berry ? 3.2 : 2.8) * (1 - t * 0.4);
    els.push({ d: circleD(cx, cy, r), fill: col(0.4 + rng() * 0.22), reveal: "bloom", delay: delay + i * 12 });
  }
  return els;
}

// 谷穗 / 草穗(稻/红蓼):中脊 + 两侧小粒,下垂
function grainHead(rng: () => number, x: number, y: number, dir: number, len: number, col: Col, delay: number, droop: number): InkEl[] {
  const els: InkEl[] = [];
  const ex = x + Math.cos(dir) * len;
  const ey = y + Math.sin(dir) * len + droop * len;
  const mx = (x + ex) / 2;
  const my = (y + ey) / 2 - len * 0.08;
  els.push({ d: brushD([[x, y], [mx, my], [ex, ey]], (t) => (1 - t) * 0.9 + 0.4), fill: col(0.5), reveal: "bloom", delay });
  const n = Math.max(5, Math.floor(len / 5));
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const px = x + (ex - x) * t + (mx - (x + ex) / 2) * Math.sin(Math.PI * t) * 0.6;
    const py = y + (ey - y) * t + (my - (y + ey) / 2) * Math.sin(Math.PI * t) * 0.6;
    const side = i % 2 === 0 ? 1 : -1;
    els.push({ d: circleD(px + side * 3, py, 1.5 + rng() * 1.1), fill: col(0.45 + rng() * 0.2), reveal: "bloom", delay: delay + i * 7 });
  }
  return els;
}

// ===================== 四季花木生成器(新) =====================

// 春·上:柳——枝自顶垂下,千条细柳丝挂叶
export function genWillow(seed: number, w = 280, h = 190): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const x0 = w * (0.1 + rng() * 0.1);
  els.push(inkBranch(rng, x0, -6, w * 0.84, h * 0.3, 4.5, 1.4, 0.7, "growDown", 0));
  const n = 10;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const bx = x0 + (w * 0.84 - x0) * t;
    const by = -6 + (h * 0.3 + 6) * t;
    for (let s = 0; s < 2; s++) {
      const len = 40 + rng() * 64;
      const sway = (rng() - 0.5) * 18;
      els.push({ d: brushD([[bx, by], [bx + sway * 0.5, by + len * 0.5], [bx + sway, by + len]], (tt) => (1 - tt) * 0.7 + 0.28), fill: GREEN(0.34 + rng() * 0.14), reveal: "growDown", delay: 120 + i * 18 });
      for (let l = 0; l < 3; l++) {
        const lt = 0.3 + l * 0.24;
        els.push({ d: bladeD(bx + sway * lt, by + len * lt, Math.PI / 2 + (rng() - 0.5) * 0.6, 8 + rng() * 5, 1.3, (rng() - 0.5) * 0.3), fill: GREEN(0.4), reveal: "bloom", delay: 200 + i * 18 + l * 6 });
      }
    }
  }
  return els;
}

// 春·上:桃花——枝 + 散开小粉桃 + 嫩叶
export function genPeach(seed: number, w = 280, h = 190): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const x0 = w * (0.08 + rng() * 0.1);
  els.push(inkBranch(rng, x0, -6, w * 0.8, h * 0.42, 4.2, 1.2, 0.7, "growDown", 0));
  const anchors: Pt[] = [[w * 0.3, h * 0.15], [w * 0.5, h * 0.27], [w * 0.66, h * 0.34], [w * 0.76, h * 0.42], [w * 0.46, h * 0.06]];
  anchors.forEach((p, i) => {
    els.push(...roundFlower(rng, p[0] + (rng() - 0.5) * 10, p[1] + (rng() - 0.5) * 10, 11 + rng() * 4, PINK, 280 + i * 50, 2));
  });
  for (let i = 0; i < 4; i++) {
    const t = 0.3 + rng() * 0.5;
    els.push({ d: bladeD(x0 + (w * 0.8 - x0) * t, -6 + h * 0.42 * t, Math.PI / 2 + (rng() - 0.5) * 1, 16 + rng() * 8, 2, (rng() - 0.5) * 0.3), fill: GREEN(0.4), reveal: "bloom", delay: 240 + i * 30 });
  }
  return els;
}

// 春·上:玉兰——疏枝 + 大而直立的白瓣花
export function genMagnolia(seed: number, w = 280, h = 190): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const x0 = w * (0.12 + rng() * 0.12);
  els.push(inkBranch(rng, x0, -6, w * 0.72, h * 0.5, 5, 1.4, 0.72, "growDown", 0));
  const fl: Pt[] = [[w * 0.3, h * 0.16], [w * 0.58, h * 0.34], [w * 0.74, h * 0.5], [w * 0.42, h * 0.06]];
  fl.forEach((p, i) => {
    for (let k = 0; k < 6; k++) {
      const a = -Math.PI / 2 + (k - 2.5) * 0.4;
      els.push({ d: petalD(p[0], p[1] + 6, a, 20 + rng() * 6, 7, (rng() - 0.5) * 0.15), fill: rgba(234, 216, 224, 0.5 + rng() * 0.18), reveal: "bloom", delay: 260 + i * 70 + k * 8 });
    }
    els.push({ d: circleD(p[0], p[1] + 4, 2.2), fill: rgba(150, 110, 80, 0.5), reveal: "bloom", delay: 340 + i * 70 });
  });
  return els;
}

// 春·上:海棠——枝 + 成簇深粉花垂柄 + 花苞
export function genCrabapple(seed: number, w = 280, h = 190): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const x0 = w * (0.1 + rng() * 0.1);
  els.push(inkBranch(rng, x0, -6, w * 0.78, h * 0.4, 4, 1.2, 0.7, "growDown", 0));
  const cl: Pt[] = [[w * 0.34, h * 0.2], [w * 0.54, h * 0.3], [w * 0.7, h * 0.4], [w * 0.46, h * 0.12]];
  cl.forEach((p, i) => {
    for (let f = 0; f < 3; f++) {
      const fx = p[0] + (rng() - 0.5) * 22;
      const fy = p[1] + 8 + rng() * 16;
      els.push({ d: brushD([[p[0], p[1]], [fx, fy]], (t) => (1 - t) * 0.7 + 0.3), fill: GREEN(0.4), reveal: "growDown", delay: 200 + i * 50 });
      els.push(...roundFlower(rng, fx, fy, 9 + rng() * 3, DEEPPINK, 260 + i * 50 + f * 26, 2));
    }
    els.push({ d: circleD(p[0] + (rng() - 0.5) * 20, p[1] + 6, 2.4), fill: RED(0.5), reveal: "bloom", delay: 300 + i * 50 });
  });
  return els;
}

// 春·下:兰——arch 长叶 + 数朵淡紫小兰
export function genOrchid(seed: number, w = 240, h = 190): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const bx = w * 0.5;
  els.push(...strapLeaves(rng, bx, h, 6, -Math.PI / 2, 120, 2.6, GREEN, 0));
  const flowers = 2 + Math.floor(rng() * 2);
  for (let i = 0; i < flowers; i++) {
    const fx = bx + (rng() - 0.5) * 70;
    const fy = h * (0.3 + rng() * 0.3);
    els.push({ d: brushD([[bx, h - 10], [(bx + fx) / 2, (h + fy) / 2], [fx, fy]], (t) => (1 - t) * 1.2 + 0.4), fill: GREEN(0.42), reveal: "growUp", delay: 200 + i * 60 });
    for (let k = 0; k < 5; k++) {
      els.push({ d: petalD(fx, fy, rng() * Math.PI * 2, 11, 3.2, (rng() - 0.5) * 0.3), fill: rgba(168, 138, 188, 0.4 + rng() * 0.16), reveal: "bloom", delay: 280 + i * 60 + k * 8 });
    }
    els.push({ d: circleD(fx, fy, 1.8), fill: rgba(150, 90, 60, 0.6), reveal: "bloom", delay: 360 + i * 60 });
  }
  return els;
}

// 春·下:水仙——剑叶 + 数朵白瓣黄盏小花
export function genNarcissus(seed: number, w = 240, h = 190): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const bx = w * 0.46;
  els.push(...strapLeaves(rng, bx, h, 5, -Math.PI / 2, 100, 3, GREEN, 0));
  const fc = 3 + Math.floor(rng() * 2);
  for (let i = 0; i < fc; i++) {
    const fx = bx + (rng() - 0.5) * 54;
    const fy = h * (0.34 + rng() * 0.18);
    els.push({ d: brushD([[bx, h - 6], [fx, fy]], (t) => (1 - t) * 1.4 + 0.5), fill: GREEN(0.42), reveal: "growUp", delay: 160 + i * 50 });
    for (let k = 0; k < 6; k++) {
      els.push({ d: petalD(fx, fy, (k / 6) * Math.PI * 2, 9, 3.4, (rng() - 0.5) * 0.2), fill: OFFWHITE(0.62), reveal: "bloom", delay: 240 + i * 50 + k * 6 });
    }
    els.push({ d: circleD(fx, fy, 2.6), fill: rgba(226, 176, 60, 0.78), reveal: "bloom", delay: 300 + i * 50 });
  }
  return els;
}

// 夏·上:紫藤——横藤 + 下垂紫花串
export function genWisteria(seed: number, w = 280, h = 200): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  // 主藤:自左上角画布外伸入,缓降向右(根部在外、不悬空)
  const bx0 = -8;
  const by0 = -4;
  const bx1 = w * 0.9;
  const by1 = h * 0.28;
  els.push(inkBranch(rng, bx0, by0, bx1, by1, 3.6, 1.4, 0.62, "growDown", 0));
  const drops = 4 + Math.floor(rng() * 2);
  for (let i = 0; i < drops; i++) {
    const t = 0.22 + i * 0.18;
    const ax = bx0 + (bx1 - bx0) * t + (rng() - 0.5) * 8;
    const ay = by0 + (by1 - by0) * t;
    const len = 46 + rng() * 64;
    els.push({ d: brushD([[ax, ay], [ax + (rng() - 0.5) * 6, ay + len]], (tt) => (1 - tt) * 0.6 + 0.3), fill: GREEN(0.36), reveal: "growDown", delay: 120 + i * 40 });
    els.push(...hangCluster(rng, ax, ay + 6, len, PURPLE, 200 + i * 40, false));
  }
  for (let i = 0; i < 3; i++) {
    const t = 0.3 + i * 0.2;
    els.push(...broadLeaf(rng, bx0 + (bx1 - bx0) * t, by0 + (by1 - by0) * t, 0.2 + (i % 2 ? 0.3 : -0.3), 24, 5, GREEN, 300));
  }
  return els;
}

// 夏·上:石榴——枝叶 + 红花 + 一只果
export function genPomegranate(seed: number, w = 280, h = 190): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const x0 = w * (0.1 + rng() * 0.1);
  els.push(inkBranch(rng, x0, -6, w * 0.78, h * 0.46, 4, 1.2, 0.7, "growDown", 0));
  for (let i = 0; i < 8; i++) {
    const t = 0.2 + rng() * 0.7;
    els.push({ d: bladeD(x0 + (w * 0.78 - x0) * t, -6 + h * 0.46 * t, rng() < 0.5 ? 0.3 : Math.PI - 0.3, 16 + rng() * 8, 2.4, (rng() - 0.5) * 0.3), fill: DKGREEN(0.42), reveal: "bloom", delay: 160 + i * 20 });
  }
  const fl: Pt[] = [[w * 0.4, h * 0.24], [w * 0.6, h * 0.36], [w * 0.72, h * 0.46]];
  fl.forEach((p, i) => {
    for (let k = 0; k < 6; k++) {
      els.push({ d: petalD(p[0], p[1], (k / 6) * Math.PI * 2, 10, 4, (rng() - 0.5) * 0.3), fill: RED(0.5 + rng() * 0.18), reveal: "bloom", delay: 240 + i * 50 + k * 6 });
    }
    els.push({ d: circleD(p[0], p[1], 2), fill: GOLD(0.6), reveal: "bloom", delay: 300 + i * 50 });
  });
  els.push({ d: circleD(w * 0.56, h * 0.3, 11), fill: rgba(196, 76, 58, 0.6), reveal: "bloom", delay: 360 });
  return els;
}

// 夏·下:睡莲——浮叶 + 层叠粉花
export function genWaterlily(seed: number, w = 260, h = 160): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  els.push({ d: brushD([[10, h * 0.7], [w * 0.5, h * 0.66], [w - 10, h * 0.7]], (t) => Math.sin(Math.PI * t) * 0.8 + 0.4), fill: rgba(70, 96, 116, 0.3), reveal: "fade", delay: 0 });
  const pads: Pt[] = [[w * 0.3, h * 0.78], [w * 0.72, h * 0.84]];
  pads.forEach((p, i) => {
    const R = i === 0 ? 40 : 30;
    const ring: Pt[] = [];
    for (let k = 0; k <= 30; k++) {
      const a = (k / 30) * Math.PI * 2;
      const cut = Math.abs(((a - 1.4 + Math.PI) % (Math.PI * 2)) - Math.PI) < 0.4 ? 0.5 : 1;
      ring.push([p[0] + Math.cos(a) * R * cut, p[1] + Math.sin(a) * R * 0.34 * cut]);
    }
    els.push({ d: ringToPath(ring), fill: GREEN(0.32), reveal: "bloom", delay: 80 + i * 60 });
  });
  const fx = w * 0.42;
  const fy = h * 0.58;
  for (let r = 0; r < 2; r++) {
    for (let k = 0; k < 7; k++) {
      const a = -Math.PI / 2 + (k - 3) * 0.42;
      els.push({ d: petalD(fx, fy, a, 20 - r * 7, 5, (rng() - 0.5) * 0.2), fill: (r ? PINK : DEEPPINK)(0.36 + rng() * 0.16), reveal: "bloom", delay: 200 + r * 60 + k * 6 });
    }
  }
  els.push({ d: circleD(fx, fy, 3), fill: GOLD(0.6), reveal: "bloom", delay: 340 });
  return els;
}

// 夏·下:芭蕉——粗茎 + 数片大破宽叶
export function genBanana(seed: number, w = 240, h = 200): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const bx = w * 0.5;
  els.push({ d: brushD([[bx, h + 6], [bx, h * 0.5]], (t) => (1 - t) * 3 + 1.6), fill: GREEN(0.5), reveal: "growUp", delay: 0 });
  const leaves = 3 + Math.floor(rng() * 2);
  for (let i = 0; i < leaves; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    els.push(...broadLeaf(rng, bx, h * 0.55, -Math.PI / 2 + side * (0.4 + i * 0.18), 90 + rng() * 40, 22, GREEN, 100 + i * 70, "growUp"));
  }
  return els;
}

// 夏·下:萱草——剑叶 + 橙色六瓣百合状花
export function genDaylily(seed: number, w = 240, h = 190): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const bx = w * 0.5;
  els.push(...strapLeaves(rng, bx, h, 5, -Math.PI / 2, 110, 3.2, GREEN, 0));
  const fc = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < fc; i++) {
    const fx = bx + (rng() - 0.5) * 50;
    const fy = h * (0.28 + rng() * 0.16);
    els.push({ d: brushD([[bx, h - 6], [fx, fy]], (t) => (1 - t) * 1.4 + 0.6), fill: GREEN(0.44), reveal: "growUp", delay: 160 + i * 60 });
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      els.push({ d: petalD(fx, fy, a, 18 + rng() * 5, 5, (rng() - 0.5) * 0.25), fill: ORANGE(0.42 + rng() * 0.16), reveal: "bloom", delay: 240 + i * 60 + k * 8 });
    }
    els.push({ d: circleD(fx, fy, 2.4), fill: rgba(150, 90, 40, 0.6), reveal: "bloom", delay: 320 + i * 60 });
  }
  return els;
}

// 夏·下:蜀葵——高茎沿杆开花 + 裂叶
export function genHollyhock(seed: number, w = 240, h = 200): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const bx = w * 0.5;
  els.push({ d: brushD([[bx, h + 6], [bx + (rng() - 0.5) * 10, h * 0.5], [bx + (rng() - 0.5) * 16, h * 0.05]], (t) => (1 - t) * 2.4 + 0.8), fill: GREEN(0.5), reveal: "growUp", delay: 0 });
  for (let i = 0; i < 5; i++) {
    const fy = h * (1 - (0.12 + i * 0.16)) * 0.95;
    const side = i % 2 ? 1 : -1;
    els.push(...roundFlower(rng, bx + side * 10, fy, 12 + rng() * 4, i < 2 ? DEEPPINK : PINK, 160 + i * 50, 2));
  }
  for (let i = 0; i < 3; i++) {
    els.push(lobedLeafEl(bx + (i % 2 ? -22 : 22), h * (0.7 - i * 0.18), 14, 5, rng() * Math.PI, GREEN, 120 + i * 40));
  }
  return els;
}

// 秋·上:枫——枝 + 五裂红叶
export function genMaple(seed: number, w = 280, h = 190): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const x0 = w * (0.1 + rng() * 0.1);
  els.push(inkBranch(rng, x0, -6, w * 0.8, h * 0.44, 3.6, 1, 0.66, "growDown", 0));
  const lv: Pt[] = [[w * 0.3, h * 0.16], [w * 0.46, h * 0.26], [w * 0.62, h * 0.36], [w * 0.76, h * 0.44], [w * 0.4, h * 0.08], [w * 0.58, h * 0.2]];
  lv.forEach((p, i) => {
    els.push({ d: brushD([[p[0], p[1] - 10], [p[0], p[1]]], () => 0.7), fill: ink(0.4), reveal: "growDown", delay: 180 + i * 50 });
    els.push(lobedLeafEl(p[0], p[1], 11 + rng() * 4, 5, rng() * Math.PI, i % 2 ? ORANGE : RED, 220 + i * 50));
  });
  return els;
}

// 秋·上:葡萄——藤 + 裂叶 + 下垂紫珠串 + 卷须
export function genGrape(seed: number, w = 280, h = 190): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  // 主藤:自左上角画布外伸入,缓降向右
  const bx0 = -8;
  const by0 = -2;
  const bx1 = w * 0.9;
  const by1 = h * 0.24;
  const at = (t: number): [number, number] => [bx0 + (bx1 - bx0) * t, by0 + (by1 - by0) * t];
  els.push(inkBranch(rng, bx0, by0, bx1, by1, 3, 1.5, 0.6, "growDown", 0));
  for (let i = 0; i < 4; i++) {
    const [lx, ly] = at(0.18 + i * 0.2);
    els.push(lobedLeafEl(lx, ly + (rng() - 0.5) * 8, 16 + rng() * 5, 5, rng() * Math.PI, GREEN, 140 + i * 40));
  }
  for (let i = 0; i < 2; i++) {
    const [cx, cy] = at(0.36 + i * 0.34);
    els.push(...hangCluster(rng, cx, cy + 6, 46 + rng() * 30, PURPLE, 220 + i * 60, true));
  }
  const [tx, ty] = at(0.55);
  els.push({ d: brushD([[tx, ty], [tx + 4, ty + 14], [tx, ty + 22], [tx + 6, ty + 28]], () => 0.6), fill: GREEN(0.4), reveal: "growDown", delay: 300 });
  return els;
}

// 秋·上:桂——枝 + 深绿叶 + 密集小金花
export function genOsmanthus(seed: number, w = 280, h = 190): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const x0 = w * (0.1 + rng() * 0.1);
  els.push(inkBranch(rng, x0, -6, w * 0.8, h * 0.46, 3.4, 1.1, 0.7, "growDown", 0));
  for (let i = 0; i < 10; i++) {
    const t = 0.18 + rng() * 0.7;
    els.push({ d: bladeD(x0 + (w * 0.8 - x0) * t, -6 + h * 0.46 * t, rng() < 0.5 ? 0.4 : Math.PI - 0.4, 20 + rng() * 8, 2.6, (rng() - 0.5) * 0.2), fill: DKGREEN(0.46), reveal: "bloom", delay: 140 + i * 16 });
  }
  for (let i = 0; i < 6; i++) {
    const t = 0.3 + rng() * 0.5;
    const cx = x0 + (w * 0.8 - x0) * t;
    const cy = -6 + h * 0.46 * t;
    for (let k = 0; k < 5; k++) {
      els.push({ d: circleD(cx + (rng() - 0.5) * 12, cy + (rng() - 0.5) * 10, 1.6), fill: rgba(226, 182, 70, 0.7), reveal: "bloom", delay: 240 + i * 30 });
    }
  }
  return els;
}

// 秋·下:菊——茎 + 多层细瓣花 + 裂叶
export function genChrysanthemum(seed: number, w = 240, h = 190): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const bx = w * 0.5;
  els.push({ d: brushD([[bx, h + 6], [bx + (rng() - 0.5) * 10, h * 0.4], [bx + (rng() - 0.5) * 14, h * 0.24]], (t) => (1 - t) * 1.8 + 0.7), fill: GREEN(0.5), reveal: "growUp", delay: 0 });
  els.push(...radialFlower(rng, bx + (rng() - 0.5) * 10, h * 0.24, 16, 26, 3.2, YELLOW, GOLD(0.7), 160, 3));
  for (let i = 0; i < 3; i++) {
    els.push(lobedLeafEl(bx + (i % 2 ? -20 : 20), h * (0.55 - i * 0.16), 12, 5, rng() * Math.PI, GREEN, 120 + i * 40));
  }
  return els;
}

// 秋·下:稻——拱秆 + 下垂金穗 + 长叶
export function genRice(seed: number, w = 240, h = 190): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  for (let i = 0; i < 4; i++) {
    const x = w * (0.28 + i * 0.16) + (rng() - 0.5) * 8;
    const topY = h * (0.3 + rng() * 0.1);
    const lean = (rng() - 0.5) * 20;
    els.push({ d: brushD([[x, h + 6], [x + lean * 0.5, (h + topY) / 2], [x + lean, topY]], (t) => (1 - t) * 1.3 + 0.4), fill: GREEN(0.46), reveal: "growUp", delay: i * 70 });
    els.push(...grainHead(rng, x + lean, topY, -Math.PI / 2 + lean * 0.02, 32, GOLD, 160 + i * 70, 0.7));
    els.push({ d: bladeD(x + lean * 0.4, h * 0.6, -Math.PI / 2 + (i % 2 ? 0.7 : -0.7), 44, 3, i % 2 ? 0.2 : -0.2), fill: GREEN(0.42), reveal: "bloom", delay: 200 + i * 40 });
  }
  return els;
}

// 秋·下:狗尾草——细秆 + 蓬松毛穗 + 草叶
export function genFoxtail(seed: number, w = 240, h = 190): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const n = 3 + Math.floor(rng() * 2);
  for (let i = 0; i < n; i++) {
    const x = w * (0.3 + i * 0.18);
    const topY = h * (0.28 + rng() * 0.12);
    const lean = (rng() - 0.5) * 16;
    els.push({ d: brushD([[x, h + 6], [x + lean, topY]], (t) => (1 - t) * 1.1 + 0.4), fill: GREEN(0.44), reveal: "growUp", delay: i * 70 });
    const sx = x + lean;
    const sl = 22 + rng() * 8;
    for (let k = 0; k < sl; k++) {
      const t = k / sl;
      const py = topY - sl * 0.7 * (1 - t);
      const side = k % 2 ? 1 : -1;
      els.push({ d: brushD([[sx + (rng() - 0.5) * 2, py], [sx + side * (3 + rng() * 3), py + (1 - t) * 4]], () => 0.6), fill: rgba(150, 140, 90, 0.5), reveal: "bloom", delay: 150 + i * 50 + k * 3 });
    }
  }
  for (let i = 0; i < 3; i++) {
    els.push({ d: bladeD(w * (0.3 + i * 0.18), h * 0.7, -Math.PI / 2 + (i % 2 ? 0.8 : -0.8), 40, 3, i % 2 ? 0.2 : -0.2), fill: GREEN(0.42), reveal: "bloom", delay: 220 });
  }
  return els;
}

// 秋·下:红蓼——红秆 + 粉穗 + 窄叶
export function genKnotweed(seed: number, w = 240, h = 190): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  for (let i = 0; i < 3; i++) {
    const x = w * (0.3 + i * 0.18);
    const topY = h * (0.26 + rng() * 0.14);
    const lean = (rng() - 0.5) * 22;
    els.push({ d: brushD([[x, h + 6], [x + lean * 0.5, (h + topY) / 2], [x + lean, topY]], (t) => (1 - t) * 1 + 0.35), fill: rgba(120, 80, 70, 0.5), reveal: "growUp", delay: i * 70 });
    const sx = x + lean;
    for (let k = 0; k < 10; k++) {
      els.push({ d: circleD(sx + (rng() - 0.5) * 4, topY - k * 2.4, 1.8), fill: DEEPPINK(0.5 + rng() * 0.16), reveal: "bloom", delay: 160 + i * 60 + k * 8 });
    }
    els.push({ d: bladeD(x + lean * 0.5, h * 0.6, -Math.PI / 2 + (i % 2 ? 0.8 : -0.8), 34, 2.4, i % 2 ? 0.2 : -0.2), fill: GREEN(0.4), reveal: "bloom", delay: 220 + i * 30 });
  }
  return els;
}

// 冬·上:蜡梅——曲折老干自顶垂下 + 黄色小花
export function genWintersweet(seed: number, w = 270, h = 170): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const x0 = w * (0.32 + rng() * 0.12);
  const trunk: Pt[] = [[x0, -8]];
  let cx = x0;
  let cy = -8;
  const dir = rng() < 0.5 ? 1 : -1;
  for (let k = 0; k < 4; k++) {
    cx += dir * (16 + rng() * 22) * (k % 2 ? -0.6 : 1);
    cy += (h - 20) / 4;
    trunk.push([cx, cy]);
  }
  els.push({ d: brushD(trunk, (t) => (1 - t) * 5.6 + 1.3), fill: ink(0.8), reveal: "growDown", delay: 0 });
  const anchors: Pt[] = [[trunk[trunk.length - 1]![0], trunk[trunk.length - 1]![1]], [trunk[2]![0], trunk[2]![1]], [trunk[3]![0], trunk[3]![1]]];
  anchors.forEach((p, i) => {
    for (let f = 0; f < 2; f++) {
      const fx = p[0] + (rng() - 0.5) * 22;
      const fy = p[1] + (rng() - 0.5) * 18;
      for (let k = 0; k < 6; k++) {
        els.push({ d: petalD(fx, fy, (k / 6) * Math.PI * 2, 7, 2.6, (rng() - 0.5) * 0.3), fill: rgba(224, 186, 70, 0.5 + rng() * 0.18), reveal: "bloom", delay: 300 + i * 60 + f * 30 + k * 5 });
      }
      els.push({ d: circleD(fx, fy, 1.6), fill: rgba(140, 90, 40, 0.7), reveal: "bloom", delay: 360 + i * 60 });
    }
  });
  return els;
}

// 冬·上:迎春——数条拱垂绿枝 + 黄色六瓣小花
export function genJasmine(seed: number, w = 280, h = 190): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const x0 = w * (0.18 + rng() * 0.1);
  for (let i = 0; i < 4; i++) {
    const sx = x0 + i * 8;
    const ex = w * (0.4 + i * 0.16);
    const ey = h * (0.4 + i * 0.08);
    els.push({ d: brushD([[sx, -6], [(sx + ex) / 2 + (rng() - 0.5) * 20, h * 0.3], [ex, ey]], (t) => (1 - t) * 1.6 + 0.4), fill: GREEN(0.5), reveal: "growDown", delay: i * 60 });
    for (let f = 0; f < 3; f++) {
      const t = 0.4 + f * 0.22;
      const fx = sx + (ex - sx) * t;
      const fy = -6 + (ey + 6) * t;
      for (let k = 0; k < 6; k++) {
        els.push({ d: petalD(fx, fy, (k / 6) * Math.PI * 2, 7, 2.6, 0), fill: rgba(230, 186, 60, 0.6), reveal: "bloom", delay: 160 + i * 60 + f * 20 });
      }
      els.push({ d: circleD(fx, fy, 1.4), fill: rgba(180, 120, 40, 0.7), reveal: "bloom", delay: 220 });
    }
  }
  return els;
}

// 冬·下:山茶——墨茎 + 深绿厚叶 + 大红圆花
export function genCamellia(seed: number, w = 240, h = 190): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const bx = w * 0.5;
  els.push({ d: brushD([[bx, h + 6], [bx + (rng() - 0.5) * 10, h * 0.4], [bx + (rng() - 0.5) * 14, h * 0.26]], (t) => (1 - t) * 2.2 + 0.8), fill: ink(0.6), reveal: "growUp", delay: 0 });
  for (let i = 0; i < 6; i++) {
    const t = 0.3 + i * 0.1;
    els.push(...broadLeaf(rng, bx, h * (1 - t), i % 2 ? 0.5 : Math.PI - 0.5, 30, 7, DKGREEN, 100 + i * 30));
  }
  els.push(...roundFlower(rng, bx + (rng() - 0.5) * 10, h * 0.26, 18, RED, 180, 3));
  els.push({ d: circleD(bx, h * 0.26, 3), fill: GOLD(0.7), reveal: "bloom", delay: 340 });
  return els;
}

// 冬·下:南天竹——直茎 + 羽状叶 + 红果串
export function genNandina(seed: number, w = 240, h = 190): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  for (let s = 0; s < 2; s++) {
    const x = w * (0.4 + s * 0.16);
    els.push({ d: brushD([[x, h + 6], [x + (rng() - 0.5) * 8, h * 0.2]], (t) => (1 - t) * 1.8 + 0.6), fill: ink(0.55 + s * 0.08), reveal: "growUp", delay: s * 120 });
    for (let i = 2; i < 7; i++) {
      const py = h + 6 - h * 0.8 * (i / 7);
      for (const side of [1, -1]) {
        els.push({ d: bladeD(x, py, side > 0 ? 0.2 : Math.PI - 0.2, 18, 2.4, side * 0.1), fill: i < 4 ? rgba(150, 70, 60, 0.46) : DKGREEN(0.46), reveal: "bloom", delay: 120 + i * 16 });
      }
    }
    if (s === 0) {
      for (let k = 0; k < 14; k++) {
        els.push({ d: circleD(x + (rng() - 0.5) * 22, h * 0.34 + (rng() - 0.5) * 24, 2.6), fill: RED(0.6 + rng() * 0.16), reveal: "bloom", delay: 240 + k * 10 });
      }
    }
  }
  return els;
}

// 冬·下:枯荷——折秆 + 残破荷叶 + 莲蓬(全墨,萧疏)
export function genWitheredLotus(seed: number, w = 260, h = 180): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const stems: [number, number, number][] = [[w * 0.4, 0.9, 1], [w * 0.6, 0.7, -1]];
  stems.forEach((p, i) => {
    const x = p[0];
    const topY = h * (1 - p[1]);
    const bend = p[2];
    els.push({ d: brushD([[x, h + 6], [x + bend * 10, h * 0.5], [x + bend * 30, topY + 10], [x + bend * 46, topY]], (t) => (1 - t) * 1.4 + 0.5), fill: ink(0.55), reveal: "growUp", delay: i * 120 });
  });
  const px = w * 0.4 + 30;
  const py = h * 0.16;
  const ring: Pt[] = [];
  for (let k = 0; k <= 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    const rr = 30 * (1 + Math.sin(a * 5 + rng()) * 0.18) * (a > Math.PI * 0.9 && a < Math.PI * 1.4 ? 0.4 : 1);
    ring.push([px + Math.cos(a) * rr, py + Math.sin(a) * rr * 0.5 + (Math.sin(a) > 0 ? 6 : 0)]);
  }
  els.push({ d: ringToPath(ring), fill: ink(0.18), reveal: "bloom", delay: 200 });
  const lx = w * 0.6 - 46;
  const ly = h * 0.3;
  els.push({ d: brushD([[lx - 7, ly], [lx, ly - 3], [lx + 7, ly]], (t) => Math.sin(Math.PI * t) * 4 + 1), fill: ink(0.4), reveal: "bloom", delay: 240 });
  for (let k = 0; k < 5; k++) {
    els.push({ d: circleD(lx - 5 + k * 2.5, ly - 2, 1), fill: ink(0.6), reveal: "bloom", delay: 280 });
  }
  return els;
}

// ===================== 注册表:季节 + 排版(上枝/下生) =====================
export type InkSeason = "spring" | "summer" | "autumn" | "winter";
export interface InkPlant {
  id: string;
  name: string;
  season: InkSeason;
  edge: "top" | "bottom";
  vb: string;
  gen: (seed: number) => InkEl[];
  // 根部/着生点(viewBox 比例坐标):摇摆以此为支点、枝由此从画布外伸入。
  // 缺省:top → 顶部偏左 [0.14,0.02];bottom → 底部中心 [0.5,1]
  anchor?: [number, number];
}

export const INK_PLANTS: InkPlant[] = [
  { id: "willow", name: "柳", season: "spring", edge: "top", vb: "0 0 280 190", gen: genWillow },
  { id: "peach", name: "桃花", season: "spring", edge: "top", vb: "0 0 280 190", gen: genPeach },
  { id: "magnolia", name: "玉兰", season: "spring", edge: "top", vb: "0 0 280 190", gen: genMagnolia },
  { id: "crabapple", name: "海棠", season: "spring", edge: "top", vb: "0 0 280 190", gen: genCrabapple },
  { id: "orchid", name: "兰", season: "spring", edge: "bottom", vb: "0 0 240 190", gen: genOrchid },
  { id: "narcissus", name: "水仙", season: "spring", edge: "bottom", vb: "0 0 240 190", gen: genNarcissus },
  { id: "wisteria", name: "紫藤", season: "summer", edge: "top", vb: "0 0 280 200", gen: genWisteria, anchor: [0.03, 0.03] },
  { id: "pomegranate", name: "石榴", season: "summer", edge: "top", vb: "0 0 280 190", gen: genPomegranate },
  { id: "lotus", name: "荷", season: "summer", edge: "bottom", vb: "0 0 260 172", gen: genLotus },
  { id: "waterlily", name: "睡莲", season: "summer", edge: "bottom", vb: "0 0 260 160", gen: genWaterlily },
  { id: "banana", name: "芭蕉", season: "summer", edge: "bottom", vb: "0 0 240 200", gen: genBanana },
  { id: "daylily", name: "萱草", season: "summer", edge: "bottom", vb: "0 0 240 190", gen: genDaylily },
  { id: "hollyhock", name: "蜀葵", season: "summer", edge: "bottom", vb: "0 0 240 200", gen: genHollyhock },
  { id: "maple", name: "枫", season: "autumn", edge: "top", vb: "0 0 280 190", gen: genMaple },
  { id: "grape", name: "葡萄", season: "autumn", edge: "top", vb: "0 0 280 190", gen: genGrape, anchor: [0.03, 0.03] },
  { id: "osmanthus", name: "桂", season: "autumn", edge: "top", vb: "0 0 280 190", gen: genOsmanthus },
  { id: "chrysanthemum", name: "菊", season: "autumn", edge: "bottom", vb: "0 0 240 190", gen: genChrysanthemum },
  { id: "reeds", name: "芦苇", season: "autumn", edge: "bottom", vb: "0 0 280 178", gen: genReeds },
  { id: "rice", name: "稻", season: "autumn", edge: "bottom", vb: "0 0 240 190", gen: genRice },
  { id: "foxtail", name: "狗尾草", season: "autumn", edge: "bottom", vb: "0 0 240 190", gen: genFoxtail },
  { id: "knotweed", name: "红蓼", season: "autumn", edge: "bottom", vb: "0 0 240 190", gen: genKnotweed },
  { id: "plum", name: "梅", season: "winter", edge: "top", vb: "0 0 270 170", gen: genPlum, anchor: [0.34, 0.02] },
  { id: "wintersweet", name: "蜡梅", season: "winter", edge: "top", vb: "0 0 270 170", gen: genWintersweet, anchor: [0.34, 0.02] },
  { id: "jasmine", name: "迎春", season: "winter", edge: "top", vb: "0 0 280 190", gen: genJasmine },
  { id: "pine", name: "松", season: "winter", edge: "top", vb: "0 0 280 190", gen: genPine },
  { id: "bamboo", name: "竹", season: "winter", edge: "bottom", vb: "0 0 220 190", gen: genBamboo },
  { id: "camellia", name: "山茶", season: "winter", edge: "bottom", vb: "0 0 240 190", gen: genCamellia },
  { id: "nandina", name: "南天竹", season: "winter", edge: "bottom", vb: "0 0 240 190", gen: genNandina },
  { id: "witheredlotus", name: "枯荷", season: "winter", edge: "bottom", vb: "0 0 260 180", gen: genWitheredLotus },
];

// ===================== 动物 + 云雾(新) =====================
const BLUE: Col = (a) => rgba(74, 118, 156, a);
const BROWN: Col = (a) => rgba(122, 86, 58, a);
const SLATE: Col = (a) => rgba(70, 78, 86, a);

function fillNeutral(fill: string): boolean {
  const m = fill.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return true;
  const r = +m[1]!;
  const g = +m[2]!;
  return g >= r - 8;
}

// 给植物墨元素附一次性动效:只让"真正的花瓣"(彩色、无弧线的多边形笔触)飘落少量;
// 花心 / 花蕊 / 花苞是 circleD(d 串含弧线 a),一律排除——不让花心掉。
// 整株的摇摆(茎/叶/花一起摆)改由外层 group(.qj-plant-body)承担,这里不再做元素级摇摆。
export function decorateMotion(els: InkEl[]): InkEl[] {
  const petals: number[] = [];
  els.forEach((e, i) => {
    if (e.reveal === "bloom" && !fillNeutral(e.fill) && !/[aA]/.test(e.d)) petals.push(i);
  });
  const fall = new Set<number>();
  if (petals.length) {
    fall.add(petals[petals.length - 1]!);
    if (petals.length > 3) fall.add(petals[Math.floor(petals.length / 2)]!);
  }
  return els.map((e, i) => {
    if (!fall.has(i)) return e;
    const dir = (i % 2 ? 1 : -1) * (10 + ((i * 7) % 16));
    return {
      ...e,
      motion: "fall" as const,
      vars: { "--qj-mx": `${dir}px`, "--qj-mr": `${(i % 2 ? 1 : -1) * (120 + ((i * 13) % 80))}deg` },
    };
  });
}

// 一枚收敛的墨点眼(不画白高光,免卡通)
function eyeEl(cx: number, cy: number, r: number, delay: number): InkEl[] {
  return [{ d: circleD(cx, cy, r * 0.82), fill: ink(0.9), reveal: "bloom", delay }];
}

// 湿墨双层笔触:淡晕(略宽)打底 + 浓芯压上,得墨色浓淡
function washStroke(pts: Pt[], widthFn: (t: number) => number, col: Col, tone: number, reveal: InkReveal, delay: number): InkEl[] {
  return [
    { d: brushD(pts, (t) => widthFn(t) + 1.8), fill: col(tone * 0.4), reveal, delay },
    { d: brushD(pts, widthFn), fill: col(tone), reveal, delay: delay + 20 },
  ];
}

// 湿墨团:两层不规则椭圆(淡外晕 + 浓内核),作躯体/壳/腹
function washBlob(rng: () => number, cx: number, cy: number, rx: number, ry: number, col: Col, tone: number, delay: number): InkEl[] {
  const mk = (sc: number): string => {
    const ring: Pt[] = [];
    for (let k = 0; k <= 26; k++) {
      const a = (k / 26) * Math.PI * 2;
      const rr = 1 + Math.sin(a * 3 + rng() * 3) * 0.08;
      ring.push([cx + Math.cos(a) * rx * sc * rr, cy + Math.sin(a) * ry * sc * rr]);
    }
    return ringToPath(ring);
  };
  return [
    { d: mk(1.16), fill: col(tone * 0.42), reveal: "bloom", delay },
    { d: mk(1), fill: col(tone), reveal: "bloom", delay: delay + 20 },
  ];
}

function triD(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): string {
  return `M${ax.toFixed(1)} ${ay.toFixed(1)}L${bx.toFixed(1)} ${by.toFixed(1)}L${cx.toFixed(1)} ${cy.toFixed(1)}Z`;
}

// ---------- 水族 ----------

// 虾(齐白石意):连贯半透墨身(头浓尾淡)+ 长须扫 + 弹足 + 利尾
export function genShrimp(seed: number, w = 240, h = 160): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const hx = w * 0.64;
  const hy = h * 0.4;
  const body: Pt[] = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    const a = Math.PI * (0.95 + t * 0.5);
    body.push([hx + Math.cos(a) * t * 92, hy + Math.sin(a) * t * 40 + t * t * 30]);
  }
  els.push(...washStroke(body, (t) => (1 - t) * 7 + 1.5, ink, 0.5, "growLeft", 0));
  els.push(...washStroke([[hx, hy - 6], [hx + 22, hy - 2]], (t) => (1 - t) * 3 + 1, ink, 0.72, "growLeft", 30));
  els.push(...eyeEl(hx + 10, hy - 7, 2.4, 60));
  els.push(...eyeEl(hx + 10, hy + 1, 2.4, 60));
  for (let k = 0; k < 3; k++) {
    els.push({ d: brushD([[hx + 18, hy - 2], [hx + 58, hy - 22 + k * 16], [hx + 118, hy + 2 + k * 30]], (t) => (1 - t) * 1.2 + 0.3), fill: ink(0.42 - k * 0.06), reveal: "growLeft", delay: 70 + k * 24 });
  }
  for (let k = 0; k < 5; k++) {
    const t = (k + 1) / 8;
    const a = Math.PI * (0.95 + t * 0.5);
    const px = hx + Math.cos(a) * t * 92;
    const py = hy + Math.sin(a) * t * 40 + t * t * 30;
    els.push({ d: brushD([[px, py], [px - 5, py + 12]], () => 0.6), fill: ink(0.5), reveal: "bloom", delay: 120 + k * 12 });
  }
  const tail = body[8]!;
  for (let k = -1; k <= 1; k++) {
    els.push({ d: bladeD(tail[0], tail[1], Math.PI * 1.18 + k * 0.3, 16, 3, 0), fill: ink(0.5), reveal: "bloom", delay: 170 });
  }
  return els;
}

// 鱼(八大山人意):湿墨纺锤身 + 大墨尾 + 白眼向人
export function genFish(seed: number, w = 240, h = 150): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const cx = w * 0.44;
  const cy = h * 0.5;
  els.push(...washStroke([[cx - 58, cy], [cx - 10, cy - 20], [cx + 34, cy - 4]], (t) => Math.sin(Math.PI * t) * 15 + 2.5, ink, 0.46, "growLeft", 0));
  els.push(...washStroke([[cx - 58, cy], [cx - 10, cy + 16], [cx + 34, cy - 4]], (t) => Math.sin(Math.PI * t) * 11 + 2, ink, 0.6, "growLeft", 30));
  for (const s of [-1, 1]) {
    els.push({ d: brushD([[cx + 30, cy - 4], [cx + 56, cy - 4 + s * 20], [cx + 78, cy - 4 + s * 30]], (t) => (1 - t) * 9 + 1), fill: ink(0.4), reveal: "bloom", delay: 110 });
  }
  els.push({ d: bladeD(cx - 6, cy - 14, -Math.PI / 2 + 0.2, 16, 4, 0.2), fill: ink(0.42), reveal: "bloom", delay: 90 });
  els.push({ d: bladeD(cx - 12, cy + 12, Math.PI / 2 - 0.2, 12, 3, -0.2), fill: ink(0.4), reveal: "bloom", delay: 100 });
  els.push({ d: circleD(cx - 46, cy - 4, 4.2), fill: ink(0.2), reveal: "bloom", delay: 60 });
  els.push(...eyeEl(cx - 44, cy - 6, 2.4, 80));
  return els;
}

// 金鱼:短肥身 + 飘逸双尾
export function genGoldfish(seed: number, w = 220, h = 160): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const cx = w * 0.4;
  const cy = h * 0.5;
  els.push({ d: brushD([[cx - 34, cy], [cx, cy - 20], [cx + 22, cy], [cx, cy + 20], [cx - 34, cy]], (t) => Math.sin(Math.PI * t) * 4 + 2), fill: ORANGE(0.5), reveal: "bloom", delay: 0 });
  els.push({ d: circleD(cx - 30, cy, 16), fill: ORANGE(0.45), reveal: "bloom", delay: 0 });
  for (let k = -1; k <= 1; k++) {
    els.push({ d: brushD([[cx + 16, cy], [cx + 44, cy + k * 22], [cx + 70, cy + k * 40]], (t) => (1 - t) * 7 + 1), fill: ORANGE(0.3), reveal: "bloom", delay: 110 + k * 10 });
  }
  els.push(...eyeEl(cx - 38, cy - 6, 3, 50));
  els.push(...eyeEl(cx - 38, cy + 6, 3, 50));
  return els;
}

// 锦鲤:长身 + 橙黑斑 + 尾
export function genKoi(seed: number, w = 260, h = 140): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const cx = w * 0.46;
  const cy = h * 0.5;
  const body: Pt[] = [[cx - 70, cy], [cx - 20, cy - 14], [cx + 30, cy + 8], [cx + 56, cy]];
  els.push({ d: brushD(body, (t) => Math.sin(Math.PI * t) * 15 + 3), fill: OFFWHITE(0.7), reveal: "growLeft", delay: 0 });
  for (let k = 0; k < 3; k++) {
    els.push({ d: circleD(cx - 50 + k * 34, cy - 6 + (k % 2) * 10, 7 - k), fill: (k % 2 ? ink(0.6) : ORANGE(0.55)), reveal: "bloom", delay: 80 + k * 30 });
  }
  for (let s = -1; s <= 1; s += 2) {
    els.push({ d: brushD([[cx + 56, cy], [cx + 80, cy + s * 18], [cx + 100, cy + s * 30]], (t) => (1 - t) * 8 + 1), fill: OFFWHITE(0.5), reveal: "bloom", delay: 120 });
  }
  els.push(...eyeEl(cx - 60, cy - 2, 2.4, 50));
  return els;
}

// 蟹(齐白石意):墨团蟹壳 + 八足两螯
export function genCrab(seed: number, w = 220, h = 170): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const cx = w * 0.5;
  const cy = h * 0.46;
  els.push(...washBlob(rng, cx, cy, 26, 18, ink, 0.55, 0));
  els.push(...eyeEl(cx - 8, cy - 12, 2, 60));
  els.push(...eyeEl(cx + 8, cy - 12, 2, 60));
  for (let s = -1; s <= 1; s += 2) {
    for (let l = 0; l < 4; l++) {
      const a0 = s > 0 ? 0.2 + l * 0.32 : Math.PI - 0.2 - l * 0.32;
      const ox = cx + Math.cos(a0) * 24;
      const oy = cy + 4 + l * 3;
      els.push({ d: brushD([[ox, oy], [ox + s * (16 + l * 2), oy + 8], [ox + s * (22 + l * 3), oy + 22]], (t) => (1 - t) * 2 + 0.5), fill: ink(0.55), reveal: "bloom", delay: 80 + l * 16 });
    }
    els.push({ d: brushD([[cx + s * 22, cy - 4], [cx + s * 40, cy - 14], [cx + s * 52, cy - 8]], (t) => (1 - t) * 3 + 1.4), fill: ink(0.6), reveal: "bloom", delay: 100 });
    els.push({ d: circleD(cx + s * 54, cy - 8, 5), fill: ink(0.6), reveal: "bloom", delay: 130 });
  }
  return els;
}

// 蝌蚪:数只圆头摆尾
export function genTadpoles(seed: number, w = 220, h = 150): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const n = 4 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const x = w * (0.2 + rng() * 0.6);
    const y = h * (0.2 + rng() * 0.6);
    const a = rng() * Math.PI * 2;
    els.push({ d: circleD(x, y, 5 + rng() * 2), fill: ink(0.6), reveal: "bloom", delay: i * 30 });
    els.push({ d: brushD([[x, y], [x - Math.cos(a) * 14, y - Math.sin(a) * 14 + 4], [x - Math.cos(a) * 24, y - Math.sin(a) * 24]], (t) => (1 - t) * 2.4 + 0.3), fill: ink(0.45), reveal: "growLeft", delay: i * 30 });
  }
  return els;
}

// 蛙:蹲坐墨蛙
export function genFrog(seed: number, w = 200, h = 160): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const cx = w * 0.5;
  const cy = h * 0.56;
  els.push(...washStroke([[cx - 26, cy], [cx, cy - 20], [cx + 26, cy]], (t) => Math.sin(Math.PI * t) * 18 + 3, GREEN, 0.5, "bloom", 0));
  els.push({ d: circleD(cx - 14, cy - 18, 6), fill: GREEN(0.5), reveal: "bloom", delay: 30 });
  els.push({ d: circleD(cx + 14, cy - 18, 6), fill: GREEN(0.5), reveal: "bloom", delay: 30 });
  els.push(...eyeEl(cx - 14, cy - 20, 2.2, 60));
  els.push(...eyeEl(cx + 14, cy - 20, 2.2, 60));
  for (let s = -1; s <= 1; s += 2) {
    els.push({ d: brushD([[cx + s * 18, cy + 6], [cx + s * 34, cy + 2], [cx + s * 40, cy + 18]], (t) => (1 - t) * 3 + 1), fill: GREEN(0.46), reveal: "bloom", delay: 80 });
    els.push({ d: brushD([[cx + s * 10, cy + 14], [cx + s * 26, cy + 22]], (t) => (1 - t) * 2 + 0.8), fill: GREEN(0.44), reveal: "bloom", delay: 90 });
  }
  return els;
}

// 龟:墨甲 + 头足尾
export function genTurtle(seed: number, w = 220, h = 150): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const cx = w * 0.5;
  const cy = h * 0.55;
  els.push(...washBlob(rng, cx, cy, 34, 22, ink, 0.52, 0));
  for (let k = 0; k < 5; k++) {
    els.push({ d: brushD([[cx - 18 + k * 9, cy - 16], [cx - 18 + k * 9, cy + 16]], () => 0.6), fill: ink(0.66), reveal: "bloom", delay: 60 + k * 14 });
  }
  els.push({ d: brushD([[cx - 34, cy - 4], [cx - 50, cy - 8]], (t) => (1 - t) * 3 + 1.4), fill: ink(0.6), reveal: "growLeft", delay: 40 });
  els.push(...eyeEl(cx - 48, cy - 8, 1.6, 90));
  for (const dx of [-22, 22]) for (const dy of [-1, 1]) {
    els.push({ d: brushD([[cx + dx, cy + dy * 16], [cx + dx * 1.3, cy + dy * 26]], (t) => (1 - t) * 3 + 1), fill: ink(0.55), reveal: "bloom", delay: 80 });
  }
  return els;
}

// 鲶:长须墨身
export function genCatfish(seed: number, w = 260, h = 130): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const cx = w * 0.5;
  const cy = h * 0.5;
  els.push({ d: brushD([[cx - 64, cy], [cx, cy - 12], [cx + 50, cy]], (t) => Math.sin(Math.PI * t) * 12 + 2.5), fill: ink(0.42), reveal: "growLeft", delay: 0 });
  els.push({ d: circleD(cx - 60, cy, 12), fill: ink(0.46), reveal: "bloom", delay: 0 });
  for (let s = -1; s <= 1; s += 2) {
    els.push({ d: brushD([[cx - 64, cy + s * 4], [cx - 96, cy + s * 16], [cx - 120, cy + s * 12]], () => 0.6), fill: ink(0.4), reveal: "growLeft", delay: 60 });
  }
  for (let k = -1; k <= 1; k++) {
    els.push({ d: bladeD(cx + 50, cy, k * 0.4, 28, 7, 0), fill: ink(0.36), reveal: "bloom", delay: 110 });
  }
  els.push(...eyeEl(cx - 62, cy - 5, 2, 50));
  return els;
}

// 蜗牛:螺旋壳 + 软身触角
export function genSnail(seed: number, w = 200, h = 150): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const sx = w * 0.56;
  const sy = h * 0.5;
  const spiral: Pt[] = [];
  for (let k = 0; k <= 40; k++) {
    const t = k / 40;
    const a = t * Math.PI * 4;
    const r = 4 + t * 24;
    spiral.push([sx + Math.cos(a) * r, sy + Math.sin(a) * r]);
  }
  els.push({ d: brushD(spiral, (t) => (1 - t) * 3 + 1), fill: ink(0.5), reveal: "growLeft", delay: 0 });
  els.push({ d: brushD([[sx - 24, sy + 18], [sx - 50, sy + 22], [sx - 70, sy + 14]], (t) => Math.sin(Math.PI * t) * 5 + 3), fill: ink(0.42), reveal: "growLeft", delay: 60 });
  for (let k = 0; k < 2; k++) {
    els.push({ d: brushD([[sx - 66, sy + 12], [sx - 74 - k * 6, sy - 2 - k * 8]], () => 0.6), fill: ink(0.45), reveal: "growUp", delay: 90 });
    els.push({ d: circleD(sx - 74 - k * 6, sy - 2 - k * 8, 1.4), fill: ink(0.7), reveal: "bloom", delay: 120 });
  }
  return els;
}

// ---------- 禽鸟 ----------

// 栖枝小鸟通用件:身/头/喙/眼/翅/尾/腿(可着色)
function perchedBird(rng: () => number, x: number, y: number, s: number, body: Col, head: Col, tailLen: number, delay: number): InkEl[] {
  const els: InkEl[] = [];
  els.push(...washBlob(rng, x, y, 16 * s, 11 * s, body, 0.52, delay));
  els.push({ d: bladeD(x - 2 * s, y - 4 * s, 0.5, 20 * s, 7 * s, 0.25), fill: head(0.58), reveal: "bloom", delay: delay + 30 });
  els.push(...washBlob(rng, x - 15 * s, y - 7 * s, 7 * s, 6.5 * s, head, 0.58, delay + 20));
  els.push({ d: brushD([[x - 21 * s, y - 7 * s], [x - 31 * s, y - 5 * s]], (t) => (1 - t) * 1.7 + 0.4), fill: ink(0.72), reveal: "growLeft", delay: delay + 50 });
  els.push(...eyeEl(x - 17 * s, y - 9 * s, 1.8 * s, delay + 60));
  els.push({ d: bladeD(x + 12 * s, y + 2 * s, 0.2, tailLen * s, 5 * s, 0.1), fill: body(0.55), reveal: "bloom", delay: delay + 40 });
  for (const dx of [3, 9]) {
    els.push({ d: brushD([[x + dx * s, y + 9 * s], [x + dx * s + 1, y + 18 * s]], () => 0.8), fill: ink(0.6), reveal: "growUp", delay: delay + 70 });
  }
  return els;
}

// 麻雀
export function genSparrow(seed: number, w = 200, h = 160): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  els.push({ d: brushD([[w * 0.18, h * 0.78], [w * 0.86, h * 0.7]], (t) => (1 - t) * 2 + 0.8), fill: ink(0.5), reveal: "growLeft", delay: 0 });
  els.push(...perchedBird(rng, w * 0.52, h * 0.5, 1.1, BROWN, ink, 16, 60));
  return els;
}

// 翠鸟:蓝头橙腹,栖立
export function genKingfisher(seed: number, w = 200, h = 160): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  els.push({ d: brushD([[w * 0.2, h * 0.82], [w * 0.8, h * 0.78]], (t) => (1 - t) * 2 + 0.8), fill: ink(0.5), reveal: "growLeft", delay: 0 });
  els.push(...perchedBird(rng, w * 0.52, h * 0.48, 1.15, ORANGE, BLUE, 12, 60));
  return els;
}

// 喜鹊:黑白长尾
export function genMagpie(seed: number, w = 230, h = 160): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  els.push({ d: brushD([[w * 0.16, h * 0.8], [w * 0.7, h * 0.74]], (t) => (1 - t) * 2 + 0.8), fill: ink(0.5), reveal: "growLeft", delay: 0 });
  els.push(...perchedBird(rng, w * 0.46, h * 0.46, 1.2, ink, ink, 30, 60));
  els.push({ d: brushD([[w * 0.46, h * 0.5], [w * 0.5, h * 0.46]], () => 4), fill: OFFWHITE(0.7), reveal: "bloom", delay: 120 });
  return els;
}

// 黄鹂:鸣枝小黄鸟
export function genOriole(seed: number, w = 210, h = 160): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  els.push({ d: brushD([[w * 0.18, h * 0.2], [w * 0.86, h * 0.32]], (t) => (1 - t) * 2.6 + 0.8), fill: ink(0.55), reveal: "growLeft", delay: 0 });
  for (let i = 0; i < 4; i++) {
    els.push({ d: bladeD(w * (0.3 + i * 0.16), h * (0.26 + i * 0.03), Math.PI / 2 + 0.3, 14, 2, 0.2), fill: GREEN(0.42), reveal: "bloom", delay: 40 + i * 20 });
  }
  els.push(...perchedBird(rng, w * 0.5, h * 0.5, 1.05, YELLOW, YELLOW, 16, 100));
  return els;
}

// 雏鸡:绒球小鸡
export function genChick(seed: number, w = 200, h = 150): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const n = 2 + Math.floor(rng() * 2);
  for (let i = 0; i < n; i++) {
    const x = w * (0.3 + i * 0.28);
    const y = h * (0.6 + (i % 2) * 0.08);
    els.push({ d: brushD([[x - 14, y], [x, y - 12], [x + 16, y + 2]], (t) => Math.sin(Math.PI * t) * 11 + 2), fill: ink(0.5), reveal: "bloom", delay: i * 60 });
    els.push({ d: circleD(x - 16, y - 8, 8), fill: ink(0.42), reveal: "bloom", delay: i * 60 + 20 });
    els.push({ d: triD(x - 22, y - 9, x - 30, y - 7, x - 22, y - 5), fill: ORANGE(0.7), reveal: "bloom", delay: i * 60 + 40 });
    els.push({ d: circleD(x - 19, y - 10, 1.4), fill: ink(0.85), reveal: "bloom", delay: i * 60 + 50 });
    for (const dx of [-2, 6]) els.push({ d: brushD([[x + dx, y + 9], [x + dx, y + 18]], () => 0.7), fill: ORANGE(0.6), reveal: "growUp", delay: i * 60 + 60 });
  }
  return els;
}

// 燕:飞翔剪尾
export function genSwallow(seed: number, w = 230, h = 150): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const x = w * 0.5;
  const y = h * 0.46;
  els.push({ d: brushD([[x - 8, y], [x + 18, y + 4]], (t) => Math.sin(Math.PI * t) * 5 + 2), fill: ink(0.62), reveal: "bloom", delay: 0 });
  els.push({ d: circleD(x - 12, y - 2, 5), fill: ink(0.6), reveal: "bloom", delay: 20 });
  els.push({ d: brushD([[x - 6, y], [x - 30, y - 24], [x - 50, y - 30]], (t) => (1 - t) * 5 + 1), fill: ink(0.5), reveal: "growLeft", delay: 40 });
  els.push({ d: brushD([[x - 6, y], [x - 26, y - 12], [x - 44, y - 6]], (t) => (1 - t) * 5 + 1), fill: ink(0.42), reveal: "growLeft", delay: 50 });
  els.push({ d: brushD([[x + 16, y + 4], [x + 36, y - 4], [x + 50, y - 14]], (t) => (1 - t) * 3 + 0.6), fill: ink(0.5), reveal: "bloom", delay: 60 });
  els.push({ d: brushD([[x + 16, y + 4], [x + 38, y + 8], [x + 52, y + 4]], (t) => (1 - t) * 3 + 0.6), fill: ink(0.5), reveal: "bloom", delay: 70 });
  return els;
}

// 仙鹤:长颈长腿独立
export function genCrane(seed: number, w = 200, h = 200): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const x = w * 0.5;
  els.push({ d: brushD([[x - 16, h * 0.5], [x + 18, h * 0.46]], (t) => Math.sin(Math.PI * t) * 12 + 3), fill: OFFWHITE(0.7), reveal: "bloom", delay: 0 });
  els.push({ d: brushD([[x - 14, h * 0.5], [x - 18, h * 0.28], [x - 8, h * 0.14]], (t) => (1 - t) * 3 + 1.4), fill: OFFWHITE(0.66), reveal: "growUp", delay: 30 });
  els.push({ d: circleD(x - 8, h * 0.13, 5), fill: OFFWHITE(0.7), reveal: "bloom", delay: 60 });
  els.push({ d: circleD(x - 8, h * 0.115, 2.4), fill: RED(0.6), reveal: "bloom", delay: 70 });
  els.push({ d: triD(x - 12, h * 0.13, x - 26, h * 0.135, x - 12, h * 0.15), fill: ink(0.7), reveal: "bloom", delay: 80 });
  els.push({ d: bladeD(x + 14, h * 0.46, 0.4, 26, 6, 0.2), fill: ink(0.55), reveal: "bloom", delay: 90 });
  for (const dx of [-4, 8]) els.push({ d: brushD([[x + dx, h * 0.56], [x + dx + 4, h * 0.92]], () => 1), fill: ink(0.6), reveal: "growUp", delay: 100 });
  return els;
}

// 白鹭:涉水细长
export function genEgret(seed: number, w = 200, h = 200): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const x = w * 0.5;
  els.push({ d: brushD([[20, h * 0.82], [w - 20, h * 0.8]], (t) => Math.sin(Math.PI * t) * 0.8 + 0.4), fill: rgba(70, 96, 116, 0.3), reveal: "fade", delay: 0 });
  els.push({ d: brushD([[x - 14, h * 0.56], [x + 16, h * 0.52]], (t) => Math.sin(Math.PI * t) * 9 + 2), fill: OFFWHITE(0.7), reveal: "bloom", delay: 30 });
  els.push({ d: brushD([[x - 12, h * 0.56], [x - 20, h * 0.34], [x - 6, h * 0.2]], (t) => (1 - t) * 2.4 + 1), fill: OFFWHITE(0.66), reveal: "growUp", delay: 50 });
  els.push({ d: circleD(x - 6, h * 0.19, 4), fill: OFFWHITE(0.7), reveal: "bloom", delay: 80 });
  els.push({ d: triD(x - 9, h * 0.19, x - 26, h * 0.2, x - 9, h * 0.21), fill: rgba(210, 170, 60, 0.7), reveal: "bloom", delay: 90 });
  for (const dx of [-2, 8]) els.push({ d: brushD([[x + dx, h * 0.62], [x + dx, h * 0.82]], () => 0.8), fill: ink(0.55), reveal: "growUp", delay: 100 });
  return els;
}

// 鸳鸯:水上彩羽
export function genMandarin(seed: number, w = 220, h = 150): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const x = w * 0.5;
  const y = h * 0.56;
  els.push({ d: brushD([[20, h * 0.78], [w - 20, h * 0.76]], (t) => Math.sin(Math.PI * t) * 0.8 + 0.4), fill: rgba(70, 96, 116, 0.3), reveal: "fade", delay: 0 });
  els.push(...washStroke([[x - 26, y], [x + 4, y - 14], [x + 28, y]], (t) => Math.sin(Math.PI * t) * 12 + 3, OFFWHITE, 0.6, "bloom", 30));
  els.push(...washBlob(rng, x - 28, y - 8, 8, 7, BROWN, 0.55, 40));
  els.push({ d: bladeD(x + 6, y - 10, -0.4, 18, 7, 0.2), fill: ORANGE(0.5), reveal: "bloom", delay: 60 });
  els.push({ d: triD(x - 34, y - 8, x - 44, y - 6, x - 34, y - 4), fill: RED(0.6), reveal: "bloom", delay: 70 });
  els.push({ d: circleD(x - 30, y - 10, 1.4), fill: ink(0.85), reveal: "bloom", delay: 80 });
  return els;
}

// 鸭:浮水墨鸭
export function genDuck(seed: number, w = 220, h = 150): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const x = w * 0.5;
  const y = h * 0.56;
  els.push({ d: brushD([[20, h * 0.78], [w - 20, h * 0.76]], (t) => Math.sin(Math.PI * t) * 0.8 + 0.4), fill: rgba(70, 96, 116, 0.3), reveal: "fade", delay: 0 });
  els.push(...washStroke([[x - 28, y], [x + 6, y - 16], [x + 32, y]], (t) => Math.sin(Math.PI * t) * 13 + 3, ink, 0.5, "bloom", 30));
  els.push({ d: brushD([[x - 26, y - 6], [x - 34, y - 24], [x - 24, y - 30]], (t) => (1 - t) * 4 + 2), fill: ink(0.55), reveal: "growUp", delay: 50 });
  els.push({ d: circleD(x - 24, y - 30, 6), fill: ink(0.55), reveal: "bloom", delay: 70 });
  els.push({ d: triD(x - 30, y - 30, x - 42, y - 28, x - 30, y - 26), fill: rgba(210, 170, 60, 0.7), reveal: "bloom", delay: 80 });
  els.push({ d: circleD(x - 26, y - 32, 1.4), fill: ink(0.85), reveal: "bloom", delay: 90 });
  return els;
}

// 鹰:踞石猛禽
export function genEagle(seed: number, w = 220, h = 190): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const x = w * 0.5;
  const y = h * 0.4;
  els.push({ d: brushD([[w * 0.2, h * 0.88], [w * 0.8, h * 0.84]], (t) => Math.sin(Math.PI * t) * 6 + 2), fill: ink(0.3), reveal: "fade", delay: 0 });
  els.push(...washStroke([[x - 6, y], [x + 6, y + 36], [x - 2, y + 60]], (t) => Math.sin(Math.PI * t) * 16 + 4, ink, 0.58, "growUp", 30));
  els.push(...washBlob(rng, x - 8, y - 6, 10, 9, ink, 0.5, 60));
  els.push({ d: triD(x - 16, y - 8, x - 30, y - 2, x - 16, y - 1), fill: rgba(200, 170, 70, 0.8), reveal: "bloom", delay: 80 });
  els.push({ d: circleD(x - 11, y - 9, 1.8), fill: ink(0.9), reveal: "bloom", delay: 90 });
  els.push({ d: bladeD(x + 6, y + 6, Math.PI / 2 + 0.3, 50, 12, 0.2), fill: ink(0.5), reveal: "bloom", delay: 70 });
  for (const dx of [-6, 6]) els.push({ d: brushD([[x + dx, y + 58], [x + dx, y + 72]], () => 1.4), fill: ink(0.62), reveal: "growUp", delay: 110 });
  return els;
}

// ---------- 虫 ----------

// 蝶
export function genButterfly(seed: number, w = 180, h = 160): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const x = w * 0.5;
  const y = h * 0.5;
  els.push({ d: brushD([[x, y - 13], [x, y + 13]], (t) => Math.sin(Math.PI * t) * 2 + 1.2), fill: ink(0.82), reveal: "bloom", delay: 0 });
  for (const s of [-1, 1]) {
    els.push(...washBlob(rng, x + s * 14, y - 7, 13, 11, PURPLE, 0.4, 20));
    els.push(...washBlob(rng, x + s * 11, y + 8, 8, 7, PURPLE, 0.36, 50));
    els.push({ d: circleD(x + s * 16, y - 7, 2.6), fill: ink(0.5), reveal: "bloom", delay: 80 });
    els.push({ d: brushD([[x, y - 12], [x + s * 7, y - 24]], (t) => (1 - t) * 0.8 + 0.3), fill: ink(0.6), reveal: "growUp", delay: 90 });
  }
  return els;
}

// 蜻蜓
export function genDragonfly(seed: number, w = 220, h = 150): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const x = w * 0.5;
  const y = h * 0.5;
  els.push({ d: brushD([[x - 30, y], [x + 36, y - 4]], (t) => Math.sin(Math.PI * t) * 2.4 + 1), fill: BLUE(0.55), reveal: "growLeft", delay: 0 });
  els.push({ d: circleD(x - 34, y, 5), fill: ink(0.6), reveal: "bloom", delay: 20 });
  for (const s of [-1, 1]) {
    els.push({ d: bladeD(x - 6, y - 2, s > 0 ? -0.2 : Math.PI + 0.2, 34, 6, s * 0.1), fill: rgba(180, 200, 210, 0.34), reveal: "bloom", delay: 40 });
    els.push({ d: bladeD(x + 2, y, s > 0 ? 0.2 : Math.PI - 0.2, 28, 5, s * 0.1), fill: rgba(180, 200, 210, 0.3), reveal: "bloom", delay: 50 });
  }
  return els;
}

// 蜂
export function genBee(seed: number, w = 160, h = 150): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const x = w * 0.5;
  const y = h * 0.5;
  els.push({ d: brushD([[x - 10, y], [x + 12, y]], (t) => Math.sin(Math.PI * t) * 7 + 2), fill: rgba(196, 160, 60, 0.6), reveal: "bloom", delay: 0 });
  for (let k = 0; k < 3; k++) els.push({ d: brushD([[x - 4 + k * 6, y - 6], [x - 4 + k * 6, y + 6]], () => 0.8), fill: ink(0.7), reveal: "bloom", delay: 30 });
  els.push({ d: circleD(x - 14, y - 2, 4), fill: ink(0.6), reveal: "bloom", delay: 20 });
  for (const s of [-1, 1]) els.push({ d: circleD(x + 2, y - 8 + (s > 0 ? 0 : 16), 6), fill: rgba(210, 220, 225, 0.4), reveal: "bloom", delay: 40 });
  return els;
}

// 蝉
export function genCicada(seed: number, w = 170, h = 160): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const x = w * 0.5;
  const y = h * 0.46;
  els.push(...washStroke([[x, y - 14], [x, y + 18]], (t) => Math.sin(Math.PI * t) * 7 + 3, ink, 0.55, "growUp", 0));
  els.push(...washBlob(rng, x, y - 14, 7, 6, ink, 0.6, 20));
  for (const s of [-1, 1]) {
    els.push({ d: circleD(x + s * 6, y - 16, 2.2), fill: ink(0.7), reveal: "bloom", delay: 30 });
    els.push({ d: bladeD(x + s * 4, y - 8, s > 0 ? 0.4 : Math.PI - 0.4, 30, 7, s * 0.1), fill: rgba(160, 180, 190, 0.3), reveal: "bloom", delay: 40 });
  }
  return els;
}

// 螳螂
export function genMantis(seed: number, w = 210, h = 160): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const x = w * 0.46;
  const y = h * 0.5;
  els.push({ d: brushD([[x, y], [x + 40, y + 10], [x + 70, y + 26]], (t) => Math.sin(Math.PI * t) * 5 + 2), fill: GREEN(0.55), reveal: "growLeft", delay: 0 });
  els.push({ d: circleD(x - 4, y - 4, 6), fill: GREEN(0.55), reveal: "bloom", delay: 20 });
  els.push({ d: circleD(x - 8, y - 8, 2), fill: ink(0.7), reveal: "bloom", delay: 30 });
  els.push({ d: brushD([[x + 4, y], [x + 20, y - 12], [x + 8, y - 22]], (t) => (1 - t) * 2.4 + 0.8), fill: GREEN(0.5), reveal: "growUp", delay: 40 });
  for (let k = 0; k < 3; k++) {
    els.push({ d: brushD([[x + 20 + k * 16, y + 6 + k * 6], [x + 30 + k * 16, y + 22], [x + 24 + k * 16, y + 36]], (t) => (1 - t) * 1.8 + 0.5), fill: GREEN(0.46), reveal: "bloom", delay: 60 + k * 16 });
  }
  els.push({ d: brushD([[x - 2, y - 6], [x - 18, y - 22]], () => 0.5), fill: GREEN(0.5), reveal: "growUp", delay: 50 });
  return els;
}

// ---------- 云雾(顶层 · 左右漂浮) ----------
const CLOUD: Col = (a) => rgba(250, 251, 253, a);
const CLOUDWARM: Col = (a) => rgba(244, 224, 200, a);
const CLOUDDEEP: Col = (a) => rgba(212, 220, 230, a);
const CLOUDLINE: Col = (a) => rgba(176, 192, 208, a);

// 软边雾团(高斯模糊):湿墨晕开,这才像雾,不是白团
function mistWash(rng: () => number, cx: number, cy: number, rx: number, ry: number, col: string, delay: number): InkEl {
  const ring: Pt[] = [];
  for (let k = 0; k <= 30; k++) {
    const a = (k / 30) * Math.PI * 2;
    const rr = 1 + Math.sin(a * 3 + rng() * 4) * 0.18 + Math.sin(a * 6 + rng()) * 0.07;
    ring.push([cx + Math.cos(a) * rx * rr, cy + Math.sin(a) * ry * rr]);
  }
  return { d: ringToPath(ring), fill: col, reveal: "fade", delay, soft: true };
}

// 流云:多层软雾横向叠错
export function genStreamCloud(seed: number, w = 300, h = 130): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  els.push(mistWash(rng, w * 0.5, h * 0.5, 132, 26, CLOUD(0.4), 0));
  for (let i = 0; i < 4; i++) {
    els.push(mistWash(rng, w * (0.26 + i * 0.16), h * (0.4 + (i % 2) * 0.2), 60 - i * 4, 13, CLOUD(0.5), 40 + i * 30));
  }
  return els;
}

// 团云:软积云(大底 + 数团叠起,模糊成棉絮)
export function genPuffCloud(seed: number, w = 300, h = 150): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  els.push(mistWash(rng, w * 0.5, h * 0.64, 98, 30, CLOUDDEEP(0.4), 0));
  const puffs: Pt[] = [[w * 0.32, h * 0.56], [w * 0.46, h * 0.44], [w * 0.62, h * 0.5], [w * 0.74, h * 0.6], [w * 0.5, h * 0.6]];
  const r = [30, 34, 30, 24, 30];
  puffs.forEach((p, i) => els.push(mistWash(rng, p[0], p[1], r[i]!, r[i]! * 0.7, CLOUD(0.6), 40 + i * 30)));
  return els;
}

// 卷云:勾云细丝(线描卷曲)
export function genWispCloud(seed: number, w = 300, h = 120): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  for (let i = 0; i < 4; i++) {
    const y = h * (0.3 + i * 0.16);
    const x0 = w * (0.12 + rng() * 0.16);
    const len = 120 + rng() * 60;
    const pts: Pt[] = [[x0, y], [x0 + len * 0.35, y - 5 - rng() * 5], [x0 + len * 0.7, y + 2], [x0 + len, y - 3]];
    els.push({ d: brushD(pts, (t) => Math.sin(Math.PI * t) * 1.8 + 0.5), fill: CLOUDLINE(0.55), reveal: "growLeft", delay: i * 50 });
  }
  return els;
}

// 雾带:贴地长软雾
export function genMistBand(seed: number, w = 300, h = 110): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  els.push(mistWash(rng, w * 0.5, h * 0.62, 150, 20, CLOUD(0.4), 0));
  els.push(mistWash(rng, w * 0.4, h * 0.66, 90, 12, CLOUD(0.42), 40));
  els.push(mistWash(rng, w * 0.66, h * 0.56, 72, 10, CLOUD(0.4), 60));
  return els;
}

// 山岚:谷中升起的竖向软雾缕
export function genHaze(seed: number, w = 280, h = 150): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  els.push(mistWash(rng, w * 0.5, h * 0.8, 124, 16, CLOUD(0.34), 0));
  for (let i = 0; i < 4; i++) {
    els.push(mistWash(rng, w * (0.26 + i * 0.16), h * (0.5 - i * 0.02), 22, 42, CLOUD(0.28), 40 + i * 40));
  }
  return els;
}

// 祥云:如意卷头(线描)
export function genRuyiCloud(seed: number, w = 280, h = 140): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  const cy = h * 0.5;
  els.push({ d: brushD([[w * 0.16, cy + 8], [w * 0.5, cy + 14], [w * 0.84, cy + 8]], (t) => Math.sin(Math.PI * t) * 2.2 + 0.8), fill: CLOUDLINE(0.6), reveal: "growLeft", delay: 0 });
  for (let s = -1; s <= 1; s += 2) {
    const sx = w * 0.5 + s * 78;
    const spiral: Pt[] = [];
    for (let k = 0; k <= 26; k++) {
      const t = k / 26;
      const a = Math.PI * 0.5 + t * Math.PI * 2.2 * -s;
      spiral.push([sx + Math.cos(a) * (3 + t * 15), cy + Math.sin(a) * (3 + t * 15) - 4]);
    }
    els.push({ d: brushD(spiral, (t) => (1 - t) * 2.4 + 0.8), fill: CLOUDLINE(0.6), reveal: "fade", delay: 40 });
  }
  for (let i = 0; i < 3; i++) {
    const cx = w * (0.36 + i * 0.14);
    els.push({ d: brushD([[cx, cy + 4], [cx + 8, cy - 6], [cx + 2, cy - 12]], (t) => (1 - t) * 1.6 + 0.6), fill: CLOUDLINE(0.5), reveal: "fade", delay: 80 });
  }
  return els;
}

// 薄霭:极淡大面积软雾
export function genThinHaze(seed: number, w = 300, h = 120): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  els.push(mistWash(rng, w * 0.46, h * 0.48, 140, 30, CLOUD(0.26), 0));
  els.push(mistWash(rng, w * 0.58, h * 0.58, 110, 22, CLOUD(0.22), 50));
  return els;
}

// 暮云:暖调软层云
export function genDuskCloud(seed: number, w = 300, h = 140): InkEl[] {
  const rng = makeRng(seed);
  const els: InkEl[] = [];
  els.push(mistWash(rng, w * 0.5, h * 0.55, 130, 24, CLOUDWARM(0.42), 0));
  for (let i = 0; i < 3; i++) {
    els.push(mistWash(rng, w * (0.34 + i * 0.18), h * (0.4 + i * 0.14), 56, 11, rgba(244, 222, 198, 0.5), 40 + i * 30));
  }
  return els;
}

// ===================== 动物 / 云雾 注册表 =====================
export type InkCategory = "plant" | "aquatic" | "bird" | "insect" | "cloud";
export interface InkSpecimen {
  id: string;
  name: string;
  category: InkCategory;
  vb: string;
  gen: (seed: number) => InkEl[];
  // 整体一次性动效(动物/云雾整体动);植物用元素级 decorateMotion
  svgMotion?: InkMotion;
}

export const INK_ANIMALS: InkSpecimen[] = [
  { id: "shrimp", name: "虾", category: "aquatic", vb: "0 0 240 160", gen: genShrimp, svgMotion: "swim" },
  { id: "fish", name: "鱼", category: "aquatic", vb: "0 0 240 150", gen: genFish, svgMotion: "swim" },
  { id: "goldfish", name: "金鱼", category: "aquatic", vb: "0 0 220 160", gen: genGoldfish, svgMotion: "swim" },
  { id: "koi", name: "锦鲤", category: "aquatic", vb: "0 0 260 140", gen: genKoi, svgMotion: "swim" },
  { id: "crab", name: "蟹", category: "aquatic", vb: "0 0 220 170", gen: genCrab, svgMotion: "swim" },
  { id: "tadpoles", name: "蝌蚪", category: "aquatic", vb: "0 0 220 150", gen: genTadpoles, svgMotion: "swim" },
  { id: "frog", name: "蛙", category: "aquatic", vb: "0 0 200 160", gen: genFrog, svgMotion: "flit" },
  { id: "turtle", name: "龟", category: "aquatic", vb: "0 0 220 150", gen: genTurtle, svgMotion: "swim" },
  { id: "catfish", name: "鲶", category: "aquatic", vb: "0 0 260 130", gen: genCatfish, svgMotion: "swim" },
  { id: "snail", name: "蜗牛", category: "aquatic", vb: "0 0 200 150", gen: genSnail, svgMotion: "sway" },
  { id: "sparrow", name: "麻雀", category: "bird", vb: "0 0 200 160", gen: genSparrow, svgMotion: "flit" },
  { id: "kingfisher", name: "翠鸟", category: "bird", vb: "0 0 200 160", gen: genKingfisher, svgMotion: "flit" },
  { id: "magpie", name: "喜鹊", category: "bird", vb: "0 0 230 160", gen: genMagpie, svgMotion: "flit" },
  { id: "oriole", name: "黄鹂", category: "bird", vb: "0 0 210 160", gen: genOriole, svgMotion: "flit" },
  { id: "chick", name: "雏鸡", category: "bird", vb: "0 0 200 150", gen: genChick, svgMotion: "flit" },
  { id: "swallow", name: "燕", category: "bird", vb: "0 0 230 150", gen: genSwallow, svgMotion: "flit" },
  { id: "crane", name: "仙鹤", category: "bird", vb: "0 0 200 200", gen: genCrane, svgMotion: "sway" },
  { id: "egret", name: "白鹭", category: "bird", vb: "0 0 200 200", gen: genEgret, svgMotion: "sway" },
  { id: "mandarin", name: "鸳鸯", category: "bird", vb: "0 0 220 150", gen: genMandarin, svgMotion: "swim" },
  { id: "duck", name: "鸭", category: "bird", vb: "0 0 220 150", gen: genDuck, svgMotion: "swim" },
  { id: "eagle", name: "鹰", category: "bird", vb: "0 0 220 190", gen: genEagle, svgMotion: "sway" },
  { id: "butterfly", name: "蝶", category: "insect", vb: "0 0 180 160", gen: genButterfly, svgMotion: "flit" },
  { id: "dragonfly", name: "蜻蜓", category: "insect", vb: "0 0 220 150", gen: genDragonfly, svgMotion: "flit" },
  { id: "bee", name: "蜂", category: "insect", vb: "0 0 160 150", gen: genBee, svgMotion: "flit" },
  { id: "cicada", name: "蝉", category: "insect", vb: "0 0 170 160", gen: genCicada, svgMotion: "sway" },
  { id: "mantis", name: "螳螂", category: "insect", vb: "0 0 210 160", gen: genMantis, svgMotion: "sway" },
];

export const INK_CLOUDS: InkSpecimen[] = [
  { id: "streamcloud", name: "流云", category: "cloud", vb: "0 0 300 130", gen: genStreamCloud, svgMotion: "drift" },
  { id: "puffcloud", name: "团云", category: "cloud", vb: "0 0 300 150", gen: genPuffCloud, svgMotion: "drift" },
  { id: "wispcloud", name: "卷云", category: "cloud", vb: "0 0 300 120", gen: genWispCloud, svgMotion: "drift" },
  { id: "mistband", name: "雾带", category: "cloud", vb: "0 0 300 110", gen: genMistBand, svgMotion: "drift" },
  { id: "haze", name: "山岚", category: "cloud", vb: "0 0 280 150", gen: genHaze, svgMotion: "drift" },
  { id: "ruyicloud", name: "祥云", category: "cloud", vb: "0 0 280 140", gen: genRuyiCloud, svgMotion: "drift" },
  { id: "thinhaze", name: "薄霭", category: "cloud", vb: "0 0 300 120", gen: genThinHaze, svgMotion: "drift" },
  { id: "duskcloud", name: "暮云", category: "cloud", vb: "0 0 300 140", gen: genDuskCloud, svgMotion: "drift" },
];

// ===================== 远飞群鸟(自下而上飞入、展翅、飞完消失) =====================
// 每只鸟 = 两笔墨翅(从关节向外上挑),由 CSS 绕关节扇动;整群由 CSS 自下升起再淡出。
export const BIRD_WING_R = brushD([[0, 0], [8, -3.5], [16, -4]], (t) => (1 - t) * 2.2 + 0.5);
export const BIRD_WING_L = brushD([[0, 0], [-8, -3.5], [-16, -4]], (t) => (1 - t) * 2.2 + 0.5);

export interface FlockBird {
  x: number;
  y: number;
  s: number;
  fill: string;
  flapDelay: number;
}

export function buildFlock(seed: number, w = 440, h = 220): FlockBird[] {
  const rng = makeRng(seed);
  const out: FlockBird[] = [];
  const n = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    out.push({
      x: w * (0.12 + rng() * 0.76),
      y: h * (0.32 + rng() * 0.42),
      s: 0.7 + rng() * 0.7,
      fill: ink(0.5 + rng() * 0.22),
      flapDelay: Math.floor(rng() * 320),
    });
  }
  return out;
}
