//! Deterministic terrain generation: rolling hills, beaches around the
//! water line, snow caps, scattered trees, bedrock floor.

use crate::noise::{fbm2, hash01};
use crate::{blocks, World, SX, SY, SZ, WATER_Y};

pub fn height_at(x: i32, z: i32, seed: u32) -> i32 {
    let h = fbm2(x as f32 * 0.013, z as f32 * 0.013, seed, 4);
    // Second, broader octave band gives larger landmasses.
    let h2 = fbm2(x as f32 * 0.004 + 100.0, z as f32 * 0.004, seed ^ 0xabcd, 3);
    let height = 8.0 + h * 22.0 + h2 * 18.0;
    (height as i32).clamp(1, SY - 8)
}

pub fn generate(seed: u32) -> World {
    let mut w = World::empty(seed);
    let water = WATER_Y as i32;

    for z in 0..SZ {
        for x in 0..SX {
            let h = height_at(x, z, seed);
            for y in 0..=h {
                let b = if y == 0 {
                    blocks::BEDROCK
                } else if y == h {
                    if h <= water + 2 {
                        blocks::SAND
                    } else if h >= 42 {
                        blocks::SNOW
                    } else {
                        blocks::GRASS
                    }
                } else if y >= h - 3 {
                    if h <= water + 2 {
                        blocks::SAND
                    } else {
                        blocks::DIRT
                    }
                } else {
                    blocks::STONE
                };
                w.set_raw(x, y, z, b);
            }
        }
    }

    plant_trees(&mut w, seed);
    w
}

const TREE_SEED: u32 = 0x7133_7000;

fn plant_trees(w: &mut World, seed: u32) {
    let water = WATER_Y as i32;
    for z in 2..SZ - 2 {
        for x in 2..SX - 2 {
            if hash01(x, z, seed ^ TREE_SEED) >= 0.0035 {
                continue;
            }
            let h = w.surface_y(x, z);
            if h <= water + 2 || h >= 40 || w.get(x, h, z) != blocks::GRASS {
                continue;
            }
            let trunk = 4 + (hash01(x, z, seed ^ 99) * 3.0) as i32;
            for y in 1..=trunk {
                w.set_raw(x, h + y, z, blocks::WOOD);
            }
            // Leaf blob around the crown.
            let top = h + trunk;
            for dy in -2..=2i32 {
                for dz in -2..=2i32 {
                    for dx in -2..=2i32 {
                        let d2 = dx * dx + dy * dy + dz * dz;
                        if d2 > 5 {
                            continue;
                        }
                        let (lx, ly, lz) = (x + dx, top + 1 + dy, z + dz);
                        if w.get(lx, ly, lz) == blocks::AIR {
                            w.set_raw(lx, ly, lz, blocks::LEAVES);
                        }
                    }
                }
            }
        }
    }
}
