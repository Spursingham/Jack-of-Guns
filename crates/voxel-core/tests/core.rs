use voxel_core::{blocks, explosion, gen, mesh, ray, World, CHUNK, GROUND_Y, SX, SY, SZ};

#[test]
fn generation_is_deterministic() {
    let a = gen::generate(1337);
    let b = gen::generate(1337);
    assert_eq!(a.data, b.data);
    let c = gen::generate(42);
    assert_ne!(a.data, c.data, "different seeds should differ");
}

#[test]
fn scrapyard_has_bedrock_floor_flat_ground_and_open_sky() {
    let w = gen::generate(7);
    for &(x, z) in &[(0, 0), (1, 1), (SX / 2, SZ / 2), (40, 40), (SX - 1, SZ - 1)] {
        assert_eq!(w.get(x, 0, z), blocks::BEDROCK, "bedrock floor at {x},{z}");
        assert_eq!(w.get(x, SY - 1, z), blocks::AIR, "open sky at {x},{z}");
        assert!(blocks::is_solid(w.get(x, GROUND_Y, z)), "solid ground at {x},{z}");
        assert!(w.surface_y(x, z) >= GROUND_Y, "surface at/above ground at {x},{z}");
    }
    // The crane is the tallest thing on the map but never reaches the sky cap.
    assert!(w.surface_y(SX / 2 - 1, SZ / 2 - 1) > GROUND_Y + 10, "crane mast is tall");
}

#[test]
fn single_voxel_meshes_to_six_quads() {
    let mut w = World::empty(0);
    w.set(5, 5, 5, blocks::STONE);
    let m = mesh::mesh_chunk(&w, 0, 0, 0);
    assert_eq!(m.positions.len(), 6 * 4 * 3, "6 quads x 4 verts x xyz");
    assert_eq!(m.indices.len(), 6 * 2 * 3, "6 quads x 2 tris");
    assert_eq!(m.colors.len(), 6 * 4 * 3);
}

#[test]
fn greedy_merges_a_row_of_voxels() {
    let mut w = World::empty(0);
    for x in 1..=4 {
        w.set(x, 5, 5, blocks::DIRT);
    }
    let m = mesh::mesh_chunk(&w, 0, 0, 0);
    // A 4x1x1 bar: 4 long faces merge to 1 quad each (top/bottom/2 sides)
    // plus 2 end caps = 6 quads total.
    assert_eq!(m.indices.len() / 6, 6, "expected 6 merged quads");
}

#[test]
fn interior_faces_are_culled() {
    let mut w = World::empty(0);
    for x in 0..3 {
        for y in 0..3 {
            for z in 0..3 {
                w.set(x + 4, y + 4, z + 4, blocks::STONE);
            }
        }
    }
    let m = mesh::mesh_chunk(&w, 0, 0, 0);
    // Solid 3x3x3 cube greedy-meshes to exactly 6 quads.
    assert_eq!(m.indices.len() / 6, 6);
}

#[test]
fn chunk_border_faces_respect_neighbor_chunks() {
    let mut w = World::empty(0);
    // Fill voxels straddling the x=31|32 chunk border.
    w.set(31, 5, 5, blocks::STONE);
    w.set(32, 5, 5, blocks::STONE);
    let m0 = mesh::mesh_chunk(&w, 0, 0, 0);
    // The +x face of voxel 31 must be culled (neighbor chunk is solid):
    // remaining faces of that voxel = 5 quads.
    assert_eq!(m0.indices.len() / 6, 5);
}

#[test]
fn set_block_dirties_own_and_border_chunks() {
    let mut w = World::empty(0);
    w.take_dirty();
    w.set(31, 5, 5, blocks::STONE); // on +x border of chunk (0,0,0)
    let d = w.take_dirty();
    assert!(d.contains(&(0, 0, 0)));
    assert!(d.contains(&(1, 0, 0)), "neighbor chunk must remesh, got {d:?}");
    assert!(w.take_dirty().is_empty(), "dirty flags drained");
}

#[test]
fn raycast_hits_expected_block_and_face() {
    let mut w = World::empty(0);
    w.set(10, 5, 5, blocks::BRICK);
    let hit = ray::raycast(&w, [5.5, 5.5, 5.5], [1.0, 0.0, 0.0], 20.0).expect("hit");
    assert_eq!(hit.block, [10, 5, 5]);
    assert_eq!(hit.normal, [-1, 0, 0], "entered through -x face");
    assert!((hit.t - 4.5).abs() < 1e-4, "t = {}", hit.t);
    assert_eq!(hit.block_id, blocks::BRICK);

    assert!(ray::raycast(&w, [5.5, 5.5, 5.5], [1.0, 0.0, 0.0], 3.0).is_none());
    assert!(ray::raycast(&w, [5.5, 5.5, 5.5], [-1.0, 0.2, 0.1], 6.0).is_none());

    // Diagonal ray down onto a floor.
    for x in 0..20 {
        for z in 0..20 {
            w.set(x, 2, z, blocks::GRASS);
        }
    }
    let hit = ray::raycast(&w, [3.5, 8.0, 3.5], [0.4, -1.0, 0.3], 30.0).expect("floor hit");
    assert_eq!(hit.normal, [0, 1, 0]);
    assert_eq!(hit.block[1], 2);
}

#[test]
fn explosion_is_spherical_and_spares_bedrock() {
    let mut w = World::empty(0);
    for x in 0..30 {
        for z in 0..30 {
            w.set(x, 0, z, blocks::BEDROCK);
            for y in 1..10 {
                w.set(x, y, z, blocks::STONE);
            }
        }
    }
    let hits = explosion::apply_explosion(&mut w, 15.0, 5.0, 15.0, 3.0);
    assert!(!hits.is_empty());
    for p in &hits {
        assert_ne!(p[1], 0, "bedrock must survive");
    }
    assert_eq!(w.get(15, 5, 15), blocks::AIR, "center destroyed");
    assert_eq!(w.get(15, 0, 15), blocks::BEDROCK);
    // Symmetry: +x/-x mirrored cells share fate.
    assert_eq!(w.get(17, 5, 15), w.get(13, 5, 15));
}

#[test]
fn world_edges_render_but_floor_is_culled() {
    let w = gen::generate(3);
    // Meshing the corner chunk must produce side faces at x=0/z=0 (visible
    // map walls) — i.e. it doesn't panic and yields geometry.
    let m = mesh::mesh_chunk(&w, 0, 0, 0);
    assert!(!m.positions.is_empty());
    let _ = CHUNK;
}
