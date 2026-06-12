// Local combat: weapon state machine (ammo/reload/cooldown), hitscan with
// client prediction, cosmetic grenade/rocket entities, explosions with
// knockback (rocket jumps!). The server stays authoritative for damage and
// world edits — predictions are reconciled by server echo / corrections.
import * as THREE from "three";
import type { VoxelWorld } from "../wasm/voxel";
import type { NetClient } from "../net/client";
import { spreadDir } from "../net/protocol";
import type { Avatars } from "./avatars";
import { sfx } from "./audio";
import type { Effects } from "./effects";
import type { Hud } from "./hud";
import {
  Block,
  BLOCK_COLORS,
  CLASSES,
  GRENADE,
  MOVE,
  ROCKET,
  WEAPONS,
  Weapon,
  slotsFor,
  type Slot,
} from "./items";
import type { PlayerBody } from "../engine/physics";
import { ViewModel } from "./viewmodel";

interface AmmoState {
  mag: number;
  reloadingUntil: number;
}

interface Nade {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  detonateAt: number;
  mine: boolean;
}

interface Rkt {
  mesh: THREE.Mesh;
  dir: THREE.Vector3;
  mine: boolean;
  smokeT: number;
}

export interface CombatDeps {
  world: VoxelWorld;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  body: PlayerBody;
  effects: Effects;
  avatars: Avatars;
  hud: Hud;
  net: NetClient;
  viewmodel: ViewModel;
  /** Offline self-damage path (sandbox mode). */
  onLocalDamage: (dmg: number, cause: number) => void;
}

export class Combat {
  slots: Slot[] = [];
  selected = 0;
  classId = 0;
  blocks = 100;
  grenades = 0;
  zoomed = false;

  private ammo = new Map<number, AmmoState>();
  private cooldownUntil = 0;
  private nades: Nade[] = [];
  private rockets: Rkt[] = [];
  private nadeGeo = new THREE.SphereGeometry(0.13, 8, 6);
  private nadeMat = new THREE.MeshLambertMaterial({ color: 0x3a5232 });
  private rktGeo = new THREE.BoxGeometry(0.16, 0.16, 0.5);
  private rktMat = new THREE.MeshLambertMaterial({ color: 0x4a4f38 });

  constructor(private d: CombatDeps) {}

  setClass(classId: number) {
    this.classId = classId;
    const c = CLASSES[classId];
    this.slots = slotsFor(classId);
    this.selected = 0;
    this.blocks = c.blockCap;
    this.grenades = c.secondary === "grenade" ? 4 : 0;
    this.ammo.clear();
    for (const s of this.slots) {
      if (s.kind === "weapon" && WEAPONS[s.weapon].mag > 0) {
        this.ammo.set(s.weapon, { mag: WEAPONS[s.weapon].mag, reloadingUntil: 0 });
      }
    }
    this.cooldownUntil = 0;
    this.d.hud.buildHotbar(this.slots, this.grenades);
    this.d.hud.selectSlot(0);
    this.d.viewmodel.setSlot(this.slots[0]);
  }

  get currentSlot(): Slot {
    return this.slots[this.selected];
  }

  selectSlot(i: number) {
    if (i < 0 || i >= this.slots.length || i === this.selected) return;
    this.selected = i;
    this.zoomed = false;
    this.d.hud.selectSlot(i);
    this.d.viewmodel.setSlot(this.slots[i]);
  }

  cycleSlot(dir: number) {
    this.selectSlot((this.selected + dir + this.slots.length) % this.slots.length);
  }

  private eyeDir(): { eye: THREE.Vector3; dir: THREE.Vector3 } {
    const eye = this.d.body.eye();
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.d.camera.quaternion);
    return { eye, dir };
  }

  private muzzle(): THREE.Vector3 {
    const c = this.d.camera;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(c.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(c.quaternion);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(c.quaternion);
    return this.d.body.eye().addScaledVector(right, 0.22).addScaledVector(up, -0.14).addScaledVector(fwd, 0.4);
  }

  reload() {
    const s = this.currentSlot;
    if (s.kind !== "weapon") return;
    const def = WEAPONS[s.weapon];
    const a = this.ammo.get(s.weapon);
    if (!def || !a || def.mag === 0 || a.mag === def.mag) return;
    const now = performance.now() / 1000;
    if (a.reloadingUntil > now) return;
    a.reloadingUntil = now + def.reload;
    sfx.reload();
    this.d.viewmodel.reloadDip();
  }

  /** Called every frame with input state. `lmbEdge`/`rmbEdge` = pressed this frame. */
  update(dt: number, lmbHeld: boolean, rmbHeld: boolean, lmbEdge: boolean, rmbEdge: boolean, alive: boolean) {
    const now = performance.now() / 1000;

    // Finish reloads.
    for (const [w, a] of this.ammo) {
      if (a.reloadingUntil > 0 && a.reloadingUntil <= now) {
        a.mag = WEAPONS[w].mag;
        a.reloadingUntil = 0;
      }
    }

    if (alive) {
      const slot = this.currentSlot;
      // Zoom (RMB on a scoped weapon).
      const zoomable = slot.kind === "weapon" && WEAPONS[slot.weapon].zoom !== undefined;
      this.zoomed = zoomable && rmbHeld;

      // Fire logic.
      if (slot.kind === "weapon") {
        const def = WEAPONS[slot.weapon];
        const wantFire = def.auto ? lmbHeld : lmbEdge;
        if (wantFire) this.tryUseWeapon(slot.weapon, now);
      } else if (slot.kind === "grenade") {
        if (lmbEdge) this.tryThrowGrenade(now);
      } else if (slot.kind === "block") {
        if (lmbHeld) this.tryDig(now, 0.45);
        if (rmbHeld || rmbEdge) this.tryPlace(slot.block, now);
      }
    } else {
      this.zoomed = false;
    }

    this.stepProjectiles(dt, now);
    this.updateHudAmmo(now);
    this.d.hud.setZoomed(this.zoomed);
  }

  private updateHudAmmo(now: number) {
    const s = this.currentSlot;
    if (s.kind === "weapon") {
      const def = WEAPONS[s.weapon];
      const a = this.ammo.get(s.weapon);
      if (def.mag === 0 || !a) {
        this.d.hud.setAmmo("--", def.name);
      } else if (a.reloadingUntil > now) {
        this.d.hud.setAmmo("RELOADING", def.name);
      } else {
        this.d.hud.setAmmo(`${a.mag} / ∞`, def.name);
      }
    } else if (s.kind === "grenade") {
      this.d.hud.setAmmo(`${this.grenades}`, "Grenades");
    } else {
      this.d.hud.setAmmo(`${this.blocks}`, `${s.name} — RMB place / LMB dig`);
    }
    const cap = CLASSES[this.classId].blockCap;
    this.d.hud.setBlocks(this.blocks, cap);
  }

  // ---- weapons ---------------------------------------------------------

  private tryUseWeapon(w: Weapon, now: number) {
    const def = WEAPONS[w];
    if (now < this.cooldownUntil) return;
    if (def.melee) {
      this.cooldownUntil = now + def.cooldown;
      this.melee(w);
      return;
    }
    const a = this.ammo.get(w);
    if (!a) return;
    if (a.reloadingUntil > now) return;
    if (a.mag <= 0) {
      this.reloadWeapon(w, now);
      return;
    }
    this.cooldownUntil = now + def.cooldown;
    a.mag--;

    if (w === Weapon.Rocket) {
      this.fireRocket();
      if (a.mag === 0) this.reloadWeapon(w, now);
      return;
    }
    this.fireHitscan(w, def);
    if (a.mag === 0) this.reloadWeapon(w, now);
  }

  private reloadWeapon(w: Weapon, now: number) {
    const def = WEAPONS[w];
    const a = this.ammo.get(w);
    if (!a || a.reloadingUntil > now) return;
    a.reloadingUntil = now + def.reload;
    sfx.reload();
    this.d.viewmodel.reloadDip();
  }

  private fireHitscan(w: Weapon, def: (typeof WEAPONS)[number]) {
    const { eye, dir } = this.eyeDir();
    const seed = (Math.random() * 0xffffffff) >>> 0;
    const muzzle = this.muzzle();

    for (let i = 0; i < def.pellets; i++) {
      const d3: [number, number, number] =
        def.pellets > 1 || def.spread > 0 ? spreadDir([dir.x, dir.y, dir.z], def.spread, seed, i) : [dir.x, dir.y, dir.z];

      const hit = this.d.world.raycast(eye.x, eye.y, eye.z, d3[0], d3[1], d3[2], def.range);
      let tBlock = Infinity;
      if (hit.length > 0) tBlock = hit[6];

      // Client-side avatar check (feedback only; server decides damage).
      let tAvatar = Infinity;
      for (const p of this.d.avatars.players.values()) {
        if (!p.alive) continue;
        const t = rayAabb(eye, new THREE.Vector3(d3[0], d3[1], d3[2]), p.renderPos, 0.4, 1.8);
        if (t !== null && t < tAvatar) tAvatar = t;
      }

      const tEnd = Math.min(tBlock, tAvatar, def.range);
      const end = new THREE.Vector3(eye.x + d3[0] * tEnd, eye.y + d3[1] * tEnd, eye.z + d3[2] * tEnd);
      this.d.effects.tracer(muzzle, end);

      if (tAvatar < tBlock) {
        this.d.effects.burst(end, [165, 40, 40], 5, 2.5);
      } else if (hit.length > 0) {
        const bx = hit[0], by = hit[1], bz = hit[2];
        const id = hit[7] | 0;
        const color = BLOCK_COLORS[id] ?? [120, 120, 120];
        this.d.effects.burst(end, color, 5, 3);
        // Predict the block break (server echoes BlockSet; corrects if not).
        if (def.breaksBlocks && this.d.world.is_breakable(bx, by, bz)) {
          this.d.world.set_block(bx, by, bz, Block.Air);
          if (!this.d.net.connected) sfx.break();
        }
      }
    }

    this.d.net.sendShoot(w, { x: eye.x, y: eye.y, z: eye.z }, { x: dir.x, y: dir.y, z: dir.z }, seed);
    sfx.shoot(w);
    this.d.viewmodel.recoil(w === Weapon.Shotgun ? 1.4 : w === Weapon.Rifle ? 1 : 0.45);
    this.d.effects.shake(w === Weapon.Shotgun ? 0.05 : 0.02);
  }

  private melee(w: Weapon) {
    const def = WEAPONS[w];
    const { eye, dir } = this.eyeDir();
    sfx.shoot(w);
    this.d.viewmodel.recoil(0.7);

    const hit = this.d.world.raycast(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, def.range);
    if (hit.length > 0) {
      const bx = hit[0], by = hit[1], bz = hit[2];
      if (this.d.world.is_breakable(bx, by, bz)) {
        const id = this.d.world.get_block(bx, by, bz);
        const color = BLOCK_COLORS[id] ?? [120, 120, 120];
        this.d.world.set_block(bx, by, bz, Block.Air);
        this.d.net.sendSetBlock(bx, by, bz, Block.Air);
        const cap = CLASSES[this.classId].blockCap;
        this.blocks = Math.min(cap, this.blocks + 1);
        this.d.effects.burst(new THREE.Vector3(bx + 0.5, by + 0.5, bz + 0.5), color, 14, 3.5);
        sfx.break();
      }
    }
    // Server checks players along the melee ray.
    this.d.net.sendShoot(w, { x: eye.x, y: eye.y, z: eye.z }, { x: dir.x, y: dir.y, z: dir.z }, 0);
  }

  private tryDig(now: number, cd: number) {
    if (now < this.cooldownUntil) return;
    const { eye, dir } = this.eyeDir();
    const hit = this.d.world.raycast(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, MOVE.reach);
    if (hit.length === 0) return;
    this.cooldownUntil = now + cd;
    const bx = hit[0], by = hit[1], bz = hit[2];
    if (!this.d.world.is_breakable(bx, by, bz)) return;
    const id = this.d.world.get_block(bx, by, bz);
    this.d.world.set_block(bx, by, bz, Block.Air);
    this.d.net.sendSetBlock(bx, by, bz, Block.Air);
    const cap = CLASSES[this.classId].blockCap;
    this.blocks = Math.min(cap, this.blocks + 1);
    this.d.effects.burst(new THREE.Vector3(bx + 0.5, by + 0.5, bz + 0.5), BLOCK_COLORS[id] ?? [120, 120, 120], 12, 3.5);
    sfx.break();
    this.d.viewmodel.recoil(0.5);
  }

  private tryPlace(block: Block, now: number) {
    if (now < this.cooldownUntil || this.blocks <= 0) return;
    const { eye, dir } = this.eyeDir();
    const hit = this.d.world.raycast(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, MOVE.reach);
    if (hit.length === 0) return;
    const [bx, by, bz, nx, ny, nz] = hit;
    if (nx === 0 && ny === 0 && nz === 0) return;
    const px = bx + nx, py = by + ny, pz = bz + nz;
    if (px < 0 || py < 0 || pz < 0 || px >= this.d.world.size_x() || py >= this.d.world.size_y() || pz >= this.d.world.size_z()) return;
    if (this.d.world.get_block(px, py, pz) !== Block.Air) return;
    // Don't entomb yourself.
    const b = this.d.body;
    if (
      px + 1 > b.pos.x - MOVE.bodyHalfW && px < b.pos.x + MOVE.bodyHalfW &&
      py + 1 > b.pos.y && py < b.pos.y + b.height &&
      pz + 1 > b.pos.z - MOVE.bodyHalfW && pz < b.pos.z + MOVE.bodyHalfW
    ) {
      return;
    }
    const buildCd = 0.24 * CLASSES[this.classId].buildCdMult;
    this.cooldownUntil = now + buildCd;
    this.blocks--;
    this.d.world.set_block(px, py, pz, block);
    this.d.net.sendSetBlock(px, py, pz, block);
    sfx.place();
    this.d.viewmodel.recoil(0.3);
  }

  private tryThrowGrenade(now: number) {
    if (now < this.cooldownUntil || this.grenades <= 0) return;
    this.cooldownUntil = now + 0.6;
    this.grenades--;
    this.d.hud.updateGrenadeCount(this.grenades);
    const { eye, dir } = this.eyeDir();
    const origin = eye.clone().addScaledVector(dir, 0.4);
    const vel = dir.clone().multiplyScalar(GRENADE.throwSpeed).addScaledVector(this.d.body.vel, 0.35);
    this.spawnNade(origin, vel, now + GRENADE.fuse, true);
    this.d.net.sendThrowGrenade({ x: origin.x, y: origin.y, z: origin.z }, { x: vel.x, y: vel.y, z: vel.z });
    this.d.viewmodel.recoil(0.8);
  }

  private fireRocket() {
    const { eye, dir } = this.eyeDir();
    const origin = eye.clone().addScaledVector(dir, 0.6);
    this.spawnRocket(origin, dir.clone(), true);
    this.d.net.sendFireRocket({ x: origin.x, y: origin.y, z: origin.z }, { x: dir.x, y: dir.y, z: dir.z });
    sfx.shoot(Weapon.Rocket);
    this.d.viewmodel.recoil(1.5);
    this.d.effects.shake(0.08);
  }

  // ---- cosmetic projectiles (server is authoritative for the boom) ------

  spawnNade(origin: THREE.Vector3, vel: THREE.Vector3, detonateAt: number, mine: boolean) {
    const mesh = new THREE.Mesh(this.nadeGeo, this.nadeMat);
    mesh.position.copy(origin);
    this.d.scene.add(mesh);
    this.nades.push({ mesh, vel: vel.clone(), detonateAt, mine });
  }

  spawnRocket(origin: THREE.Vector3, dir: THREE.Vector3, mine: boolean) {
    const mesh = new THREE.Mesh(this.rktGeo, this.rktMat);
    mesh.position.copy(origin);
    mesh.lookAt(origin.clone().add(dir));
    this.d.scene.add(mesh);
    this.rockets.push({ mesh, dir: dir.clone().normalize(), mine, smokeT: 0 });
  }

  private stepProjectiles(dt: number, now: number) {
    for (let i = this.nades.length - 1; i >= 0; i--) {
      const n = this.nades[i];
      n.vel.y -= GRENADE.gravity * dt;
      const p = n.mesh.position;
      for (const axis of ["x", "y", "z"] as const) {
        const np = p[axis] + n.vel[axis] * dt;
        const test = p.clone();
        test[axis] = np;
        if (this.d.world.is_solid(Math.floor(test.x), Math.floor(test.y), Math.floor(test.z))) {
          n.vel[axis] *= -0.45;
          if (axis === "y") {
            n.vel.x *= 0.7;
            n.vel.z *= 0.7;
          }
        } else {
          p[axis] = np;
        }
      }
      if (now >= n.detonateAt) {
        if (!this.d.net.connected) {
          this.applyExplosion(p.clone(), GRENADE.radius, true);
        }
        this.removeNade(i);
      }
    }

    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i];
      const p = r.mesh.position;
      p.addScaledVector(r.dir, ROCKET.speed * dt);
      r.smokeT += dt;
      if (r.smokeT > 0.05) {
        r.smokeT = 0;
        this.d.effects.burst(p, [180, 180, 185], 1, 0.4, 0.08);
      }
      if (this.d.world.is_solid(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))) {
        if (!this.d.net.connected) {
          this.applyExplosion(p.clone(), ROCKET.radius, true);
        }
        this.removeRocket(i);
        continue;
      }
      if (p.y < -20 || p.y > this.d.world.size_y() + 80) this.removeRocket(i);
    }
  }

  private removeNade(i: number) {
    this.d.scene.remove(this.nades[i].mesh);
    this.nades.splice(i, 1);
  }
  private removeRocket(i: number) {
    this.d.scene.remove(this.rockets[i].mesh);
    this.rockets.splice(i, 1);
  }

  /** Server Explosion event (or local detonation when offline). */
  applyExplosion(at: THREE.Vector3, radius: number, offlineLocal = false) {
    // Deterministic world destruction (same code as the server).
    this.d.world.apply_explosion(at.x, at.y, at.z, radius);
    this.d.effects.explosionFx(at, radius, [134, 96, 67]);

    // Remove the nearest cosmetic projectile (it just detonated server-side).
    if (!offlineLocal) {
      let best = -1;
      let bestD = 4;
      this.nades.forEach((n, i) => {
        const d = n.mesh.position.distanceTo(at);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      if (best >= 0) this.removeNade(best);
      else {
        let bw = -1;
        let bd = 4;
        this.rockets.forEach((r, i) => {
          const d = r.mesh.position.distanceTo(at);
          if (d < bd) {
            bd = d;
            bw = i;
          }
        });
        if (bw >= 0) this.removeRocket(bw);
      }
    }

    // Knockback on the local player — this is what makes rocket jumps work.
    const body = this.d.body;
    const center = body.pos.clone().add(new THREE.Vector3(0, body.height * 0.5, 0));
    const dmgR = radius * 1.6;
    const dist = center.distanceTo(at);
    if (dist < dmgR) {
      const k = 1 - dist / dmgR;
      const push = center.clone().sub(at);
      if (push.lengthSq() < 1e-6) push.set(0, 1, 0);
      push.normalize();
      push.y += 0.45; // bias upward for satisfying launches
      push.normalize();
      body.vel.addScaledVector(push, k * 17);
      body.onGround = false;
      this.d.effects.shake(0.25 * k);
      if (offlineLocal) {
        this.d.onLocalDamage(Math.round(90 * k), 9);
      }
    }
    const { pan, vol } = panvolFor(at, body, this.d.body.yaw);
    sfx.explosion(pan, vol);
  }

  fovTarget(): number {
    const s = this.currentSlot;
    if (this.zoomed && s.kind === "weapon") {
      const z = WEAPONS[s.weapon].zoom;
      if (z) return z;
    }
    return 0; // 0 = base fov
  }
}

function panvolFor(at: THREE.Vector3, body: PlayerBody, yaw: number): { pan: number; vol: number } {
  const dx = at.x - body.pos.x;
  const dz = at.z - body.pos.z;
  const dist = Math.hypot(dx, dz);
  const vol = Math.max(0.15, 1 - dist / 80);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  const pan = dist < 0.5 ? 0 : Math.max(-1, Math.min(1, (dx * rx + dz * rz) / dist)) * 0.7;
  return { pan, vol };
}

/** Ray vs player-sized AABB centered at feet pos. Returns t or null. */
function rayAabb(origin: THREE.Vector3, dir: THREE.Vector3, feet: THREE.Vector3, halfW: number, height: number): number | null {
  let tmin = 0;
  let tmax = Infinity;
  const lo = [feet.x - halfW, feet.y, feet.z - halfW];
  const hi = [feet.x + halfW, feet.y + height, feet.z + halfW];
  const o = [origin.x, origin.y, origin.z];
  const d = [dir.x, dir.y, dir.z];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < lo[a] || o[a] > hi[a]) return null;
    } else {
      let t0 = (lo[a] - o[a]) / d[a];
      let t1 = (hi[a] - o[a]) / d[a];
      if (t0 > t1) [t0, t1] = [t1, t0];
      tmin = Math.max(tmin, t0);
      tmax = Math.min(tmax, t1);
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}
