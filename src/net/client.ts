// WebSocket client. Connects, performs the Join/Welcome handshake, then
// dispatches decoded server messages to a handler. Falls back to offline
// (single-player) mode if the server can't be reached.
import { decode, encode, type ServerMsg } from "./protocol";

const CONNECT_TIMEOUT_MS = 5000;

export type WelcomeMsg = Extract<ServerMsg, { t: "welcome" }>;

/**
 * Game server endpoint. Same-origin `/ws` by default (the Rust server serves
 * both). A static host (e.g. GitHub Pages) can point at an external server
 * with `?server=my-game.fly.dev` or `?server=ws://localhost:8080` — without
 * it the client just drops into the offline sandbox.
 */
function serverUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const override = new URLSearchParams(location.search).get("server");
  if (override) {
    const base = override.includes("://") ? override : `${proto}://${override}`;
    return base.replace(/\/$/, "").endsWith("/ws") ? base : `${base.replace(/\/$/, "")}/ws`;
  }
  return `${proto}://${location.host}/ws`;
}

export class NetClient {
  private ws: WebSocket | null = null;
  connected = false;
  myId = -1;
  onMessage: ((msg: ServerMsg) => void) | null = null;
  onDisconnect: (() => void) | null = null;

  connect(name: string, classId: number): Promise<WelcomeMsg> {
    const url = serverUrl();
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (why: string) => {
        if (!settled) {
          settled = true;
          reject(new Error(why));
        }
      };
      const timer = setTimeout(() => {
        fail("connection timed out");
        this.ws?.close();
      }, CONNECT_TIMEOUT_MS);

      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        clearTimeout(timer);
        fail(String(e));
        return;
      }
      this.ws = ws;
      ws.binaryType = "arraybuffer";

      ws.onopen = () => ws.send(encode.join(name, classId));
      ws.onerror = () => fail("connection failed");
      ws.onclose = () => {
        const was = this.connected;
        this.connected = false;
        if (!settled) fail("connection closed");
        else if (was) this.onDisconnect?.();
      };
      ws.onmessage = (ev) => {
        const msg = decode(new Uint8Array(ev.data as ArrayBuffer));
        if (!msg) return;
        if (!settled) {
          if (msg.t === "welcome") {
            settled = true;
            clearTimeout(timer);
            this.connected = true;
            this.myId = msg.id;
            resolve(msg);
          }
          return;
        }
        this.onMessage?.(msg);
      };
    });
  }

  private send(buf: Uint8Array) {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) this.ws.send(buf);
  }

  sendState(pos: { x: number; y: number; z: number }, vel: { x: number; y: number; z: number }, yaw: number, pitch: number, flags: number) {
    this.send(encode.state(pos, vel, yaw, pitch, flags));
  }
  sendSetBlock(x: number, y: number, z: number, b: number) {
    this.send(encode.setBlock(x, y, z, b));
  }
  sendShoot(weapon: number, origin: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, seed: number) {
    this.send(encode.shoot(weapon, origin, dir, seed));
  }
  sendRespawn(classId: number) {
    this.send(encode.respawn(classId));
  }
  sendThrowGrenade(origin: { x: number; y: number; z: number }, vel: { x: number; y: number; z: number }) {
    this.send(encode.throwGrenade(origin, vel));
  }
  sendFireRocket(origin: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }) {
    this.send(encode.fireRocket(origin, dir));
  }
}
