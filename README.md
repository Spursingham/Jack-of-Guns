# Jack of Guns

A browser-first multiplayer **voxel FPS** — a spiritual successor to *Ace of Spades* (0.x).
Fully destructible/constructible terrain, four classes, rocket jumps, and instant play:
no install, no plugins. WebGPU rendering with automatic WebGL fallback.

```
three.js (WebGPU/WebGL)  ←→  Rust → WASM voxel core  ←→  Rust authoritative server
        rendering              meshing · raycasts            60 Hz sim · WebSocket
```

## Features

- **Voxel world** — 256×64×256 map (8×2×8 chunks of 32³), procedurally generated
  (rolling hills, beaches, snow caps, trees, bedrock floor) from a shared seed.
- **Greedy meshing in Rust/WASM** — coplanar faces merged into large quads, one
  draw call per chunk, lighting baked into vertex colors (the classic AoS
  flat-color look). Dirty-chunk tracking remeshes only what changed, under a
  per-frame time budget.
- **Destructible/constructible** — DDA raycast (WASM) for dig/place/shoot;
  explosions carve deterministic spheres replayed identically on every client.
- **Multiplayer** — Rust (axum/tokio) authoritative server over a compact
  binary WebSocket protocol (~37 B state packets, 20 Hz snapshots, interpolated
  remote players). The server validates reach, rate, line-of-sight hitscan,
  explosion damage, movement speed (anti-teleport), and corrects rejected edits.
- **Classes** (Ace of Spades style):

  | Class     | Primary         | Secondary | Perk                          |
  |-----------|-----------------|-----------|-------------------------------|
  | Marksman  | Semi-auto rifle | Pistol    | RMB scope zoom                |
  | Commando  | Assault rifle   | Grenades  | Fastest sprint                |
  | Rocketeer | Rocket launcher | Pistol    | Rocket jump (low self-damage) |
  | Miner     | Shotgun         | Pickaxe   | Insta-dig, 2× blocks & build  |

- **Game feel** — first-person viewmodels, tracers, debris particles, explosion
  flashes & screen shake, kill feed, scoreboard, hitmarkers, procedural WebAudio
  SFX with stereo panning. Offline sandbox mode if no server is reachable.

## Quick start

Prereqs: **Node 20+**, **Rust 1.75+** with the wasm target, and `wasm-bindgen-cli`:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.123   # must match Cargo.toml pin
npm install
```

Dev loop (two terminals):

```sh
npm run server   # game server on :8080 (SEED=1337 PORT=8080 to override)
npm run dev      # vite on :5173, /ws proxied to the server
```

Open `http://localhost:5173`, pick a name + class, **DEPLOY**. Open a second
tab for instant multiplayer. Append `?gl` to force the WebGL path.

Production:

```sh
npm run build                      # wasm + type-check + vite build → dist/
cargo run -p server --release      # serves dist/ and /ws on :8080
```

### Controls

| Input | Action |
|---|---|
| WASD / Space / Shift / C | move / jump / sprint / crouch |
| Mouse, LMB | look, use item (shoot · dig · throw) |
| RMB | scope (Marksman) · place block (block slots) |
| 1–8 / wheel | hotbar: primary · secondary · spade · 5 block types |
| R | reload |
| Tab | scoreboard |

## Testing

```sh
cargo test --workspace      # mesher, raycast, worldgen, protocol, validation
npm run check               # strict TypeScript
npm run build               # full client build
npm run smoke               # end-to-end: real server + 3 protocol clients
```

The smoke test spins three headless clients through the entire flow: join,
snapshots, edit broadcast/rejection, anti-teleport, authoritative kills,
respawn, grenades, and world-edit persistence for late joiners.

## Architecture

```
crates/voxel-core    pure Rust: world, gen, greedy mesher, DDA ray, explosions
crates/voxel-wasm    wasm-bindgen bridge for the browser (≈44 KB .wasm)
crates/server        axum/tokio: 60 Hz tick, players, projectiles, anti-cheat
src/                 TypeScript client (three.js)
  engine/            renderer (WebGPU→WebGL), chunk meshes, physics, input
  game/              combat, classes, avatars, effects, HUD, audio, viewmodel
  net/               binary protocol (mirror of server) + WebSocket client
scripts/smoke.mjs    protocol-level integration test
```

The same `voxel-core` crate compiles into both the WASM client and the native
server, so world generation, raycasts and explosion shapes are **identical by
construction** — the server only ships a seed plus an edit overlay
(`world = f(seed) + edits`), which is also what late joiners receive.

State flow per tick: clients send inputs/state at 20 Hz → server validates
(reach, rate limits, cooldowns, movement clamp, LoS raycasts vs voxels *and*
player AABBs) → broadcasts snapshots, block edits, shots, explosions, damage,
deaths. Clients predict their own edits and movement; the server echoes or
corrects.

## Deploy

**Full multiplayer** — single container (builds wasm + client + server):

```sh
docker build -t jack-of-guns .
docker run -p 8080:8080 -e SEED=1337 jack-of-guns
```

Works as-is on Railway / Render / Fly.io (they detect the Dockerfile; the
server honors `$PORT`). WebSockets pass through their default HTTP proxies.

**GitHub Pages (client only)** — `.github/workflows/deploy-pages.yml` builds
the static client and publishes it on every push to `main`. One-time setup:
repo **Settings → Pages → Source: "GitHub Actions"** (the workflow also tries
to enable this itself). Pages can't run the game server, so the Pages site
boots into the **offline single-player sandbox** — to get multiplayer from a
static host, deploy the server container somewhere and point the client at it:

```
https://<user>.github.io/Jack-of-Guns/?server=my-game.fly.dev
```

(`?server=` accepts `host[:port]` or a full `ws://` / `wss://` URL; pages
served over https need a TLS-terminated `wss` server, which Railway/Render/Fly
provide by default.)

## Roadmap (post-MVP)

- WebRTC DataChannels (unreliable transport) with WS fallback; lag-compensated
  rewind for hitscan
- Web Worker pool for meshing (wasm-bindgen-rayon), vertex AO
- Server-side block inventory enforcement; headshots; fall damage
- Teams, CTF-style intel mode, map persistence (RocksDB), mobile touch controls
