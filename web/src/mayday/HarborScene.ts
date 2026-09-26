// The MAYDAY harbor: HQ lighthouse on the left, the Payments API server
// platform offshore on the right, a sandbox barge between them. Agent boats sail
// to bid, to the sandbox, or to the platform; human rescue boats launch when the
// team is paged. State-driven: render(state) sets targets, the ticker animates.
import { Application, Container, Graphics, Text } from "pixi.js";

import type { AgentId } from "../contract";
import type { MarketState } from "../state/reducer";
import { harborModel, type BoatSpot, type HarborModel, type Mood } from "./model";

const W = 1600;
const H = 820;
const SEA_Y = 380;
const FONT = ["JetBrains Mono", "Consolas", "monospace"];

const MOOD_COLOR: Record<Mood, { accent: number; glow: number; sky: number }> = {
  calm: { accent: 0x4cc9f0, glow: 0x4cc9f0, sky: 0x081624 },
  alarm: { accent: 0xff4d5e, glow: 0xff7a59, sky: 0x1a0810 },
  repair: { accent: 0xffb547, glow: 0xff9f43, sky: 0x140f0a },
  restored: { accent: 0x3dffa8, glow: 0x33e1ff, sky: 0x06161c },
};

const PLATFORM = { x: 1150, y: 430, w: 360 };
const SANDBOX = { x: 760, y: 610 };
const AGENT_INDEX: Record<AgentId, number> = { haiku: 0, sonnet: 1, opus: 2 };

function spotFor(spot: BoatSpot, i: number): { x: number; y: number } {
  switch (spot) {
    case "dock": return { x: 210 + i * 95, y: 600 };
    case "bidding": return { x: 470 + i * 150, y: 500 };
    case "sandbox": return { x: SANDBOX.x - 10, y: SANDBOX.y + 110 };
    case "platform": return { x: PLATFORM.x - 60 + i * 20, y: PLATFORM.y + 250 };
  }
}

function label(value: string, size: number, fill: number | string = 0xe6f1ff, weight: "400" | "700" = "700"): Text {
  const t = new Text({ text: value, style: { fontFamily: FONT, fontSize: size, fill, fontWeight: weight } });
  t.anchor.set(0.5);
  return t;
}

interface Boat {
  root: Container;
  hull: Graphics;
  flag: Text;
  flagBg: Graphics;
  x: number;
  y: number;
  target: { x: number; y: number };
  phase: number;
}

interface Rescue {
  root: Container;
  x: number;
  y: number;
  target: { x: number; y: number };
  phase: number;
}

interface Puff {
  g: Graphics;
  life: number;
  vx: number;
}

export class HarborScene {
  private readonly app: Application;
  private readonly el: HTMLElement;
  private readonly world = new Container();
  private readonly sky = new Graphics();
  private readonly stars = new Graphics();
  private readonly sea = new Graphics();
  private readonly waves = new Graphics();
  private readonly beam = new Graphics();
  private readonly lamp = new Graphics();
  private readonly racks = new Graphics();
  private readonly glow = new Graphics();
  private readonly barge = new Graphics();
  private readonly smoke = new Container();
  private readonly sign: Text;
  private readonly sandboxText: Text;
  private readonly sandboxVerdict: Text;
  private readonly boats = new Map<AgentId, Boat>();
  private readonly rescues = new Map<string, Rescue>();
  private readonly rescueLayer = new Container();
  private puffs: Puff[] = [];
  private model: HarborModel | null = null;
  private time = 0;
  private resizeObserver: ResizeObserver | null = null;
  private lastKey = "";

  private constructor(el: HTMLElement, app: Application) {
    this.el = el;
    this.app = app;
    this.sign = label("PAYMENTS API", 22);
    this.sandboxText = label("SANDBOX", 14, 0x9fb3c8);
    this.sandboxVerdict = label("", 26);
  }

  static async create(el: HTMLElement): Promise<HarborScene> {
    const app = new Application();
    await app.init({
      resizeTo: el,
      backgroundAlpha: 0,
      antialias: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      autoDensity: true,
    });
    const scene = new HarborScene(el, app);
    scene.build();
    el.appendChild(app.canvas);
    app.canvas.classList.add("harbor-canvas");
    scene.resizeObserver = new ResizeObserver(() => scene.fit());
    scene.resizeObserver.observe(el);
    scene.fit();
    app.ticker.add((ticker) => scene.tick(ticker.deltaMS));
    return scene;
  }

  render(state: MarketState): void {
    const model = harborModel(state);
    const key = JSON.stringify(model);
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.model = model;
    this.apply(model);
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.app.destroy(true, { children: true });
  }

  private fit(): void {
    const { clientWidth: w, clientHeight: h } = this.el;
    if (!w || !h) return;
    this.app.renderer.resize(w, h);
    // Show the whole harbor, anchored to the bottom; sky and sea are drawn past
    // the world edges so the leftover space never shows a border.
    const scale = Math.min(w / W, h / H);
    this.world.scale.set(scale);
    this.world.position.set(Math.round((w - W * scale) / 2), Math.round(h - H * scale));
  }

  // ---------------------------------------------------------------- build
  private build(): void {
    this.app.stage.addChild(this.world);
    this.world.addChild(this.sky, this.stars, this.beam, this.sea, this.waves);
    this.drawStars();
    this.buildLighthouse();
    this.buildPlatform();
    this.buildSandbox();
    this.world.addChild(this.rescueLayer);
    for (const agentId of ["haiku", "sonnet", "opus"] as AgentId[]) this.buildBoat(agentId);
    this.world.addChild(this.smoke);
  }

  private drawStars(): void {
    let seed = 7;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 260; i += 1) {
      const x = rand() * W * 3 - W;
      const y = rand() * (SEA_Y + 2 * H - 40) - 2 * H;
      this.stars.circle(x, y, rand() * 1.6 + 0.4).fill({ color: 0xffffff, alpha: 0.35 + rand() * 0.5 });
    }
  }

  private buildLighthouse(): void {
    const g = new Graphics();
    // Pier
    g.rect(-W, 560, W + 560, 26).fill(0x3a2a1f);
    for (let x = 16 - 58 * 20; x < 560; x += 58) g.rect(x, 586, 10, 120).fill(0x2a1d15);
    g.rect(-W, 552, W + 560, 8).fill(0x5a4230);
    // HQ building
    g.rect(40, 470, 150, 90).fill(0x1b2a3a);
    g.rect(40, 462, 150, 10).fill(0x2c4056);
    for (let i = 0; i < 4; i += 1) g.rect(54 + i * 34, 494, 20, 26).fill({ color: 0xffd98a, alpha: 0.75 });
    // Lighthouse tower
    g.poly([230, 560, 300, 560, 285, 250, 245, 250]).fill(0xe8edf2);
    for (let i = 0; i < 4; i += 1) {
      const y0 = 300 + i * 66;
      g.poly([245 - i * 1.3, y0, 285 + i * 1.3, y0, 287 + i * 1.3, y0 + 26, 243 - i * 1.3, y0 + 26]).fill(0xd64545);
    }
    g.rect(236, 236, 58, 16).fill(0x1c2733);
    g.rect(244, 200, 42, 36).fill(0x0f1720);
    g.poly([236, 200, 294, 200, 265, 176]).fill(0x1c2733);
    this.world.addChild(g, this.lamp);
    const hq = label("MAYDAY HQ", 16, 0x9fb3c8);
    hq.position.set(115, 450);
    this.world.addChild(hq);
  }

  private buildPlatform(): void {
    const { x, y, w } = PLATFORM;
    const g = new Graphics();
    // Legs into the sea
    for (const lx of [x + 20, x + w * 0.35, x + w * 0.65, x + w - 30]) {
      g.rect(lx, y + 80, 16, 260).fill(0x2b3947);
      g.rect(lx - 4, y + 150, 24, 8).fill(0x3c4d5e);
    }
    g.moveTo(x + 28, y + 160).lineTo(x + w * 0.35 + 8, y + 300).stroke({ width: 5, color: 0x2b3947 });
    g.moveTo(x + w - 22, y + 160).lineTo(x + w * 0.65 + 8, y + 300).stroke({ width: 5, color: 0x2b3947 });
    // Deck
    g.rect(x - 10, y + 70, w + 20, 18).fill(0x46586a);
    g.rect(x - 10, y + 86, w + 20, 6).fill(0x2b3947);
    // Crane
    g.rect(x + w - 50, y - 90, 10, 160).fill(0x5d6d7e);
    g.moveTo(x + w - 45, y - 90).lineTo(x + w - 160, y - 60).stroke({ width: 6, color: 0x5d6d7e });
    this.world.addChild(g, this.glow, this.racks);
    this.sign.position.set(x + w / 2 - 20, y - 118);
    this.world.addChild(this.sign);
  }

  private buildSandbox(): void {
    this.world.addChild(this.barge, this.sandboxText, this.sandboxVerdict);
    this.sandboxText.position.set(SANDBOX.x, SANDBOX.y + 92);
    this.sandboxVerdict.position.set(SANDBOX.x, SANDBOX.y - 40);
  }

  private buildBoat(agentId: AgentId): void {
    const root = new Container();
    const hull = new Graphics();
    const flagBg = new Graphics();
    const flag = label("", 15, 0x0b1320);
    const name = label(agentId.toUpperCase(), 13, 0xe6f1ff);
    name.position.set(0, 34);
    flag.position.set(0, -66);
    root.addChild(hull, flagBg, flag, name);
    const start = spotFor("dock", AGENT_INDEX[agentId]);
    root.position.set(start.x, start.y);
    this.world.addChild(root);
    this.boats.set(agentId, { root, hull, flag, flagBg, x: start.x, y: start.y, target: start, phase: AGENT_INDEX[agentId] * 1.7 });
  }

  // ---------------------------------------------------------------- state -> targets
  private apply(model: HarborModel): void {
    for (const boat of model.boats) {
      const view = this.boats.get(boat.agentId);
      if (!view) continue;
      view.target = spotFor(boat.spot, AGENT_INDEX[boat.agentId]);
      this.drawBoat(view, boat.color);
      view.flag.text = boat.flag ?? "";
      view.flagBg.clear();
      if (boat.flag) {
        const w = Math.max(54, view.flag.width + 18);
        const fill = boat.flagTone === "good" ? 0x3dffa8 : boat.flagTone === "bad" ? 0xff4d5e : 0xf4f7fb;
        view.flagBg.moveTo(0, -24).lineTo(0, -54).stroke({ width: 3, color: 0xc9d4df });
        view.flagBg.roundRect(-w / 2, -80, w, 28, 6).fill(fill);
      }
    }

    const seen = new Set<string>();
    model.responders.forEach((responder, i) => {
      seen.add(responder.id);
      let view = this.rescues.get(responder.id);
      if (!view) {
        view = this.buildRescue(responder.name, i);
        this.rescues.set(responder.id, view);
      }
      view.target = responder.spot === "platform"
        ? { x: PLATFORM.x + 40 + i * 78, y: PLATFORM.y + 330 }
        : { x: 1000 + i * 70, y: 770 };
    });
    for (const [id, view] of this.rescues) {
      if (!seen.has(id)) {
        view.root.destroy({ children: true });
        this.rescues.delete(id);
      }
    }

    this.sandboxText.text = model.sandboxLabel.toUpperCase();
    this.sandboxVerdict.text = model.sandbox === "pass" ? "PASS" : model.sandbox === "fail" ? "REJECTED" : model.sandbox === "testing" ? "TESTING..." : "";
    this.sandboxVerdict.style.fill = model.sandbox === "pass" ? 0x3dffa8 : model.sandbox === "fail" ? 0xff4d5e : 0xffb547;
    this.sign.style.fill = model.platform === "down" ? 0xff4d5e : model.platform === "restored" ? 0x3dffa8 : 0xe6f1ff;
  }

  private buildRescue(name: string, i: number): Rescue {
    const root = new Container();
    const g = new Graphics();
    g.poly([-26, 0, 26, 0, 18, 14, -18, 14]).fill(0xff7b1c);
    g.rect(-10, -14, 20, 14).fill(0xf4f7fb);
    g.rect(-26, -2, 52, 4).fill(0xffffff);
    const tag = label(name.toUpperCase(), 12, 0xffd0a8);
    tag.position.set(0, 28);
    root.addChild(g, tag);
    const start = { x: 120 + i * 40, y: 640 };
    root.position.set(start.x, start.y);
    this.rescueLayer.addChild(root);
    return { root, x: start.x, y: start.y, target: start, phase: i * 1.3 };
  }

  private drawBoat(view: Boat, color: string): void {
    const g = view.hull;
    g.clear();
    g.poly([-40, 0, 40, 0, 30, 20, -30, 20]).fill(color);
    g.rect(-40, -3, 80, 5).fill(0xf4f7fb);
    g.rect(-16, -22, 30, 20).fill(0xe6edf5);
    g.rect(-10, -17, 8, 7).fill(0x16324a);
    g.rect(2, -17, 8, 7).fill(0x16324a);
  }

  // ---------------------------------------------------------------- animation
  private tick(deltaMS: number): void {
    const dt = Math.min(64, deltaMS) / 1000;
    this.time += dt;
    const model = this.model;
    const mood = model?.mood ?? "calm";
    const colors = MOOD_COLOR[mood];

    const pad = W;
    this.sky.clear();
    this.sky.rect(-pad, -3 * H, W + 2 * pad, 3 * H + SEA_Y).fill(colors.sky);
    this.sky.rect(-pad, SEA_Y - 120, W + 2 * pad, 120).fill({ color: colors.glow, alpha: 0.06 });
    this.sky.circle(1380, 110, 34).fill({ color: 0xf4f1de, alpha: 0.9 });

    this.sea.clear();
    this.sea.rect(-pad, SEA_Y, W + 2 * pad, H - SEA_Y + 200).fill(0x06121f);
    this.sea.rect(-pad, SEA_Y, W + 2 * pad, 40).fill({ color: colors.glow, alpha: 0.05 });

    this.waves.clear();
    for (let row = 0; row < 11; row += 1) {
      const y = SEA_Y + 24 + row * 40;
      const amp = 3 + row * 0.5;
      this.waves.moveTo(-pad, y);
      for (let x = -pad; x <= W + pad; x += 40) {
        this.waves.lineTo(x, y + Math.sin(x / 90 + this.time * (1.2 + row * 0.08) + row) * amp);
      }
      this.waves.stroke({ width: 2, color: row % 3 === 0 ? colors.accent : 0x2a5a7a, alpha: row % 3 === 0 ? 0.18 : 0.35 });
    }

    // Lighthouse beam sweeps; red and fast during an incident.
    const speed = mood === "alarm" ? 2.6 : mood === "repair" ? 1.6 : 0.7;
    const angle = Math.sin(this.time * speed) * 0.9;
    const lx = 265;
    const ly = 218;
    const len = 900;
    this.beam.clear();
    this.beam
      .poly([lx, ly, lx + Math.cos(angle - 0.08) * len, ly + Math.sin(angle - 0.08) * len * 0.35, lx + Math.cos(angle + 0.08) * len, ly + Math.sin(angle + 0.08) * len * 0.35])
      .fill({ color: colors.glow, alpha: 0.13 });
    this.lamp.clear();
    this.lamp.circle(lx, ly, 13).fill(colors.glow);
    this.lamp.circle(lx, ly, 26).fill({ color: colors.glow, alpha: 0.25 });

    this.drawRacks(model);
    this.drawBarge(model);
    this.updateSmoke(dt, model);

    for (const boat of this.boats.values()) {
      boat.x += (boat.target.x - boat.x) * Math.min(1, dt * 1.8);
      boat.y += (boat.target.y - boat.y) * Math.min(1, dt * 1.8);
      const bob = Math.sin(this.time * 2 + boat.phase) * 3;
      boat.root.position.set(boat.x, boat.y + bob);
      boat.root.rotation = Math.sin(this.time * 1.6 + boat.phase) * 0.03;
    }
    for (const rescue of this.rescues.values()) {
      rescue.x += (rescue.target.x - rescue.x) * Math.min(1, dt * 1.2);
      rescue.y += (rescue.target.y - rescue.y) * Math.min(1, dt * 1.2);
      rescue.root.position.set(rescue.x, rescue.y + Math.sin(this.time * 2.4 + rescue.phase) * 2.5);
    }
  }

  private drawRacks(model: HarborModel | null): void {
    const { x, y } = PLATFORM;
    const state = model?.platform ?? "healthy";
    const g = this.racks;
    g.clear();
    this.glow.clear();
    const glowColor = state === "down" ? 0xff4d5e : state === "restored" ? 0x3dffa8 : 0x4cc9f0;
    const pulse = state === "down" ? 0.18 + 0.12 * Math.sin(this.time * 8) : 0.12;
    this.glow.circle(x + 150, y + 20, 190).fill({ color: glowColor, alpha: pulse * 0.5 });
    for (let r = 0; r < 4; r += 1) {
      const rx = x + 20 + r * 72;
      g.rect(rx, y - 70, 58, 140).fill(0x121c27);
      g.rect(rx, y - 70, 58, 6).fill(0x2b3947);
      for (let row = 0; row < 9; row += 1) {
        const ry = y - 56 + row * 14;
        g.rect(rx + 6, ry, 46, 9).fill(0x1c2a38);
        for (let led = 0; led < 3; led += 1) {
          const seed = (r * 31 + row * 7 + led * 13) % 17;
          let color = 0x3dffa8;
          let on = Math.sin(this.time * (3 + seed * 0.4) + seed) > -0.2;
          if (state === "down") {
            color = seed % 3 === 0 ? 0xffb547 : 0xff4d5e;
            on = Math.sin(this.time * (9 + seed) + seed) > 0;
          }
          if (on) g.rect(rx + 10 + led * 9, ry + 3, 5, 3).fill(color);
        }
      }
    }
  }

  private drawBarge(model: HarborModel | null): void {
    const { x, y } = SANDBOX;
    const state = model?.sandbox ?? "idle";
    const g = this.barge;
    g.clear();
    const edge = state === "pass" ? 0x3dffa8 : state === "fail" ? 0xff4d5e : state === "testing" ? 0xffb547 : 0x4a6178;
    const bob = Math.sin(this.time * 1.4) * 2;
    g.poly([x - 90, y + 60 + bob, x + 90, y + 60 + bob, x + 74, y + 82 + bob, x - 74, y + 82 + bob]).fill(0x2b3947);
    g.rect(x - 90, y + 56 + bob, 180, 6).fill(edge);
    g.rect(x - 40, y - 14 + bob, 80, 70).fill(0x121c27);
    g.rect(x - 40, y - 14 + bob, 80, 70).stroke({ width: 2, color: edge, alpha: 0.9 });
    for (let row = 0; row < 4; row += 1) {
      const on = state === "testing" ? Math.sin(this.time * 10 + row) > 0 : state !== "idle";
      if (on) g.rect(x - 28, y - 2 + row * 14 + bob, 56, 5).fill(edge);
    }
    this.sandboxVerdict.y = y - 40 + bob;
  }

  private updateSmoke(dt: number, model: HarborModel | null): void {
    if (model?.platform === "down" && Math.random() < dt * 9) {
      const g = new Graphics();
      g.circle(0, 0, 10 + Math.random() * 12).fill({ color: 0x3a3f47, alpha: 0.55 });
      g.position.set(PLATFORM.x + 60 + Math.random() * 220, PLATFORM.y - 70);
      this.smoke.addChild(g);
      this.puffs.push({ g, life: 0, vx: 8 + Math.random() * 14 });
    }
    this.puffs = this.puffs.filter((puff) => {
      puff.life += dt;
      puff.g.y -= dt * 38;
      puff.g.x += dt * puff.vx;
      puff.g.scale.set(1 + puff.life * 0.9);
      puff.g.alpha = Math.max(0, 1 - puff.life / 3);
      if (puff.life >= 3) {
        puff.g.destroy();
        return false;
      }
      return true;
    });
    if (model?.platform === "down" && Math.random() < dt * 4) {
      const spark = new Graphics();
      spark.circle(0, 0, 3).fill(0xffd166);
      spark.position.set(PLATFORM.x + 20 + Math.random() * 280, PLATFORM.y - 60 + Math.random() * 120);
      this.smoke.addChild(spark);
      this.puffs.push({ g: spark, life: 2.6, vx: 0 });
    }
  }
}
