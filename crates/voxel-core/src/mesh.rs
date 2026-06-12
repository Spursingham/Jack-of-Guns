//! Greedy mesher: merges coplanar same-block faces into large quads.
//! Output is one vertex buffer per chunk — positions are chunk-local so the
//! client places each mesh at the chunk origin (good float precision, easy
//! frustum culling). Lighting is baked into vertex colors (face shading +
//! a subtle per-quad tint), which keeps the fragment path trivially cheap.

use crate::{blocks, World, CHUNK};

pub struct MeshBuffers {
    /// 3 floats per vertex, chunk-local coordinates.
    pub positions: Vec<f32>,
    /// 3 bytes per vertex (sRGB, normalized in the renderer).
    pub colors: Vec<u8>,
    /// Triangle list.
    pub indices: Vec<u32>,
}

/// Brightness per face direction: +x, -x, +y, -y, +z, -z.
const SHADE: [f32; 6] = [0.80, 0.70, 1.00, 0.46, 0.88, 0.60];

#[inline]
fn dir_index(axis: usize, positive: bool) -> usize {
    axis * 2 + if positive { 0 } else { 1 }
}

/// Mesh one chunk. `(cx, cy, cz)` are chunk coordinates.
pub fn mesh_chunk(w: &World, cx: i32, cy: i32, cz: i32) -> MeshBuffers {
    let n = CHUNK as usize;
    let origin = [cx * CHUNK, cy * CHUNK, cz * CHUNK];

    let mut out = MeshBuffers {
        positions: Vec::new(),
        colors: Vec::new(),
        indices: Vec::new(),
    };

    // For each axis d, sweep slices; u/v span the slice plane.
    for d in 0..3usize {
        let u = (d + 1) % 3;
        let v = (d + 2) % 3;

        for positive in [true, false] {
            let step = if positive { 1 } else { -1 };
            let mut mask = vec![0u8; n * n];

            for slice in 0..CHUNK {
                // Build visibility mask for this slice/direction.
                let mut any = false;
                for j in 0..CHUNK {
                    for i in 0..CHUNK {
                        let mut p = [0i32; 3];
                        p[d] = slice;
                        p[u] = i;
                        p[v] = j;
                        let wx = origin[0] + p[0];
                        let wy = origin[1] + p[1];
                        let wz = origin[2] + p[2];
                        let b = w.get(wx, wy, wz);
                        let m = if blocks::is_solid(b) {
                            let mut q = [wx, wy, wz];
                            q[d] += step;
                            if blocks::is_solid(w.get(q[0], q[1], q[2])) {
                                0
                            } else {
                                b
                            }
                        } else {
                            0
                        };
                        mask[(j as usize) * n + i as usize] = m;
                        any |= m != 0;
                    }
                }
                if !any {
                    continue;
                }

                // Greedy rectangle merge over the mask.
                for j in 0..n {
                    let mut i = 0usize;
                    while i < n {
                        let b = mask[j * n + i];
                        if b == 0 {
                            i += 1;
                            continue;
                        }
                        // Grow width.
                        let mut wdt = 1usize;
                        while i + wdt < n && mask[j * n + i + wdt] == b {
                            wdt += 1;
                        }
                        // Grow height while every cell matches.
                        let mut hgt = 1usize;
                        'grow: while j + hgt < n {
                            for k in 0..wdt {
                                if mask[(j + hgt) * n + i + k] != b {
                                    break 'grow;
                                }
                            }
                            hgt += 1;
                        }
                        emit_quad(
                            &mut out, d, u, v, positive, slice, i as i32, j as i32, wdt as i32,
                            hgt as i32, b, origin,
                        );
                        for jj in 0..hgt {
                            for ii in 0..wdt {
                                mask[(j + jj) * n + i + ii] = 0;
                            }
                        }
                        i += wdt;
                    }
                }
            }
        }
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn emit_quad(
    out: &mut MeshBuffers,
    d: usize,
    u: usize,
    v: usize,
    positive: bool,
    slice: i32,
    i: i32,
    j: i32,
    quad_w: i32,
    quad_h: i32,
    block: u8,
    origin: [i32; 3],
) {
    let mut base = [0f32; 3];
    base[d] = (slice + if positive { 1 } else { 0 }) as f32;
    base[u] = i as f32;
    base[v] = j as f32;

    let mut du = [0f32; 3];
    du[u] = quad_w as f32;
    let mut dv = [0f32; 3];
    dv[v] = quad_h as f32;

    let p0 = base;
    let p1 = [base[0] + du[0], base[1] + du[1], base[2] + du[2]];
    let p2 = [p1[0] + dv[0], p1[1] + dv[1], p1[2] + dv[2]];
    let p3 = [base[0] + dv[0], base[1] + dv[1], base[2] + dv[2]];

    let start = (out.positions.len() / 3) as u32;
    for p in [p0, p1, p2, p3] {
        out.positions.extend_from_slice(&p);
    }

    // cross(e_u, e_v) == +e_d for the cyclic (d, u, v) triple, so the
    // 0-1-2 / 0-2-3 order faces +d; reverse it for the -d face.
    if positive {
        out.indices
            .extend_from_slice(&[start, start + 1, start + 2, start, start + 2, start + 3]);
    } else {
        out.indices
            .extend_from_slice(&[start, start + 2, start + 1, start, start + 3, start + 2]);
    }

    let shade = SHADE[dir_index(d, positive)];
    // Subtle deterministic per-quad tint so large merged areas still read
    // as voxel terrain instead of flat plastic.
    let qx = origin[0] + base[0] as i32;
    let qy = origin[1] + base[1] as i32;
    let qz = origin[2] + base[2] as i32;
    let h = crate::noise::hash01(qx * 3 + qy * 7, qz * 5 + qy, 0x71f7);
    let tint = 0.95 + 0.08 * h;

    let c = blocks::color(block);
    let rgb = [
        (c[0] as f32 * shade * tint).min(255.0) as u8,
        (c[1] as f32 * shade * tint).min(255.0) as u8,
        (c[2] as f32 * shade * tint).min(255.0) as u8,
    ];
    for _ in 0..4 {
        out.colors.extend_from_slice(&rgb);
    }
}
