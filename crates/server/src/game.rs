//! Authoritative game state: players, world edits, hitscan validation,
//! projectile simulation, damage and respawns. Runs as a single task fed by
//! a command channel — no locks anywhere.

use std::collections::HashMap;
use std::time::Instant;

use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use voxel_core::{blocks, explosion, gen, ray, World};

use crate::protocol::*;

pub const MAX_PLAYERS: usize = 32;
pub const TICK_HZ: u32 = 60;
/// Snapshots every Nth tick (20 Hz).
const SNAPSHOT_DIV: u32 = 3;

const EYE_STAND: f32 = 1.62;
const EYE_CROUCH: f32 = 1.10;
const BODY_HALF_W: f32 = 0.4;
const BODY_H_STAND: f32 = 1.8;
const BODY_H_CROUCH: f32 = 1.3;
const REACH: f32 = 6.0;
const RESPAWN_SECS: f32 = 2.8;
const GRENADE_FUSE: f32 = 2.2;
const GRENADE_GRAVITY: f32 = 18.0;
const GRENADE_RADIUS: f32 = 4.2;
const GRENADE_DMG: f32 = 95.0;
const ROCKET_SPEED: f32 = 30.0;
const ROCKET_RADIUS: f32 = 4.5;
const ROCKET_DMG: f32 = 90.0;
/// Rocketeers take reduced self-damage so rocket jumps are viable.
const ROCKET_SELF_MULT: f32 = 0.35;
const FLAG_CROUCH: u8 = 1;

pub enum Cmd {
    Join {
        name: String,
        class: u8,
        out: UnboundedSender<Vec<u8>>,
        reply: tokio::sync::oneshot::Sender<Option<u8>>,
    },
    Msg(u8, Vec<u8>),
    Leave(u8),
}

struct Weapon {
    damage: f32,
    cooldown: f32,
    range: f32,
    pellets: u32,
    spread: f32,
    breaks_blocks: bool,
}

fn weapon(id: u8) -> Option<Weapon> {
    let w = match id {
        W_RIFLE => Weapon { damage: 55.0, cooldown: 0.55, range: 220.0, pellets: 1, spread: 0.0, breaks_blocks: true },
        W_AR => Weapon { damage: 18.0, cooldown: 0.105, range: 160.0, pellets: 1, spread: 0.012, breaks_blocks: true },
        W_SHOTGUN => Weapon { damage: 9.0, cooldown: 0.9, range: 40.0, pellets: 8, spread: 0.05, breaks_blocks: true },
        W_PISTOL => Weapon { damage: 26.0, cooldown: 0.24, range: 120.0, pellets: 1, spread: 0.008, breaks_blocks: true },
        W_SPADE => Weapon { damage: 45.0, cooldown: 0.5, range: 2.7, pellets: 1, spread: 0.0, breaks_blocks: false },
        W_PICKAXE => Weapon { damage: 45.0, cooldown: 0.3, range: 2.9, pellets: 1, spread: 0.0, breaks_blocks: false },
        _ => return None,
    };
    Some(w)
}

/// Primary weapon for a class (used to validate Shoot messages loosely).
fn class_allows_weapon(class: u8, w: u8) -> bool {
    match w {
        W_RIFLE => class == 0,
        W_AR => class == 1,
        W_ROCKET => class == 2,
        W_SHOTGUN => class == 3,
        W_PISTOL => class == 0 || class == 2,
        W_SPADE => class != 3,
        W_PICKAXE => class == 3,
        _ => false,
    }
}

struct Player {
    name: String,
    class: u8,
    alive: bool,
    hp: f32,
    pos: [f32; 3],
    yaw: f32,
    pitch: f32,
    flags: u8,
    kills: u16,
    deaths: u16,
    grenades: u8,
    last_state: Instant,
    last_shot: Instant,
    last_grenade: Instant,
    died_at: Instant,
    just_spawned: bool,
    edit_tokens: f32,
    out: UnboundedSender<Vec<u8>>,
}

impl Player {
    fn eye(&self) -> [f32; 3] {
        let h = if self.flags & FLAG_CROUCH != 0 { EYE_CROUCH } else { EYE_STAND };
        [self.pos[0], self.pos[1] + h, self.pos[2]]
    }
    fn body_h(&self) -> f32 {
        if self.flags & FLAG_CROUCH != 0 { BODY_H_CROUCH } else { BODY_H_STAND }
    }
    fn aabb(&self) -> ([f32; 3], [f32; 3]) {
        (
            [self.pos[0] - BODY_HALF_W, self.pos[1], self.pos[2] - BODY_HALF_W],
            [self.pos[0] + BODY_HALF_W, self.pos[1] + self.body_h(), self.pos[2] + BODY_HALF_W],
        )
    }
    fn center(&self) -> [f32; 3] {
        [self.pos[0], self.pos[1] + self.body_h() * 0.5, self.pos[2]]
    }
}

enum Projectile {
    Grenade { owner: u8, pos: [f32; 3], vel: [f32; 3], detonate_at: Instant },
    Rocket { owner: u8, pos: [f32; 3], dir: [f32; 3], travelled: f32 },
}

pub struct Game {
    world: World,
    /// Pristine generated data, to keep the edit overlay minimal.
    gen_data: Vec<u8>,
    edits: HashMap<(u16, u16, u16), u8>,
    players: [Option<Player>; MAX_PLAYERS],
    projectiles: Vec<Projectile>,
    seed: u32,
    tick: u32,
    rng: u64,
}

pub async fn run(seed: u32, mut rx: UnboundedReceiver<Cmd>) {
    let world = gen::generate(seed);
    let gen_data = world.data.clone();
    let mut g = Game {
        world,
        gen_data,
        edits: HashMap::new(),
        players: std::array::from_fn(|_| None),
        projectiles: Vec::new(),
        seed,
        tick: 0,
        rng: 0x853c_49e6_748f_ea9b ^ seed as u64,
    };
    println!("[game] world generated (seed {seed})");

    let mut interval = tokio::time::interval(std::time::Duration::from_micros(1_000_000 / TICK_HZ as u64));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            cmd = rx.recv() => match cmd {
                Some(Cmd::Join { name, class, out, reply }) => { let _ = reply.send(g.join(name, class, out)); }
                Some(Cmd::Msg(id, data)) => g.handle(id, &data),
                Some(Cmd::Leave(id)) => g.leave(id),
                None => return,
            },
            _ = interval.tick() => g.step(),
        }
    }
}

impl Game {
    fn rand01(&mut self) -> f32 {
        // xorshift64*
        self.rng ^= self.rng >> 12;
        self.rng ^= self.rng << 25;
        self.rng ^= self.rng >> 27;
        ((self.rng.wrapping_mul(0x2545_f491_4f6c_dd1d) >> 40) & 0xff_ffff) as f32 / 16_777_216.0
    }

    // ---- connection lifecycle ----------------------------------------

    fn join(&mut self, name: String, class: u8, out: UnboundedSender<Vec<u8>>) -> Option<u8> {
        let id = (0..MAX_PLAYERS).find(|i| self.players[*i].is_none())? as u8;
        let class = class.min(3);
        let name = sanitize_name(&name);
        let spawn = self.pick_spawn();

        let mut welcome = Writer::new(S2C_WELCOME);
        welcome.u8(id).u32(self.seed);
        welcome.f32(spawn[0]).f32(spawn[1]).f32(spawn[2]);
        let others: Vec<u8> = (0..MAX_PLAYERS as u8)
            .filter(|i| self.players[*i as usize].is_some())
            .collect();
        welcome.u8(others.len() as u8);
        for oid in others {
            let p = self.players[oid as usize].as_ref().unwrap();
            welcome.u8(oid).u8(p.class).u8(p.hp.max(0.0) as u8);
            welcome.u16(p.kills).u16(p.deaths);
            welcome.str8(&p.name);
            welcome.f32(p.pos[0]).f32(p.pos[1]).f32(p.pos[2]).f32(p.yaw);
        }
        welcome.u32(self.edits.len() as u32);
        for (&(x, y, z), &b) in &self.edits {
            welcome.u16(x).u16(y).u16(z).u8(b);
        }
        let _ = out.send(welcome.buf);

        let now = Instant::now();
        let p = Player {
            name: name.clone(),
            class,
            alive: true,
            hp: 100.0,
            pos: spawn,
            yaw: 0.0,
            pitch: 0.0,
            flags: 0,
            kills: 0,
            deaths: 0,
            grenades: if class == 1 { 4 } else { 0 },
            last_state: now,
            last_shot: now - std::time::Duration::from_secs(5),
            last_grenade: now - std::time::Duration::from_secs(5),
            died_at: now,
            just_spawned: true,
            edit_tokens: 30.0,
            out,
        };
        self.players[id as usize] = Some(p);

        let mut j = Writer::new(S2C_PLAYER_JOINED);
        j.u8(id).u8(class).str8(&name);
        j.f32(spawn[0]).f32(spawn[1]).f32(spawn[2]);
        self.broadcast_except(id, &j.buf);
        println!("[game] #{id} '{name}' joined (class {class})");
        Some(id)
    }

    fn leave(&mut self, id: u8) {
        if self.players[id as usize].take().is_some() {
            let mut w = Writer::new(S2C_PLAYER_LEFT);
            w.u8(id);
            self.broadcast(&w.buf);
            println!("[game] #{id} left");
        }
    }

    fn pick_spawn(&mut self) -> [f32; 3] {
        // Spawn on open ground — not on top of containers, the crane or scrap.
        for _ in 0..60 {
            let x = 8 + (self.rand01() * (voxel_core::SX - 16) as f32) as i32;
            let z = 8 + (self.rand01() * (voxel_core::SZ - 16) as f32) as i32;
            let y = self.world.surface_y(x, z);
            if (voxel_core::GROUND_Y..=voxel_core::GROUND_Y + 1).contains(&y) {
                return [x as f32 + 0.5, y as f32 + 1.05, z as f32 + 0.5];
            }
        }
        let c = voxel_core::SX as f32 / 2.0;
        [c, voxel_core::GROUND_Y as f32 + 1.05, c]
    }

    // ---- message handling ---------------------------------------------

    fn handle(&mut self, id: u8, data: &[u8]) {
        let mut r = Reader::new(data);
        match r.u8() {
            Some(C2S_STATE) => self.on_state(id, &mut r),
            Some(C2S_SET_BLOCK) => self.on_set_block(id, &mut r),
            Some(C2S_SHOOT) => self.on_shoot(id, &mut r),
            Some(C2S_RESPAWN) => self.on_respawn(id, &mut r),
            Some(C2S_THROW_GRENADE) => self.on_grenade(id, &mut r),
            Some(C2S_FIRE_ROCKET) => self.on_rocket(id, &mut r),
            _ => {}
        }
    }

    fn on_state(&mut self, id: u8, r: &mut Reader) {
        let (Some(pos), Some(_vel), Some(yaw), Some(pitch), Some(flags)) =
            (r.vec3(), r.vec3(), r.f32(), r.f32(), r.u8())
        else {
            return;
        };
        let Some(p) = self.players[id as usize].as_mut() else { return };
        if !p.alive {
            return;
        }
        let now = Instant::now();
        let dt = (now - p.last_state).as_secs_f32().min(1.0);
        p.last_state = now;

        if !pos.iter().all(|v| v.is_finite()) {
            return;
        }
        // Anti-teleport clamp: cap horizontal/vertical travel per update.
        // (Falling is fast, so vertical gets a bigger budget.)
        if p.just_spawned {
            p.just_spawned = false;
            p.pos = pos;
        } else {
            let max_h = 14.0 * dt + 1.5;
            let max_v = 60.0 * dt + 2.0;
            let dx = pos[0] - p.pos[0];
            let dy = pos[1] - p.pos[1];
            let dz = pos[2] - p.pos[2];
            let h = (dx * dx + dz * dz).sqrt();
            let s = if h > max_h { max_h / h } else { 1.0 };
            p.pos[0] += dx * s;
            p.pos[2] += dz * s;
            p.pos[1] += dy.clamp(-max_v, max_v);
        }
        p.pos[0] = p.pos[0].clamp(-8.0, voxel_core::SX as f32 + 8.0);
        p.pos[1] = p.pos[1].clamp(0.0, voxel_core::SY as f32 + 16.0);
        p.pos[2] = p.pos[2].clamp(-8.0, voxel_core::SZ as f32 + 8.0);
        p.yaw = yaw;
        p.pitch = pitch;
        p.flags = flags;
    }

    fn on_set_block(&mut self, id: u8, r: &mut Reader) {
        let (Some(x), Some(y), Some(z), Some(b)) = (r.u16(), r.u16(), r.u16(), r.u8()) else {
            return;
        };
        let Some(p) = self.players[id as usize].as_ref() else { return };
        if !p.alive {
            return;
        }
        let eye = p.eye();
        let tokens = p.edit_tokens;
        let target = [x as f32 + 0.5, y as f32 + 0.5, z as f32 + 0.5];
        let cur = self.world.get(x as i32, y as i32, z as i32);

        // No building on this map — only destruction. Anything other than
        // "set to air within reach" is rejected (and corrected) below.
        let ok = b == blocks::AIR && tokens >= 1.0 && dist3(target, eye) <= REACH && blocks::is_breakable(cur);

        if !ok {
            // Corrective echo so a rejected client doesn't drift from us.
            let mut w = Writer::new(S2C_BLOCK_SET);
            w.u16(x).u16(y).u16(z).u8(cur);
            if let Some(p) = self.players[id as usize].as_ref() {
                let _ = p.out.send(w.buf);
            }
            return;
        }
        if let Some(p) = self.players[id as usize].as_mut() {
            p.edit_tokens -= 1.0;
        }
        self.apply_block(x as i32, y as i32, z as i32, b);
    }

    /// Set a block, track the edit overlay, broadcast to everyone.
    fn apply_block(&mut self, x: i32, y: i32, z: i32, b: u8) {
        if !self.world.set(x, y, z, b) {
            return;
        }
        let key = (x as u16, y as u16, z as u16);
        let gen_b = self.gen_data[(x + voxel_core::SX * (z + voxel_core::SZ * y)) as usize];
        if gen_b == b {
            self.edits.remove(&key);
        } else {
            self.edits.insert(key, b);
        }
        let mut w = Writer::new(S2C_BLOCK_SET);
        w.u16(key.0).u16(key.1).u16(key.2).u8(b);
        self.broadcast(&w.buf);
    }

    fn on_shoot(&mut self, id: u8, r: &mut Reader) {
        let (Some(wid), Some(origin), Some(dir), Some(seed)) = (r.u8(), r.vec3(), r.vec3(), r.u32()) else {
            return;
        };
        let Some(w) = weapon(wid) else { return };
        let Some(p) = self.players[id as usize].as_ref() else { return };
        if !p.alive || !class_allows_weapon(p.class, wid) {
            return;
        }
        let now = Instant::now();
        if (now - p.last_shot).as_secs_f32() < w.cooldown * 0.8 {
            return;
        }
        // The claimed muzzle must be near the eye the server knows about.
        let eye = p.eye();
        if dist3(origin, eye) > 3.0 {
            return;
        }
        if !origin.iter().chain(dir.iter()).all(|v| v.is_finite()) {
            return;
        }
        let dl = (dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]).sqrt();
        if dl < 1e-4 {
            return;
        }
        let dir = [dir[0] / dl, dir[1] / dl, dir[2] / dl];
        self.players[id as usize].as_mut().unwrap().last_shot = now;

        let mut end = origin;
        for pi in 0..w.pellets {
            let d = if w.pellets > 1 || w.spread > 0.0 {
                spread_dir(dir, w.spread, seed, pi)
            } else {
                dir
            };
            end = self.fire_hitscan(id, wid, &w, origin, d);
        }

        // Tracer/sound for everyone else (last pellet's end point is fine).
        let mut s = Writer::new(S2C_SHOT);
        s.u8(id).u8(wid);
        s.f32(origin[0]).f32(origin[1]).f32(origin[2]);
        s.f32(end[0]).f32(end[1]).f32(end[2]);
        self.broadcast_except(id, &s.buf);
    }

    /// Trace one pellet: nearest of voxel hit / player hit wins.
    fn fire_hitscan(&mut self, shooter: u8, wid: u8, w: &Weapon, origin: [f32; 3], dir: [f32; 3]) -> [f32; 3] {
        let block_hit = ray::raycast(&self.world, origin, dir, w.range);
        let t_block = block_hit.as_ref().map(|h| h.t).unwrap_or(f32::INFINITY);

        let mut best: Option<(u8, f32)> = None;
        for vid in 0..MAX_PLAYERS as u8 {
            if vid == shooter {
                continue;
            }
            let Some(v) = self.players[vid as usize].as_ref() else { continue };
            if !v.alive {
                continue;
            }
            let (lo, hi) = v.aabb();
            if let Some(t) = ray_aabb(origin, dir, lo, hi) {
                if t <= w.range && t < t_block && best.map(|(_, bt)| t < bt).unwrap_or(true) {
                    best = Some((vid, t));
                }
            }
        }

        if let Some((vid, t)) = best {
            self.damage(vid, shooter, w.damage, wid);
            return [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
        }
        if let Some(h) = block_hit {
            if w.breaks_blocks && blocks::is_breakable(h.block_id) {
                self.apply_block(h.block[0], h.block[1], h.block[2], blocks::AIR);
            }
            return [origin[0] + dir[0] * h.t, origin[1] + dir[1] * h.t, origin[2] + dir[2] * h.t];
        }
        [
            origin[0] + dir[0] * w.range,
            origin[1] + dir[1] * w.range,
            origin[2] + dir[2] * w.range,
        ]
    }

    fn on_grenade(&mut self, id: u8, r: &mut Reader) {
        let (Some(origin), Some(vel)) = (r.vec3(), r.vec3()) else { return };
        let Some(p) = self.players[id as usize].as_mut() else { return };
        if !p.alive || p.grenades == 0 {
            return;
        }
        let now = Instant::now();
        if (now - p.last_grenade).as_secs_f32() < 0.5 {
            return;
        }
        if dist3(origin, p.eye()) > 3.0 {
            return;
        }
        let vl = (vel[0] * vel[0] + vel[1] * vel[1] + vel[2] * vel[2]).sqrt();
        if !vl.is_finite() || vl > 20.0 {
            return;
        }
        p.grenades -= 1;
        p.last_grenade = now;
        self.projectiles.push(Projectile::Grenade {
            owner: id,
            pos: origin,
            vel,
            detonate_at: now + std::time::Duration::from_secs_f32(GRENADE_FUSE),
        });
        let mut w = Writer::new(S2C_GRENADE_THROWN);
        w.u8(id);
        w.f32(origin[0]).f32(origin[1]).f32(origin[2]);
        w.f32(vel[0]).f32(vel[1]).f32(vel[2]);
        w.f32(GRENADE_FUSE);
        self.broadcast_except(id, &w.buf);
    }

    fn on_rocket(&mut self, id: u8, r: &mut Reader) {
        let (Some(origin), Some(dir)) = (r.vec3(), r.vec3()) else { return };
        let Some(p) = self.players[id as usize].as_ref() else { return };
        if !p.alive || p.class != 2 {
            return;
        }
        let now = Instant::now();
        if (now - p.last_shot).as_secs_f32() < 1.1 {
            return;
        }
        if dist3(origin, p.eye()) > 3.0 {
            return;
        }
        let dl = (dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]).sqrt();
        if !dl.is_finite() || dl < 1e-4 {
            return;
        }
        let dir = [dir[0] / dl, dir[1] / dl, dir[2] / dl];
        self.players[id as usize].as_mut().unwrap().last_shot = now;
        self.projectiles.push(Projectile::Rocket { owner: id, pos: origin, dir, travelled: 0.0 });
        let mut w = Writer::new(S2C_ROCKET_FIRED);
        w.u8(id);
        w.f32(origin[0]).f32(origin[1]).f32(origin[2]);
        w.f32(dir[0]).f32(dir[1]).f32(dir[2]);
        self.broadcast_except(id, &w.buf);
    }

    fn on_respawn(&mut self, id: u8, r: &mut Reader) {
        let Some(class) = r.u8() else { return };
        let Some(p) = self.players[id as usize].as_ref() else { return };
        if p.alive || (Instant::now() - p.died_at).as_secs_f32() < RESPAWN_SECS - 0.3 {
            return;
        }
        let class = class.min(3);
        let spawn = self.pick_spawn();
        let p = self.players[id as usize].as_mut().unwrap();
        p.alive = true;
        p.hp = 100.0;
        p.class = class;
        p.pos = spawn;
        p.grenades = if class == 1 { 4 } else { 0 };
        p.just_spawned = true;
        let mut w = Writer::new(S2C_SPAWN);
        w.u8(id);
        w.f32(spawn[0]).f32(spawn[1]).f32(spawn[2]);
        w.u8(class).u8(100);
        self.broadcast(&w.buf);
    }

    // ---- damage --------------------------------------------------------

    fn damage(&mut self, victim: u8, attacker: u8, amount: f32, cause: u8) {
        let Some(v) = self.players[victim as usize].as_mut() else { return };
        if !v.alive {
            return;
        }
        v.hp -= amount;
        let hp = v.hp.max(0.0) as u8;
        let mut d = Writer::new(S2C_DAMAGE);
        d.u8(victim).u8(attacker).u8(hp);
        self.broadcast(&d.buf);

        if hp == 0 {
            let v = self.players[victim as usize].as_mut().unwrap();
            v.alive = false;
            v.died_at = Instant::now();
            v.deaths = v.deaths.saturating_add(1);
            if attacker != victim {
                if let Some(k) = self.players[attacker as usize].as_mut() {
                    k.kills = k.kills.saturating_add(1);
                }
            }
            let mut w = Writer::new(S2C_DEATH);
            w.u8(victim).u8(attacker).u8(cause);
            self.broadcast(&w.buf);
        }
    }

    fn explode(&mut self, pos: [f32; 3], radius: f32, max_dmg: f32, owner: u8, cause: u8) {
        // World destruction (deterministic — clients replay it from the event).
        let destroyed = explosion::apply_explosion(&mut self.world, pos[0], pos[1], pos[2], radius);
        for d in destroyed {
            let key = (d[0] as u16, d[1] as u16, d[2] as u16);
            let gen_b = self.gen_data[(d[0] + voxel_core::SX * (d[2] + voxel_core::SZ * d[1])) as usize];
            if gen_b == blocks::AIR {
                self.edits.remove(&key);
            } else {
                self.edits.insert(key, blocks::AIR);
            }
        }
        let mut w = Writer::new(S2C_EXPLOSION);
        w.f32(pos[0]).f32(pos[1]).f32(pos[2]).f32(radius);
        self.broadcast(&w.buf);

        // Radial damage with linear falloff (damage radius is wider than
        // the destruction sphere so near-misses still hurt).
        let dmg_r = radius * 1.6;
        for vid in 0..MAX_PLAYERS as u8 {
            let Some(v) = self.players[vid as usize].as_ref() else { continue };
            if !v.alive {
                continue;
            }
            let d = dist3(v.center(), pos);
            if d >= dmg_r {
                continue;
            }
            let mut dmg = max_dmg * (1.0 - d / dmg_r);
            if vid == owner && cause == CAUSE_ROCKET {
                dmg *= ROCKET_SELF_MULT;
            }
            if dmg >= 1.0 {
                self.damage(vid, owner, dmg, cause);
            }
        }
    }

    // ---- tick -----------------------------------------------------------

    fn step(&mut self) {
        self.tick = self.tick.wrapping_add(1);
        let dt = 1.0 / TICK_HZ as f32;
        let now = Instant::now();

        // Refill edit token buckets.
        for p in self.players.iter_mut().flatten() {
            let rate = if p.class == 3 { 60.0 } else { 30.0 };
            p.edit_tokens = (p.edit_tokens + rate * dt).min(rate * 2.0);
        }

        self.step_projectiles(dt, now);

        if self.tick % SNAPSHOT_DIV == 0 {
            self.send_snapshot();
        }
    }

    fn step_projectiles(&mut self, dt: f32, now: Instant) {
        let mut exploded: Vec<([f32; 3], f32, f32, u8, u8)> = Vec::new();
        let mut i = 0;
        while i < self.projectiles.len() {
            let mut remove = false;
            match &mut self.projectiles[i] {
                Projectile::Grenade { owner, pos, vel, detonate_at } => {
                    vel[1] -= GRENADE_GRAVITY * dt;
                    // Per-axis move with bounce (matches the client cosmetic sim).
                    for a in 0..3 {
                        let mut np = *pos;
                        np[a] += vel[a] * dt;
                        if blocks::is_solid(self.world.get(
                            np[0].floor() as i32,
                            np[1].floor() as i32,
                            np[2].floor() as i32,
                        )) {
                            vel[a] *= -0.45;
                            if a == 1 {
                                vel[0] *= 0.7;
                                vel[2] *= 0.7;
                            }
                        } else {
                            pos[a] = np[a];
                        }
                    }
                    if now >= *detonate_at {
                        exploded.push((*pos, GRENADE_RADIUS, GRENADE_DMG, *owner, CAUSE_GRENADE));
                        remove = true;
                    }
                }
                Projectile::Rocket { owner, pos, dir, travelled } => {
                    let step_len = ROCKET_SPEED * dt;
                    let sub = 4;
                    'fly: for _ in 0..sub {
                        let s = step_len / sub as f32;
                        pos[0] += dir[0] * s;
                        pos[1] += dir[1] * s;
                        pos[2] += dir[2] * s;
                        *travelled += s;
                        if blocks::is_solid(self.world.get(
                            pos[0].floor() as i32,
                            pos[1].floor() as i32,
                            pos[2].floor() as i32,
                        )) {
                            exploded.push((*pos, ROCKET_RADIUS, ROCKET_DMG, *owner, CAUSE_ROCKET));
                            remove = true;
                            break 'fly;
                        }
                        for vid in 0..MAX_PLAYERS as u8 {
                            if vid == *owner {
                                continue;
                            }
                            let Some(v) = self.players[vid as usize].as_ref() else { continue };
                            if !v.alive {
                                continue;
                            }
                            let (lo, hi) = v.aabb();
                            if pos[0] > lo[0] - 0.3 && pos[0] < hi[0] + 0.3
                                && pos[1] > lo[1] - 0.3 && pos[1] < hi[1] + 0.3
                                && pos[2] > lo[2] - 0.3 && pos[2] < hi[2] + 0.3
                            {
                                exploded.push((*pos, ROCKET_RADIUS, ROCKET_DMG, *owner, CAUSE_ROCKET));
                                remove = true;
                                break 'fly;
                            }
                        }
                        if *travelled > 300.0 || pos[1] < -16.0 || pos[1] > voxel_core::SY as f32 + 64.0 {
                            remove = true;
                            break 'fly;
                        }
                    }
                }
            }
            if remove {
                self.projectiles.swap_remove(i);
            } else {
                i += 1;
            }
        }
        for (pos, r, dmg, owner, cause) in exploded {
            self.explode(pos, r, dmg, owner, cause);
        }
    }

    fn send_snapshot(&mut self) {
        let ids: Vec<u8> = (0..MAX_PLAYERS as u8)
            .filter(|i| self.players[*i as usize].is_some())
            .collect();
        if ids.is_empty() {
            return;
        }
        let mut w = Writer::new(S2C_SNAPSHOT);
        w.u8(ids.len() as u8);
        for id in ids {
            let p = self.players[id as usize].as_ref().unwrap();
            w.u8(id);
            w.f32(p.pos[0]).f32(p.pos[1]).f32(p.pos[2]);
            w.f32(p.yaw).f32(p.pitch);
            w.u8(p.flags).u8(p.hp.max(0.0) as u8);
        }
        self.broadcast(&w.buf);
    }

    // ---- helpers ---------------------------------------------------------

    fn broadcast(&self, buf: &[u8]) {
        for p in self.players.iter().flatten() {
            let _ = p.out.send(buf.to_vec());
        }
    }

    fn broadcast_except(&self, id: u8, buf: &[u8]) {
        for (i, p) in self.players.iter().enumerate() {
            if let Some(p) = p {
                if i as u8 != id {
                    let _ = p.out.send(buf.to_vec());
                }
            }
        }
    }
}

fn sanitize_name(s: &str) -> String {
    let t: String = s.chars().filter(|c| !c.is_control()).take(16).collect();
    let t = t.trim().to_string();
    if t.is_empty() {
        "Deuce".into()
    } else {
        t
    }
}

fn dist3(a: [f32; 3], b: [f32; 3]) -> f32 {
    let d = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt()
}

/// Slab-method ray vs AABB; returns entry distance if the ray hits.
fn ray_aabb(origin: [f32; 3], dir: [f32; 3], lo: [f32; 3], hi: [f32; 3]) -> Option<f32> {
    let mut tmin = 0.0f32;
    let mut tmax = f32::INFINITY;
    for a in 0..3 {
        if dir[a].abs() < 1e-9 {
            if origin[a] < lo[a] || origin[a] > hi[a] {
                return None;
            }
        } else {
            let inv = 1.0 / dir[a];
            let mut t0 = (lo[a] - origin[a]) * inv;
            let mut t1 = (hi[a] - origin[a]) * inv;
            if t0 > t1 {
                std::mem::swap(&mut t0, &mut t1);
            }
            tmin = tmin.max(t0);
            tmax = tmax.min(t1);
            if tmin > tmax {
                return None;
            }
        }
    }
    Some(tmin)
}

/// Deterministic pellet spread (same algorithm in TS for tracer visuals).
fn spread_dir(dir: [f32; 3], spread: f32, seed: u32, pellet: u32) -> [f32; 3] {
    let mut h = seed.wrapping_add(pellet.wrapping_mul(0x9e37_79b9));
    let mut next = || {
        h ^= h << 13;
        h ^= h >> 17;
        h ^= h << 5;
        (h & 0xffff) as f32 / 65536.0 - 0.5
    };
    let (rx, ry, rz) = (next(), next(), next());
    let d = [
        dir[0] + rx * spread * 2.0,
        dir[1] + ry * spread * 2.0,
        dir[2] + rz * spread * 2.0,
    ];
    let l = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt().max(1e-6);
    [d[0] / l, d[1] / l, d[2] / l]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ray_aabb_basics() {
        let lo = [10.0, 0.0, -0.5];
        let hi = [11.0, 2.0, 0.5];
        let t = ray_aabb([0.0, 1.0, 0.0], [1.0, 0.0, 0.0], lo, hi).unwrap();
        assert!((t - 10.0).abs() < 1e-5);
        assert!(ray_aabb([0.0, 1.0, 0.0], [-1.0, 0.0, 0.0], lo, hi).is_none());
        assert!(ray_aabb([0.0, 5.0, 0.0], [1.0, 0.0, 0.0], lo, hi).is_none());
        // Starting inside returns t=0 (entry clamp).
        let t = ray_aabb([10.5, 1.0, 0.0], [1.0, 0.0, 0.0], lo, hi).unwrap();
        assert_eq!(t, 0.0);
    }

    #[test]
    fn spread_is_deterministic_and_normalized() {
        let a = spread_dir([0.0, 0.0, 1.0], 0.05, 42, 3);
        let b = spread_dir([0.0, 0.0, 1.0], 0.05, 42, 3);
        assert_eq!(a, b);
        let l = (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt();
        assert!((l - 1.0).abs() < 1e-4);
        let c = spread_dir([0.0, 0.0, 1.0], 0.05, 43, 3);
        assert_ne!(a, c);
    }
}
