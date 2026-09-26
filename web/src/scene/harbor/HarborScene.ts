// The MAYDAY harbor: the Abyss market dock on the left, the Payments API
// platform offshore on the right, and a sandbox barge in between. Drawn with
// Pixi Graphics; render(state) sets targets and the ticker animates toward them.
import { Application, Container, Graphics, Text } from "pixi.js";

import type { MarketState } from "../../state/reducer";
import { harborModel, type Berth, type BoatModel, type HarborModel, type Mood } from "./model";

export const HARBOR = { w: 1200, h: 960 };
const SEA_Y = 380;
const FONT = ["Silkscreen", "monospace"];
const PLATFORM = { x: 780, y: 230, w: 320 };
const BARGE = { x: 450, y: 650 };

const MOOD_COLOR: Record<Mood, { sky: string; glow: string; led: string }> = {
  healthy: { sky: "#0d2236", glow: "#39d2c0", led: "#39d98a" },
  alarm: { sky: "#2a0f19", glow: "#ff5a4f", led: "#ff4d4d" },
  recovering: { sky: "#1f1a22", glow: "#f5b342", led: "#f5b342" },
  restored: { sky: "#0b2433", glow: "#3ee8c9", led: "#3ee89a" },
  failed: { sky: "#240b10", glow: "#ff3b3b", led: "#ff3b3b" },
};

function label(value: string, size: number, fill = "#e8f1f5"): Text {
  const t = new Text({ text: value, style: { fontFamily: FONT, fontSize: size, fill } });
  t.anchor.set(0.5);
  return t;
}

interface BoatView {
  root: Container;
  hull: Graphics;
  name: Text;
  bubbleBg: Graphics;
  bubble: Text;
  x: number;
  y: number;
  phase: number;
}

export class HarborScene {
  readonly app: Application;
  private readonly el: HTMLElement;
  private readonly world = new Container();
  private readonly sky = new Graphics();
  private readonly sea = new Graphics();
  private readonly waves = new Graphics();
  private readonly platform = new Graphics();
  private readonly leds = new Graphics();
  private readonly beacon = new Graphics();
  private readonly smoke = new Graphics();
  private readonly barge = new Graphics();
  private readonly bargeLight = new Graphics();
  private readonly bargeText = label("SANDBOX", 16);
  private readonly platformText = label("PAYMENTS API", 20);
  private readonly boatLayer = new Container();
  private readonly boats = new Map<string, BoatView>();
  private model: HarborModel | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private time = 0;

  private constructor(el: HTMLElement, app: Application) {
    this.el = el;
    this.app = app;
  }

  static async create(el: HTMLElement): Promise<HarborScene> {
    await document.fonts.load('16px "Silkscreen"').catch(() => undefined);
    const app = new Application();
    await app.init({ resizeTo: el, backgroundAlpha: 0, antialias: true, resolution: Math.min(2, window.devicePixelRatio || 1), autoDensity: true });
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
    this.model = harborModel(state);
    this.drawStatic(this.model.mood);
    this.syncBoats(this.model.boats);
    this.bargeText.text = this.model.sandboxLabel;
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.app.destroy(true, { children: true });
  }

  private fit(): void {
    const { clientWidth: w, clientHeight: h } = this.el;
    if (!w || !h) return;
    this.app.renderer.resize(w, h);
    const scale = Math.max(w / HARBOR.w, h / HARBOR.h);
    this.world.scale.set(scale);
    this.world.position.set(Math.round((w - HARBOR.w * scale) / 2), Math.round((h - HARBOR.h * scale) / 2));
  }

  private build(): void {
    this.app.stage.addChild(this.world);
    const dock = new Graphics();
    // Pier and market dock
    dock.rect(0, SEA_Y - 20, 470, 26).fill("#5a3d27");
    for (let x = 10; x < 470; x += 34) dock.rect(x, SEA_Y + 6, 10, 70).fill("#3b2819");
    dock.rect(0, SEA_Y - 26, 470, 6).fill("#7a5537");
    // Market stalls on the dock
    const stallColors = ["#4fb3a9", "#e8a33d", "#8e6cc9"];
    stallColors.forEach((color, i) => {
      const x = 160 + i * 100;
      dock.rect(x, SEA_Y - 96, 80, 70).fill("#1c2b3a");
      dock.poly([x - 8, SEA_Y - 96, x + 88, SEA_Y - 96, x + 74, SEA_Y - 124, x + 6, SEA_Y - 124]).fill(color);
    });
    // Lighthouse
    dock.rect(100, SEA_Y - 230, 24, 204).fill("#d9dde2");
    for (let y = SEA_Y - 210; y < SEA_Y - 30; y += 40) dock.rect(100, y, 24, 14).fill("#c94a4a");
    const dockSign = label("ABYSS AGENT MARKET", 18, "#f4dc97");
    dockSign.position.set(300, SEA_Y - 146);

    const platformLegs = new Graphics();
    for (let i = 0; i < 4; i += 1) {
      platformLegs.rect(PLATFORM.x + 20 + i * 92, PLATFORM.y + 120, 16, 300).fill("#2c3a47");
    }
    this.platformText.position.set(PLATFORM.x + PLATFORM.w / 2, PLATFORM.y - 34);

    this.bargeText.position.set(BARGE.x + 90, BARGE.y - 58);

    this.world.addChild(
      this.sky, this.sea, this.waves, dock, dockSign, platformLegs, this.platform, this.leds,
      this.beacon, this.smoke, this.platformText, this.barge, this.bargeLight, this.bargeText, this.boatLayer,
    );
    this.drawStatic("healthy");
  }

  private drawStatic(mood: Mood): void {
    const colors = MOOD_COLOR[mood];
    this.sky.clear().rect(0, 0, HARBOR.w, SEA_Y).fill(colors.sky);
    for (let i = 0; i < 40; i += 1) {
      this.sky.rect((i * 397) % HARBOR.w, (i * 131) % (SEA_Y - 60), 3, 3).fill({ color: "#ffffff", alpha: 0.5 });
    }
    this.sky.circle(560, 110, 30).fill({ color: "#f3efd6", alpha: 0.85 });
    this.sea.clear().rect(0, SEA_Y, HARBOR.w, HARBOR.h - SEA_Y).fill("#0a2a3f");

    const { x, y, w } = PLATFORM;
    this.platform.clear();
    this.platform.rect(x - 10, y + 110, w + 20, 18).fill("#3d4d5c");
    this.platform.rect(x, y, w, 112).fill("#18222d").stroke({ width: 3, color: colors.glow, alpha: 0.7 });
    for (let i = 0; i < 4; i += 1) this.platform.rect(x + 18 + i * 78, y + 14, 60, 88).fill("#0c141c");

    this.barge.clear();
    this.barge.poly([BARGE.x, BARGE.y, BARGE.x + 180, BARGE.y, BARGE.x + 160, BARGE.y + 28, BARGE.x + 20, BARGE.y + 28]).fill("#384654");
    this.barge.rect(BARGE.x + 50, BARGE.y - 40, 80, 40).fill("#1c2733").stroke({ width: 2, color: "#8fb3c9" });
  }

  private syncBoats(models: BoatModel[]): void {
    const seen = new Set<string>();
    for (const boat of models) {
      seen.add(boat.id);
      let view = this.boats.get(boat.id);
      if (!view) {
        view = this.createBoat(boat);
        this.boats.set(boat.id, view);
      }
      this.drawBoat(view, boat);
    }
    for (const [id, view] of this.boats) {
      if (!seen.has(id)) {
        view.root.destroy({ children: true });
        this.boats.delete(id);
      }
    }
  }

  private createBoat(boat: BoatModel): BoatView {
    const root = new Container();
    const hull = new Graphics();
    const name = label(boat.label, 13);
    name.position.set(0, 26);
    const bubbleBg = new Graphics();
    const bubble = label("", 14, "#10202c");
    bubble.position.set(0, -58);
    root.addChild(hull, name, bubbleBg, bubble);
    this.boatLayer.addChild(root);
    const home = this.berthPosition(boat, "dock");
    return { root, hull, name, bubbleBg, bubble, x: home.x, y: home.y, phase: Math.random() * Math.PI * 2 };
  }

  private drawBoat(view: BoatView, boat: BoatModel): void {
    const w = boat.kind === "agent" ? 64 : 44;
    view.hull.clear();
    view.hull.poly([-w / 2, 0, w / 2, 0, w / 2 - 10, 16, -w / 2 + 10, 16]).fill(boat.kind === "agent" ? "#2b1d14" : "#39424c");
    view.hull.rect(-2, -40, 4, 40).fill("#c8b89a");
    view.hull.poly([2, -38, 2, -6, boat.kind === "agent" ? 28 : 20, -6]).fill(boat.color);
    if (boat.highlight) view.hull.rect(-w / 2, 17, w, 3).fill("#f4dc97");
    view.bubble.text = boat.bubble ?? "";
    view.bubbleBg.clear();
    if (boat.bubble) {
      const bw = view.bubble.width + 18;
      view.bubbleBg.roundRect(-bw / 2, -72, bw, 28, 6).fill("#f4f7f9");
      view.bubbleBg.poly([-6, -44, 6, -44, 0, -36]).fill("#f4f7f9");
    }
  }

  private berthPosition(boat: BoatModel, berth: Berth): { x: number; y: number } {
    const models = this.model?.boats ?? [boat];
    const human = boat.kind === "human";
    // Humans at the platform line up by dispatch order so the paged team stays together.
    const group = models.filter((b) => b.kind === boat.kind && (!human || berth !== "platform" || b.berth === "platform"));
    const slot = Math.max(0, group.findIndex((b) => b.id === boat.id));
    if (berth === "platform") {
      return human
        ? { x: PLATFORM.x - 60 + slot * 105, y: 830 }
        : { x: PLATFORM.x + 40 + slot * 110, y: 690 };
    }
    if (berth === "sandbox") return { x: BARGE.x + 90, y: BARGE.y + 80 };
    return human ? { x: 130 + slot * 88, y: 830 } : { x: 180 + slot * 110, y: 470 };
  }

  private tick(deltaMS: number): void {
    this.time += deltaMS / 1000;
    const t = this.time;
    const model = this.model;
    const mood = model?.mood ?? "healthy";
    const colors = MOOD_COLOR[mood];

    this.waves.clear();
    for (let row = 0; row < 12; row += 1) {
      const y = SEA_Y + 20 + row * 48;
      for (let x = -40; x < HARBOR.w; x += 80) {
        const dx = (x + t * (18 + row * 6)) % (HARBOR.w + 80);
        this.waves.rect(dx, y + Math.sin(t * 1.6 + x * 0.05 + row) * 4, 34, 3).fill({ color: "#5fa8c7", alpha: 0.25 });
      }
    }

    this.leds.clear();
    const broken = mood === "alarm" || mood === "failed";
    for (let rack = 0; rack < 4; rack += 1) {
      for (let row = 0; row < 7; row += 1) {
        const on = broken ? Math.sin(t * 9 + rack * 3 + row * 1.7) > 0.2 : Math.sin(t * 3 + rack + row * 2.3) > -0.6;
        const x = PLATFORM.x + 26 + rack * 78;
        this.leds.rect(x, PLATFORM.y + 22 + row * 11, 44, 5).fill({ color: on ? colors.led : "#1b2733", alpha: on ? 1 : 0.8 });
      }
    }

    this.beacon.clear();
    const pulse = 0.5 + 0.5 * Math.sin(t * (broken ? 8 : 2));
    const bx = PLATFORM.x + PLATFORM.w / 2;
    this.beacon.circle(bx, PLATFORM.y - 8, 10).fill(colors.glow);
    this.beacon.circle(bx, PLATFORM.y - 8, 26 + pulse * 30).fill({ color: colors.glow, alpha: 0.12 + pulse * 0.12 });

    this.smoke.clear();
    const damage = model?.damage ?? 0;
    if (broken && damage > 0) {
      for (let i = 0; i < 12; i += 1) {
        const life = (t * 0.35 + i / 12) % 1;
        const sx = PLATFORM.x + 60 + ((i * 53) % 220) + Math.sin(t + i) * 10;
        this.smoke.circle(sx, PLATFORM.y - life * 150, 10 + life * 26).fill({ color: "#3a3a44", alpha: (1 - life) * 0.5 * damage });
      }
      if (Math.sin(t * 13) > 0.7) {
        this.smoke.rect(PLATFORM.x + 40 + ((t * 700) % 250), PLATFORM.y + 60, 6, 6).fill("#ffd166");
      }
    }

    this.bargeLight.clear();
    const light = model?.sandbox ?? "idle";
    const lightColor = light === "pass" ? "#3ee89a" : light === "fail" ? "#ff4d4d" : light === "testing" ? "#f5b342" : "#4b6273";
    const blink = light === "testing" ? 0.4 + 0.6 * Math.abs(Math.sin(t * 6)) : 1;
    this.bargeLight.circle(BARGE.x + 90, BARGE.y - 20, 12).fill({ color: lightColor, alpha: blink });
    this.bargeText.style.fill = light === "fail" ? "#ff8a80" : light === "pass" ? "#7ff5c4" : "#e8f1f5";

    for (const boat of model?.boats ?? []) {
      const view = this.boats.get(boat.id);
      if (!view) continue;
      const target = this.berthPosition(boat, boat.berth);
      view.x += (target.x - view.x) * Math.min(1, deltaMS / 900);
      view.y += (target.y - view.y) * Math.min(1, deltaMS / 900);
      view.root.position.set(view.x, view.y + Math.sin(t * 2 + view.phase) * 3);
      view.root.rotation = Math.sin(t * 1.5 + view.phase) * 0.03;
    }
  }
}
