// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function installWebGlMock() {
  const compileShader = vi.fn();
  const gl = {
    ARRAY_BUFFER: 0x8892,
    BLEND: 0x0be2,
    COLOR_BUFFER_BIT: 0x4000,
    COMPILE_STATUS: 0x8b81,
    FLOAT: 0x1406,
    FRAGMENT_SHADER: 0x8b30,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    SRC_ALPHA: 0x0302,
    STATIC_DRAW: 0x88e4,
    TRIANGLES: 0x0004,
    VERTEX_SHADER: 0x8b31,
    attachShader: vi.fn(),
    bindBuffer: vi.fn(),
    blendFunc: vi.fn(),
    bufferData: vi.fn(),
    clear: vi.fn(),
    compileShader,
    createBuffer: vi.fn(() => ({})),
    createProgram: vi.fn(() => ({})),
    createShader: vi.fn((type: number) => ({ type })),
    drawArrays: vi.fn(),
    enable: vi.fn(),
    enableVertexAttribArray: vi.fn(),
    getAttribLocation: vi.fn(() => 0),
    getShaderInfoLog: vi.fn(() => ""),
    getShaderParameter: vi.fn(() => true),
    getUniformLocation: vi.fn((_program: unknown, name: string) => ({ name })),
    linkProgram: vi.fn(),
    shaderSource: vi.fn(),
    uniform1f: vi.fn(),
    uniform2f: vi.fn(),
    uniform3fv: vi.fn(),
    useProgram: vi.fn(),
    vertexAttribPointer: vi.fn(),
    viewport: vi.fn(),
  } as unknown as WebGLRenderingContext & { compileShader: ReturnType<typeof vi.fn> };

  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((contextId: string) => {
    if (contextId !== "webgl") return null;
    return gl;
  });

  return { compileShader };
}

describe("inkWipe WebGL 资源复用", () => {
  it("预热后跨 canvas attach 不重复编译 shader", async () => {
    const webgl = installWebGlMock();
    const { createInkWipe, prewarmInkWipe } = await import("./inkWipe");
    const host = document.createElement("div");
    document.body.appendChild(host);

    expect(prewarmInkWipe()).toBe(true);
    expect(webgl.compileShader).toHaveBeenCalledTimes(2);

    const firstCanvas = document.createElement("canvas");
    firstCanvas.className = "ccx-ink";
    host.appendChild(firstCanvas);
    const first = createInkWipe(firstCanvas);
    expect(first.ok).toBe(true);
    expect(firstCanvas.style.display).toBe("none");
    first.dispose();
    expect(firstCanvas.style.display).toBe("");

    const secondCanvas = document.createElement("canvas");
    secondCanvas.className = "ccx-ink";
    host.appendChild(secondCanvas);
    const second = createInkWipe(secondCanvas);
    expect(second.ok).toBe(true);
    second.dispose();

    expect(webgl.compileShader).toHaveBeenCalledTimes(2);
  });
});
