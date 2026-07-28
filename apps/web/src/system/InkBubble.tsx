import { useEffect, useRef } from "react";
import * as THREE from "three";
import "./ink-bubble.css";

/* ---------- shader source ---------- */

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;

/**
 * Fragment shader: horizontal brush-stroke sweep with organic edges.
 *
 * Approach:
 * 1. Define a rounded-rect SDF that covers the content area (with padding).
 * 2. Aggressive multi-layer noise displacement on edges (ink bleed look).
 * 3. Animate a left-to-right wipe mask with a noisy leading edge.
 * 4. Add small splatter dots near edges for hand-painted feel.
 */
const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  varying vec2 vUv;
  uniform float uTime;
  uniform float uProgress;   // 0..1 animation progress
  uniform float uAspect;     // canvas width / height
  uniform vec3  uColor;      // ink color
  uniform float uPadFracH;   // SDF horizontal pad fraction
  uniform float uPadFracV;   // SDF vertical pad fraction
  uniform float uNoiseAmp;   // edge noise amplitude multiplier
  uniform float uBorderRadius; // corner radius

  /* ---- noise ---- */
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float hash1(float n) {
    return fract(sin(n) * 43758.5453123);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  // 4-octave FBM for richer noise.
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    vec2 shift = vec2(100.0);
    for (int i = 0; i < 4; i++) {
      v += a * vnoise(p);
      p = p * 2.0 + shift;
      a *= 0.5;
    }
    return v;
  }

  // Second noise layer at different frequency for variety
  float fbm2(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    vec2 shift = vec2(73.0, -41.0);
    for (int i = 0; i < 3; i++) {
      v += a * vnoise(p);
      p = p * 2.5 + shift;
      a *= 0.55;
    }
    return v;
  }

  /* ---- rounded rect SDF ---- */
  float sdRoundedRect(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  }

  /* ---- splatter dot SDF ---- */
  float splatDot(vec2 uv, vec2 pos, float r) {
    float d = length(uv - pos) - r;
    float n = fbm(uv * 25.0 + pos * 9.0) * r * 0.5;
    return d - n;
  }

  void main() {
    // Map UV to aspect-corrected centered coords
    vec2 centered = (vUv - 0.5) * vec2(uAspect, 1.0);

    // The content area occupies the center, with asymmetric padding:
    // ~20px horizontal, ~4px vertical. The canvas is (content+40px) wide
    // and (content+8px) tall. padFrac approximates the UV-space margin.
    float padFracH = uPadFracH;
    float padFracV = uPadFracV;
    vec2 halfExtent = vec2(
      uAspect * (0.5 - padFracH),
      0.5 - padFracV
    );
    float cornerRadius = uBorderRadius;

    float baseDist = sdRoundedRect(centered, halfExtent, cornerRadius);

    // --- Aggressive organic edge displacement ---
    // Multi-layer noise displacement for ink-bleeding-into-paper look.
    vec2 normPos = centered / halfExtent;
    float absX = abs(normPos.x);
    float absY = abs(normPos.y);
    float lateralness = smoothstep(0.0, 1.0, absX / (absX + absY + 0.001));

    // Primary noise layer — high amplitude wobble
    float edgeNoiseH1 = fbm(vec2(centered.y * 8.0, 13.7));
    float edgeNoiseV1 = fbm(vec2(centered.x * 8.0, 27.3));

    // Secondary noise layer at different frequency for variety
    float edgeNoiseH2 = fbm2(vec2(centered.y * 18.0 + 5.0, 41.2));
    float edgeNoiseV2 = fbm2(vec2(centered.x * 18.0 + 5.0, 53.8));

    // Right edge gets extra displacement (trailing brush edge = more ragged)
    float rightBias = smoothstep(0.3, 1.0, normPos.x) * 1.5 + 1.0;

    // Displacement magnitudes — scaled by uNoiseAmp (default ~0.07 gives original look)
    float nAmp = uNoiseAmp / 0.07; // normalize so 0.07 = original multiplier
    float lrDisp = ((edgeNoiseH1 - 0.5) * 0.07 + (edgeNoiseH2 - 0.5) * 0.035) * lateralness * rightBias * nAmp;
    float tbDisp = ((edgeNoiseV1 - 0.5) * 0.04 + (edgeNoiseV2 - 0.5) * 0.02) * (1.0 - lateralness) * nAmp;
    float displacement = abs(lrDisp) + abs(tbDisp);

    // Add extra ragged displacement using angle-based noise.
    float angle = atan(centered.y, centered.x);
    float angularNoise = fbm(vec2(angle * 3.0, 7.77)) * 0.025;
    displacement += angularNoise;

    // Expand outward (subtract from SDF)
    float field = baseDist - displacement;

    // --- Ink alpha from field ---
    // Narrow transition band for sharp-ish but slightly bleedy edges
    float inkAlpha = 1.0 - smoothstep(-0.006, 0.003, field);

    // Edge transparency variation (uneven ink bleed)
    float edgeNoise = fbm(centered * 25.0 + 42.0);
    float edgeBand = smoothstep(-0.01, 0.003, field) * smoothstep(0.01, -0.003, field);
    inkAlpha -= edgeBand * edgeNoise * 0.25;

    // Density variation within ink (organic texture)
    float densityNoise = fbm(centered * 12.0 + 7.0);
    inkAlpha *= mix(0.94, 1.0, densityNoise);

    // --- Splatter dots near edges ---
    float splatAlpha = 0.0;
    for (int i = 0; i < 5; i++) {
      float fi = float(i);
      // Position dots near the boundary
      float a2 = hash1(fi * 7.3 + 1.0) * 6.2832;
      float dist = 0.5 + hash1(fi * 13.7 + 2.0) * 0.15;
      vec2 pos = vec2(
        cos(a2) * halfExtent.x * dist,
        sin(a2) * halfExtent.y * dist
      );
      float r = 0.004 + hash1(fi * 19.3 + 3.0) * 0.006;
      float d = splatDot(centered, pos, r);
      float dotAlpha = 1.0 - smoothstep(-0.002, 0.001, d);
      splatAlpha = max(splatAlpha, dotAlpha * 0.8);
    }

    inkAlpha = max(inkAlpha, splatAlpha);
    inkAlpha = clamp(inkAlpha, 0.0, 1.0);

    // --- Left-to-right wipe animation ---
    float t = uProgress;
    float sweepMask = 1.0;

    if (t < 0.999) {
      // Sweep front moves from left edge to right edge
      float sweepX = mix(-uAspect * 0.55, uAspect * 0.6, t);
      // Noisy leading edge (organic brush front)
      float frontNoise = fbm(vec2(centered.y * 7.0 + 3.0, uTime * 0.5 + 11.0));
      float frontNoise2 = fbm2(vec2(centered.y * 14.0 - 2.0, uTime * 0.3 + 5.0));
      float sweepEdge = sweepX + (frontNoise - 0.5) * 0.12 + (frontNoise2 - 0.5) * 0.06;
      // Soft transition at the wipe front
      sweepMask = smoothstep(sweepEdge + 0.03, sweepEdge - 0.02, centered.x);
    }

    float finalAlpha = inkAlpha * sweepMask;

    gl_FragColor = vec4(uColor, finalAlpha);
  }
`;

/* ---------- easing ---------- */

/** Brush-stroke easing: fast start, gentle deceleration */
function easeBrushStroke(t: number): number {
  return 1 - Math.pow(1 - t, 4);
}

/* ---------- types ---------- */

export interface InkBubbleProps {
  animate: boolean;
  children: React.ReactNode;
  className?: string;
}

interface InkUniforms {
  uTime: THREE.IUniform<number>;
  uProgress: THREE.IUniform<number>;
  uAspect: THREE.IUniform<number>;
  uColor: THREE.IUniform<THREE.Vector3>;
  uPadFracH: THREE.IUniform<number>;
  uPadFracV: THREE.IUniform<number>;
  uNoiseAmp: THREE.IUniform<number>;
  uBorderRadius: THREE.IUniform<number>;
}

const INK_COLOR: [number, number, number] = [0.122, 0.165, 0.192];
const DURATION = 0.5; // seconds

/* --- Confirmed spatial constants --- */
// Content padding is set in ink-bubble.css: 6px 25px
const PAD_V = 12;            // px — canvas overflow vertical
const PAD_H = 18;            // px — canvas overflow horizontal
const SDF_PAD_V = 0.085;    // shader SDF vertical pad fraction
const SDF_PAD_H = 0.080;    // shader SDF horizontal pad fraction
const NOISE_AMP = 0.150;    // edge noise amplitude
const BORDER_RADIUS = 0.200; // SDF rounded rect corner radius

/**
 * InkBubble — a chat bubble with an ink brush-stroke background that sweeps
 * left to right. Text appears inside after the ink settles.
 */
export function InkBubble({
  animate,
  children,
  className = "",
}: InkBubbleProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const wrap = wrapRef.current;
    const container = canvasContainerRef.current;
    const contentEl = contentRef.current;
    if (!wrap || !container || !contentEl) return;
    wrap.classList.remove("ink-bubble--static-fallback");

    // Canvas dimensions = content + overflow padding on each side
    const contentW = wrap.offsetWidth;
    const contentH = wrap.offsetHeight;
    if (contentW === 0 || contentH === 0) return;

    const canvasW = contentW + PAD_H * 2;
    const canvasH = contentH + PAD_V * 2;
    const aspect = canvasW / canvasH;

    const ignoreResourceError = (action: () => void) => {
      try {
        action();
      } catch {
        // WebGL 降级路径不能因清理异常再次逃逸到根错误边界。
      }
    };

    const showStaticFallback = () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      contentEl.classList.add("ink-bubble__content--visible");
      wrap.classList.remove("ink-bubble--animate");
      wrap.classList.add("ink-bubble--static-fallback");
      container.replaceChildren();
    };

    // Create renderer
    const dpr = Math.min(window.devicePixelRatio, 1.5);
    let renderer: THREE.WebGLRenderer | null = null;
    try {
      renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: false,
        powerPreference: "low-power",
        preserveDrawingBuffer: true,
      });
      renderer.setPixelRatio(dpr);
      renderer.setSize(canvasW, canvasH);
      renderer.setClearColor(0x000000, 0);
      container.appendChild(renderer.domElement);
      rendererRef.current = renderer;
    } catch {
      ignoreResourceError(() => renderer?.dispose());
      ignoreResourceError(() => renderer?.forceContextLoss());
      ignoreResourceError(() => renderer?.domElement.remove());
      if (rendererRef.current === renderer) rendererRef.current = null;
      showStaticFallback();
      return;
    }
    if (!renderer) {
      showStaticFallback();
      return;
    }

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const uniforms: InkUniforms = {
      uTime: { value: 0 },
      uProgress: { value: animate ? 0.0 : 1.0 },
      uAspect: { value: aspect },
      uColor: { value: new THREE.Vector3(...INK_COLOR) },
      uPadFracH: { value: SDF_PAD_H },
      uPadFracV: { value: SDF_PAD_V },
      uNoiseAmp: { value: NOISE_AMP },
      uBorderRadius: { value: BORDER_RADIUS },
    };

    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
      transparent: true,
      depthTest: false,
    });

    const geometry = new THREE.PlaneGeometry(2, 2);
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    let snapshotCanvas: HTMLCanvasElement | null = null;
    let rendererDisposed = false;

    const disposeRenderer = () => {
      if (rendererDisposed) return;
      rendererDisposed = true;
      ignoreResourceError(() => geometry.dispose());
      ignoreResourceError(() => material.dispose());
      ignoreResourceError(() => renderer.dispose());
      ignoreResourceError(() => renderer.forceContextLoss());
      ignoreResourceError(() => renderer.domElement.remove());
      if (rendererRef.current === renderer) {
        rendererRef.current = null;
      }
    };

    const renderFrame = (): boolean => {
      try {
        renderer.render(scene, camera);
        return true;
      } catch {
        snapshotCanvas?.remove();
        snapshotCanvas = null;
        disposeRenderer();
        showStaticFallback();
        return false;
      }
    };

    const settleToSnapshot = () => {
      if (rendererDisposed) return;

      const webglCanvas = renderer.domElement;
      const staticCanvas = document.createElement("canvas");
      staticCanvas.width = webglCanvas.width;
      staticCanvas.height = webglCanvas.height;
      staticCanvas.style.width = webglCanvas.style.width;
      staticCanvas.style.height = webglCanvas.style.height;

      const ctx = staticCanvas.getContext("2d");
      if (!ctx) return;

      ctx.clearRect(0, 0, staticCanvas.width, staticCanvas.height);
      ctx.drawImage(webglCanvas, 0, 0, staticCanvas.width, staticCanvas.height);
      snapshotCanvas = staticCanvas;

      if (webglCanvas.parentNode === container) {
        container.replaceChild(staticCanvas, webglCanvas);
      } else {
        container.appendChild(staticCanvas);
      }

      disposeRenderer();
    };

    // If not animating, render one frame with full progress and done
    if (!animate) {
      if (!renderFrame()) {
        return () => {
          disposeRenderer();
        };
      }
      settleToSnapshot();
      return () => {
        disposeRenderer();
        snapshotCanvas?.remove();
        snapshotCanvas = null;
      };
    }

    // --- Animation loop ---
    const startTime = performance.now();

    const tick = () => {
      const elapsed = (performance.now() - startTime) / 1000;
      const rawProgress = Math.min(elapsed / DURATION, 1);
      const progress = easeBrushStroke(rawProgress);

      uniforms.uTime.value = elapsed;
      uniforms.uProgress.value = progress;

      if (!renderFrame()) return;

      if (rawProgress >= 1) {
        // Animation done — stop rAF, reveal text
        rafRef.current = 0;
        uniforms.uProgress.value = 1.0;
        if (!renderFrame()) return;

        // Reveal text via DOM class (no React re-render)
        contentEl.classList.add("ink-bubble__content--visible");
        settleToSnapshot();
        return;
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      disposeRenderer();
      snapshotCanvas?.remove();
      snapshotCanvas = null;
    };
  }, [animate]);

  return (
    <div
      ref={wrapRef}
      className={`ink-bubble ${animate ? "ink-bubble--animate" : ""} ${className}`.trim()}
    >
      <div ref={canvasContainerRef} className="ink-bubble__canvas" />
      <div
        ref={contentRef}
        className={`ink-bubble__content${!animate ? " ink-bubble__content--visible" : ""}`}
      >
        {children}
      </div>
    </div>
  );
}
