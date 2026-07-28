// 墨尘粒子(玄青空间景深)。移植自 cc-b demo。返回 start/stop/dispose 控制器。

export interface DustController {
  start: () => void;
  stop: () => void;
  dispose: () => void;
}

interface Particle {
  x: number;
  y: number;
  z: number;
  r: number;
  vx: number;
  vy: number;
  a: number;
  hue: boolean;
}

export function createDust(canvas: HTMLCanvasElement): DustController {
  const ctx = canvas.getContext("2d");
  let particles: Particle[] = [];
  let raf = 0;

  function init() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    particles = [];
    for (let i = 0; i < 70; i++) {
      particles.push({
        x: Math.random() * window.innerWidth,
        y: Math.random() * window.innerHeight,
        z: Math.random(),
        r: 0.5 + Math.random() * 2.4,
        vx: (Math.random() - 0.5) * 0.18,
        vy: -0.06 - Math.random() * 0.22,
        a: 0.05 + Math.random() * 0.22,
        hue: Math.random() < 0.15,
      });
    }
  }
  function draw() {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of particles) {
      p.x += p.vx * (0.4 + p.z);
      p.y += p.vy * (0.4 + p.z);
      if (p.y < -6) {
        p.y = canvas.height + 6;
        p.x = Math.random() * canvas.width;
      }
      if (p.x < -6) p.x = canvas.width + 6;
      if (p.x > canvas.width + 6) p.x = -6;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * (0.5 + p.z), 0, 6.283);
      ctx.fillStyle = p.hue ? `rgba(207,90,79,${p.a * 0.8})` : `rgba(200,214,208,${p.a})`;
      ctx.fill();
    }
    raf = requestAnimationFrame(draw);
  }
  const onResize = () => {
    if (particles.length) init();
  };
  window.addEventListener("resize", onResize);

  return {
    start() {
      init();
      if (!raf) draw();
    },
    stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    },
    dispose() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      window.removeEventListener("resize", onResize);
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
      canvas.width = 0;
      canvas.height = 0;
      particles = [];
    },
  };
}
