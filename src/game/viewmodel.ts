// First-person viewmodel: simple box guns attached to the camera with
// bob, recoil kick and reload dip. Swaps model per selected slot.
import * as THREE from "three";
import { BLOCK_COLORS, Weapon, type Slot } from "./items";

const GUNMETAL = 0x32363a;
const WOODTONE = 0x7a5b38;

function box(w: number, h: number, d: number, color: number): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color }));
}

function buildModel(slot: Slot): THREE.Group {
  const g = new THREE.Group();
  if (slot.kind === "block") {
    const c = BLOCK_COLORS[slot.block];
    const cube = box(0.22, 0.22, 0.22, (c[0] << 16) | (c[1] << 8) | c[2]);
    g.add(cube);
    return g;
  }
  if (slot.kind === "grenade") {
    const body = box(0.12, 0.16, 0.12, 0x3a5232);
    const cap = box(0.05, 0.06, 0.05, 0x888888);
    cap.position.y = 0.1;
    g.add(body, cap);
    return g;
  }
  switch (slot.weapon) {
    case Weapon.Rifle: {
      const barrel = box(0.05, 0.06, 0.7, GUNMETAL);
      barrel.position.z = -0.35;
      const body = box(0.07, 0.12, 0.32, WOODTONE);
      const scope = box(0.04, 0.05, 0.16, 0x222222);
      scope.position.set(0, 0.09, -0.1);
      g.add(barrel, body, scope);
      break;
    }
    case Weapon.AR: {
      const barrel = box(0.05, 0.06, 0.5, GUNMETAL);
      barrel.position.z = -0.28;
      const body = box(0.08, 0.13, 0.3, GUNMETAL);
      const mag = box(0.05, 0.16, 0.1, 0x26282c);
      mag.position.set(0, -0.12, -0.04);
      g.add(barrel, body, mag);
      break;
    }
    case Weapon.Rocket: {
      const tube = box(0.13, 0.13, 0.8, 0x4a4f38);
      tube.position.z = -0.2;
      const tip = box(0.15, 0.15, 0.12, 0xa03838);
      tip.position.z = -0.62;
      g.add(tube, tip);
      break;
    }
    case Weapon.Shotgun: {
      const barrel = box(0.06, 0.07, 0.55, GUNMETAL);
      barrel.position.z = -0.3;
      const pump = box(0.07, 0.07, 0.16, WOODTONE);
      pump.position.set(0, -0.05, -0.3);
      const body = box(0.07, 0.12, 0.3, WOODTONE);
      g.add(barrel, pump, body);
      break;
    }
    case Weapon.Pistol: {
      const barrel = box(0.045, 0.06, 0.24, GUNMETAL);
      barrel.position.z = -0.12;
      const grip = box(0.05, 0.14, 0.07, 0x26282c);
      grip.position.set(0, -0.08, 0.05);
      g.add(barrel, grip);
      break;
    }
    case Weapon.Spade: {
      const handle = box(0.035, 0.4, 0.035, WOODTONE);
      const blade = box(0.16, 0.2, 0.02, 0x6a6f73);
      blade.position.y = -0.28;
      g.add(handle, blade);
      g.rotation.x = 0.5;
      break;
    }
    case Weapon.Pickaxe: {
      const handle = box(0.035, 0.45, 0.035, WOODTONE);
      const head = box(0.3, 0.05, 0.05, 0x6a6f73);
      head.position.y = -0.2;
      g.add(handle, head);
      g.rotation.x = 0.5;
      break;
    }
  }
  return g;
}

export class ViewModel {
  private holder = new THREE.Group();
  private model: THREE.Group | null = null;
  private kick = 0;
  private dip = 0;
  private bobT = 0;

  constructor(camera: THREE.Camera) {
    this.holder.position.set(0.28, -0.26, -0.55);
    camera.add(this.holder);
  }

  setSlot(slot: Slot) {
    if (this.model) this.holder.remove(this.model);
    this.model = buildModel(slot);
    this.holder.add(this.model);
    this.dip = Math.max(this.dip, 0.5); // draw animation
  }

  recoil(amount = 1) {
    this.kick = Math.min(1.5, this.kick + amount);
  }

  reloadDip() {
    this.dip = 1;
  }

  update(dt: number, moveSpeed: number, onGround: boolean) {
    this.bobT += dt * (onGround ? Math.min(moveSpeed, 7) : 0) * 1.6;
    const bob = Math.sin(this.bobT * Math.PI) * 0.012 * Math.min(moveSpeed / 4, 1);
    this.kick = Math.max(0, this.kick - dt * 9);
    this.dip = Math.max(0, this.dip - dt * 2.2);
    this.holder.position.set(
      0.28 + Math.cos(this.bobT * Math.PI * 0.5) * 0.008,
      -0.26 + bob - this.dip * 0.18,
      -0.55 + this.kick * 0.08,
    );
    this.holder.rotation.x = this.kick * 0.14 - this.dip * 0.5;
  }
}
