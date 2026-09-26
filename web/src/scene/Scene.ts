// The seaside market, built on the painted backdrop (art/market_reference.png,
// cleaned by art/prepare_scene.py). Everything live is an overlay in the art's
// own pixel coordinates. Fully state-driven: render(state) alone produces the
// correct picture; director.ts adds motion on top.
import { Application, Assets, Container, Graphics, Sprite, Text, type Texture } from "pixi.js";

import type { AgentId, TaskType } from "../contract";
import type { MarketState } from "../state/reducer";
import { AGENT_ORDER, MAX_CARDS, TASK_TYPES, VENDOR, sceneModel, type BubbleTone, type SceneModel, type StallModel } from "./model";

export const WORLD = { w: 2816, h: 1536 };
const FONT = ["Silkscreen", "monospace"];

export const PALETTE = {
  ink: "#1b1b2f",
  paper: "#fffdf6",
  cream: "#f3e6c8",
  gold: "#f0cb68",
  good: "#3fb950",
  ok: "#e0a82e",
  bad: "#e0473c",
  muted: "#9aa3ad",
  research: "#4aa8e0",
  writing: "#e8a33d",
  checking: "#d0508a",
} as const;

/** Where each agent's stall is in the art: plate centre (cx) over the painted
 *  "Vendor" sign row (y0..y1), and the spot in front where bids appear. */
export const STALLS: Record<AgentId, { cx: number; label: [number, number, number, number]; front: { x: number; y: number } }> = {
  opus: { cx: 651, label: [486, 932, 816, 979], front: { x: 651, y: 1040 } },
  sonnet: { cx: 1200, label: [1035, 932, 1365, 979], front: { x: 1200, y: 1040 } },
  haiku: { cx: 1810, label: [1645, 932, 1975, 979], front: { x: 1810, y: 1040 } },
};
const PLATE_W = 330;
const CLOSED_CX = 2272;
const DELIVERY_LABEL = { x: 1905, y: 1352 };
export const BOARD = { x: 1400, y: 440, w: 305, h: 160 };
export const HUB_SPOT = { x: 1552, y: 690 };
export const DELIVERY_SPOT = { x: 1800, y: 1238 };
export const COURIER_HOME = { x: 1694, y: 1049 };
export const OFFICER = { x: 1940, y: 1220 };
export const SPENT_POS = { x: WORLD.w - 40, y: 44 };
const MAIN_BUBBLE: [number, number, number, number] = [424, 699, 664, 766];
const GRADE_BUBBLE = { x: 1941, y: 1090 };

const TYPE_COLOR: Record<TaskType, string> = {
  research: PALETTE.research,
  writing: PALETTE.writing,
  checking: PALETTE.checking,
  diagnose: PALETTE.research,
  remediate: PALETTE.writing,
  verify: PALETTE.checking,
};
const BUBBLE_TEXT_COLOR: Record<BubbleTone, string> = {
  thinking: PALETTE.muted,
  bid: PALETTE.ink,
  pass: PALETTE.muted,
  won: "#8a5a00",
  working: "#1f5f8b",
  done: "#1d6b2a",
};
const CARD_FILL: Record<string, string> = {
  pending: "#8a6a44",
  open: PALETTE.paper,
  assigned: PALETTE.paper,
  working: PALETTE.paper,
  done: "#dff3d8",
  graded: "#dff3d8",
  failed: "#f6d0cc",
};

export function text(value: string, size: number, fill: string = PALETTE.paper): Text {
  const t = new Text({ text: value, style: { fontFamily: FONT, fontSize: size, fill } });
  t.anchor.set(0.5);
  return t;
}

/** White pixel-style speech bubble centred at (cx, cy), tail pointing `tail`. */
function bubble(g: Graphics, cx: number, cy: number, w: number, h: number, tail: "up" | "down" | null, fill: string = PALETTE.paper): void {
  const x = Math.round(cx - w / 2);
  const y = Math.round(cy - h / 2);
  g.roundRect(x - 4, y - 4, w + 8, h + 8, 10).fill(PALETTE.ink);
  g.roundRect(x, y, w, h, 7).fill(fill);
  if (tail === "down") {
    g.poly([cx - 14, y + h, cx + 14, y + h, cx, y + h + 20]).fill(PALETTE.ink);
    g.poly([cx - 8, y + h - 2, cx + 8, y + h - 2, cx, y + h + 11]).fill(fill);
  } else if (tail === "up") {
    g.poly([cx - 14, y, cx + 14, y, cx, y - 20]).fill(PALETTE.ink);
    g.poly([cx - 8, y + 2, cx + 8, y + 2, cx, y - 11]).fill(fill);
  }
}

interface StallView {
  plate: Graphics;
  name: Text;
  role: Text;
  reps: Graphics;
  bubbleBg: Graphics;
  bubbleText: Text;
}

interface CardView {
  bg: Graphics;
  label: Text;
  glyph: Text;
}

export class MarketScene {
  readonly app: Application;
  /** World-space layer for director.ts effects, above all overlays. */
  readonly fx = new Container();
  readonly world = new Container();
  courier!: Sprite;
  private readonly el: HTMLElement;
  private readonly stalls = new Map<AgentId, StallView>();
  private readonly cards: CardView[] = [];
  private banner!: Text;
  private spent!: Text;
  private captainBg!: Graphics;
  private captainText!: Text;
  private gradeBg!: Graphics;
  private gradeText!: Text;
  private finalBg!: Graphics;
  private finalText!: Text;
  private resizeObserver: ResizeObserver | null = null;
  private lastModel = "";

  private constructor(el: HTMLElement, app: Application) {
    this.el = el;
    this.app = app;
  }

  static async create(el: HTMLElement): Promise<MarketScene> {
    await document.fonts.load('16px "Silkscreen"').catch(() => undefined);
    const app = new Application();
    await app.init({
      resizeTo: el,
      backgroundAlpha: 0,
      antialias: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      autoDensity: true,
    });
    const [backdrop, courier] = await Promise.all([
      Assets.load<Texture>("/art/market.png"),
      Assets.load<Texture>("/art/courier.png"),
    ]);
    const scene = new MarketScene(el, app);
    scene.build(backdrop, courier);
    el.appendChild(app.canvas);
    app.canvas.classList.add("market-canvas");
    scene.resizeObserver = new ResizeObserver(() => scene.fit());
    scene.resizeObserver.observe(el);
    scene.fit();
    return scene;
  }

  render(state: MarketState): void {
    const model = sceneModel(state);
    const key = JSON.stringify(model);
    if (key === this.lastModel) return;
    this.lastModel = key;
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
    const scale = Math.min(w / WORLD.w, h / WORLD.h);
    this.world.scale.set(scale);
    this.world.position.set(Math.round((w - WORLD.w * scale) / 2), Math.round((h - WORLD.h * scale) / 2));
  }

  // ------------------------------------------------------------ build once
  private build(backdrop: Texture, courier: Texture): void {
    this.app.stage.addChild(this.world);
    this.world.addChild(new Sprite(backdrop));

    this.courier = new Sprite(courier);
    this.courier.anchor.set(0.5);
    this.courier.position.set(COURIER_HOME.x, COURIER_HOME.y);
    this.world.addChild(this.courier);

    this.buildBoard();
    for (const agentId of AGENT_ORDER) this.buildStall(agentId);
    this.buildClosedStall();

    this.captainBg = new Graphics();
    this.captainText = text("", 26, PALETTE.ink);
    this.captainText.position.set((MAIN_BUBBLE[0] + MAIN_BUBBLE[2]) / 2, (MAIN_BUBBLE[1] + MAIN_BUBBLE[3]) / 2);
    this.gradeBg = new Graphics();
    this.gradeText = text("", 30, PALETTE.ink);
    this.gradeText.position.set(GRADE_BUBBLE.x + 26, GRADE_BUBBLE.y);

    const hud = new Graphics().rect(0, 0, WORLD.w, 88).fill({ color: PALETTE.ink, alpha: 0.72 });
    this.banner = text("", 38);
    this.banner.anchor.set(0, 0.5);
    this.banner.position.set(40, 44);
    this.spent = text("", 38, PALETTE.gold);
    this.spent.anchor.set(1, 0.5);
    this.spent.position.set(SPENT_POS.x, SPENT_POS.y);
    this.finalBg = new Graphics();
    this.finalText = text("", 48, PALETTE.ink);
    this.finalText.position.set(WORLD.w / 2, 150);

    this.world.addChild(
      this.captainBg, this.captainText, this.gradeBg, this.gradeText,
      hud, this.banner, this.spent, this.finalBg, this.finalText, this.fx,
    );
  }

  private buildBoard(): void {
    const { x, y, w, h } = BOARD;
    const panel = new Graphics();
    panel.roundRect(x - 6, y - 6, w + 12, h + 12, 6).fill("#5b3a1e");
    panel.roundRect(x, y, w, h, 4).fill("#c89a5e");
    this.world.addChild(panel);
    const rowH = h / MAX_CARDS;
    for (let i = 0; i < MAX_CARDS; i += 1) {
      const card: CardView = { bg: new Graphics(), label: text("", 20, PALETTE.ink), glyph: text("", 20, PALETTE.ink) };
      card.label.anchor.set(0, 0.5);
      card.label.position.set(x + 22, y + rowH * i + rowH / 2);
      card.glyph.anchor.set(1, 0.5);
      card.glyph.position.set(x + w - 12, y + rowH * i + rowH / 2);
      this.world.addChild(card.bg, card.label, card.glyph);
      this.cards.push(card);
    }
  }

  private buildStall(agentId: AgentId): void {
    const { cx } = STALLS[agentId];
    const view: StallView = {
      plate: new Graphics(),
      name: text("", 26),
      role: text("", 15, PALETTE.muted),
      reps: new Graphics(),
      bubbleBg: new Graphics(),
      bubbleText: text("", 28, PALETTE.ink),
    };
    view.name.anchor.set(0, 0.5);
    view.name.position.set(cx - PLATE_W / 2 + 14, 948);
    view.role.anchor.set(0, 0.5);
    view.role.position.set(cx - PLATE_W / 2 + 14, 976);
    view.bubbleText.position.set(cx, STALLS[agentId].front.y);
    this.world.addChild(view.plate, view.name, view.role, view.reps, view.bubbleBg, view.bubbleText);
    for (const [i, type] of TASK_TYPES.entries()) {
      const letter = text(type[0].toUpperCase(), 14, PALETTE.cream);
      letter.position.set(cx + 46, 942 + i * 16);
      this.world.addChild(letter);
    }
    this.stalls.set(agentId, view);
  }

  private buildClosedStall(): void {
    const cx = CLOSED_CX;
    const plate = new Graphics();
    plate.roundRect(cx - PLATE_W / 2 - 5, 919, PLATE_W + 10, 73, 10).fill(PALETTE.muted);
    plate.roundRect(cx - PLATE_W / 2, 924, PLATE_W, 63, 7).fill({ color: PALETTE.ink, alpha: 0.94 });
    const label = text("CLOSED", 30, PALETTE.muted);
    label.position.set(cx, 955);
    const delivery = text("TASK DELIVERY", 30, PALETTE.paper);
    delivery.style.stroke = { color: PALETTE.ink, width: 6 };
    delivery.position.set(DELIVERY_LABEL.x, DELIVERY_LABEL.y);
    this.world.addChild(plate, label, delivery);
  }

  // ------------------------------------------------------------ state → picture
  private apply(model: SceneModel): void {
    this.banner.text = model.banner.length > 70 ? `${model.banner.slice(0, 67)}...` : model.banner;
    this.spent.text = model.spent;

    for (const agentId of AGENT_ORDER) {
      this.drawStall(agentId, this.stalls.get(agentId)!, model.stalls.find((s) => s.agentId === agentId) ?? null);
    }
    this.drawBoard(model);

    this.captainBg.clear();
    this.captainText.text = model.captain;
    const cw = Math.max(MAIN_BUBBLE[2] - MAIN_BUBBLE[0] - 8, this.captainText.width + 36);
    bubble(this.captainBg, this.captainText.x, this.captainText.y, cw, MAIN_BUBBLE[3] - MAIN_BUBBLE[1] - 8, "down");

    this.gradeBg.clear();
    this.gradeText.text = "";
    if (model.reviewing) {
      bubble(this.gradeBg, GRADE_BUBBLE.x, GRADE_BUBBLE.y, 110, 70, "down");
      this.gradeText.text = "...";
      this.gradeText.x = GRADE_BUBBLE.x;
    } else if (model.review) {
      const grade = model.review.text.split(" ")[1];
      bubble(this.gradeBg, GRADE_BUBBLE.x + 14, GRADE_BUBBLE.y, 180, 76, "down");
      this.drawVerdict(model.review.tone, GRADE_BUBBLE.x - 46, GRADE_BUBBLE.y);
      this.gradeText.text = grade;
      this.gradeText.x = GRADE_BUBBLE.x + 40;
    }

    this.finalBg.clear();
    this.finalText.text = model.finalBanner ?? "";
    if (model.finalBanner) {
      const w = this.finalText.width + 60;
      this.finalBg.roundRect(WORLD.w / 2 - w / 2 - 5, 115, w + 10, 80, 12).fill(PALETTE.ink);
      this.finalBg.roundRect(WORLD.w / 2 - w / 2, 120, w, 70, 9).fill(PALETTE.gold);
    }
  }

  private drawVerdict(tone: "good" | "ok" | "bad", x: number, y: number): void {
    const g = this.gradeBg;
    if (tone === "bad") {
      g.moveTo(x - 20, y - 20).lineTo(x + 20, y + 20).moveTo(x + 20, y - 20).lineTo(x - 20, y + 20)
        .stroke({ width: 12, color: PALETTE.bad, cap: "round" });
    } else {
      g.moveTo(x - 22, y).lineTo(x - 6, y + 18).lineTo(x + 24, y - 22)
        .stroke({ width: 12, color: tone === "good" ? PALETTE.good : PALETTE.ok, cap: "round", join: "round" });
    }
  }

  private drawBoard(model: SceneModel): void {
    const { x, y, w, h } = BOARD;
    const rowH = h / MAX_CARDS;
    this.cards.forEach((view, i) => {
      const card = model.cards[i];
      view.bg.clear();
      if (!card) {
        view.label.text = "";
        view.glyph.text = "";
        return;
      }
      const top = y + i * rowH + 3;
      if (card.current) view.bg.roundRect(x + 4, top - 3, w - 8, rowH, 4).fill(PALETTE.gold);
      view.bg.roundRect(x + 8, top, w - 16, rowH - 6, 3).fill(CARD_FILL[card.status] ?? PALETTE.paper);
      view.bg.rect(x + 8, top, 7, rowH - 6).fill(TYPE_COLOR[card.type]);
      if (card.winnerColor) view.bg.rect(x + 15, top + rowH - 10, w - 23, 4).fill(card.winnerColor);
      view.label.text = card.label;
      view.label.style.fill = card.status === "pending" ? "#f3e6c8" : PALETTE.ink;
      view.glyph.text = card.glyph;
      view.glyph.style.fill = card.status === "failed" ? PALETTE.bad : PALETTE.ink;
    });
  }

  private drawStall(agentId: AgentId, view: StallView, stall: StallModel | null): void {
    const [, y0, , y1] = STALLS[agentId].label;
    const { cx } = STALLS[agentId];
    const color = stall?.color ?? PALETTE.muted;
    const plateW = PLATE_W;
    const px = cx - plateW / 2;

    view.plate.clear();
    view.plate.roundRect(px - 5, y0 - 13, plateW + 10, y1 - y0 + 26, 10).fill(stall?.winner ? PALETTE.gold : color);
    view.plate.roundRect(px, y0 - 8, plateW, y1 - y0 + 16, 7).fill({ color: PALETTE.ink, alpha: 0.94 });
    view.name.text = stall?.name ?? "";
    view.role.text = VENDOR[agentId].tier;

    view.reps.clear();
    TASK_TYPES.forEach((type, i) => {
      const by = 937 + i * 16;
      const rep = stall?.reputation[type] ?? 1;
      const w = Math.max(0, Math.min(100, Math.round((rep / 2) * 100)));
      view.reps.rect(cx + 56, by, 100, 10).fill("#3a3a52");
      view.reps.rect(cx + 56, by, w, 10).fill(TYPE_COLOR[type]);
      view.reps.rect(cx + 105, by - 3, 3, 16).fill(PALETTE.cream); // 1.0 tick
    });

    view.bubbleBg.clear();
    view.bubbleText.text = stall?.bubble?.text ?? "";
    if (stall?.bubble) {
      view.bubbleText.style.fill = BUBBLE_TEXT_COLOR[stall.bubble.tone];
      const w = Math.max(90, view.bubbleText.width + 40);
      bubble(view.bubbleBg, cx, STALLS[agentId].front.y, w, 54, "up",
        stall.bubble.tone === "won" ? "#fff1c1" : PALETTE.paper);
    }
  }
}
