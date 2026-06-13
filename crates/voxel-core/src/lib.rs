//! Shared voxel engine core: world storage, terrain generation, greedy
//! meshing, DDA raycasting and explosions. Compiled both to WASM (client)
//! and natively (authoritative server) so the two always agree on the world.

pub mod blocks;
pub mod explosion;
pub mod gen;
pub mod mesh;
pub mod noise;
pub mod ray;
pub mod world;

pub use blocks::*;
pub use world::World;

/// Chunk edge length in voxels.
pub const CHUNK: i32 = 32;
/// World size in chunks (X, Y, Z). Small scrapyard skirmish arena: 96x32x96.
/// (Y is one chunk; 0.5 isn't possible since size = chunks * CHUNK, and the
/// crane needs the vertical room anyway — the map stays "low" because the
/// ground is flat, not because the world is short.)
pub const WORLD_CHUNKS: (i32, i32, i32) = (3, 1, 3);
/// World size in voxels.
pub const SX: i32 = CHUNK * WORLD_CHUNKS.0;
pub const SY: i32 = CHUNK * WORLD_CHUNKS.1;
pub const SZ: i32 = CHUNK * WORLD_CHUNKS.2;
/// Top of the flat scrapyard ground (solid surface players stand on is here;
/// they walk at GROUND_Y + 1). Bedrock is at y=0.
pub const GROUND_Y: i32 = 3;
/// No water on this map. Kept at 0 so the old water-line spawn checks pass and
/// the underwater tint never triggers.
pub const WATER_Y: f32 = 0.0;
