// Thin wrapper around the wasm-bindgen output (generated into ./pkg by
// `npm run wasm`). Exposes a single init function plus the VoxelWorld type.
import init, { VoxelWorld } from "./pkg/voxel_wasm.js";

let ready: Promise<unknown> | null = null;

export function initWasm(): Promise<unknown> {
  if (!ready) ready = init();
  return ready;
}

export { VoxelWorld };
