// Binary wire protocol (little-endian).
// Byte-for-byte mirror of crates/server/src/protocol.rs — keep in sync.

export enum C2S {
  Join = 0x01,
  State = 0x02,
  SetBlock = 0x03,
  Shoot = 0x04,
  Respawn = 0x05,
  ThrowGrenade = 0x06,
  FireRocket = 0x07,
}

export enum S2C {
  Welcome = 0x80,
  PlayerJoined = 0x81,
  PlayerLeft = 0x82,
  Snapshot = 0x83,
  BlockSet = 0x84,
  Shot = 0x85,
  Explosion = 0x86,
  Damage = 0x87,
  Death = 0x88,
  Spawn = 0x89,
  GrenadeThrown = 0x8a,
  RocketFired = 0x8b,
}

class Writer {
  private buf = new Uint8Array(256);
  private view = new DataView(this.buf.buffer);
  private pos = 0;

  constructor(type: number) {
    this.u8(type);
  }
  private grow(n: number) {
    if (this.pos + n <= this.buf.length) return;
    const nb = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n));
    nb.set(this.buf);
    this.buf = nb;
    this.view = new DataView(nb.buffer);
  }
  u8(v: number) {
    this.grow(1);
    this.view.setUint8(this.pos, v);
    this.pos += 1;
    return this;
  }
  u16(v: number) {
    this.grow(2);
    this.view.setUint16(this.pos, v, true);
    this.pos += 2;
    return this;
  }
  u32(v: number) {
    this.grow(4);
    this.view.setUint32(this.pos, v >>> 0, true);
    this.pos += 4;
    return this;
  }
  f32(v: number) {
    this.grow(4);
    this.view.setFloat32(this.pos, v, true);
    this.pos += 4;
    return this;
  }
  vec3(v: { x: number; y: number; z: number }) {
    return this.f32(v.x).f32(v.y).f32(v.z);
  }
  str8(s: string) {
    const b = new TextEncoder().encode(s).slice(0, 255);
    this.u8(b.length);
    this.grow(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
    return this;
  }
  bytes(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

class Reader {
  private view: DataView;
  private pos = 0;
  constructor(private buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  get remaining() {
    return this.buf.length - this.pos;
  }
  u8(): number {
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }
  u16(): number {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f32(): number {
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }
  vec3(): [number, number, number] {
    return [this.f32(), this.f32(), this.f32()];
  }
  str8(): string {
    const n = this.u8();
    const s = new TextDecoder().decode(this.buf.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }
}

// ---- C2S encoders ---------------------------------------------------------

export const encode = {
  join(name: string, classId: number): Uint8Array {
    return new Writer(C2S.Join).u8(classId).str8(name).bytes();
  },
  state(
    pos: { x: number; y: number; z: number },
    vel: { x: number; y: number; z: number },
    yaw: number,
    pitch: number,
    flags: number,
  ): Uint8Array {
    return new Writer(C2S.State).vec3(pos).vec3(vel).f32(yaw).f32(pitch).u8(flags).bytes();
  },
  setBlock(x: number, y: number, z: number, b: number): Uint8Array {
    return new Writer(C2S.SetBlock).u16(x).u16(y).u16(z).u8(b).bytes();
  },
  shoot(
    weapon: number,
    origin: { x: number; y: number; z: number },
    dir: { x: number; y: number; z: number },
    seed: number,
  ): Uint8Array {
    return new Writer(C2S.Shoot).u8(weapon).vec3(origin).vec3(dir).u32(seed).bytes();
  },
  respawn(classId: number): Uint8Array {
    return new Writer(C2S.Respawn).u8(classId).bytes();
  },
  throwGrenade(
    origin: { x: number; y: number; z: number },
    vel: { x: number; y: number; z: number },
  ): Uint8Array {
    return new Writer(C2S.ThrowGrenade).vec3(origin).vec3(vel).bytes();
  },
  fireRocket(
    origin: { x: number; y: number; z: number },
    dir: { x: number; y: number; z: number },
  ): Uint8Array {
    return new Writer(C2S.FireRocket).vec3(origin).vec3(dir).bytes();
  },
};

// ---- S2C decoded message shapes -------------------------------------------

export interface PlayerInfo {
  id: number;
  classId: number;
  hp: number;
  kills: number;
  deaths: number;
  name: string;
  pos: [number, number, number];
  yaw: number;
}

export type ServerMsg =
  | {
      t: "welcome";
      id: number;
      seed: number;
      spawn: [number, number, number];
      players: PlayerInfo[];
      edits: { x: number; y: number; z: number; b: number }[];
    }
  | { t: "playerJoined"; id: number; classId: number; name: string; pos: [number, number, number] }
  | { t: "playerLeft"; id: number }
  | {
      t: "snapshot";
      players: { id: number; pos: [number, number, number]; yaw: number; pitch: number; flags: number; hp: number }[];
    }
  | { t: "blockSet"; x: number; y: number; z: number; b: number }
  | { t: "shot"; shooter: number; weapon: number; origin: [number, number, number]; end: [number, number, number] }
  | { t: "explosion"; pos: [number, number, number]; radius: number }
  | { t: "damage"; target: number; attacker: number; hp: number }
  | { t: "death"; victim: number; killer: number; cause: number }
  | { t: "spawn"; id: number; pos: [number, number, number]; classId: number; hp: number }
  | { t: "grenadeThrown"; owner: number; origin: [number, number, number]; vel: [number, number, number]; fuse: number }
  | { t: "rocketFired"; owner: number; origin: [number, number, number]; dir: [number, number, number] };

export function decode(buf: Uint8Array): ServerMsg | null {
  if (buf.length === 0) return null;
  const r = new Reader(buf);
  const type = r.u8();
  switch (type) {
    case S2C.Welcome: {
      const id = r.u8();
      const seed = r.u32();
      const spawn = r.vec3();
      const n = r.u8();
      const players: PlayerInfo[] = [];
      for (let i = 0; i < n; i++) {
        const pid = r.u8();
        const classId = r.u8();
        const hp = r.u8();
        const kills = r.u16();
        const deaths = r.u16();
        const name = r.str8();
        const pos = r.vec3();
        const yaw = r.f32();
        players.push({ id: pid, classId, hp, kills, deaths, name, pos, yaw });
      }
      const ne = r.u32();
      const edits = [];
      for (let i = 0; i < ne; i++) {
        edits.push({ x: r.u16(), y: r.u16(), z: r.u16(), b: r.u8() });
      }
      return { t: "welcome", id, seed, spawn, players, edits };
    }
    case S2C.PlayerJoined: {
      const id = r.u8();
      const classId = r.u8();
      const name = r.str8();
      return { t: "playerJoined", id, classId, name, pos: r.vec3() };
    }
    case S2C.PlayerLeft:
      return { t: "playerLeft", id: r.u8() };
    case S2C.Snapshot: {
      const n = r.u8();
      const players = [];
      for (let i = 0; i < n; i++) {
        players.push({ id: r.u8(), pos: r.vec3(), yaw: r.f32(), pitch: r.f32(), flags: r.u8(), hp: r.u8() });
      }
      return { t: "snapshot", players };
    }
    case S2C.BlockSet:
      return { t: "blockSet", x: r.u16(), y: r.u16(), z: r.u16(), b: r.u8() };
    case S2C.Shot: {
      const shooter = r.u8();
      const weapon = r.u8();
      return { t: "shot", shooter, weapon, origin: r.vec3(), end: r.vec3() };
    }
    case S2C.Explosion:
      return { t: "explosion", pos: r.vec3(), radius: r.f32() };
    case S2C.Damage:
      return { t: "damage", target: r.u8(), attacker: r.u8(), hp: r.u8() };
    case S2C.Death:
      return { t: "death", victim: r.u8(), killer: r.u8(), cause: r.u8() };
    case S2C.Spawn: {
      const id = r.u8();
      const pos = r.vec3();
      return { t: "spawn", id, pos, classId: r.u8(), hp: r.u8() };
    }
    case S2C.GrenadeThrown: {
      const owner = r.u8();
      return { t: "grenadeThrown", owner, origin: r.vec3(), vel: r.vec3(), fuse: r.f32() };
    }
    case S2C.RocketFired: {
      const owner = r.u8();
      return { t: "rocketFired", owner, origin: r.vec3(), dir: r.vec3() };
    }
    default:
      return null;
  }
}

/// Deterministic pellet spread — mirrors spread_dir() in game.rs so shotgun
/// tracers roughly match where the server says pellets went.
export function spreadDir(
  dir: [number, number, number],
  spread: number,
  seed: number,
  pellet: number,
): [number, number, number] {
  let h = (seed + Math.imul(pellet, 0x9e3779b9)) >>> 0;
  const next = () => {
    h ^= (h << 13) >>> 0;
    h >>>= 0;
    h ^= h >>> 17;
    h ^= (h << 5) >>> 0;
    h >>>= 0;
    return (h & 0xffff) / 65536 - 0.5;
  };
  const rx = next(),
    ry = next(),
    rz = next();
  const d: [number, number, number] = [
    dir[0] + rx * spread * 2,
    dir[1] + ry * spread * 2,
    dir[2] + rz * spread * 2,
  ];
  const l = Math.max(1e-6, Math.hypot(d[0], d[1], d[2]));
  return [d[0] / l, d[1] / l, d[2] / l];
}
