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

// Scrapyard materials.
pub const ASPHALT: u8 = 10; // ground surface
pub const GRAVEL: u8 = 11; // sub-ground / dirt piles
pub const CONCRETE: u8 = 12; // office, pads, crane base
pub const RUST: u8 = 13; // corroded metal / scrap / car bodies
pub const STEEL: u8 = 14; // clean metal / containers / crane
pub const HAZARD: u8 = 15; // yellow crane / hazard markings
pub const CAR_RED: u8 = 16;
pub const CAR_BLUE: u8 = 17;
pub const CONTAINER_GREEN: u8 = 18;
pub const WINDOW: u8 = 19; // opaque dark glass
pub const TIRE: u8 = 20; // black rubber

pub const NUM_BLOCKS: u8 = 21;

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
        ASPHALT => [58, 60, 66],
        GRAVEL => [120, 110, 96],
        CONCRETE => [166, 164, 156],
        RUST => [150, 82, 48],
        STEEL => [120, 128, 136],
        HAZARD => [222, 184, 44],
        CAR_RED => [172, 56, 46],
        CAR_BLUE => [54, 86, 150],
        CONTAINER_GREEN => [74, 112, 74],
        WINDOW => [78, 104, 120],
        TIRE => [30, 30, 34],
        _ => [255, 0, 255],
    }
}
