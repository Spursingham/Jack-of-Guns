// Pointer-lock mouse look + key state. Pure input collection; game logic
// reads the public fields each frame.

export class Controls {
  yaw = 0;
  pitch = 0;
  keys = new Set<string>();
  lmb = false;
  rmb = false;
  locked = false;
  sensitivity = 0.0023;
  /** Scales look speed while zoomed. */
  sensScale = 1;

  onSlot: ((n: number) => void) | null = null;
  onWheel: ((dir: number) => void) | null = null;
  onLockChange: ((locked: boolean) => void) | null = null;
  onLmbDown: (() => void) | null = null;
  onRmbDown: (() => void) | null = null;
  onKey: ((code: string) => void) | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    canvas.addEventListener("click", () => {
      if (!this.locked) canvas.requestPointerLock();
    });
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) {
        this.keys.clear();
        this.lmb = this.rmb = false;
      }
      this.onLockChange?.(this.locked);
    });
    document.addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * this.sensitivity * this.sensScale;
      this.pitch -= e.movementY * this.sensitivity * this.sensScale;
      const lim = Math.PI / 2 - 0.01;
      this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
    });
    document.addEventListener("mousedown", (e) => {
      if (!this.locked) return;
      if (e.button === 0) {
        this.lmb = true;
        this.onLmbDown?.();
      } else if (e.button === 2) {
        this.rmb = true;
        this.onRmbDown?.();
      }
    });
    document.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.lmb = false;
      else if (e.button === 2) this.rmb = false;
    });
    document.addEventListener("contextmenu", (e) => e.preventDefault());
    document.addEventListener("wheel", (e) => {
      if (this.locked) this.onWheel?.(Math.sign(e.deltaY));
    });
    document.addEventListener("keydown", (e) => {
      if (!this.locked) return;
      if (e.code === "Tab") e.preventDefault();
      this.keys.add(e.code);
      const m = /^Digit([1-9])$/.exec(e.code);
      if (m) this.onSlot?.(parseInt(m[1], 10) - 1);
      if (!e.repeat) this.onKey?.(e.code);
    });
    document.addEventListener("keyup", (e) => this.keys.delete(e.code));
  }

  lock() {
    if (!this.locked) this.canvas.requestPointerLock();
  }

  down(code: string): boolean {
    return this.keys.has(code);
  }
}
