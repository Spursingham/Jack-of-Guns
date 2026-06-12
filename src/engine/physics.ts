// Kinematic character controller: per-axis AABB sweep against the voxel
// grid. The local player is client-predicted; the server only sanity-clamps.
import * as THREE from "three";
import type { VoxelWorld } from "../wasm/voxel";
import { MOVE } from "../game/items";

export interface MoveInput {
  fwd: number; // -1..1
  strafe: number; // -1..1
  jump: boolean;
  crouch: boolean;
  sprint: boolean;
  sprintMult: number;
}

export class PlayerBody {
  pos = new THREE.Vector3(); // feet center
  vel = new THREE.Vector3();
  onGround = false;
  crouching = false;
  yaw = 0;

  constructor(private world: VoxelWorld) {}

  get height(): number {
    return this.crouching ? MOVE.bodyHCrouch : MOVE.bodyHStand;
  }
  get eyeHeight(): number {
    return this.crouching ? MOVE.eyeCrouch : MOVE.eyeStand;
  }
  eye(): THREE.Vector3 {
    return new THREE.Vector3(this.pos.x, this.pos.y + this.eyeHeight, this.pos.z);
  }

  teleport(x: number, y: number, z: number) {
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
  }

  step(input: MoveInput, dt: number) {
    // Crouch state (don't stand up under a ceiling).
    if (input.crouch) {
      this.crouching = true;
    } else if (this.crouching && this.headroomToStand()) {
      this.crouching = false;
    }

    // Wish direction in world space from yaw.
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    let wx = -sin * input.fwd - cos * input.strafe;
    let wz = -cos * input.fwd + sin * input.strafe;
    const wl = Math.hypot(wx, wz);
    if (wl > 1) {
      wx /= wl;
      wz /= wl;
    }
    let speed = MOVE.walk;
    if (this.crouching) speed *= MOVE.crouchMult;
    else if (input.sprint && input.fwd > 0) speed *= input.sprintMult;

    // Horizontal acceleration: strong on ground, weak in air.
    const accel = this.onGround ? 12 : 2.4;
    const k = Math.min(1, accel * dt);
    this.vel.x += (wx * speed - this.vel.x) * k;
    this.vel.z += (wz * speed - this.vel.z) * k;

    this.vel.y -= MOVE.gravity * dt;
    if (this.vel.y < -55) this.vel.y = -55;
    if (input.jump && this.onGround) {
      this.vel.y = MOVE.jumpVel;
      this.onGround = false;
    }

    this.moveAxis(0, this.vel.x * dt);
    this.onGround = false;
    this.moveAxis(1, this.vel.y * dt);
    this.moveAxis(2, this.vel.z * dt);

    // Keep inside the map horizontally (map edge is open air).
    const hw = MOVE.bodyHalfW;
    this.pos.x = THREE.MathUtils.clamp(this.pos.x, hw + 0.01, this.world.size_x() - hw - 0.01);
    this.pos.z = THREE.MathUtils.clamp(this.pos.z, hw + 0.01, this.world.size_z() - hw - 0.01);
  }

  private headroomToStand(): boolean {
    const hw = MOVE.bodyHalfW;
    const x0 = Math.floor(this.pos.x - hw);
    const x1 = Math.floor(this.pos.x + hw);
    const z0 = Math.floor(this.pos.z - hw);
    const z1 = Math.floor(this.pos.z + hw);
    const y0 = Math.floor(this.pos.y + MOVE.bodyHCrouch);
    const y1 = Math.floor(this.pos.y + MOVE.bodyHStand - 0.001);
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) if (this.world.is_solid(x, y, z)) return false;
    return true;
  }

  /** Move along one axis, clamping against solid voxels. */
  private moveAxis(axis: 0 | 1 | 2, delta: number) {
    if (delta === 0) return;
    const p = this.pos;
    const hw = MOVE.bodyHalfW;
    const h = this.height;
    const comp = axis === 0 ? "x" : axis === 1 ? "y" : "z";
    p[comp] += delta;

    // AABB in voxel coords after the move.
    const minX = p.x - hw,
      maxX = p.x + hw;
    const minY = p.y,
      maxY = p.y + h;
    const minZ = p.z - hw,
      maxZ = p.z + hw;
    const x0 = Math.floor(minX),
      x1 = Math.floor(maxX - 1e-7);
    const y0 = Math.floor(minY),
      y1 = Math.floor(maxY - 1e-7);
    const z0 = Math.floor(minZ),
      z1 = Math.floor(maxZ - 1e-7);

    let hit = false;
    for (let y = y0; y <= y1 && !hit; y++)
      for (let z = z0; z <= z1 && !hit; z++)
        for (let x = x0; x <= x1 && !hit; x++) if (this.world.is_solid(x, y, z)) hit = true;
    if (!hit) return;

    // Push back to the voxel boundary along this axis.
    if (axis === 0) {
      if (delta > 0) p.x = Math.floor(maxX) - hw - 1e-4;
      else p.x = Math.floor(minX) + 1 + hw + 1e-4;
      this.vel.x = 0;
    } else if (axis === 1) {
      if (delta > 0) {
        p.y = Math.floor(maxY) - h - 1e-4;
      } else {
        p.y = Math.floor(minY) + 1 + 1e-4;
        this.onGround = true;
      }
      this.vel.y = 0;
    } else {
      if (delta > 0) p.z = Math.floor(maxZ) - hw - 1e-4;
      else p.z = Math.floor(minZ) + 1 + hw + 1e-4;
      this.vel.z = 0;
    }
  }
}
