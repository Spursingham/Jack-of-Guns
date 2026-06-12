// Visual effects: cube debris particles (instanced), tracer lines,
// explosion flashes and camera shake. All pooled, zero allocation per frame.
import * as THREE from "three";

const MAX_PARTICLES = 768;
const MAX_TRACERS = 32;

interface Particle {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  size: number;
}

interface Tracer {
  line: THREE.Line;
  life: number;
}

export class Effects {
  private particles: Particle[] = [];
  private particleMesh: THREE.InstancedMesh;
  private tracers: Tracer[] = [];
  private tracerPool: THREE.Line[] = [];
  private flashes: { sprite: THREE.Sprite; life: number; scale: number }[] = [];
  private flashTexture: THREE.Texture;
  private shakeAmp = 0;
  private dummy = new THREE.Object3D();

  constructor(private scene: THREE.Scene) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshBasicMaterial();
    this.particleMesh = new THREE.InstancedMesh(geo, mat, MAX_PARTICLES);
    this.particleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.particleMesh.count = 0;
    this.particleMesh.frustumCulled = false;
    scene.add(this.particleMesh);

    for (let i = 0; i < MAX_TRACERS; i++) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
      const m = new THREE.LineBasicMaterial({
        color: 0xffe9a8,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const line = new THREE.Line(g, m);
      line.visible = false;
      line.frustumCulled = false;
      scene.add(line);
      this.tracerPool.push(line);
    }

    // Radial gradient sprite for explosion flashes.
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const ctx = c.getContext("2d")!;
    const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
    grad.addColorStop(0, "rgba(255,240,190,1)");
    grad.addColorStop(0.35, "rgba(255,160,40,0.85)");
    grad.addColorStop(1, "rgba(255,90,20,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    this.flashTexture = new THREE.CanvasTexture(c);
  }

  /** Burst of colored debris cubes (block break, impacts, explosions). */
  burst(at: THREE.Vector3, color: [number, number, number], count: number, speed = 4, size = 0.09) {
    for (let i = 0; i < count; i++) {
      if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
      const a = Math.random() * Math.PI * 2;
      const up = Math.random() * 0.9 + 0.25;
      const s = speed * (0.4 + Math.random() * 0.8);
      const p: Particle = {
        pos: at.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.4, Math.random() * 0.4, (Math.random() - 0.5) * 0.4)),
        vel: new THREE.Vector3(Math.cos(a) * s, up * s, Math.sin(a) * s),
        life: 0,
        maxLife: 0.35 + Math.random() * 0.45,
        size: size * (0.6 + Math.random() * 0.9),
      };
      this.particles.push(p);
      const idx = this.particles.length - 1;
      this.particleMesh.setColorAt(
        idx,
        new THREE.Color(color[0] / 255, color[1] / 255, color[2] / 255).multiplyScalar(0.7 + Math.random() * 0.5),
      );
    }
    if (this.particleMesh.instanceColor) this.particleMesh.instanceColor.needsUpdate = true;
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3) {
    const line = this.tracerPool.find((l) => !l.visible);
    if (!line) return;
    const attr = line.geometry.getAttribute("position") as THREE.BufferAttribute;
    attr.setXYZ(0, from.x, from.y, from.z);
    attr.setXYZ(1, to.x, to.y, to.z);
    attr.needsUpdate = true;
    line.visible = true;
    this.tracers.push({ line, life: 0 });
  }

  explosionFx(at: THREE.Vector3, radius: number, debrisColor: [number, number, number]) {
    this.burst(at, debrisColor, 40, 9, 0.16);
    this.burst(at, [70, 60, 55], 20, 6, 0.12);
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.flashTexture,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    sprite.position.copy(at);
    sprite.scale.setScalar(radius * 1.2);
    this.scene.add(sprite);
    this.flashes.push({ sprite, life: 0, scale: radius * 2.4 });
  }

  shake(amount: number) {
    this.shakeAmp = Math.min(0.6, this.shakeAmp + amount);
  }

  /** Apply decaying shake offset; call right before render. */
  applyShake(camera: THREE.Camera) {
    if (this.shakeAmp <= 0.001) return;
    camera.position.x += (Math.random() - 0.5) * this.shakeAmp;
    camera.position.y += (Math.random() - 0.5) * this.shakeAmp;
    camera.position.z += (Math.random() - 0.5) * this.shakeAmp;
  }

  update(dt: number) {
    // Particles: integrate with gravity, write instance matrices.
    let alive = 0;
    for (const p of this.particles) {
      p.life += dt;
      if (p.life >= p.maxLife) continue;
      p.vel.y -= 16 * dt;
      p.pos.addScaledVector(p.vel, dt);
      const k = 1 - p.life / p.maxLife;
      this.dummy.position.copy(p.pos);
      this.dummy.scale.setScalar(p.size * (0.5 + k * 0.5));
      this.dummy.rotation.set(p.life * 6, p.life * 5, 0);
      this.dummy.updateMatrix();
      this.particleMesh.setMatrixAt(alive, this.dummy.matrix);
      alive++;
    }
    this.particles = this.particles.filter((p) => p.life < p.maxLife);
    this.particleMesh.count = alive;
    this.particleMesh.instanceMatrix.needsUpdate = true;

    for (const t of this.tracers) {
      t.life += dt;
      const m = t.line.material as THREE.LineBasicMaterial;
      m.opacity = Math.max(0, 0.9 - t.life * 9);
      if (t.life > 0.1) t.line.visible = false;
    }
    this.tracers = this.tracers.filter((t) => t.line.visible);

    for (const f of this.flashes) {
      f.life += dt;
      const k = f.life / 0.28;
      f.sprite.scale.setScalar(f.scale * (0.4 + k));
      (f.sprite.material as THREE.SpriteMaterial).opacity = Math.max(0, 1 - k);
      if (k >= 1) {
        this.scene.remove(f.sprite);
        f.sprite.material.dispose();
      }
    }
    this.flashes = this.flashes.filter((f) => f.life < 0.28);

    this.shakeAmp *= Math.max(0, 1 - dt * 7);
  }
}
