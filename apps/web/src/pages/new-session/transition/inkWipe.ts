// 墨水(水墨渗墨)转场引擎 —— 移植自 cc-b demo 的 v9 WebGL fbm reveal。
// 全屏 quad,片元用 hash/vnoise/fbm 生成不规则渗墨边界,从 uOrigin(点击点)
// 向外渗染:mask=0 透明(露出底下首页宣纸),mask=1 显出「玄青夜空」深色空间。
// 锋面带湿浓墨环 + 极淡朱砂,颜色取自玄青夜空主题,与现有配色协调。

export interface InkWipeHandle {
  ok: boolean;
  /** 播放渗墨。reverse=false 揭开(浅→深);reverse=true 墨退(深→浅)。origin 为 [ux,uy](左上原点 0..1)。 */
  play: (
    origin: [number, number] | null,
    durationMs: number,
    reverse: boolean,
    onProgress?: (eased: number, raw: number) => void,
  ) => Promise<void>;
  hide: () => void;
  dispose: () => void;
}

const VERT = `attribute vec2 aPos; varying vec2 vUv;
  void main(){ vUv=aPos*0.5+0.5; gl_Position=vec4(aPos,0.0,1.0); }`;

const FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform float uProgress;
  uniform vec2  uOrigin;
  uniform vec2  uRes;
  uniform float uTime;
  uniform float uReverse;
  uniform float uMaxDist;
  uniform vec3  uBg0;
  uniform vec3  uBg1;
  uniform vec3  uInk;
  uniform vec3  uCinnabar;

  float hash(vec2 p){ p=fract(p*vec2(123.34,345.45)); p+=dot(p,p+34.345); return fract(p.x*p.y); }
  float vnoise(vec2 p){ vec2 i=floor(p),f=fract(p); vec2 u=f*f*(3.0-2.0*f);
    float a=hash(i+vec2(0.,0.)), b=hash(i+vec2(1.,0.)), c=hash(i+vec2(0.,1.)), d=hash(i+vec2(1.,1.));
    return mix(mix(a,b,u.x),mix(c,d,u.x),u.y); }
  float fbm(vec2 p){ float v=0.0,amp=0.5; mat2 rot=mat2(0.8,-0.6,0.6,0.8);
    for(int i=0;i<6;i++){ v+=amp*vnoise(p); p=rot*p*2.02; amp*=0.5; } return v; }

  void main(){
    float aspect = uRes.x/uRes.y;
    vec2 uv = vUv;
    vec2 p = vec2((uv.x-uOrigin.x)*aspect, uv.y-uOrigin.y);
    float dist = length(p);

    vec2 q = uv*vec2(aspect,1.0);
    float warp  = fbm(q*3.0 + uTime*0.04);
    float warp2 = fbm(q*7.0 - uTime*0.03 + warp*2.0);
    float fibers= fbm(q*22.0 + warp*3.0);

    float field = dist - warp*0.07 - warp2*0.035 - fibers*0.02;
    float thr = uProgress*(uMaxDist*1.06+0.10) - 0.10;
    float edge = 0.05 + 0.035*warp2;

    float mask = smoothstep(thr+edge, thr-edge, field);
    float band = smoothstep(thr+edge,thr,field) * smoothstep(thr-edge,thr,field);
    float wet  = band*4.0;

    float rad = clamp(length((uv-vec2(0.5,0.46))*vec2(aspect,1.0))*0.9, 0.0, 1.0);
    vec3 space = mix(uBg0, uBg1, rad);

    vec3 col = space;
    col = mix(col, uInk, clamp(wet*0.9,0.0,0.82)*mask);
    float redEdge = band*smoothstep(0.5,0.9,fibers);
    col = mix(col, uCinnabar, clamp(redEdge*0.5,0.0,0.38));

    float a = clamp(mask + wet*0.6*(1.0-mask), 0.0, 1.0);
    float seed = smoothstep(0.14,0.0,dist)*smoothstep(0.0,0.12,uProgress)*(1.0-uProgress*0.5)*(1.0-uReverse);
    col = mix(col, uInk, seed*0.6);
    a = max(a, seed*0.8);

    gl_FragColor = vec4(col, a);
  }`;

const COL = {
  bg0: [0x1a / 255, 0x23 / 255, 0x2a / 255], // 玄青(中心)
  bg1: [0x0a / 255, 0x0c / 255, 0x0e / 255], // 更深(边缘)
  ink: [0x0c / 255, 0x10 / 255, 0x14 / 255], // 湿墨:深玄青墨
  cinnabar: [0xcf / 255, 0x5a / 255, 0x4f / 255], // 朱砂
};

function easeInOutCubic(p: number): number {
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}

interface InkWipeProgram {
  aPos: number;
  buf: WebGLBuffer | null;
  fragmentShader: WebGLShader;
  prog: WebGLProgram;
  uniforms: {
    bg0: WebGLUniformLocation | null;
    bg1: WebGLUniformLocation | null;
    cinnabar: WebGLUniformLocation | null;
    ink: WebGLUniformLocation | null;
    maxDist: WebGLUniformLocation | null;
    origin: WebGLUniformLocation | null;
    progress: WebGLUniformLocation | null;
    res: WebGLUniformLocation | null;
    reverse: WebGLUniformLocation | null;
    time: WebGLUniformLocation | null;
  };
  vertexShader: WebGLShader;
}

interface InkWipeAttachment {
  id: number;
  previousDisplay: string;
  targetCanvas: HTMLCanvasElement;
}

let sharedInkWipeEngine: SharedInkWipeEngine | null = null;
let sharedInkWipeUnavailable = false;
let nextInkWipeAttachmentId = 1;

/**
 * 在给定 canvas 上创建墨水渗染引擎。WebGL 不可用时返回 ok=false 的桩,
 * 调用方应退回 CSS 渐显。
 */
export function createInkWipe(canvas: HTMLCanvasElement): InkWipeHandle {
  const engine = getSharedInkWipeEngine();
  if (!engine) {
    return createNoopInkWipe();
  }
  return engine.createHandle(canvas);
}

export function prewarmInkWipe(): boolean {
  return getSharedInkWipeEngine() !== null;
}

function createNoopInkWipe(): InkWipeHandle {
  return { ok: false, play: () => Promise.resolve(), hide: () => {}, dispose: () => {} };
}

function getSharedInkWipeEngine(): SharedInkWipeEngine | null {
  if (sharedInkWipeEngine) {
    return sharedInkWipeEngine;
  }
  if (sharedInkWipeUnavailable || typeof document === "undefined") {
    return null;
  }

  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false });
  if (!gl) {
    sharedInkWipeUnavailable = true;
    return null;
  }

  try {
    sharedInkWipeEngine = new SharedInkWipeEngine(canvas, gl, createInkWipeProgram(gl));
    return sharedInkWipeEngine;
  } catch (error) {
    console.error("[ink-wipe]", error);
    sharedInkWipeUnavailable = true;
    return null;
  }
}

function createInkWipeProgram(gl: WebGLRenderingContext): InkWipeProgram {
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error("[ink-wipe]", gl.getShaderInfoLog(s));
    }
    return s;
  };
  const vertexShader = compile(gl.VERTEX_SHADER, VERT);
  const fragmentShader = compile(gl.FRAGMENT_SHADER, FRAG);
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vertexShader);
  gl.attachShader(prog, fragmentShader);
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  const uniforms = {
    progress: gl.getUniformLocation(prog, "uProgress"),
    origin: gl.getUniformLocation(prog, "uOrigin"),
    res: gl.getUniformLocation(prog, "uRes"),
    time: gl.getUniformLocation(prog, "uTime"),
    reverse: gl.getUniformLocation(prog, "uReverse"),
    maxDist: gl.getUniformLocation(prog, "uMaxDist"),
    bg0: gl.getUniformLocation(prog, "uBg0"),
    bg1: gl.getUniformLocation(prog, "uBg1"),
    ink: gl.getUniformLocation(prog, "uInk"),
    cinnabar: gl.getUniformLocation(prog, "uCinnabar"),
  };
  return { aPos, buf, fragmentShader, prog, uniforms, vertexShader };
}

function readInkWipeDpr(): number {
  return Math.min(window.devicePixelRatio || 1, 2);
}

class SharedInkWipeEngine {
  private activeResolve: (() => void) | null = null;
  private attachment: InkWipeAttachment | null = null;
  private ph = 0;
  private pw = 0;
  private raf = 0;
  private readonly onResize = () => this.resize();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGLRenderingContext,
    private readonly program: InkWipeProgram,
  ) {
    this.canvas.setAttribute("aria-hidden", "true");
    this.gl.enable(this.gl.BLEND);
    this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);
    this.resize();
    window.addEventListener("resize", this.onResize);
  }

  createHandle(targetCanvas: HTMLCanvasElement): InkWipeHandle {
    const id = nextInkWipeAttachmentId;
    nextInkWipeAttachmentId += 1;
    this.attach(id, targetCanvas);
    return {
      ok: true,
      play: (origin, durationMs, reverse, onProgress) =>
        this.play(id, origin, durationMs, reverse, onProgress),
      hide: () => this.hide(id),
      dispose: () => this.detach(id),
    };
  }

  private attach(id: number, targetCanvas: HTMLCanvasElement): void {
    this.detachCurrentAttachment();
    this.attachment = {
      id,
      previousDisplay: targetCanvas.style.display,
      targetCanvas,
    };
    targetCanvas.style.display = "none";
    this.canvas.className = targetCanvas.className;
    targetCanvas.parentNode?.insertBefore(this.canvas, targetCanvas.nextSibling);
    this.resize();
  }

  private play(
    id: number,
    origin: [number, number] | null,
    durationMs: number,
    reverse: boolean,
    onProgress?: (eased: number, raw: number) => void,
  ): Promise<void> {
    return new Promise((resolve) => {
      if (!this.isCurrentAttachment(id)) {
        resolve();
        return;
      }
      this.stopActiveAnimation();
      this.activeResolve = resolve;
      this.resize();
      this.canvas.classList.add("active");
      const ox = origin ? origin[0] : 0.5;
      const oy = origin ? 1.0 - origin[1] : 0.5; // shader y 上为正
      const aspect = this.pw / this.ph;
      let maxDist = 0;
      for (const cx of [0, 1])
        for (const cy of [0, 1]) {
          const dx = (cx - ox) * aspect;
          const dy = cy - oy;
          maxDist = Math.max(maxDist, Math.hypot(dx, dy));
        }
      const t0 = performance.now();
      this.useProgram();
      const U = this.program.uniforms;
      this.gl.uniform2f(U.origin, ox, oy);
      this.gl.uniform2f(U.res, this.pw, this.ph);
      this.gl.uniform1f(U.reverse, reverse ? 1 : 0);
      this.gl.uniform1f(U.maxDist, maxDist);
      this.gl.uniform3fv(U.bg0, COL.bg0);
      this.gl.uniform3fv(U.bg1, COL.bg1);
      this.gl.uniform3fv(U.ink, COL.ink);
      this.gl.uniform3fv(U.cinnabar, COL.cinnabar);
      const frame = (now: number) => {
        this.runFrame(id, now, t0, durationMs, reverse, onProgress, resolve);
      };
      this.raf = requestAnimationFrame(frame);
    });
  }

  private runFrame(
    id: number,
    now: number,
    startTime: number,
    durationMs: number,
    reverse: boolean,
    onProgress: ((eased: number, raw: number) => void) | undefined,
    resolve: () => void,
  ): void {
    this.raf = 0;
    if (!this.isCurrentAttachment(id)) {
      this.activeResolve = null;
      resolve();
      return;
    }
    let p = (now - startTime) / durationMs;
    if (p > 1) p = 1;
    const e = easeInOutCubic(p);
    const prog01 = reverse ? 1 - e : e;
    const U = this.program.uniforms;
    this.gl.uniform1f(U.progress, prog01);
    this.gl.uniform1f(U.time, now * 0.001);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
    onProgress?.(e, p);
    if (p < 1) {
      this.raf = requestAnimationFrame((nextNow) => {
        this.runFrame(id, nextNow, startTime, durationMs, reverse, onProgress, resolve);
      });
    } else {
      this.activeResolve = null;
      resolve();
    }
  }

  private hide(id: number): void {
    if (!this.isCurrentAttachment(id)) {
      return;
    }
    this.hideCurrent();
  }

  private detach(id: number): void {
    if (!this.isCurrentAttachment(id)) {
      return;
    }
    this.detachCurrentAttachment();
  }

  private detachCurrentAttachment(): void {
    const attachment = this.attachment;
    if (!attachment) {
      return;
    }
    this.stopActiveAnimation();
    this.hideCurrent();
    attachment.targetCanvas.style.display = attachment.previousDisplay;
    this.canvas.remove();
    this.attachment = null;
  }

  private hideCurrent(): void {
    this.canvas.classList.remove("active");
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  private isCurrentAttachment(id: number): boolean {
    return this.attachment?.id === id;
  }

  private resize(): void {
    const dpr = readInkWipeDpr();
    this.pw = Math.round(window.innerWidth * dpr);
    this.ph = Math.round(window.innerHeight * dpr);
    this.canvas.width = this.pw;
    this.canvas.height = this.ph;
    this.canvas.style.width = window.innerWidth + "px";
    this.canvas.style.height = window.innerHeight + "px";
    this.gl.viewport(0, 0, this.pw, this.ph);
  }

  private stopActiveAnimation(): void {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    if (this.activeResolve) {
      const resolve = this.activeResolve;
      this.activeResolve = null;
      resolve();
    }
  }

  private useProgram(): void {
    this.gl.useProgram(this.program.prog);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.program.buf);
    this.gl.enableVertexAttribArray(this.program.aPos);
    this.gl.vertexAttribPointer(this.program.aPos, 2, this.gl.FLOAT, false, 0, 0);
  }
}
