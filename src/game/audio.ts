// Procedural WebAudio SFX — no asset files. Sounds from other players are
// stereo-panned and attenuated by distance.
import { Weapon } from "./items";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

function ac(): AudioContext | null {
  if (!ctx) {
    try {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = 0.35;
      master.connect(ctx.destination);
    } catch {
      return null;
    }
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function out(pan = 0, gain = 1): AudioNode | null {
  const c = ac();
  if (!c || !master) return null;
  const g = c.createGain();
  g.gain.value = gain;
  if (pan !== 0) {
    const p = c.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    g.connect(p);
    p.connect(master);
  } else {
    g.connect(master);
  }
  return g;
}

function noiseBurst(dur: number, freq: number, q: number, pan: number, gain: number, type: BiquadFilterType = "bandpass") {
  const c = ac();
  const dst = out(pan, gain);
  if (!c || !dst) return;
  const len = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 1.6;
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  src.connect(f);
  f.connect(dst);
  src.start();
}

function blip(freq: number, dur: number, pan: number, gain: number, type: OscillatorType = "square", slide = 0) {
  const c = ac();
  const dst = out(pan, gain);
  if (!c || !dst) return;
  const o = c.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  if (slide !== 0) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), c.currentTime + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(1, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
  o.connect(g);
  g.connect(dst);
  o.start();
  o.stop(c.currentTime + dur);
}

export const sfx = {
  /** Call on first user gesture to unlock the AudioContext. */
  unlock() {
    ac();
  },

  shoot(weapon: number, pan = 0, vol = 1) {
    switch (weapon) {
      case Weapon.Rifle:
        noiseBurst(0.16, 900, 0.8, pan, 0.9 * vol);
        blip(220, 0.1, pan, 0.4 * vol, "sawtooth", -120);
        break;
      case Weapon.AR:
        noiseBurst(0.09, 1300, 1, pan, 0.55 * vol);
        break;
      case Weapon.Shotgun:
        noiseBurst(0.22, 600, 0.6, pan, 1.0 * vol);
        blip(140, 0.14, pan, 0.5 * vol, "sawtooth", -60);
        break;
      case Weapon.Pistol:
        noiseBurst(0.1, 1100, 1, pan, 0.6 * vol);
        break;
      case Weapon.Rocket:
        noiseBurst(0.4, 400, 0.5, pan, 0.8 * vol, "lowpass");
        blip(90, 0.3, pan, 0.6 * vol, "sawtooth", 60);
        break;
      case Weapon.Spade:
      case Weapon.Pickaxe:
        blip(300, 0.06, pan, 0.4 * vol, "triangle", -80);
        break;
    }
  },

  explosion(pan = 0, vol = 1) {
    noiseBurst(0.7, 300, 0.4, pan, 1.2 * vol, "lowpass");
    blip(55, 0.5, pan, 0.9 * vol, "sine", -25);
  },

  place(pan = 0) {
    blip(620, 0.07, pan, 0.5, "triangle", 80);
  },
  break(pan = 0) {
    noiseBurst(0.08, 800, 1.4, pan, 0.45);
  },
  hitmarker() {
    blip(2100, 0.05, 0, 0.5, "square", -300);
  },
  hurt() {
    blip(160, 0.18, 0, 0.7, "sawtooth", -70);
  },
  death() {
    blip(220, 0.5, 0, 0.8, "sawtooth", -160);
  },
  reload() {
    blip(500, 0.05, 0, 0.4, "square");
    setTimeout(() => blip(700, 0.05, 0, 0.4, "square"), 130);
  },
  respawn() {
    blip(520, 0.12, 0, 0.5, "triangle", 200);
  },
};

/** Pan/volume helper for positional one-shots. */
export function panvol(
  from: { x: number; z: number },
  listener: { x: number; z: number },
  yaw: number,
  maxDist = 70,
): { pan: number; vol: number } {
  const dx = from.x - listener.x;
  const dz = from.z - listener.z;
  const dist = Math.hypot(dx, dz);
  const vol = Math.max(0.05, 1 - dist / maxDist);
  // Right vector for yaw (rotation around Y, forward = -Z at yaw 0).
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  const pan = dist < 0.5 ? 0 : Math.max(-1, Math.min(1, (dx * rx + dz * rz) / dist)) * 0.75;
  return { pan, vol };
}
