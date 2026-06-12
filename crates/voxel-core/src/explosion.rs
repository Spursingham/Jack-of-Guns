//! Deterministic spherical destruction. Server and client both run this on
//! an Explosion event and arrive at the identical set of destroyed voxels.

use crate::{blocks, World};

/// Positions destroyed by an explosion (does not mutate the world).
pub fn explosion_blocks(w: &World, cx: f32, cy: f32, cz: f32, radius: f32) -> Vec<[i32; 3]> {
    let r = radius.max(0.0);
    let r2 = r * r;
    let (x0, x1) = ((cx - r).floor() as i32, (cx + r).ceil() as i32);
    let (y0, y1) = ((cy - r).floor() as i32, (cy + r).ceil() as i32);
    let (z0, z1) = ((cz - r).floor() as i32, (cz + r).ceil() as i32);
    let mut out = Vec::new();
    for y in y0..=y1 {
        for z in z0..=z1 {
            for x in x0..=x1 {
                let dx = x as f32 + 0.5 - cx;
                let dy = y as f32 + 0.5 - cy;
                let dz = z as f32 + 0.5 - cz;
                if dx * dx + dy * dy + dz * dz > r2 {
                    continue;
                }
                if blocks::is_breakable(w.get(x, y, z)) {
                    out.push([x, y, z]);
                }
            }
        }
    }
    out
}

/// Apply an explosion to the world; returns destroyed positions.
pub fn apply_explosion(w: &mut World, cx: f32, cy: f32, cz: f32, radius: f32) -> Vec<[i32; 3]> {
    let hits = explosion_blocks(w, cx, cy, cz, radius);
    for p in &hits {
        w.set(p[0], p[1], p[2], blocks::AIR);
    }
    hits
}
