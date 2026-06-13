// Jack of Guns — entry point. Boots the engine, connects to the server
// (or falls back to offline sandbox), then runs the game loop.
import * as THREE from "three";
import { Controls } from "./engine/controls";
import { PlayerBody } from "./engine/physics";
import { BASE_FOV, createRenderer } from "./engine/renderer";
import { ChunkRenderer, GROUND_Y, WATER_Y } from "./engine/world";
import { Avatars } from "./game/avatars";
import { panvol, sfx } from "./game/audio";
import { Combat } from "./game/combat";
import { Effects } from "./game/effects";
import { Hud } from "./game/hud";
import { Block, BLOCK_COLORS, WEAPON_KILL_NAME, Weapon } from "./game/items";
import { ViewModel } from "./game/viewmodel";
import { NetClient } from "./net/client";
import type { ServerMsg } from "./net/protocol";
import { initWasm, VoxelWorld } from "./wasm/voxel";

const STATE_SEND_MS = 50; // 20 Hz
const RESPAWN_DELAY = 2.8;

interface RosterEntry {
  name: string;
  classId: number;
  kills: number;
  deaths: number;
}

async function boot() {
  const hud = new Hud();
  const canvas = document.getElementById("game") as HTMLCanvasElement;

  hud.bootMsg("loading engine…");
  const [, ctx] = await Promise.all([initWasm(), createRenderer(canvas)]);
  hud.bootMsg(`renderer: ${ctx.backend} — ready`);

  const { name, classId: startClass } = await hud.waitForStart();
  sfx.unlock();

  // ---- connect (or offline sandbox) ------------------------------------
  hud.bootMsg("connecting…");
  const net = new NetClient();
  let seed = 1337;
  let spawn: [number, number, number] | null = null;
  const roster = new Map<number, RosterEntry>();
  let welcomePlayers: { id: number; classId: number; name: string; pos: [number, number, number]; kills: number; deaths: number; hp: number }[] = [];
  let welcomeEdits: { x: number; y: number; z: number; b: number }[] = [];

  try {
    const w = await net.connect(name, startClass);
    seed = w.seed;
    spawn = w.spawn;
    welcomeEdits = w.edits;
    welcomePlayers = w.players;
  } catch (e) {
    console.warn("offline mode:", e);
  }

  // ---- world -----------------------------------------------------------
  hud.bootMsg("generating world…");
  await frame(); // let the message paint
  const world = new VoxelWorld(seed >>> 0);
  for (const e of welcomeEdits) world.set_block(e.x, e.y, e.z, e.b);
  world.take_dirty(); // buildAll covers everything anyway

  const chunks = new ChunkRenderer(world, ctx.scene);
  await chunks.buildAll((done, total) => hud.bootMsg(`meshing terrain… ${done}/${total}`));
  console.log(`[jog] renderer=${ctx.backend}, built ${chunks.meshCount} chunk meshes, surface y(center)=${world.surface_y(world.size_x() >> 1, world.size_z() >> 1)}`);

  // ---- actors ------------------------------------------------------------
  const controls = new Controls(canvas);
  const body = new PlayerBody(world);
  const effects = new Effects(ctx.scene);
  const avatars = new Avatars(ctx.scene);
  const viewmodel = new ViewModel(ctx.camera);
  ctx.scene.add(ctx.camera); // viewmodel children render with the camera

  const local = {
    id: net.myId,
    hp: 100,
    alive: true,
    classId: startClass,
    kills: 0,
    deaths: 0,
  };
  roster.set(local.id, { name, classId: startClass, kills: 0, deaths: 0 });
  for (const p of welcomePlayers) {
    roster.set(p.id, { name: p.name, classId: p.classId, kills: p.kills, deaths: p.deaths });
    avatars.add(p.id, p.name, p.classId, p.pos, p.kills, p.deaths, p.hp);
  }

  const combat = new Combat({
    world,
    scene: ctx.scene,
    camera: ctx.camera,
    body,
    effects,
    avatars,
    hud,
    net,
    viewmodel,
    onLocalDamage: (dmg, cause) => takeDamage(dmg, local.id, cause),
  });
  combat.setClass(startClass);

  // Spawn position.
  if (spawn) body.teleport(spawn[0], spawn[1], spawn[2]);
  else body.teleport(...pickOfflineSpawn(world));

  // Block highlight wireframe.
  const highlight = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }),
  );
  highlight.visible = false;
  ctx.scene.add(highlight);

  // ---- local damage / death ---------------------------------------------
  function takeDamage(dmg: number, attacker: number, cause: number) {
    if (!local.alive) return;
    local.hp = Math.max(0, local.hp - dmg);
    hud.setHp(local.hp);
    hud.damageFlash();
    sfx.hurt();
    if (local.hp <= 0) die(attacker, cause);
  }

  function die(killer: number, cause: number) {
    local.alive = false;
    local.deaths++;
    const r = roster.get(local.id);
    if (r) r.deaths++;
    sfx.death();
    const killerName = killer === local.id ? "yourself" : (roster.get(killer)?.name ?? "someone");
    if (killer !== local.id) {
      const kr = roster.get(killer);
      if (kr && !net.connected) kr.kills++;
    }
    hud.killFeed(killerName, name, WEAPON_KILL_NAME[cause] ?? "?");
    hud.showRespawn(killerName === "yourself" ? "" : killerName, local.classId, (cls) => {
      if (net.connected) {
        net.sendRespawn(cls);
        local.classId = cls; // server Spawn event completes the respawn
      } else {
        respawnLocal(cls);
      }
    }, RESPAWN_DELAY);
  }

  function respawnLocal(cls: number) {
    local.classId = cls;
    local.hp = 100;
    local.alive = true;
    body.teleport(...pickOfflineSpawn(world));
    combat.setClass(cls);
    hud.setHp(100);
    hud.hideRespawn();
    sfx.respawn();
    controls.lock();
    const r = roster.get(local.id);
    if (r) r.classId = cls;
  }

  function pickOfflineSpawn(w: VoxelWorld): [number, number, number] {
    // Open ground only — not on top of containers, the crane or scrap heaps.
    for (let i = 0; i < 60; i++) {
      const x = 8 + Math.floor(Math.random() * (w.size_x() - 16));
      const z = 8 + Math.floor(Math.random() * (w.size_z() - 16));
      const y = w.surface_y(x, z);
      if (y >= GROUND_Y && y <= GROUND_Y + 1) return [x + 0.5, y + 1.05, z + 0.5];
    }
    const c = w.size_x() / 2;
    return [c, GROUND_Y + 1.05, c];
  }

  // ---- server messages ----------------------------------------------------
  net.onMessage = (msg: ServerMsg) => {
    switch (msg.t) {
      case "playerJoined":
        roster.set(msg.id, { name: msg.name, classId: msg.classId, kills: 0, deaths: 0 });
        avatars.add(msg.id, msg.name, msg.classId, msg.pos);
        break;
      case "playerLeft":
        roster.delete(msg.id);
        avatars.remove(msg.id);
        break;
      case "snapshot":
        for (const p of msg.players) {
          if (p.id === local.id) {
            // Light reconciliation: only snap when the server disagrees hard.
            const d = Math.hypot(p.pos[0] - body.pos.x, p.pos[1] - body.pos.y, p.pos[2] - body.pos.z);
            if (d > 4) body.teleport(p.pos[0], p.pos[1], p.pos[2]);
            continue;
          }
          avatars.onSnapshot(p.id, p.pos, p.yaw, p.pitch, p.flags, p.hp);
        }
        break;
      case "blockSet": {
        const changed = world.get_block(msg.x, msg.y, msg.z) !== msg.b;
        if (changed) {
          const old = world.get_block(msg.x, msg.y, msg.z);
          world.set_block(msg.x, msg.y, msg.z, msg.b);
          if (msg.b === Block.Air && old !== Block.Air) {
            const at = new THREE.Vector3(msg.x + 0.5, msg.y + 0.5, msg.z + 0.5);
            effects.burst(at, BLOCK_COLORS[old] ?? [120, 120, 120], 8, 3);
            const { pan } = panvol({ x: at.x, z: at.z }, { x: body.pos.x, z: body.pos.z }, body.yaw);
            sfx.break(pan);
          }
        }
        break;
      }
      case "shot": {
        const from = new THREE.Vector3(...msg.origin);
        const to = new THREE.Vector3(...msg.end);
        effects.tracer(from, to);
        effects.burst(to, [200, 190, 160], 3, 2, 0.06);
        const { pan, vol } = panvol({ x: from.x, z: from.z }, { x: body.pos.x, z: body.pos.z }, body.yaw);
        sfx.shoot(msg.weapon, pan, vol);
        break;
      }
      case "explosion":
        combat.applyExplosion(new THREE.Vector3(...msg.pos), msg.radius);
        break;
      case "damage":
        if (msg.target === local.id) {
          const dmg = local.hp - msg.hp;
          local.hp = msg.hp;
          hud.setHp(local.hp);
          if (dmg > 0) {
            hud.damageFlash();
            sfx.hurt();
          }
        } else {
          const a = avatars.players.get(msg.target);
          if (a) a.hp = msg.hp;
          if (msg.attacker === local.id) {
            hud.hitMarker();
            sfx.hitmarker();
          }
        }
        break;
      case "death": {
        const killerName = msg.killer === msg.victim ? "themselves" : (roster.get(msg.killer)?.name ?? "?");
        const victimName = roster.get(msg.victim)?.name ?? "?";
        const kr = roster.get(msg.killer);
        if (kr && msg.killer !== msg.victim) kr.kills++;
        const vr = roster.get(msg.victim);
        if (vr) vr.deaths++;
        if (msg.victim === local.id) {
          local.alive = false;
          local.deaths++;
          sfx.death();
          hud.showRespawn(
            msg.killer === local.id ? "" : (roster.get(msg.killer)?.name ?? "?"),
            local.classId,
            (cls) => {
              net.sendRespawn(cls);
              local.classId = cls;
            },
            RESPAWN_DELAY,
          );
        } else {
          avatars.setAlive(msg.victim, false);
          const a = avatars.chestOf(msg.victim);
          if (a) effects.burst(a, [165, 40, 40], 16, 4);
          if (msg.killer === local.id) {
            local.kills++;
            hud.hitMarker();
          }
        }
        hud.killFeed(
          msg.killer === msg.victim ? victimName : killerName,
          msg.killer === msg.victim ? "themselves" : victimName,
          WEAPON_KILL_NAME[msg.cause] ?? "?",
        );
        break;
      }
      case "spawn": {
        const r = roster.get(msg.id);
        if (r) r.classId = msg.classId;
        if (msg.id === local.id) {
          local.hp = msg.hp;
          local.alive = true;
          local.classId = msg.classId;
          body.teleport(msg.pos[0], msg.pos[1], msg.pos[2]);
          combat.setClass(msg.classId);
          hud.setHp(msg.hp);
          hud.hideRespawn();
          sfx.respawn();
          controls.lock();
        } else {
          // Re-add to refresh class colors, then mark alive at the new spot.
          avatars.add(msg.id, r?.name ?? "?", msg.classId, msg.pos, r?.kills ?? 0, r?.deaths ?? 0, msg.hp);
          avatars.onSnapshot(msg.id, msg.pos, 0, 0, 0, msg.hp);
        }
        break;
      }
      case "grenadeThrown":
        combat.spawnNade(
          new THREE.Vector3(...msg.origin),
          new THREE.Vector3(...msg.vel),
          performance.now() / 1000 + msg.fuse,
          false,
        );
        break;
      case "rocketFired": {
        combat.spawnRocket(new THREE.Vector3(...msg.origin), new THREE.Vector3(...msg.dir), false);
        const { pan, vol } = panvol({ x: msg.origin[0], z: msg.origin[2] }, { x: body.pos.x, z: body.pos.z }, body.yaw);
        sfx.shoot(Weapon.Rocket, pan, vol);
        break;
      }
      case "welcome":
        break; // handled during connect
    }
  };

  net.onDisconnect = () => {
    hud.setStatus(`<span class="warn">DISCONNECTED</span> — refresh to rejoin`);
  };

  // ---- input wiring --------------------------------------------------------
  let lmbEdge = false;
  controls.onLmbDown = () => (lmbEdge = true);
  controls.onSlot = (i) => combat.selectSlot(i);
  controls.onWheel = (dir) => combat.cycleSlot(dir);
  controls.onKey = (code) => {
    if (code === "KeyR") combat.reload();
  };
  controls.onLockChange = (locked) => {
    hud.setPaused(!locked && local.alive);
  };
  hud.setPaused(true);

  hud.hideStart();
  hud.setHp(100);
  hud.setStatus(
    net.connected
      ? `ONLINE as <b>${escapeHtml(name)}</b>`
      : `<span class="warn">OFFLINE SANDBOX</span> — server unreachable`,
  );

  // ---- main loop ------------------------------------------------------------
  let last = performance.now();
  let stateTimer = 0;
  let fpsFrames = 0;
  let fpsTime = 0;
  const PHYS_DT = 1 / 120;
  let accum = 0;
  let renderErrorShown = false;

  function frameLoop(now: number) {
    requestAnimationFrame(frameLoop);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    // Input → physics (fixed substeps for stable collisions).
    body.yaw = controls.yaw;
    const input = {
      fwd: (controls.down("KeyW") ? 1 : 0) - (controls.down("KeyS") ? 1 : 0),
      strafe: (controls.down("KeyA") ? 1 : 0) - (controls.down("KeyD") ? 1 : 0),
      jump: controls.down("Space"),
      crouch: controls.down("ControlLeft") || controls.down("KeyC"),
      sprint: controls.down("ShiftLeft"),
      sprintMult: combat.zoomed ? 1 : (sprintFor(local.classId)),
    };
    if (local.alive) {
      accum = Math.min(accum + dt, 0.12);
      while (accum >= PHYS_DT) {
        body.step(input, PHYS_DT);
        accum -= PHYS_DT;
      }
    }

    // Camera follows the body.
    const eye = body.eye();
    ctx.camera.position.copy(eye);
    ctx.camera.rotation.set(controls.pitch, controls.yaw, 0);

    // Zoom FOV + sensitivity.
    const targetFov = combat.fovTarget() || BASE_FOV;
    ctx.camera.fov += (targetFov - ctx.camera.fov) * Math.min(1, dt * 14);
    ctx.camera.updateProjectionMatrix();
    controls.sensScale = ctx.camera.fov / BASE_FOV;

    // Combat & world.
    combat.update(dt, controls.lmb, controls.rmb, lmbEdge, local.alive && controls.locked);
    lmbEdge = false;
    chunks.update();
    avatars.update(dt);
    effects.update(dt);
    hud.update(dt);

    // Block highlight for dig/place modes.
    const slot = combat.currentSlot;
    const wantHl = local.alive && (slot.kind === "block" || (slot.kind === "weapon" && (slot.weapon === Weapon.Spade || slot.weapon === Weapon.Pickaxe)));
    if (wantHl) {
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
      const reach = slot.kind === "block" ? 5.5 : 2.9;
      const hit = world.raycast(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, reach);
      if (hit.length > 0) {
        highlight.position.set(hit[0] + 0.5, hit[1] + 0.5, hit[2] + 0.5);
        highlight.visible = true;
      } else highlight.visible = false;
    } else highlight.visible = false;

    hud.setUnderwater(eye.y < WATER_Y);

    // Scoreboard while Tab held.
    if (controls.down("Tab")) {
      hud.showScoreboard(
        [...roster.entries()].map(([id, r]) => ({
          id,
          name: r.name,
          classId: r.classId,
          kills: r.kills,
          deaths: r.deaths,
          me: id === local.id,
        })),
      );
    } else hud.showScoreboard(null);

    // Network state @ 20 Hz.
    stateTimer += dt * 1000;
    if (stateTimer >= STATE_SEND_MS && net.connected && local.alive) {
      stateTimer = 0;
      const flags = (body.crouching ? 1 : 0) | (input.sprint ? 2 : 0) | (body.onGround ? 4 : 0);
      net.sendState(
        { x: body.pos.x, y: body.pos.y, z: body.pos.z },
        { x: body.vel.x, y: body.vel.y, z: body.vel.z },
        controls.yaw,
        controls.pitch,
        flags,
      );
    }

    // FPS counter.
    fpsFrames++;
    fpsTime += dt;
    if (fpsTime >= 0.5) {
      hud.setFps(fpsFrames / fpsTime, ctx.backend);
      fpsFrames = 0;
      fpsTime = 0;
    }

    effects.applyShake(ctx.camera);
    try {
      ctx.renderer.render(ctx.scene, ctx.camera);
    } catch (err) {
      // A render-loop throw must never leave a silent blank screen.
      if (!renderErrorShown) {
        renderErrorShown = true;
        console.error("[jog] render error:", err);
        hud.setStatus(`<span class="warn">RENDER ERROR</span> — ${escapeHtml(String((err as Error)?.message ?? err))} (try ?gl)`);
      }
    }
  }
  requestAnimationFrame(frameLoop);
}

function sprintFor(classId: number): number {
  return classId === 1 ? 1.6 : 1.35;
}

function frame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
}

boot().catch((e) => {
  console.error(e);
  const el = document.getElementById("starterr");
  if (el) el.textContent = `Failed to start: ${e?.message ?? e}`;
  const btn = document.getElementById("playbtn") as HTMLButtonElement | null;
  if (btn) btn.disabled = false;
});
