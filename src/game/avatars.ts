// Remote player avatars: blocky humanoids tinted by class color, name
// sprites, and snapshot interpolation (render ~120 ms in the past).
import * as THREE from "three";
import { CLASSES } from "./items";

const INTERP_DELAY = 0.12;

interface Snap {
  t: number;
  pos: THREE.Vector3;
  yaw: number;
  pitch: number;
  flags: number;
}

export interface RemotePlayer {
  id: number;
  name: string;
  classId: number;
  hp: number;
  kills: number;
  deaths: number;
  alive: boolean;
  group: THREE.Group;
  headPivot: THREE.Object3D;
  legL: THREE.Object3D;
  legR: THREE.Object3D;
  armL: THREE.Object3D;
  armR: THREE.Object3D;
  snaps: Snap[];
  renderPos: THREE.Vector3;
  walkPhase: number;
}

function limb(w: number, h: number, d: number, color: number, pivotY: number): THREE.Object3D {
  const pivot = new THREE.Object3D();
  pivot.position.y = pivotY;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color }));
  mesh.position.y = -h / 2;
  pivot.add(mesh);
  return pivot;
}

function makeNameSprite(name: string): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 48;
  const ctx = c.getContext("2d")!;
  ctx.font = "bold 26px monospace";
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  const w = Math.min(250, ctx.measureText(name).width + 18);
  ctx.fillRect(128 - w / 2, 6, w, 34);
  ctx.fillStyle = "#fff";
  ctx.fillText(name, 128, 31);
  const tex = new THREE.CanvasTexture(c);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sprite.scale.set(1.9, 0.36, 1);
  return sprite;
}

export class Avatars {
  players = new Map<number, RemotePlayer>();

  constructor(private scene: THREE.Scene) {}

  add(id: number, name: string, classId: number, pos: [number, number, number], kills = 0, deaths = 0, hp = 100) {
    this.remove(id);
    const tint = CLASSES[classId]?.color ?? 0x888888;
    const group = new THREE.Group();

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.72, 0.34), new THREE.MeshLambertMaterial({ color: tint }));
    torso.position.y = 1.06;
    group.add(torso);

    const headPivot = new THREE.Object3D();
    headPivot.position.y = 1.48;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.42), new THREE.MeshLambertMaterial({ color: 0xd8b49a }));
    head.position.y = 0.24;
    headPivot.add(head);
    const helmet = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.18, 0.46), new THREE.MeshLambertMaterial({ color: tint }));
    helmet.position.y = 0.42;
    headPivot.add(helmet);
    group.add(headPivot);

    const dark = new THREE.Color(tint).multiplyScalar(0.7).getHex();
    const legL = limb(0.24, 0.7, 0.26, dark, 0.7);
    legL.position.x = -0.16;
    const legR = limb(0.24, 0.7, 0.26, dark, 0.7);
    legR.position.x = 0.16;
    group.add(legL, legR);

    const armL = limb(0.18, 0.62, 0.22, tint, 1.4);
    armL.position.x = -0.4;
    const armR = limb(0.18, 0.62, 0.22, tint, 1.4);
    armR.position.x = 0.4;
    group.add(armL, armR);

    // Held gun: simple dark box in front of the right arm.
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.14, 0.66), new THREE.MeshLambertMaterial({ color: 0x2c2c30 }));
    gun.position.set(0.4, 0.74, -0.4);
    group.add(gun);

    const tag = makeNameSprite(name);
    tag.position.y = 2.25;
    group.add(tag);

    group.visible = false;
    this.scene.add(group);

    this.players.set(id, {
      id,
      name,
      classId,
      hp,
      kills,
      deaths,
      alive: hp > 0,
      group,
      headPivot,
      legL,
      legR,
      armL,
      armR,
      snaps: [],
      renderPos: new THREE.Vector3(pos[0], pos[1], pos[2]),
      walkPhase: 0,
    });
  }

  remove(id: number) {
    const p = this.players.get(id);
    if (!p) return;
    this.scene.remove(p.group);
    p.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    this.players.delete(id);
  }

  onSnapshot(id: number, pos: [number, number, number], yaw: number, pitch: number, flags: number, hp: number) {
    const p = this.players.get(id);
    if (!p) return;
    p.hp = hp;
    p.snaps.push({
      t: performance.now() / 1000,
      pos: new THREE.Vector3(pos[0], pos[1], pos[2]),
      yaw,
      pitch,
      flags,
    });
    if (p.snaps.length > 30) p.snaps.splice(0, p.snaps.length - 30);
  }

  setAlive(id: number, alive: boolean) {
    const p = this.players.get(id);
    if (p) {
      p.alive = alive;
      if (!alive) p.group.visible = false;
    }
  }

  /** World-space chest position (for tracer targets / kill cams). */
  chestOf(id: number): THREE.Vector3 | null {
    const p = this.players.get(id);
    return p ? p.renderPos.clone().add(new THREE.Vector3(0, 1.2, 0)) : null;
  }

  update(dt: number) {
    const now = performance.now() / 1000;
    const renderT = now - INTERP_DELAY;
    for (const p of this.players.values()) {
      if (p.snaps.length === 0) continue;
      // Drop snapshots older than the previous-to-render one.
      while (p.snaps.length > 2 && p.snaps[1].t < renderT) p.snaps.shift();

      let pos: THREE.Vector3;
      let yaw: number;
      let pitch: number;
      let flags: number;
      const a = p.snaps[0];
      const b = p.snaps.length > 1 ? p.snaps[1] : null;
      if (b && b.t > a.t) {
        const k = THREE.MathUtils.clamp((renderT - a.t) / (b.t - a.t), 0, 1.25);
        pos = a.pos.clone().lerp(b.pos, k);
        yaw = a.yaw + shortestAngle(a.yaw, b.yaw) * Math.min(k, 1);
        pitch = THREE.MathUtils.lerp(a.pitch, b.pitch, Math.min(k, 1));
        flags = (k < 1 ? a : b).flags;
      } else {
        pos = a.pos.clone();
        yaw = a.yaw;
        pitch = a.pitch;
        flags = a.flags;
      }

      const speed = p.renderPos.distanceTo(pos) / Math.max(dt, 1e-4);
      p.renderPos.copy(pos);
      p.group.position.copy(pos);
      p.group.rotation.y = yaw;
      p.headPivot.rotation.x = -pitch * 0.8;
      p.group.visible = p.alive;

      // Crouch squash + walk cycle.
      const crouch = (flags & 1) !== 0;
      p.group.scale.y = crouch ? 0.78 : 1;
      p.walkPhase += Math.min(speed, 8) * dt * 2.2;
      const swing = Math.min(speed / 4, 1) * 0.65 * Math.sin(p.walkPhase * Math.PI);
      p.legL.rotation.x = swing;
      p.legR.rotation.x = -swing;
      p.armL.rotation.x = -swing * 0.7;
      p.armR.rotation.x = swing * 0.7;
    }
  }
}

function shortestAngle(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
