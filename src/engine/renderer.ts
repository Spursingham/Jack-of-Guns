// Renderer bootstrap: WebGPU first (Three WebGPURenderer), automatic
// fallback to WebGL2. Both paths expose the same Three.js API surface.
import * as THREE from "three";

export interface RenderCtx {
  renderer: THREE.WebGLRenderer; // structural type also satisfied by WebGPURenderer
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  backend: "webgpu" | "webgl";
}

const SKY = 0x9cc8e0;
export const BASE_FOV = 72;

export async function createRenderer(canvas: HTMLCanvasElement): Promise<RenderCtx> {
  const forceGL = new URLSearchParams(location.search).has("gl");
  let renderer: THREE.WebGLRenderer | null = null;
  let backend: "webgpu" | "webgl" = "webgl";

  if (!forceGL && "gpu" in navigator) {
    try {
      const { WebGPURenderer } = await import("three/webgpu");
      const r = new WebGPURenderer({ canvas, antialias: true });
      await r.init();
      renderer = r as unknown as THREE.WebGLRenderer;
      backend = "webgpu";
    } catch (e) {
      console.warn("WebGPU init failed, falling back to WebGL:", e);
      renderer = null;
    }
  }
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    backend = "webgl";
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);
  // Ace of Spades signature: thick distance fog matching the sky.
  scene.fog = new THREE.Fog(SKY, 70, 170);

  // Chunk geometry has lighting baked into vertex colors; these lights are
  // for avatars, viewmodel and debris (Lambert materials).
  const hemi = new THREE.HemisphereLight(0xdfedf5, 0x5a4d3c, 0.95);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2dd, 1.0);
  sun.position.set(0.6, 1, 0.35);
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(BASE_FOV, innerWidth / innerHeight, 0.08, 600);
  camera.rotation.order = "YXZ";

  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer!.setSize(innerWidth, innerHeight);
  });

  return { renderer, scene, camera, backend };
}
