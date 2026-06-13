// Owns the WASM voxel world plus one Three.js mesh per chunk.
// Remeshing is fed by the WASM dirty queue and processed under a per-frame
// time budget so edits/explosions never hitch the render loop for long.
import * as THREE from "three";
import type { VoxelWorld } from "../wasm/voxel";

export const WATER_Y = 0.0; // mirror of voxel_core::WATER_Y (no water on this map)
export const GROUND_Y = 3; // mirror of voxel_core::GROUND_Y (flat scrapyard floor)

export class ChunkRenderer {
  private meshes = new Map<string, THREE.Mesh>();
  private queue: [number, number, number][] = [];
  private queued = new Set<string>();
  private material: THREE.Material;
  readonly group = new THREE.Group();

  constructor(
    readonly world: VoxelWorld,
    readonly scene: THREE.Scene,
  ) {
    this.material = new THREE.MeshBasicMaterial({ vertexColors: true });
    scene.add(this.group);
  }

  get chunkSize(): number {
    return this.world.chunk_size();
  }

  /** Queue every chunk and build progressively; resolves when done. */
  buildAll(onProgress?: (done: number, total: number) => void): Promise<void> {
    const [nx, ny, nz] = [this.world.chunks_x(), this.world.chunks_y(), this.world.chunks_z()];
    for (let cy = 0; cy < ny; cy++)
      for (let cz = 0; cz < nz; cz++)
        for (let cx = 0; cx < nx; cx++) this.enqueue(cx, cy, cz);
    const total = this.queue.length;
    return new Promise((resolve) => {
      const step = () => {
        this.drainQueue(12);
        onProgress?.(total - this.queue.length, total);
        if (this.queue.length === 0) resolve();
        else requestAnimationFrame(step);
      };
      step();
    });
  }

  /** Call once per frame: pick up WASM dirty chunks and rebuild under budget. */
  update() {
    const dirty = this.world.take_dirty();
    for (let i = 0; i < dirty.length; i += 3) this.enqueue(dirty[i], dirty[i + 1], dirty[i + 2]);
    this.drainQueue(6);
  }

  private enqueue(cx: number, cy: number, cz: number) {
    const key = `${cx},${cy},${cz}`;
    if (this.queued.has(key)) return;
    this.queued.add(key);
    this.queue.push([cx, cy, cz]);
  }

  private drainQueue(budgetMs: number) {
    const start = performance.now();
    while (this.queue.length > 0 && performance.now() - start < budgetMs) {
      const [cx, cy, cz] = this.queue.shift()!;
      this.queued.delete(`${cx},${cy},${cz}`);
      this.remesh(cx, cy, cz);
    }
  }

  private remesh(cx: number, cy: number, cz: number) {
    const key = `${cx},${cy},${cz}`;
    const m = this.world.mesh_chunk(cx, cy, cz);
    const positions = m.positions;
    const colorsU8 = m.colors;
    const indices = m.indices;
    m.free();

    const existing = this.meshes.get(key);
    if (positions.length === 0) {
      if (existing) {
        existing.geometry.dispose();
        this.group.remove(existing);
        this.meshes.delete(key);
      }
      return;
    }

    // Float32 0..1 vertex colors: works identically on WebGL2 and the WebGPU
    // node-material path (a normalized Uint8 attribute is ambiguous on WebGPU).
    const colors = new Float32Array(colorsU8.length);
    for (let i = 0; i < colorsU8.length; i++) colors[i] = colorsU8[i] / 255;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeBoundingSphere();

    if (existing) {
      existing.geometry.dispose();
      existing.geometry = geo;
    } else {
      const mesh = new THREE.Mesh(geo, this.material);
      const cs = this.chunkSize;
      mesh.position.set(cx * cs, cy * cs, cz * cs);
      this.meshes.set(key, mesh);
      this.group.add(mesh);
    }
  }

  /** Number of chunk meshes currently in the scene (diagnostics). */
  get meshCount(): number {
    return this.meshes.size;
  }
}
