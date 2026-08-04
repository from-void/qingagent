import { useEffect, useRef } from "react";

/**
 * 青简 Loading：文档区为空时的占位。
 * - reasoning=false（左侧未推理）→ 静止态：只显示一个金色「青」字。
 * - reasoning=true（左侧推理/生成中）→ 推理态：四周含青古诗以青为中心向外辐射，
 *   仅靠不透明度做从中心扩散的波浪，外围圆形遮罩，整轮浮现后换下一首诗；
 *   鼠标移到圆圈上才显示双行署名（标题/作者）。
 *
 * 动效为命令式（rAF + 直接改 style），不触发 React 重渲染；reasoning 切换时重启调度。
 */

interface Poem { title: string; author: string; text: string }

// 含「青」古诗轮换（首选李贺《秋来》——含「青简」正合产品名）
const POEMS: Poem[] = [
  { title: "秋来", author: "李贺", text: "桐风惊心壮士苦衰灯络纬啼寒素谁看青简一编书不遣花虫粉空蠹思牵今夜肠应直雨冷香魂吊书客秋坟鬼唱鲍家诗恨血千年土中碧" },
  { title: "望岳", author: "杜甫", text: "岱宗夫如何齐鲁青未了造化钟神秀阴阳割昏晓荡胸生曾云决眦入归鸟会当凌绝顶一览众山小" },
  { title: "长歌行", author: "汉乐府", text: "青青园中葵朝露待日晞阳春布德泽万物生光辉常恐秋节至焜黄华叶衰百川东到海何时复西归少壮不努力老大徒伤悲" },
  { title: "子衿", author: "诗经", text: "青青子衿悠悠我心纵我不往子宁不嗣音青青子佩悠悠我思纵我不往子宁不来" },
  { title: "送元二使安西", author: "王维", text: "渭城朝雨浥轻尘客舍青青柳色新劝君更尽一杯酒西出阳关无故人" },
  { title: "绝句", author: "杜甫", text: "两个黄鹂鸣翠柳一行白鹭上青天窗含西岭千秋雪门泊东吴万里船" },
  { title: "望天门山", author: "李白", text: "天门中断楚江开碧水东流至此回两岸青山相对出孤帆一片日边来" },
  { title: "过故人庄", author: "孟浩然", text: "故人具鸡黍邀我至田家绿树村边合青山郭外斜开轩面场圃把酒话桑麻待到重阳日还来就菊花" },
  { title: "菩萨蛮·书江西造口壁", author: "辛弃疾", text: "郁孤台下清江水中间多少行人泪西北望长安可怜无数山青山遮不住毕竟东流去江晚正愁余山深闻鹧鸪" },
  { title: "竹枝词", author: "刘禹锡", text: "杨柳青青江水平闻郎江上唱歌声东边日出西边雨道是无晴却有晴" },
];

const P = {
  radius: 5.6, cellSize: 34, fontSize: 24, circleFeather: 1.4,
  spread: 150, fadeIn: 360, hold: 1160, fadeOut: 1020, gap: 140, jitter: 90,
  maxOpacity: 0.41, centerGlow: 20,
  inkColor: "#9a9081", tagColor: "#6b6256", centerColor: "#a8823f",
  font: "var(--font-zh-serif)",
};

function stripCJK(s: string): string[] {
  return [...s].filter((ch) => /[一-鿿]/.test(ch));
}
function buildRadialSeq(poem: Poem): string[] {
  const chars = stripCJK(poem.text);
  let qi = chars.indexOf("青");
  if (qi < 0) qi = 0;
  return chars.slice(qi + 1).concat(chars.slice(0, qi));
}

export function QingLoading({ reasoning }: { reasoning: boolean }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const tagInnerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stage = stageRef.current;
    const tagInner = tagInnerRef.current;
    if (!stage) return;

    const C = P.cellSize, R = P.radius;
    const maxCell = Math.ceil(R + 0.7);
    const size = (2 * maxCell + 1) * C;
    const cx = size / 2, cy = size / 2;
    stage.style.width = size + "px";
    stage.style.height = size + "px";
    const edge = R * C;
    const solid = Math.max(0, R - P.circleFeather) * C;
    const mask = `radial-gradient(circle ${edge}px at center, #000 ${solid}px, transparent ${edge}px)`;
    stage.style.webkitMaskImage = mask;
    stage.style.maskImage = mask;
    stage.style.clipPath = `circle(${edge}px at center)`;

    // 署名收到圆正下方（抵消方形盒半宽到圆边的空白），留 ~14px 间距
    const tagEl = stage.parentElement?.querySelector<HTMLElement>(".qing-tag");
    if (tagEl) tagEl.style.marginTop = (-((maxCell + 0.5 - R) * C) + 14) + "px";

    // 生成圆内（含羽化带）的格子，按到中心距离排序（一环环向外）
    const list: Array<{ dx: number; dy: number; d: number; ang: number }> = [];
    for (let dy = -maxCell; dy <= maxCell; dy++) {
      for (let dx = -maxCell; dx <= maxCell; dx++) {
        if (dx === 0 && dy === 0) continue;
        if (Math.hypot(dx, dy) > R + 0.7) continue;
        list.push({ dx, dy, d: Math.hypot(dx, dy), ang: Math.atan2(dy, dx) });
      }
    }
    list.sort((a, b) => a.d - b.d || a.ang - b.ang);
    const maxD = R;

    let seed = 1;
    const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const cells: Array<{ el: HTMLDivElement; d: number; rnd: number }> = [];
    stage.replaceChildren();
    for (const c of list) {
      const el = document.createElement("div");
      el.className = "qing-ch";
      el.style.width = C + "px"; el.style.height = C + "px";
      el.style.left = (cx + c.dx * C - C / 2) + "px";
      el.style.top = (cy + c.dy * C - C / 2) + "px";
      el.style.color = P.inkColor; el.style.fontSize = P.fontSize + "px"; el.style.fontFamily = P.font;
      el.style.opacity = "0";
      stage.appendChild(el);
      cells.push({ el, d: c.d, rnd: rand() });
    }
    const centerEl = document.createElement("div");
    centerEl.className = "qing-center";
    centerEl.textContent = "青";
    centerEl.style.width = C + "px"; centerEl.style.height = C + "px";
    centerEl.style.left = (cx - C / 2) + "px"; centerEl.style.top = (cy - C / 2) + "px";
    // 青字颜色由 CSS 控制（静止态浅金、hover 纸面变深金；推理态深金）——不写 inline，避免覆盖 :hover。
    centerEl.style.fontSize = P.fontSize + "px"; centerEl.style.fontFamily = P.font;
    stage.appendChild(centerEl);

    let poemIdx = 0;
    let lastTagged = -1;
    let cycleStart = performance.now();
    let lastSwitch = performance.now();

    const assignChars = () => {
      const seq = buildRadialSeq(POEMS[poemIdx]!);
      cells.forEach((c, i) => { c.el.textContent = seq.length ? seq[i % seq.length]! : ""; });
      if (!tagInner) return;
      const p = POEMS[poemIdx]!;
      const html = `<div class="qt-title">《${p.title}》</div><div class="qt-author">${p.author}</div>`;
      if (poemIdx !== lastTagged) {
        tagInner.style.transition = "none";
        tagInner.style.opacity = "0";
        tagInner.style.transform = "translateY(6px)";
        tagInner.innerHTML = html;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          tagInner.style.transition = "opacity .45s ease, transform .45s ease";
          tagInner.style.opacity = "1";
          tagInner.style.transform = "translateY(0)";
        }));
        lastTagged = poemIdx;
      } else {
        tagInner.innerHTML = html;
      }
    };

    const envelope = (local: number): number => {
      if (local < 0) return 0;
      if (local < P.fadeIn) return local / P.fadeIn;
      if (local < P.fadeIn + P.hold) return 1;
      if (local < P.fadeIn + P.hold + P.fadeOut) return 1 - (local - P.fadeIn - P.hold) / P.fadeOut;
      return 0;
    };
    const cycleLen = () => maxD * P.spread + P.fadeIn + P.hold + P.fadeOut + P.gap;

    assignChars();
    let raf = 0;
    const frame = (now: number) => {
      if (reasoning) {
        const phase = now - cycleStart;
        for (const c of cells) {
          const e = envelope(phase - (c.d * P.spread + c.rnd * P.jitter));
          c.el.style.opacity = e <= 0 ? "0" : (e * P.maxOpacity).toFixed(3);
        }
        const flash = Math.max(0, 1 - (now - lastSwitch) / 500);
        centerEl.style.filter = `drop-shadow(0 0 ${(P.centerGlow * (1 + flash)).toFixed(1)}px ${hexA(P.centerColor, 0.55 + 0.4 * flash)})`;
        if (phase > cycleLen()) {
          poemIdx = (poemIdx + 1) % POEMS.length;
          assignChars();
          cycleStart = now; lastSwitch = now;
        }
      } else {
        // 静止态：只剩青字；辉光由 CSS 控制（含 hover 加深），清掉推理态遗留的 inline filter。
        for (const c of cells) { if (c.el.style.opacity !== "0") c.el.style.opacity = "0"; }
        if (centerEl.style.filter) centerEl.style.filter = "";
        return;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [reasoning]);

  return (
    <div className={"doc-empty qing-empty" + (reasoning ? "" : " is-static")} data-wf="QingLoading">
      <div className="qing-col">
        <div className="qing-stage" ref={stageRef} />
        <div className="qing-tag"><div className="qing-tag-inner" ref={tagInnerRef} /></div>
      </div>
    </div>
  );
}

function hexA(hex: string, a: number): string {
  const m = hex.replace("#", "");
  const r = parseInt(m.substring(0, 2), 16), g = parseInt(m.substring(2, 4), 16), b = parseInt(m.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
