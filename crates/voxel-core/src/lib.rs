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
/// World size in chunks (X, Y, Z).
pub const WORLD_CHUNKS: (i32, i32, i32) = (8, 2, 8);
/// World size in voxels.
pub const SX: i32 = CHUNK * WORLD_CHUNKS.0;
pub const SY: i32 = CHUNK * WORLD_CHUNKS.1;
pub const SZ: i32 = CHUNK * WORLD_CHUNKS.2;
/// Visual water level (no water voxels; terrain below this gets sand).
pub const WATER_Y: f32 = 11.5;
