//! Tiny self-contained value noise + fBm (deterministic across platforms,
//! integer-hash based so client WASM and native server always match).

#[inline]
fn hash2(ix: i32, iz: i32, seed: u32) -> u32 {
    let mut h = seed ^ 0x9e37_79b9;
    h = h.wrapping_add(ix as u32).wrapping_mul(0x85eb_ca6b);
    h ^= h >> 13;
    h = h.wrapping_add(iz as u32).wrapping_mul(0xc2b2_ae35);
    h ^= h >> 16;
    h = h.wrapping_mul(0x27d4_eb2f);
    h ^ (h >> 15)
}

/// Hash to [0, 1).
#[inline]
pub fn hash01(ix: i32, iz: i32, seed: u32) -> f32 {
    (hash2(ix, iz, seed) & 0x00ff_ffff) as f32 / 16_777_216.0
}

#[inline]
fn smooth(t: f32) -> f32 {
    t * t * (3.0 - 2.0 * t)
}

/// Bilinear value noise at (x, z), output [0, 1).
pub fn value2(x: f32, z: f32, seed: u32) -> f32 {
    let ix = x.floor() as i32;
    let iz = z.floor() as i32;
    let fx = smooth(x - ix as f32);
    let fz = smooth(z - iz as f32);
    let a = hash01(ix, iz, seed);
    let b = hash01(ix + 1, iz, seed);
    let c = hash01(ix, iz + 1, seed);
    let d = hash01(ix + 1, iz + 1, seed);
    let ab = a + (b - a) * fx;
    let cd = c + (d - c) * fx;
    ab + (cd - ab) * fz
}

/// Fractal Brownian motion, output roughly [0, 1).
pub fn fbm2(x: f32, z: f32, seed: u32, octaves: u32) -> f32 {
    let mut amp = 0.5;
    let mut freq = 1.0;
    let mut sum = 0.0;
    let mut norm = 0.0;
    for o in 0..octaves {
        sum += amp * value2(x * freq, z * freq, seed.wrapping_add(o * 1013));
        norm += amp;
        amp *= 0.5;
        freq *= 2.0;
    }
    sum / norm
}
