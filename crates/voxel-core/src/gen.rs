//! Scrapyard arena generator: a flat industrial lot with a tower crane, a
//! site office, shipping containers, wrecked cars and scrap heaps, ringed by
//! a corrugated fence. Fully deterministic from the seed so the client (WASM)
//! and the authoritative server build the identical world.

use crate::noise::hash01;
use crate::{blocks, World, GROUND_Y, SX, SZ};

pub fn generate(seed: u32) -> World {
    let mut w = World::empty(seed);
    lay_ground(&mut w);
    perimeter_fence(&mut w);
    site_office(&mut w, 6, 6);
    tower_crane(&mut w, SX / 2 - 1, SZ / 2 - 1);
    place_containers(&mut w);
    place_cars(&mut w, seed);
    scrap_heaps(&mut w, seed);
    tire_stacks(&mut w, seed);
    w
}

/// Inclusive solid box (coordinates may be given in any order).
fn fill(w: &mut World, a: [i32; 3], b: [i32; 3], block: u8) {
    for y in a[1].min(b[1])..=a[1].max(b[1]) {
        for z in a[2].min(b[2])..=a[2].max(b[2]) {
            for x in a[0].min(b[0])..=a[0].max(b[0]) {
                w.set_raw(x, y, z, block);
            }
        }
    }
}

fn lay_ground(w: &mut World) {
    for z in 0..SZ {
        for x in 0..SX {
            w.set_raw(x, 0, z, blocks::BEDROCK);
            for y in 1..GROUND_Y {
                w.set_raw(x, y, z, blocks::GRAVEL);
            }
            // Mostly asphalt with occasional gravel patches for texture.
            let patch = hash01(x, z, 0x5ca7) < 0.06;
            w.set_raw(x, GROUND_Y, z, if patch { blocks::GRAVEL } else { blocks::ASPHALT });
        }
    }
}

/// Corrugated rust/steel fence around the lot so the arena is contained.
fn perimeter_fence(w: &mut World) {
    let top = GROUND_Y + 4;
    for y in (GROUND_Y + 1)..=top {
        for x in 0..SX {
            let b = if (x + y) % 2 == 0 { blocks::RUST } else { blocks::STEEL };
            w.set_raw(x, y, 0, b);
            w.set_raw(x, y, SZ - 1, b);
        }
        for z in 0..SZ {
            let b = if (z + y) % 2 == 0 { blocks::RUST } else { blocks::STEEL };
            w.set_raw(0, y, z, b);
            w.set_raw(SX - 1, y, z, b);
        }
    }
}

/// Concrete site office with a window strip, a doorway and a steel roof.
fn site_office(w: &mut World, ox: i32, oz: i32) {
    let (wx, wz, h) = (14, 10, 6);
    let y0 = GROUND_Y + 1;
    let y1 = y0 + h;

    fill(w, [ox, GROUND_Y, oz], [ox + wx, GROUND_Y, oz + wz], blocks::CONCRETE);
    for y in y0..=y1 {
        for x in ox..=ox + wx {
            w.set_raw(x, y, oz, blocks::CONCRETE);
            w.set_raw(x, y, oz + wz, blocks::CONCRETE);
        }
        for z in oz..=oz + wz {
            w.set_raw(ox, y, z, blocks::CONCRETE);
            w.set_raw(ox + wx, y, z, blocks::CONCRETE);
        }
    }
    // Window band.
    for wy in (y0 + 2)..=(y0 + 3) {
        for x in (ox + 2)..(ox + wx - 1) {
            w.set_raw(x, wy, oz, blocks::WINDOW);
            w.set_raw(x, wy, oz + wz, blocks::WINDOW);
        }
        for z in (oz + 2)..(oz + wz - 1) {
            w.set_raw(ox, wy, z, blocks::WINDOW);
            w.set_raw(ox + wx, wy, z, blocks::WINDOW);
        }
    }
    // Doorway on the +z face.
    let dx = ox + wx / 2;
    for y in y0..=(y0 + 2) {
        w.set_raw(dx, y, oz + wz, blocks::AIR);
        w.set_raw(dx + 1, y, oz + wz, blocks::AIR);
    }
    fill(w, [ox, y1, oz], [ox + wx, y1, oz + wz], blocks::STEEL);
}

/// Tower crane: hazard-striped lattice mast, a long jib with a short counter
/// jib, an operator cab, and a cable holding a suspended wreck.
fn tower_crane(w: &mut World, cx: i32, cz: i32) {
    let base = GROUND_Y + 1;
    let mast_top = GROUND_Y + 22;

    fill(w, [cx - 2, GROUND_Y, cz - 2], [cx + 3, GROUND_Y, cz + 3], blocks::CONCRETE);
    for y in base..=mast_top {
        for (dx, dz) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
            let b = if y % 3 == 0 { blocks::HAZARD } else { blocks::STEEL };
            w.set_raw(cx + dx, y, cz + dz, b);
        }
    }

    let jib_y = mast_top;
    for x in (cx - 6)..=(cx + 18) {
        let b = if x % 2 == 0 { blocks::HAZARD } else { blocks::STEEL };
        w.set_raw(x, jib_y, cz, b);
        w.set_raw(x, jib_y, cz + 1, b);
        if x % 4 == 0 {
            w.set_raw(x, jib_y + 1, cz, blocks::STEEL);
            w.set_raw(x, jib_y + 1, cz + 1, blocks::STEEL);
        }
    }
    // Operator cab just under the slew point.
    fill(w, [cx - 1, jib_y - 2, cz - 1], [cx + 2, jib_y - 1, cz + 2], blocks::HAZARD);

    // Cable + suspended wreck near the jib tip.
    let hx = cx + 15;
    for y in (GROUND_Y + 7)..jib_y {
        w.set_raw(hx, y, cz, blocks::STEEL);
    }
    fill(w, [hx - 1, GROUND_Y + 4, cz - 1], [hx + 1, GROUND_Y + 6, cz + 1], blocks::RUST);
}

/// One shipping container (solid block, good cover) at a base height.
fn container(w: &mut World, x: i32, z: i32, y_base: i32, along_x: bool, color: u8) {
    let (lx, lz) = if along_x { (8, 3) } else { (3, 8) };
    fill(w, [x, y_base, z], [x + lx - 1, y_base + 2, z + lz - 1], color);
    // Corrugated end caps in steel for a bit of read.
    for y in y_base..=y_base + 2 {
        for z2 in z..z + lz {
            w.set_raw(x, y, z2, blocks::STEEL);
            w.set_raw(x + lx - 1, y, z2, blocks::STEEL);
        }
    }
}

fn place_containers(w: &mut World) {
    let g = GROUND_Y + 1;
    let stack = GROUND_Y + 4;
    // A stacked pair near one side…
    container(w, 18, 60, g, true, blocks::CONTAINER_GREEN);
    container(w, 18, 60, stack, true, blocks::CAR_BLUE);
    container(w, 20, 64, g, true, blocks::RUST);
    // …singles scattered as cover.
    container(w, 66, 18, g, false, blocks::RUST);
    container(w, 70, 48, g, true, blocks::STEEL);
    container(w, 48, 70, g, false, blocks::CONTAINER_GREEN);
    container(w, 60, 62, g, true, blocks::CAR_BLUE);
}

/// A wrecked car: chassis, lower body, window strip, four tires.
fn car(w: &mut World, x: i32, z: i32, color: u8) {
    let y0 = GROUND_Y + 1;
    fill(w, [x, y0, z], [x + 4, y0, z + 2], color);
    fill(w, [x + 1, y0 + 1, z], [x + 3, y0 + 1, z + 2], color);
    fill(w, [x + 1, y0 + 2, z + 1], [x + 3, y0 + 2, z + 1], blocks::WINDOW);
    for wx in [x, x + 4] {
        w.set_raw(wx, y0, z, blocks::TIRE);
        w.set_raw(wx, y0, z + 2, blocks::TIRE);
    }
}

fn place_cars(w: &mut World, seed: u32) {
    let palette = [blocks::CAR_RED, blocks::CAR_BLUE, blocks::RUST, blocks::CONTAINER_GREEN];
    let spots = [(30, 26), (40, 30), (54, 40), (28, 46), (62, 32), (44, 54), (34, 66)];
    for (i, &(x, z)) in spots.iter().enumerate() {
        let c = palette[(hash01(x, z, seed) * palette.len() as f32) as usize % palette.len()];
        car(w, x, z, c);
        let _ = i;
    }
}

/// Random mounds of rust/steel/tires.
fn scrap_heaps(w: &mut World, seed: u32) {
    for i in 0..16 {
        let hx = 8 + (hash01(i, 0, seed) * (SX - 16) as f32) as i32;
        let hz = 8 + (hash01(0, i, seed ^ 0x55) * (SZ - 16) as f32) as i32;
        let r = 1 + (hash01(i, i, seed ^ 0xa1) * 2.5) as i32;
        for dy in 0..=r {
            let rr = r - dy;
            for dz in -rr..=rr {
                for dx in -rr..=rr {
                    if dx * dx + dz * dz <= rr * rr + 1 {
                        let b = match (dx + dz + dy).rem_euclid(3) {
                            0 => blocks::TIRE,
                            1 => blocks::STEEL,
                            _ => blocks::RUST,
                        };
                        w.set_raw(hx + dx, GROUND_Y + 1 + dy, hz + dz, b);
                    }
                }
            }
        }
    }
}

fn tire_stacks(w: &mut World, seed: u32) {
    for i in 0..8 {
        let x = 10 + (hash01(i, 7, seed ^ 0x7e) * (SX - 20) as f32) as i32;
        let z = 10 + (hash01(7, i, seed ^ 0x7e) * (SZ - 20) as f32) as i32;
        let h = 2 + (hash01(i, i, seed ^ 0x3) * 3.0) as i32;
        for y in 0..h {
            w.set_raw(x, GROUND_Y + 1 + y, z, blocks::TIRE);
        }
    }
}
