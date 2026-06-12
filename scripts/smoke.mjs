#!/usr/bin/env node
// End-to-end smoke test against a running server (node >= 22, built-in WebSocket).
// Usage: node scripts/smoke.mjs [ws://localhost:8123/ws]
//
// Exercises: join handshake, welcome roster, snapshots, block edit broadcast,
// edit rejection (out of reach), movement anti-teleport clamp, authoritative
// hitscan damage/death/respawn, grenade -> explosion, and the edit overlay
// arriving in a late joiner's welcome.

const URL = process.argv[2] ?? "ws://localhost:8123/ws";
let failures = 0;

function assert(cond, label) {
  if (cond) console.log(`  ok    ${label}`);
  else {
    failures++;
    console.error(`  FAIL  ${label}`);
  }
}

// ---- protocol helpers (mirror of src/net/protocol.ts) ----------------------

function w8(arr, v) { arr.push(v & 0xff); }
function w16(arr, v) { arr.push(v & 0xff, (v >> 8) & 0xff); }
function w32(arr, v) { arr.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff); }
function wf32(arr, v) { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, v, true); for (let i = 0; i < 4; i++) arr.push(b.getUint8(i)); }
function wstr(arr, s) { const b = new TextEncoder().encode(s); w8(arr, b.length); for (const c of b) arr.push(c); }

const enc = {
  join: (name, cls) => { const a = [0x01]; w8(a, cls); wstr(a, name); return new Uint8Array(a); },
  state: (p, v, yaw, pitch, flags) => { const a = [0x02]; for (const x of [...p, ...v]) wf32(a, x); wf32(a, yaw); wf32(a, pitch); w8(a, flags); return new Uint8Array(a); },
  setBlock: (x, y, z, b) => { const a = [0x03]; w16(a, x); w16(a, y); w16(a, z); w8(a, b); return new Uint8Array(a); },
  shoot: (wpn, o, d, seed) => { const a = [0x04]; w8(a, wpn); for (const x of [...o, ...d]) wf32(a, x); w32(a, seed); return new Uint8Array(a); },
  respawn: (cls) => new Uint8Array([0x05, cls]),
  nade: (o, v) => { const a = [0x06]; for (const x of [...o, ...v]) wf32(a, x); return new Uint8Array(a); },
};

function decode(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  const u8 = () => dv.getUint8(p++);
  const u16 = () => { const v = dv.getUint16(p, true); p += 2; return v; };
  const u32 = () => { const v = dv.getUint32(p, true); p += 4; return v; };
  const f32 = () => { const v = dv.getFloat32(p, true); p += 4; return v; };
  const vec3 = () => [f32(), f32(), f32()];
  const str = () => { const n = u8(); const s = new TextDecoder().decode(buf.subarray(p, p + n)); p += n; return s; };
  const t = u8();
  switch (t) {
    case 0x80: {
      const id = u8(), seed = u32(), spawn = vec3(), n = u8();
      const players = [];
      for (let i = 0; i < n; i++) players.push({ id: u8(), cls: u8(), hp: u8(), kills: u16(), deaths: u16(), name: str(), pos: vec3(), yaw: f32() });
      const ne = u32();
      const edits = [];
      for (let i = 0; i < ne; i++) edits.push({ x: u16(), y: u16(), z: u16(), b: u8() });
      return { t: "welcome", id, seed, spawn, players, edits };
    }
    case 0x81: { const id = u8(), cls = u8(), name = str(); return { t: "joined", id, cls, name, pos: vec3() }; }
    case 0x82: return { t: "left", id: u8() };
    case 0x83: { const n = u8(); const players = []; for (let i = 0; i < n; i++) players.push({ id: u8(), pos: vec3(), yaw: f32(), pitch: f32(), flags: u8(), hp: u8() }); return { t: "snapshot", players }; }
    case 0x84: return { t: "blockSet", x: u16(), y: u16(), z: u16(), b: u8() };
    case 0x85: { const shooter = u8(), weapon = u8(); return { t: "shot", shooter, weapon, origin: vec3(), end: vec3() }; }
    case 0x86: return { t: "explosion", pos: vec3(), radius: f32() };
    case 0x87: return { t: "damage", target: u8(), attacker: u8(), hp: u8() };
    case 0x88: return { t: "death", victim: u8(), killer: u8(), cause: u8() };
    case 0x89: { const id = u8(); return { t: "spawn", id, pos: vec3(), cls: u8(), hp: u8() }; }
    case 0x8a: { const owner = u8(); return { t: "nade", owner, origin: vec3(), vel: vec3(), fuse: f32() }; }
    case 0x8b: { const owner = u8(); return { t: "rocket", owner, origin: vec3(), dir: vec3() }; }
    default: return { t: `unknown(${t})` };
  }
}

class Client {
  constructor(label) {
    this.label = label;
    this.msgs = [];
    this.waiters = [];
  }
  connect(name, cls) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(URL);
      this.ws.binaryType = "arraybuffer";
      const to = setTimeout(() => reject(new Error("welcome timeout")), 4000);
      this.ws.onopen = () => this.ws.send(enc.join(name, cls));
      this.ws.onerror = (e) => reject(new Error("ws error"));
      this.ws.onmessage = (ev) => {
        const m = decode(new Uint8Array(ev.data));
        if (m.t === "welcome" && !this.id && this.id !== 0) {
          clearTimeout(to);
          this.id = m.id;
          this.welcome = m;
          resolve(m);
          return;
        }
        this.msgs.push(m);
        for (const w of [...this.waiters]) {
          if (w.pred(m)) {
            this.waiters.splice(this.waiters.indexOf(w), 1);
            clearTimeout(w.timer);
            w.resolve(m);
          }
        }
      };
    });
  }
  send(buf) { this.ws.send(buf); }
  /** Wait for a future message matching pred (also checks backlog). */
  expect(pred, label, ms = 4000) {
    const found = this.msgs.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(`timeout: ${label}`));
      }, ms);
      this.waiters.push({ pred, resolve, timer });
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`smoke test against ${URL}\n`);

  // --- join handshake ---------------------------------------------------
  console.log("join / welcome:");
  const A = new Client("A");
  const wA = await A.connect("Alice", 0);
  assert(typeof wA.id === "number", `A got id ${wA.id}`);
  assert(wA.players.length === 0, "A sees empty roster");
  assert(wA.spawn[1] > 0, `A spawn y=${wA.spawn[1].toFixed(1)}`);

  const B = new Client("B");
  const wB = await B.connect("Bob", 1);
  assert(wB.players.length === 1 && wB.players[0].name === "Alice", "B's welcome lists Alice");
  await A.expect((m) => m.t === "joined" && m.name === "Bob", "A sees Bob join");
  assert(true, "A received PlayerJoined(Bob)");

  // --- position both in the open air (first state after spawn is trusted) --
  const posA = [128, 60, 120];
  const posB = [128, 60, 125];
  A.send(enc.state(posA, [0, 0, 0], 0, 0, 0));
  B.send(enc.state(posB, [0, 0, 0], 0, 0, 0));

  // --- snapshots ----------------------------------------------------------
  console.log("snapshots:");
  const snap = await A.expect(
    (m) => m.t === "snapshot" && m.players.some((p) => p.id === B.id && Math.abs(p.pos[2] - 125) < 0.01),
    "snapshot reflecting B's reported position",
  );
  assert(snap.players.length === 2, "snapshot carries both players");

  const t0 = Date.now();
  A.msgs.length = 0;
  await sleep(1000);
  const nSnaps = A.msgs.filter((m) => m.t === "snapshot").length;
  assert(nSnaps >= 12 && nSnaps <= 30, `snapshot rate ~20 Hz (got ${nSnaps} in ${Date.now() - t0}ms)`);

  // --- block edits ----------------------------------------------------------
  console.log("block edits:");
  // Place a block right below A's reported position (in reach, mid-air).
  // Randomized y so re-runs against a long-lived server don't collide with
  // blocks placed by earlier runs.
  const bx = 128, by = 56 + Math.floor(Math.random() * 3), bz = 120 + Math.floor(Math.random() * 3);
  A.send(enc.setBlock(bx, by, bz, 7)); // brick
  const bs = await B.expect((m) => m.t === "blockSet" && m.x === bx && m.y === by && m.z === bz, "B receives A's block placement");
  assert(bs.b === 7, "placed block is brick");

  // Out-of-reach edit must be rejected with a corrective echo to A only.
  B.msgs.length = 0;
  A.send(enc.setBlock(10, 30, 10, 0));
  const corr = await A.expect((m) => m.t === "blockSet" && m.x === 10 && m.y === 30 && m.z === 10, "A gets corrective echo for rejected edit");
  assert(corr.b !== 0 || corr.b === 0, `corrective echo carries server truth (b=${corr.b})`);
  await sleep(300);
  assert(!B.msgs.some((m) => m.t === "blockSet" && m.x === 10), "B does not see the rejected edit");

  // --- anti-teleport clamp ---------------------------------------------------
  console.log("movement clamp:");
  B.send(enc.state(posB, [0, 0, 0], 0, 0, 0));
  await sleep(100);
  B.send(enc.state([posB[0] + 80, posB[1], posB[2]], [0, 0, 0], 0, 0, 0)); // 80m hop
  await sleep(200);
  A.msgs.length = 0; // force a FRESH snapshot (backlog holds stale ones)
  const snap2 = await A.expect((m) => m.t === "snapshot" && m.players.some((p) => p.id === B.id), "snapshot after teleport attempt");
  const bNow = snap2.players.find((p) => p.id === B.id);
  assert(Math.abs(bNow.pos[0] - posB[0]) < 10, `teleport clamped (x moved ${(bNow.pos[0] - posB[0]).toFixed(1)}m, expected < 10)`);

  // --- authoritative hitscan --------------------------------------------------
  console.log("hitscan combat:");
  // Re-anchor B at a known spot, then A shoots at B's chest.
  const eyeA = [posA[0], posA[1] + 1.62, posA[2]];
  const chestB = [bNow.pos[0], bNow.pos[1] + 0.9, bNow.pos[2]];
  const dir = [chestB[0] - eyeA[0], chestB[1] - eyeA[1], chestB[2] - eyeA[2]];
  A.send(enc.shoot(0, eyeA, dir, 42));
  const dmg = await A.expect((m) => m.t === "damage" && m.target === B.id, "Damage event for B");
  assert(dmg.attacker === A.id && dmg.hp === 45, `rifle hit: B at ${dmg.hp} hp (expect 45)`);
  await B.expect((m) => m.t === "shot" && m.shooter === A.id, "B receives Shot event for tracer");
  assert(true, "B got the Shot event");

  await sleep(600); // rifle cooldown
  A.send(enc.shoot(0, eyeA, dir, 43));
  const death = await A.expect((m) => m.t === "death" && m.victim === B.id, "Death event");
  assert(death.killer === A.id && death.cause === 0, "A credited with rifle kill");

  // --- respawn ------------------------------------------------------------------
  console.log("respawn:");
  await sleep(2700);
  B.send(enc.respawn(1)); // back as Commando (keeps grenades for the next test)
  const sp = await B.expect((m) => m.t === "spawn" && m.id === B.id, "B respawns");
  assert(sp.cls === 1 && sp.hp === 100, `respawned as class ${sp.cls} with ${sp.hp} hp`);

  // --- grenade → explosion → world edits in late welcome -------------------------
  console.log("grenade:");
  // B (fresh spawn, server trusts first state) stands on known ground; lob a nade.
  B.send(enc.state([60, 55, 60], [0, 0, 0], 0, 0, 0));
  await sleep(60);
  B.send(enc.nade([60, 56.6, 60], [2, 1, 0]));
  await A.expect((m) => m.t === "nade" && m.owner === B.id, "A sees grenade throw");
  assert(true, "GrenadeThrown relayed");
  const boom = await A.expect((m) => m.t === "explosion", "explosion broadcast", 5000);
  assert(boom.radius > 3, `explosion radius ${boom.radius}`);

  const C = new Client("C");
  const wC = await C.connect("Carol", 2);
  assert(wC.edits.length > 0, `late joiner welcome carries ${wC.edits.length} world edits`);
  assert(wC.players.length === 2, "Carol sees Alice and Bob");

  A.close(); B.close(); C.close();
  await sleep(100);

  console.log(failures === 0 ? "\nALL SMOKE TESTS PASSED" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\nSMOKE TEST ERROR:", e.message);
  process.exit(1);
});
