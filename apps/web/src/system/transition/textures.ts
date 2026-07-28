// 新建页卡片用的程序化水墨纹理(与首页新建卡同款 V9 颗粒噪点 + fbm 墨色字纹)。
// 整模块只生成一次并缓存,morph 飞行卡与右侧 4 张模板叠卡共用,保证与首页新建卡视觉一致。

let cachedNoise: string | null = null;
let cachedInkTex: string | null = null;

function nkHash(x: number, y: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
}
function nkNoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const a = nkHash(xi, yi);
  const b = nkHash(xi + 1, yi);
  const c = nkHash(xi, yi + 1);
  const d = nkHash(xi + 1, yi + 1);
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}
function nkFbm(x: number, y: number): number {
  let s = 0;
  let amp = 0.5;
  for (let i = 0; i < 4; i++) {
    s += amp * nkNoise(x, y);
    x *= 2;
    y *= 2;
    amp *= 0.5;
  }
  return s;
}

export function buildCardTextures(): { noise: string; inkTex: string } {
  if (cachedNoise && cachedInkTex) {
    return { noise: cachedNoise, inkTex: cachedInkTex };
  }
  // 颗粒噪点
  const s1 = 200;
  const cv1 = document.createElement("canvas");
  cv1.width = cv1.height = s1;
  const c1 = cv1.getContext("2d");
  let noise = "";
  if (c1) {
    const img = c1.createImageData(s1, s1);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (Math.random() * 22) | 0;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = n;
      img.data[i + 3] = (Math.random() * 16) | 0;
    }
    c1.putImageData(img, 0, 0);
    noise = `url(${cv1.toDataURL()})`;
  }
  // 文字水墨底纹(fbm 浓淡 + 飞白)
  const s2 = 180;
  const cv2 = document.createElement("canvas");
  cv2.width = cv2.height = s2;
  const c2 = cv2.getContext("2d");
  let inkTex = "";
  if (c2) {
    const img = c2.createImageData(s2, s2);
    for (let y = 0; y < s2; y++) {
      for (let x = 0; x < s2; x++) {
        const v = nkFbm(x * 0.045 + 2.0, y * 0.045 + 7.0);
        const m = Math.min(1, Math.max(0, v * 1.25));
        const i = (y * s2 + x) * 4;
        img.data[i] = 30 + m * 34;
        img.data[i + 1] = 25 + m * 28;
        img.data[i + 2] = 16 + m * 20;
        img.data[i + 3] = 255 * Math.min(1, Math.max(0.55, 0.72 + (v - 0.5) * 0.9));
      }
    }
    c2.putImageData(img, 0, 0);
    inkTex = `url(${cv2.toDataURL()})`;
  }
  cachedNoise = noise;
  cachedInkTex = inkTex;
  return { noise, inkTex };
}
