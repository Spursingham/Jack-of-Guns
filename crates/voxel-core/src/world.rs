//! Flat-array voxel world with per-chunk dirty tracking.

use crate::{blocks, CHUNK, SX, SY, SZ, WORLD_CHUNKS};

pub struct World {
    /// Block ids, indexed `x + SX * (z + SZ * y)`.
    pub data: Vec<u8>,
    /// Per-chunk dirty flags (needs remesh), indexed `cx + NCX * (cz + NCZ * cy)`.
    dirty: Vec<bool>,
    pub seed: u32,
}

pub const NCX: i32 = WORLD_CHUNKS.0;
pub const NCY: i32 = WORLD_CHUNKS.1;
pub const NCZ: i32 = WORLD_CHUNKS.2;

#[inline]
pub fn in_bounds(x: i32, y: i32, z: i32) -> bool {
    x >= 0 && y >= 0 && z >= 0 && x < SX && y < SY && z < SZ
}

#[inline]
fn idx(x: i32, y: i32, z: i32) -> usize {
    (x + SX * (z + SZ * y)) as usize
}

#[inline]
fn chunk_idx(cx: i32, cy: i32, cz: i32) -> usize {
    (cx + NCX * (cz + NCZ * cy)) as usize
}

impl World {
    pub fn empty(seed: u32) -> World {
        World {
            data: vec![blocks::AIR; (SX * SY * SZ) as usize],
            dirty: vec![false; (NCX * NCY * NCZ) as usize],
            seed,
        }
    }

    /// Block at (x,y,z). Outside the map: solid below y=0 (so map floor
    /// faces are culled), air everywhere else (map edges render).
    #[inline]
    pub fn get(&self, x: i32, y: i32, z: i32) -> u8 {
        if in_bounds(x, y, z) {
            self.data[idx(x, y, z)]
        } else if y < 0 {
            blocks::BEDROCK
        } else {
            blocks::AIR
        }
    }

    /// Set a block and mark affected chunks dirty. Returns true if changed.
    pub fn set(&mut self, x: i32, y: i32, z: i32, b: u8) -> bool {
        if !in_bounds(x, y, z) {
            return false;
        }
        let i = idx(x, y, z);
        if self.data[i] == b {
            return false;
        }
        self.data[i] = b;
        self.mark_dirty_around(x, y, z);
        true
    }

    /// Raw set during generation (no dirty tracking).
    #[inline]
    pub fn set_raw(&mut self, x: i32, y: i32, z: i32, b: u8) {
        if in_bounds(x, y, z) {
            self.data[idx(x, y, z)] = b;
        }
    }

    /// Mark the chunk containing (x,y,z) dirty, plus neighbors when the
    /// voxel lies on a chunk border (their face culling changes too).
    fn mark_dirty_around(&mut self, x: i32, y: i32, z: i32) {
        let (cx, cy, cz) = (x / CHUNK, y / CHUNK, z / CHUNK);
        let (lx, ly, lz) = (x % CHUNK, y % CHUNK, z % CHUNK);
        for (dx, l) in [(-1, lx == 0), (1, lx == CHUNK - 1), (0, true)] {
            if !l {
                continue;
            }
            for (dy, l) in [(-1, ly == 0), (1, ly == CHUNK - 1), (0, true)] {
                if !l {
                    continue;
                }
                for (dz, l) in [(-1, lz == 0), (1, lz == CHUNK - 1), (0, true)] {
                    if !l {
                        continue;
                    }
                    self.mark_chunk_dirty(cx + dx, cy + dy, cz + dz);
                }
            }
        }
    }

    pub fn mark_chunk_dirty(&mut self, cx: i32, cy: i32, cz: i32) {
        if cx >= 0 && cy >= 0 && cz >= 0 && cx < NCX && cy < NCY && cz < NCZ {
            self.dirty[chunk_idx(cx, cy, cz)] = true;
        }
    }

    /// Drain dirty chunk coords as (cx, cy, cz) triples.
    pub fn take_dirty(&mut self) -> Vec<(i32, i32, i32)> {
        let mut out = Vec::new();
        for cy in 0..NCY {
            for cz in 0..NCZ {
                for cx in 0..NCX {
                    let i = chunk_idx(cx, cy, cz);
                    if self.dirty[i] {
                        self.dirty[i] = false;
                        out.push((cx, cy, cz));
                    }
                }
            }
        }
        out
    }

    /// Highest solid y at column (x,z), or -1 if the column is empty.
    pub fn surface_y(&self, x: i32, z: i32) -> i32 {
        for y in (0..SY).rev() {
            if blocks::is_solid(self.get(x, y, z)) {
                return y;
            }
        }
        -1
    }
}
