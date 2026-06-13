// Weapon / class / block definitions.
// Damage, cooldown, range, pellets and spread MUST mirror the server table
// in crates/server/src/game.rs — the server is authoritative, these values
// only drive prediction and presentation.

export enum Weapon {
  Rifle = 0,
  AR = 1,
  Rocket = 2,
  Shotgun = 3,
  Pistol = 4,
  Spade = 5,
  Grenade = 6,
  Pickaxe = 7,
}

export const CAUSE_GRENADE = 8;
export const CAUSE_ROCKET = 9;

export interface WeaponDef {
  name: string;
  short: string;
  damage: number;
  cooldown: number; // seconds between uses
  range: number;
  mag: number; // 0 = no ammo concept (melee)
  reload: number;
  auto: boolean;
  pellets: number;
  spread: number;
  breaksBlocks: boolean;
  zoom?: number; // fov when aiming (RMB)
  melee?: boolean;
}

export const WEAPONS: Record<number, WeaponDef> = {
  [Weapon.Rifle]: { name: "Marksman Rifle", short: "RIFLE", damage: 55, cooldown: 0.55, range: 220, mag: 8, reload: 1.6, auto: false, pellets: 1, spread: 0, breaksBlocks: true, zoom: 28 },
  [Weapon.AR]: { name: "Assault Rifle", short: "AR", damage: 18, cooldown: 0.105, range: 160, mag: 30, reload: 2.0, auto: true, pellets: 1, spread: 0.012, breaksBlocks: true },
  [Weapon.Rocket]: { name: "Rocket Launcher", short: "RCKT", damage: 90, cooldown: 1.4, range: 300, mag: 1, reload: 1.4, auto: false, pellets: 1, spread: 0, breaksBlocks: true },
  [Weapon.Shotgun]: { name: "Shotgun", short: "SHTGN", damage: 9, cooldown: 0.9, range: 40, mag: 6, reload: 2.2, auto: false, pellets: 8, spread: 0.05, breaksBlocks: true },
  [Weapon.Pistol]: { name: "Pistol", short: "PISTL", damage: 26, cooldown: 0.24, range: 120, mag: 8, reload: 1.3, auto: false, pellets: 1, spread: 0.008, breaksBlocks: true },
  [Weapon.Spade]: { name: "Spade", short: "SPADE", damage: 45, cooldown: 0.5, range: 2.7, mag: 0, reload: 0, auto: true, pellets: 1, spread: 0, breaksBlocks: true, melee: true },
  [Weapon.Grenade]: { name: "Grenade", short: "NADE", damage: 95, cooldown: 0.6, range: 0, mag: 0, reload: 0, auto: false, pellets: 1, spread: 0, breaksBlocks: false },
  [Weapon.Pickaxe]: { name: "Pickaxe", short: "PICK", damage: 45, cooldown: 0.3, range: 2.9, mag: 0, reload: 0, auto: true, pellets: 1, spread: 0, breaksBlocks: true, melee: true },
};

export const WEAPON_KILL_NAME: Record<number, string> = {
  [Weapon.Rifle]: "rifle",
  [Weapon.AR]: "assault rifle",
  [Weapon.Rocket]: "rocket",
  [Weapon.Shotgun]: "shotgun",
  [Weapon.Pistol]: "pistol",
  [Weapon.Spade]: "spade",
  [Weapon.Grenade]: "grenade",
  [Weapon.Pickaxe]: "pickaxe",
  [CAUSE_GRENADE]: "grenade",
  [CAUSE_ROCKET]: "rocket",
};

// Block ids — mirror crates/voxel-core/src/blocks.rs. Colors here are only
// used for debris particles / HUD; the rendered world colors come from the
// Rust mesher.
export enum Block {
  Air = 0,
  Grass = 1,
  Dirt = 2,
  Stone = 3,
  Sand = 4,
  Wood = 5,
  Leaves = 6,
  Brick = 7,
  Snow = 8,
  Bedrock = 9,
  Asphalt = 10,
  Gravel = 11,
  Concrete = 12,
  Rust = 13,
  Steel = 14,
  Hazard = 15,
  CarRed = 16,
  CarBlue = 17,
  ContainerGreen = 18,
  Window = 19,
  Tire = 20,
}

export const BLOCK_COLORS: Record<number, [number, number, number]> = {
  [Block.Grass]: [106, 170, 64],
  [Block.Dirt]: [134, 96, 67],
  [Block.Stone]: [136, 140, 141],
  [Block.Sand]: [218, 210, 158],
  [Block.Wood]: [161, 127, 81],
  [Block.Leaves]: [60, 129, 51],
  [Block.Brick]: [188, 74, 60],
  [Block.Snow]: [235, 240, 244],
  [Block.Bedrock]: [48, 48, 52],
  [Block.Asphalt]: [58, 60, 66],
  [Block.Gravel]: [120, 110, 96],
  [Block.Concrete]: [166, 164, 156],
  [Block.Rust]: [150, 82, 48],
  [Block.Steel]: [120, 128, 136],
  [Block.Hazard]: [222, 184, 44],
  [Block.CarRed]: [172, 56, 46],
  [Block.CarBlue]: [54, 86, 150],
  [Block.ContainerGreen]: [74, 112, 74],
  [Block.Window]: [78, 104, 120],
  [Block.Tire]: [30, 30, 34],
};

export interface ClassDef {
  id: number;
  name: string;
  color: number; // avatar tint
  primary: Weapon;
  secondary: Weapon | "grenade";
  tool: Weapon;
  sprintMult: number;
  blockCap: number;
  buildCdMult: number; // miner builds faster
  perk: string;
}

export const CLASSES: ClassDef[] = [
  { id: 0, name: "Marksman", color: 0x4c8f3c, primary: Weapon.Rifle, secondary: Weapon.Pistol, tool: Weapon.Spade, sprintMult: 1.35, blockCap: 100, buildCdMult: 1, perk: "RMB scope zoom" },
  { id: 1, name: "Commando", color: 0xb06a2c, primary: Weapon.AR, secondary: "grenade", tool: Weapon.Spade, sprintMult: 1.6, blockCap: 100, buildCdMult: 1, perk: "Fast sprint, 4 grenades" },
  { id: 2, name: "Rocketeer", color: 0xa03838, primary: Weapon.Rocket, secondary: Weapon.Pistol, tool: Weapon.Spade, sprintMult: 1.35, blockCap: 100, buildCdMult: 1, perk: "Rocket jump (low self-dmg)" },
  { id: 3, name: "Wrecker", color: 0xc8a032, primary: Weapon.Shotgun, secondary: Weapon.Pickaxe, tool: Weapon.Pickaxe, sprintMult: 1.35, blockCap: 200, buildCdMult: 0.5, perk: "Shotgun + insta-dig pickaxe" },
];

export type Slot =
  | { kind: "weapon"; weapon: Weapon }
  | { kind: "grenade" }
  | { kind: "block"; block: Block; name: string };

export function slotsFor(classId: number): Slot[] {
  const c = CLASSES[classId] ?? CLASSES[0];
  const slots: Slot[] = [{ kind: "weapon", weapon: c.primary }];
  if (c.secondary === "grenade") slots.push({ kind: "grenade" });
  else if (c.secondary !== c.tool) slots.push({ kind: "weapon", weapon: c.secondary });
  slots.push({ kind: "weapon", weapon: c.tool }); // melee digging tool
  return slots;
}

// Movement constants (client prediction; server clamps speeds loosely).
export const MOVE = {
  walk: 4.5,
  crouchMult: 0.55,
  jumpVel: 8.0,
  gravity: 22,
  eyeStand: 1.62,
  eyeCrouch: 1.1,
  bodyHalfW: 0.35,
  bodyHStand: 1.8,
  bodyHCrouch: 1.3,
  reach: 5.5,
};

export const GRENADE = { fuse: 2.2, gravity: 18, radius: 4.2, throwSpeed: 13.5 };
export const ROCKET = { speed: 30, radius: 4.5 };
