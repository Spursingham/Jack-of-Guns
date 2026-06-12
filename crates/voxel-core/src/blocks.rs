//! Block identifiers and per-block properties.

pub const AIR: u8 = 0;
pub const GRASS: u8 = 1;
pub const DIRT: u8 = 2;
pub const STONE: u8 = 3;
pub const SAND: u8 = 4;
pub const WOOD: u8 = 5;
pub const LEAVES: u8 = 6;
pub const BRICK: u8 = 7;
pub const SNOW: u8 = 8;
pub const BEDROCK: u8 = 9;

pub const NUM_BLOCKS: u8 = 10;

#[inline]
pub fn is_solid(b: u8) -> bool {
    b != AIR
}

/// Bedrock keeps the map floor intact no matter what.
#[inline]
pub fn is_breakable(b: u8) -> bool {
    b != AIR && b != BEDROCK
}

/// Base sRGB color per block id (flat-colored voxels, Ace of Spades style).
pub fn color(b: u8) -> [u8; 3] {
    match b {
        GRASS => [106, 170, 64],
        DIRT => [134, 96, 67],
        STONE => [136, 140, 141],
        SAND => [218, 210, 158],
        WOOD => [161, 127, 81],
        LEAVES => [60, 129, 51],
        BRICK => [188, 74, 60],
        SNOW => [235, 240, 244],
        BEDROCK => [48, 48, 52],
        _ => [255, 0, 255],
    }
}
