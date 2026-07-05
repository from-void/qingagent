import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { usePerfTier, type PerfTier } from "../../../system/perf/motionTier";
import { createVisibilityPausedRaf, type VisibilitySchedulerHandle } from "../../../system/perf/visibilityScheduler";

type BookSource = {
  id: string;
  title: string;
  description: string;
};

type BookCurlShelfProps = {
  books: readonly BookSource[];
};

type BookMesh = {
  basePositions: Float32Array;
  geometry: THREE.PlaneGeometry;
  height: number;
  mesh: THREE.Mesh;
  width: number;
};

const BOOK_WIDTH = 178.91;
const BOOK_HEIGHT = 238;
const BOOK_CURL_HIGH_SEGMENTS = { width: 64, height: 72 } as const;
const BOOK_CURL_LOW_SEGMENTS = { width: 32, height: 36 } as const;

export type BookCurlParams = {
  activeAmount: number;
  areaX: number;
  areaY: number;
  falloffPowerX: number;
  falloffPowerY: number;
  softness: number;
  shiftX: number;
  shiftY: number;
  liftZ: number;
  ridgeZ: number;
  rollX: number;
  rollY: number;
  cornerPin: number;
  speed: number;
  snap: number;
  ambientLight: number;
  directionalLight: number;
  lightX: number;
  lightY: number;
  lightZ: number;
  canvasPadTop: number;
  canvasPadRight: number;
  canvasPadBottom: number;
  canvasPadLeft: number;
};

export const BOOK_CURL_DEFAULTS: BookCurlParams = {
  activeAmount: 1,
  areaX: 0.42,
  areaY: 0.28,
  falloffPowerX: 2,
  falloffPowerY: 2,
  softness: 1,
  shiftX: 0.026,
  shiftY: 0.004,
  liftZ: 0.055,
  ridgeZ: 0,
  rollX: 0,
  rollY: 0,
  cornerPin: 0,
  speed: 0.14,
  snap: 0.002,
  ambientLight: 1.45,
  directionalLight: 1.15,
  lightX: -160,
  lightY: 180,
  lightZ: 360,
  canvasPadTop: 34,
  canvasPadRight: 42,
  canvasPadBottom: 34,
  canvasPadLeft: 34,
};

type BookCurlWindow = Window & {
  __HOME_BOOK_CURL_PARAMS__?: BookCurlParams;
};

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function rgba(r: number, g: number, b: number, a: number) {
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function drawVerticalText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fontSize: number,
  lineHeight: number,
  color: string,
) {
  context.save();
  context.fillStyle = color;
  context.textAlign = "center";
  context.textBaseline = "top";
  context.font = `400 ${fontSize}px "Noto Serif SC", "Source Han Serif SC", "Songti SC", "STSong", "SimSun", serif`;

  Array.from(text).forEach((char, index) => {
    context.fillText(char, x, y + index * lineHeight);
  });
  context.restore();
}

function createBookTexture(title: string, description: string) {
  const scale = 4;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(BOOK_WIDTH * scale);
  canvas.height = Math.round(BOOK_HEIGHT * scale);
  const context = canvas.getContext("2d");

  if (!context) {
    return new THREE.CanvasTexture(canvas);
  }

  context.scale(scale, scale);
  context.clearRect(0, 0, BOOK_WIDTH, BOOK_HEIGHT);

  context.fillStyle = rgba(248, 250, 247, 0.1);
  context.fillRect(0, 0, BOOK_WIDTH, BOOK_HEIGHT);

  const radial = context.createRadialGradient(
    BOOK_WIDTH * 0.9788,
    BOOK_HEIGHT,
    0,
    BOOK_WIDTH * 0.9788,
    BOOK_HEIGHT,
    BOOK_WIDTH * 1.16,
  );
  radial.addColorStop(0, rgba(134, 134, 134, 0.1));
  radial.addColorStop(1, rgba(217, 217, 217, 0));
  context.fillStyle = radial;
  context.fillRect(0, 0, BOOK_WIDTH, BOOK_HEIGHT);

  const topLine = context.createLinearGradient(0, 0, BOOK_WIDTH, 0);
  topLine.addColorStop(0, rgba(0, 0, 0, 0.18));
  topLine.addColorStop(0.64, rgba(0, 0, 0, 0.09));
  topLine.addColorStop(1, rgba(0, 0, 0, 0));
  context.fillStyle = topLine;
  context.fillRect(0, 0, BOOK_WIDTH - 5, 0.75);

  const leftLine = context.createLinearGradient(0, 0, 0, BOOK_HEIGHT);
  leftLine.addColorStop(0, rgba(0, 0, 0, 0.18));
  leftLine.addColorStop(0.62, rgba(0, 0, 0, 0.09));
  leftLine.addColorStop(1, rgba(0, 0, 0, 0));
  context.fillStyle = leftLine;
  context.fillRect(0, 0, 0.75, BOOK_HEIGHT);

  const bindingX = BOOK_WIDTH - 19.7;
  const bindingLine = context.createLinearGradient(0, 0, 0, BOOK_HEIGHT);
  bindingLine.addColorStop(0, rgba(0, 0, 0, 0.18));
  bindingLine.addColorStop(0.58, rgba(0, 0, 0, 0.09));
  bindingLine.addColorStop(1, rgba(0, 0, 0, 0));
  context.fillStyle = bindingLine;
  context.fillRect(bindingX, 0, 0.75, BOOK_HEIGHT);

  const smallLine = context.createLinearGradient(bindingX, 0, BOOK_WIDTH, 0);
  smallLine.addColorStop(0, rgba(0, 0, 0, 0.09));
  smallLine.addColorStop(1, rgba(0, 0, 0, 0.02));
  context.fillStyle = smallLine;
  [0.179, 0.403, 0.628].forEach((top) => {
    context.fillRect(bindingX, BOOK_HEIGHT * top, 19.7, 0.75);
  });

  drawVerticalText(context, title, BOOK_WIDTH * 0.23, 14, 20, 26, rgba(0, 0, 0, 1));
  drawVerticalText(context, description, BOOK_WIDTH * 0.47, 16, 14, 18, rgba(0, 0, 0, 0.7));

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

function flipGeometryUvY(geometry: THREE.PlaneGeometry) {
  const uvAttribute = geometry.attributes.uv as THREE.BufferAttribute;
  for (let index = 0; index < uvAttribute.count; index += 1) {
    uvAttribute.setY(index, 1 - uvAttribute.getY(index));
  }
  uvAttribute.needsUpdate = true;
}

function ease(current: number, target: number, speed: number) {
  return current + (target - current) * clamp(speed, 0.01, 1);
}

export function resolveBookCurlSegments(perfTier: PerfTier, reducedMotion: boolean) {
  return perfTier === "low" || reducedMotion ? BOOK_CURL_LOW_SEGMENTS : BOOK_CURL_HIGH_SEGMENTS;
}

export function advanceBookCurlProgress(current: number, target: number, params: Pick<BookCurlParams, "speed" | "snap">) {
  const nextProgress = ease(current, target, params.speed);
  const progress = Math.abs(nextProgress - target) < params.snap ? target : nextProgress;
  return {
    progress,
    settled: progress === target,
  };
}

function deformGeometry(meshData: BookMesh, width: number, height: number, progress: number, params: BookCurlParams) {
  const positionAttribute = meshData.geometry.attributes.position as THREE.BufferAttribute;
  const positions = positionAttribute.array as Float32Array;
  const vertexCount = positionAttribute.count;
  const areaX = Math.max(0.01, params.areaX);
  const areaY = Math.max(0.01, params.areaY);
  const powerX = Math.max(0.01, params.falloffPowerX);
  const powerY = Math.max(0.01, params.falloffPowerY);
  const softness = clamp(params.softness, -1, 2);
  const pin = Math.max(0, params.cornerPin);

  for (let index = 0; index < vertexCount; index += 1) {
    const i = index * 3;
    const x = meshData.basePositions[i]!;
    const y = meshData.basePositions[i + 1]!;
    const u = x / width + 0.5;
    const v = 0.5 - y / height;
    const leftFalloff = clamp(1 - u / areaX);
    const topFalloff = clamp(1 - v / areaY);
    const leftField = Math.pow(leftFalloff, powerX);
    const topField = Math.pow(topFalloff, powerY);
    const rawField = clamp(leftField * topField);
    const smoothField = rawField * rawField * (3 - 2 * rawField);
    const field = clamp(rawField + (smoothField - rawField) * softness);
    const cornerHold = pin > 0 ? Math.pow(clamp(topFalloff + leftFalloff, 0, 1), pin) : 1;
    const curl = field * cornerHold * progress;
    const ridge = Math.sin(clamp(leftFalloff * topFalloff) * Math.PI) * progress;

    positions[i] = x + curl * width * params.shiftX + ridge * width * params.rollX;
    positions[i + 1] = y + curl * height * params.shiftY - ridge * height * params.rollY;
    positions[i + 2] = curl * width * params.liftZ + ridge * width * params.ridgeZ;
  }

  positionAttribute.needsUpdate = true;
  meshData.geometry.computeVertexNormals();
}

export function BookCurlShelf({ books }: BookCurlShelfProps) {
  const perfTier = usePerfTier();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const hitRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const targetRef = useRef<number | null>(null);
  const progressRef = useRef(books.map(() => 0));
  const reduceMotionRef = useRef(false);
  const paramsRef = useRef<BookCurlParams>(BOOK_CURL_DEFAULTS);
  const requestRenderRef = useRef<(() => void) | null>(null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    const source = (window as BookCurlWindow).__HOME_BOOK_CURL_PARAMS__;
    if (source) {
      paramsRef.current = { ...BOOK_CURL_DEFAULTS, ...source };
    }

    const handleParams = (event: Event) => {
      const detail = (event as CustomEvent<Partial<BookCurlParams>>).detail;
      paramsRef.current = { ...BOOK_CURL_DEFAULTS, ...paramsRef.current, ...detail };
      requestRenderRef.current?.();
    };

    window.addEventListener("home-book-curl-params", handleParams);
    return () => window.removeEventListener("home-book-curl-params", handleParams);
  }, []);

  const setTarget = useCallback((index: number | null) => {
    const nextTarget = reduceMotionRef.current ? null : index;
    if (targetRef.current === nextTarget) {
      return;
    }
    targetRef.current = nextTarget;
    requestRenderRef.current?.();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) {
      return;
    }

    const reduceMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    reduceMotionRef.current = reduceMotionQuery.matches;
    if (reduceMotionRef.current) {
      targetRef.current = null;
    }

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: true,
        canvas,
        powerPreference: "high-performance",
      });
    } catch {
      setIsReady(false);
      return;
    }

    rendererRef.current = renderer;
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(0, 1, 0, -1, -1000, 1000);
    camera.position.set(0, 0, 10);
    const ambientLight = new THREE.AmbientLight(0xffffff, BOOK_CURL_DEFAULTS.ambientLight);
    scene.add(ambientLight);
    const light = new THREE.DirectionalLight(0xffffff, BOOK_CURL_DEFAULTS.directionalLight);
    light.position.set(BOOK_CURL_DEFAULTS.lightX, BOOK_CURL_DEFAULTS.lightY, BOOK_CURL_DEFAULTS.lightZ);
    scene.add(light);

    const textures = books.map((book) => createBookTexture(book.title, book.description));
    const meshes: BookMesh[] = [];
    let animationLoop: VisibilitySchedulerHandle | null = null;
    let disposed = false;
    let started = false;

    const stopAnimationLoop = () => {
      animationLoop?.stop();
      animationLoop = null;
    };

    const disposeMeshes = () => {
      meshes.splice(0).forEach((meshData) => {
        scene.remove(meshData.mesh);
        meshData.geometry.dispose();
        const material = meshData.mesh.material;
        if (Array.isArray(material)) {
          material.forEach((item) => item.dispose());
        } else {
          material.dispose();
        }
      });
    };

    const syncMeshes = () => {
      const canvasRect = canvas.getBoundingClientRect();
      const width = Math.max(1, canvasRect.width);
      const height = Math.max(1, canvasRect.height);
      renderer.setSize(width, height, false);
      camera.left = 0;
      camera.right = width;
      camera.top = 0;
      camera.bottom = -height;
      camera.updateProjectionMatrix();

      disposeMeshes();
      const segments = resolveBookCurlSegments(perfTier, reduceMotionRef.current);
      hitRefs.current.forEach((button, index) => {
        if (!button) {
          return;
        }

        const rect = button.getBoundingClientRect();
        const bookWidth = rect.width;
        const bookHeight = rect.height;
        const geometry = new THREE.PlaneGeometry(bookWidth, bookHeight, segments.width, segments.height);
        flipGeometryUvY(geometry);
        const material = new THREE.MeshStandardMaterial({
          map: textures[index],
          metalness: 0,
          roughness: 0.82,
          side: THREE.DoubleSide,
          transparent: true,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(rect.left - canvasRect.left + bookWidth / 2, -(rect.top - canvasRect.top + bookHeight / 2), 0);
        scene.add(mesh);
        const positionAttribute = geometry.attributes.position as THREE.BufferAttribute;
        const meshData = {
          basePositions: new Float32Array(positionAttribute.array as Float32Array),
          geometry,
          height: bookHeight,
          mesh,
          width: bookWidth,
        };
        deformGeometry(meshData, bookWidth, bookHeight, progressRef.current[index] ?? 0, paramsRef.current);
        meshes.push(meshData);
      });

      if (started) {
        requestRender();
      }
    };

    const observer = new ResizeObserver(syncMeshes);
    observer.observe(stage);
    hitRefs.current.forEach((button) => {
      if (button) {
        observer.observe(button);
      }
    });

    const render = () => {
      const params = paramsRef.current;
      ambientLight.intensity = params.ambientLight;
      light.intensity = params.directionalLight;
      light.position.set(params.lightX, params.lightY, params.lightZ);

      let hasPendingMotion = false;
      meshes.forEach((meshData, index) => {
        const target = !reduceMotionRef.current && targetRef.current === index ? params.activeAmount : 0;
        const { progress, settled } = advanceBookCurlProgress(progressRef.current[index] ?? 0, target, params);
        progressRef.current[index] = progress;
        hasPendingMotion ||= !settled;
        deformGeometry(meshData, meshData.width, meshData.height, progress, params);
      });
      renderer.render(scene, camera);
      return hasPendingMotion;
    };

    const requestRender = () => {
      if (disposed || !started || animationLoop) {
        return;
      }

      animationLoop = createVisibilityPausedRaf(
        () => {
          const shouldContinue = render();
          if (!shouldContinue) {
            stopAnimationLoop();
          }
        },
        { element: stage },
      );
    };

    requestRenderRef.current = requestRender;

    const handleReduceMotionChange = () => {
      const previous = reduceMotionRef.current;
      reduceMotionRef.current = reduceMotionQuery.matches;
      if (reduceMotionRef.current) {
        targetRef.current = null;
      }
      if (previous !== reduceMotionRef.current) {
        syncMeshes();
      } else {
        requestRender();
      }
    };
    reduceMotionQuery.addEventListener("change", handleReduceMotionChange);

    const start = () => {
      if (disposed || started) {
        return;
      }
      syncMeshes();
      started = true;
      setIsReady(true);
      if (render()) {
        requestRender();
      }
    };

    if ("fonts" in document) {
      void document.fonts.ready.then(start);
    } else {
      start();
    }

    return () => {
      disposed = true;
      reduceMotionQuery.removeEventListener("change", handleReduceMotionChange);
      observer.disconnect();
      if (requestRenderRef.current === requestRender) {
        requestRenderRef.current = null;
      }
      stopAnimationLoop();
      disposeMeshes();
      textures.forEach((texture) => texture.dispose());
      renderer.dispose();
      rendererRef.current = null;
    };
  }, [books, perfTier]);

  return (
    <div className="home-book-stage" data-webgl-ready={isReady ? "true" : "false"} ref={stageRef}>
      <canvas className="home-book-webgl" ref={canvasRef} aria-hidden="true" />
      <div className="home-book-grid home-book-hit-grid" aria-label="文档源">
        {books.map((book, index) => (
          <button
            aria-label={`${book.title}：${book.description}`}
            className="home-book-card home-book-hit-card"
            key={book.id}
            onBlur={() => setTarget(null)}
            onFocus={() => setTarget(index)}
            onPointerEnter={() => setTarget(index)}
            onPointerLeave={() => setTarget(null)}
            ref={(node) => {
              hitRefs.current[index] = node;
            }}
            type="button"
          >
            <span className="home-book-fallback" aria-hidden="true">
              <span className="home-book-title">{book.title}</span>
              <span className="home-book-desc">{book.description}</span>
              <span className="home-book-binding home-book-binding--one" />
              <span className="home-book-binding home-book-binding--two" />
              <span className="home-book-binding home-book-binding--three" />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
