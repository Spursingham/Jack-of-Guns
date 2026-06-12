//! wasm-bindgen bridge exposing the voxel core to the browser client.

use voxel_core::{blocks, explosion, gen, mesh, ray, World};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct VoxelWorld {
    w: World,
}

#[wasm_bindgen]
pub struct ChunkMesh {
    positions: Vec<f32>,
    colors: Vec<u8>,
    indices: Vec<u32>,
}

#[wasm_bindgen]
impl ChunkMesh {
    #[wasm_bindgen(getter)]
    pub fn positions(&self) -> Vec<f32> {
        self.positions.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn colors(&self) -> Vec<u8> {
        self.colors.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn indices(&self) -> Vec<u32> {
        self.indices.clone()
    }
}

#[wasm_bindgen]
impl VoxelWorld {
    /// Generate the world from a seed (matches the server exactly).
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u32) -> VoxelWorld {
        VoxelWorld {
            w: gen::generate(seed),
        }
    }

    pub fn size_x(&self) -> i32 {
        voxel_core::SX
    }
    pub fn size_y(&self) -> i32 {
        voxel_core::SY
    }
    pub fn size_z(&self) -> i32 {
        voxel_core::SZ
    }
    pub fn chunk_size(&self) -> i32 {
        voxel_core::CHUNK
    }
    pub fn chunks_x(&self) -> i32 {
        voxel_core::WORLD_CHUNKS.0
    }
    pub fn chunks_y(&self) -> i32 {
        voxel_core::WORLD_CHUNKS.1
    }
    pub fn chunks_z(&self) -> i32 {
        voxel_core::WORLD_CHUNKS.2
    }

    pub fn get_block(&self, x: i32, y: i32, z: i32) -> u8 {
        self.w.get(x, y, z)
    }

    /// True if the voxel blocks movement (used by the TS physics).
    pub fn is_solid(&self, x: i32, y: i32, z: i32) -> bool {
        blocks::is_solid(self.w.get(x, y, z))
    }

    pub fn is_breakable(&self, x: i32, y: i32, z: i32) -> bool {
        blocks::is_breakable(self.w.get(x, y, z))
    }

    pub fn set_block(&mut self, x: i32, y: i32, z: i32, b: u8) -> bool {
        self.w.set(x, y, z, b)
    }

    /// Drain chunks needing remesh as [cx,cy,cz, cx,cy,cz, ...].
    pub fn take_dirty(&mut self) -> Vec<i32> {
        let mut out = Vec::new();
        for (cx, cy, cz) in self.w.take_dirty() {
            out.extend_from_slice(&[cx, cy, cz]);
        }
        out
    }

    pub fn mark_all_dirty(&mut self) {
        for cy in 0..voxel_core::WORLD_CHUNKS.1 {
            for cz in 0..voxel_core::WORLD_CHUNKS.2 {
                for cx in 0..voxel_core::WORLD_CHUNKS.0 {
                    self.w.mark_chunk_dirty(cx, cy, cz);
                }
            }
        }
    }

    pub fn mesh_chunk(&self, cx: i32, cy: i32, cz: i32) -> ChunkMesh {
        let m = mesh::mesh_chunk(&self.w, cx, cy, cz);
        ChunkMesh {
            positions: m.positions,
            colors: m.colors,
            indices: m.indices,
        }
    }

    /// DDA raycast. Empty array on miss, else
    /// [bx, by, bz, nx, ny, nz, t, block_id].
    pub fn raycast(
        &self,
        ox: f32,
        oy: f32,
        oz: f32,
        dx: f32,
        dy: f32,
        dz: f32,
        max_dist: f32,
    ) -> Vec<f32> {
        match ray::raycast(&self.w, [ox, oy, oz], [dx, dy, dz], max_dist) {
            Some(h) => vec![
                h.block[0] as f32,
                h.block[1] as f32,
                h.block[2] as f32,
                h.normal[0] as f32,
                h.normal[1] as f32,
                h.normal[2] as f32,
                h.t,
                h.block_id as f32,
            ],
            None => Vec::new(),
        }
    }

    /// Apply a deterministic explosion; returns destroyed [x,y,z, ...].
    pub fn apply_explosion(&mut self, x: f32, y: f32, z: f32, radius: f32) -> Vec<i32> {
        let mut out = Vec::new();
        for p in explosion::apply_explosion(&mut self.w, x, y, z, radius) {
            out.extend_from_slice(&p);
        }
        out
    }

    pub fn surface_y(&self, x: i32, z: i32) -> i32 {
        self.w.surface_y(x, z)
    }

    /// Block base color as [r, g, b] (for HUD swatches / debris particles).
    pub fn block_color(&self, b: u8) -> Vec<u8> {
        blocks::color(b).to_vec()
    }
}
