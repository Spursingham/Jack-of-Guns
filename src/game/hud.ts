// DOM HUD: hotbar, health/ammo, kill feed, scoreboard, start & respawn
// screens. Pure presentation — game code pushes state in.
import { BLOCK_COLORS, CLASSES, WEAPONS, type Slot } from "./items";

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

export interface ScoreRow {
  id: number;
  name: string;
  classId: number;
  kills: number;
  deaths: number;
  me: boolean;
}

export class Hud {
  private hpText = el("hptext");
  private hpFill = el("hpfill");
  private ammoText = el("ammotext");
  private ammoLabel = el("ammolabel");
  private blocksText = el("blockstext");
  private hotbar = el("hotbar");
  private killfeed = el("killfeed");
  private statusEl = el("status");
  private vignette = el("vignette");
  private waterTint = el("watertint");
  private hitmarker = el("hitmarker");
  private crosshair = el("crosshair");
  private scoreboard = el("scoreboard");
  private respawnEl = el("respawn");
  private pauseEl = el("pause");
  private fpsEl = el("fps");
  private hitT = 0;
  private dmgT = 0;

  // ---- start screen ---------------------------------------------------

  bootMsg(msg: string) {
    el("boot").textContent = msg;
  }

  startError(msg: string) {
    el("starterr").textContent = msg;
    (el("playbtn") as HTMLButtonElement).disabled = false;
  }

  /** Shows the start screen; resolves with name + class on DEPLOY. */
  waitForStart(): Promise<{ name: string; classId: number }> {
    const classes = el("startclasses");
    let selected = 0;
    classes.innerHTML = "";
    for (const c of CLASSES) {
      const card = document.createElement("div");
      card.className = "ccard" + (c.id === 0 ? " sel" : "");
      const w = WEAPONS[c.primary];
      card.innerHTML = `<h4 style="color:#${c.color.toString(16).padStart(6, "0")}">${c.name}</h4><p>${w.name}<br/>${c.perk}</p>`;
      card.onclick = () => {
        classes.querySelectorAll(".ccard").forEach((e) => e.classList.remove("sel"));
        card.classList.add("sel");
        selected = c.id;
      };
      classes.appendChild(card);
    }
    const nameInput = el<HTMLInputElement>("name");
    nameInput.value = localStorage.getItem("jog-name") ?? "";
    return new Promise((resolve) => {
      const go = () => {
        const name = nameInput.value.trim() || "Deuce";
        localStorage.setItem("jog-name", name);
        (el("playbtn") as HTMLButtonElement).disabled = true;
        resolve({ name, classId: selected });
      };
      el("playbtn").onclick = go;
      nameInput.onkeydown = (e) => {
        if (e.key === "Enter") go();
      };
    });
  }

  hideStart() {
    el("start").style.display = "none";
  }

  // ---- respawn screen ---------------------------------------------------

  /** Returns the chosen class id via callback when the player respawns. */
  showRespawn(killerName: string, classId: number, onRespawn: (classId: number) => void, respawnDelay = 2.8) {
    this.respawnEl.style.display = "flex";
    el("killedby").textContent = killerName ? `Killed by ${killerName}` : "";
    const classes = el("respawnclasses");
    classes.innerHTML = "";
    let selected = classId;
    for (const c of CLASSES) {
      const card = document.createElement("div");
      card.className = "ccard" + (c.id === selected ? " sel" : "");
      card.innerHTML = `<h4 style="color:#${c.color.toString(16).padStart(6, "0")}">${c.name}</h4>`;
      card.onclick = () => {
        classes.querySelectorAll(".ccard").forEach((e) => e.classList.remove("sel"));
        card.classList.add("sel");
        selected = c.id;
      };
      classes.appendChild(card);
    }
    const timer = el("respawntimer");
    const deadAt = performance.now();
    let done = false;
    const tick = () => {
      if (done) return;
      const left = respawnDelay - (performance.now() - deadAt) / 1000;
      if (left > 0) {
        timer.textContent = `Respawn in ${left.toFixed(1)}s`;
        requestAnimationFrame(tick);
      } else {
        timer.textContent = "Press SPACE or click to respawn";
        const go = () => {
          if (done) return;
          done = true;
          removeEventListener("keydown", onKey);
          this.respawnEl.onclick = null;
          onRespawn(selected);
        };
        const onKey = (e: KeyboardEvent) => {
          if (e.code === "Space") go();
        };
        addEventListener("keydown", onKey);
        this.respawnEl.onclick = (e) => {
          if (!(e.target as HTMLElement).closest(".ccard")) go();
        };
        requestAnimationFrame(tick);
      }
    };
    tick();
  }

  hideRespawn() {
    this.respawnEl.style.display = "none";
    this.respawnEl.onclick = null;
  }

  // ---- in-game --------------------------------------------------------

  setStatus(html: string) {
    this.statusEl.innerHTML = html;
  }

  setPaused(paused: boolean) {
    this.pauseEl.style.display = paused ? "block" : "none";
  }

  setHp(hp: number) {
    this.hpText.textContent = String(Math.max(0, Math.round(hp)));
    this.hpFill.style.width = `${Math.max(0, hp)}%`;
    this.hpFill.style.background = hp > 50 ? "linear-gradient(90deg,#51d06b,#8fe07a)" : hp > 25 ? "#e0b13f" : "#d04a3a";
  }

  setAmmo(text: string, label: string) {
    this.ammoText.textContent = text;
    this.ammoLabel.textContent = label;
  }

  setBlocks(count: number, cap: number) {
    this.blocksText.textContent = `▦ ${count}/${cap} blocks`;
  }

  buildHotbar(slots: Slot[], grenades: number) {
    this.hotbar.innerHTML = "";
    slots.forEach((slot, i) => {
      const div = document.createElement("div");
      div.className = "slot";
      div.dataset.idx = String(i);
      let inner = "";
      if (slot.kind === "weapon") inner = `<span>${WEAPONS[slot.weapon].short}</span>`;
      else if (slot.kind === "grenade") inner = `<span>NADE</span><span class="count">${grenades}</span>`;
      else {
        const c = BLOCK_COLORS[slot.block];
        inner = `<div class="swatch" style="background:rgb(${c[0]},${c[1]},${c[2]})"></div>`;
      }
      div.innerHTML = `<span class="key">${i + 1}</span>${inner}`;
      this.hotbar.appendChild(div);
    });
  }

  selectSlot(i: number) {
    this.hotbar.querySelectorAll(".slot").forEach((s, idx) => s.classList.toggle("sel", idx === i));
  }

  updateGrenadeCount(n: number) {
    const c = this.hotbar.querySelector(".slot .count");
    if (c) c.textContent = String(n);
  }

  killFeed(killer: string, victim: string, weaponName: string) {
    const div = document.createElement("div");
    div.className = "kf";
    div.innerHTML = `<b>${esc(killer)}</b> ▸ ${esc(weaponName)} ▸ ${esc(victim)}`;
    this.killfeed.prepend(div);
    while (this.killfeed.children.length > 6) this.killfeed.lastChild?.remove();
    setTimeout(() => div.remove(), 7000);
  }

  hitMarker() {
    this.hitT = 0.22;
    this.hitmarker.style.opacity = "1";
  }

  damageFlash() {
    this.dmgT = 0.4;
    this.vignette.style.opacity = "1";
  }

  setZoomed(z: boolean) {
    this.crosshair.classList.toggle("zoomed", z);
  }

  setUnderwater(under: boolean) {
    this.waterTint.style.opacity = under ? "1" : "0";
  }

  setFps(fps: number, backend: string) {
    this.fpsEl.innerHTML = `${fps.toFixed(0)} FPS<br/>${backend.toUpperCase()}`;
  }

  showScoreboard(rows: ScoreRow[] | null) {
    if (!rows) {
      this.scoreboard.style.display = "none";
      return;
    }
    const tbody = this.scoreboard.querySelector("tbody")!;
    tbody.innerHTML = "";
    for (const r of [...rows].sort((a, b) => b.kills - a.kills)) {
      const tr = document.createElement("tr");
      if (r.me) tr.className = "me";
      tr.innerHTML = `<td>${esc(r.name)}</td><td>${CLASSES[r.classId]?.name ?? "?"}</td><td>${r.kills}</td><td>${r.deaths}</td>`;
      tbody.appendChild(tr);
    }
    this.scoreboard.style.display = "block";
  }

  update(dt: number) {
    if (this.hitT > 0) {
      this.hitT -= dt;
      if (this.hitT <= 0) this.hitmarker.style.opacity = "0";
    }
    if (this.dmgT > 0) {
      this.dmgT -= dt;
      if (this.dmgT <= 0) this.vignette.style.opacity = "0";
    }
  }
}

function esc(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
}
