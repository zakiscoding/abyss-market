import Phaser from 'phaser';
import run from '../../fixtures/fake_run.json';
import { AGENTS, AGENT_COLOR, AGENT_NAME, ART, FONT, H, TYPE_COLOR, W, hex, makeTextures, preloadArt, sliceCharacters } from './art';
import { askForTask, chatClear, chatPost } from './chat';
import type { BidData, DoneData, Envelope, FinalData, GradedData, RepUpdateData, TaskSpec, WonData } from './types';

type Cn = Phaser.GameObjects.Container;
type Txt = Phaser.GameObjects.Text;
type Img = Phaser.GameObjects.Image;
type Rect = Phaser.GameObjects.Rectangle;

interface TextOpts {
  size?: number;
  color?: string;
  bold?: boolean;
  wrap?: number;
  stroke?: boolean;
}

const CAM = Phaser.Cameras.Scene2D.Events;
// Harbor coordinates are measured off art/harbor.png drawn at 640x360: sea along the top,
// ship and pier on the left, hub board and inspection booth up top, three stalls on the sand plaza.
const STALL_CX: Record<string, number> = { research: 226, writing: 364, checking: 511 };
const AWNING_TOP = 146;
const COUNTER_Y = 222;
const KEEPER_FEET = 258;
const HUB = { x: 355, y: 62, w: 72 };
const DELIVERY = { x: 300, y: 130 };
const PORTER_HOME = { x: 124, y: 102 };
const REVIEWER_POS = { x: 511, y: 122 };
const DECK = { x: 38, y: 150 };
const TIER_LABEL: Record<string, string> = { haiku: 'CHEAP', sonnet: 'MID', opus: 'PREMIUM' };
const PRICE_TAG: Record<string, string> = { haiku: '$', sonnet: '$$', opus: '$$$' };
// Where the winning model works in each stall interior (art/interior_<type>.png).
const WORK: Record<string, { x: number; flip: boolean }> = {
  research: { x: 214, flip: true },
  writing: { x: 84, flip: false },
  checking: { x: 118, flip: false },
};
const LOG_TITLE: Record<string, string> = { research: 'CATCH LOG', writing: 'FORGED DRAFT', checking: 'INSPECTION REPORT' };
const FLOOR = 268;
const HARBOR_DLG_Y = 0;
const KEEPER_X: Record<string, number> = { haiku: 140, sonnet: 320, opus: 500 };
const TIERS = [
  'EASY JOB: the cheap model is good enough',
  'MEDIUM JOB: worth paying for the mid-tier model',
  'HARD JOB: only the premium model clears the bar',
];
const THINKING: Record<string, string> = {
  research: 'collecting the key facts',
  writing: 'drafting the text',
  checking: 'checking every claim',
};

const params = new URLSearchParams(location.search);
const BASE_SPEED = Math.max(0.25, Number(params.get('speed') ?? 1) || 1);
// Dev only: ?jump=t2 (a task id) or ?jump=final fast-forwards the replay to that point.
const JUMP = params.get('jump');

export class MarketScene extends Phaser.Scene {
  private speed = BASE_SPEED;
  private harbor!: Cn;
  private stall!: Cn;
  private hud!: Cn;
  private customer!: Img;
  private porter!: Img;
  private dlg!: Cn;
  private dlgName!: Txt;
  private dlgText!: Txt;
  private tillText!: Txt;
  private taskText!: Txt;
  private till = { value: 0 };
  private rep: Record<string, Record<string, number>> = {};
  private tasks: Record<string, TaskSpec> = {};
  private cards: Record<string, { bg: Rect; stamp: Txt }> = {};
  private bids: Record<string, BidData> = {};
  private current: TaskSpec | null = null;
  private inStall = false;
  private keepers: Record<string, Img> = {};
  private bidCards: Record<string, Cn> = {};
  private trustFill: Record<string, Rect> = {};
  private trustText: Record<string, Txt> = {};
  private panel: Cn | null = null;
  private plate: Cn | null = null;
  private boatCrates: Record<string, Rect> = {};
  private prop: { act: (chunk: string, i: number) => Promise<void> } | null = null;
  private thought: Txt | null = null;
  private logBody: Txt | null = null;
  private logMeta: Txt | null = null;
  private rawLog = '';
  private winner: string | null = null;

  constructor() {
    super('market');
  }

  init() {
    this.till = { value: 0 };
    this.rep = {};
    this.tasks = {};
    this.cards = {};
    this.bids = {};
    this.current = null;
    this.inStall = false;
    this.panel = null;
    this.winner = null;
    this.boatCrates = {};
    this.prop = null;
  }

  preload() {
    preloadArt(this);
  }

  create() {
    makeTextures(this);
    sliceCharacters(this);
    for (const key of ART) this.textures.get(key).setFilter(Phaser.Textures.FilterMode.LINEAR);
    this.harbor = this.add.container(0, 0);
    this.stall = this.add.container(0, 0).setVisible(false);
    this.hud = this.add.container(0, 0);
    const ui = this.cameras.add(0, 0, W, H);
    ui.ignore([this.harbor, this.stall]);
    this.cameras.main.ignore(this.hud);

    this.buildHarbor();
    this.buildHud();
    this.setSpeed(BASE_SPEED);

    const typing = () => document.activeElement instanceof HTMLInputElement;
    this.input.keyboard?.on('keydown-SPACE', () => !typing() && this.setSpeed(this.speed === BASE_SPEED ? BASE_SPEED * 4 : BASE_SPEED));
    this.input.keyboard?.on('keydown-R', () => !typing() && this.scene.restart());
    chatClear();

    this.play(run as Envelope[]);
  }

  // ---------- playback ----------

  private async play(events: Envelope[]) {
    let jumping = !!JUMP;
    if (jumping) this.setSpeed(40);
    for (const ev of events) {
      if (jumping && (ev.type === JUMP || ev.data?.task_id === JUMP) && ev.type !== 'stats') {
        jumping = false;
        this.setSpeed(BASE_SPEED);
      }
      await this.handle(ev);
    }
  }

  private async handle(ev: Envelope) {
    const d = ev.data;
    switch (ev.type) {
      case 'hello':
        this.rep = structuredClone(d.reputation);
        await this.wait(500);
        await this.walk(this.customer, [[DELIVERY.x, 128], [DELIVERY.x, DELIVERY.y]]);
        this.label(this.harbor, DELIVERY.x, DELIVERY.y - 42, 'YOU', '#ffe08a');
        chatPost('SHIP', 'Ahoy! Radio me a task and I will split it up and deliver each piece to the right stall.');
        break;
      case 'job_split':
        await this.onSplit(d.job_text, d.tasks);
        break;
      case 'stats':
        this.countTill(d.total_cost_usd);
        break;
      case 'task_posted':
        await this.onTaskPosted(this.tasks[d.task_id], d.index, d.total);
        break;
      case 'bid':
        await this.onBid(d as BidData);
        break;
      case 'won':
        await this.onWon(d as WonData);
        break;
      case 'working':
        await this.onWorking(d.agent_id);
        break;
      case 'done':
        await this.onDone(d as DoneData);
        break;
      case 'graded':
        await this.onGraded(d as GradedData);
        break;
      case 'rep_update':
        await this.onRepUpdate(d as RepUpdateData);
        break;
      case 'error':
        await this.say('SYSTEM', d.message);
        break;
      case 'final':
        await this.onFinal(d as FinalData);
        break;
      default:
        console.warn('unknown event', ev.type);
    }
  }

  private async onSplit(jobText: string, tasks: TaskSpec[]) {
    this.taskText.setText('RADIO THE SHIP');
    const typed = JUMP ? jobText : await askForTask(jobText);
    chatPost('YOU', typed);
    if (typed !== jobText) chatPost('NOTE', `Demo mode: no backend yet, so this replays the recorded job: "${jobText}"`);
    await this.say('YOU', typed, 600);
    tasks.forEach((t) => (this.tasks[t.task_id] = t));
    const plan = tasks.map((t) => `${t.task_id.toUpperCase()} ${t.type}`).join(', ');
    chatPost('SHIP', `Got it. Splitting into ${tasks.length} crates: ${plan}.`);
    await this.say('PARENT SHIP', `Got it. I'll split that into ${tasks.length} crates and deliver each one to the right stall.`, 600);
    for (const [i, t] of tasks.entries()) {
      this.buildCard(t, i);
      const card = this.cards[t.task_id];
      card.bg.setScale(0);
      const crate = this.add.rectangle(DECK.x + i * 11, DECK.y, 9, 9, TYPE_COLOR[t.type]).setStrokeStyle(1, 0x1c140e);
      this.harbor.add(crate);
      this.boatCrates[t.task_id] = crate;
      crate.setScale(0);
      this.tween({ targets: crate, scale: 1, duration: 220, ease: 'Back.easeOut' });
      await this.tween({ targets: card.bg, scale: 1, duration: 220, ease: 'Back.easeOut' });
    }
    await this.wait(500);
  }

  private async arc(obj: Rect, x1: number, y1: number, height: number, duration: number) {
    const x0 = obj.x;
    const y0 = obj.y;
    const p = { t: 0 };
    await this.tween({
      targets: p,
      t: 1,
      duration,
      onUpdate: () => obj.setPosition(Phaser.Math.Linear(x0, x1, p.t), Phaser.Math.Linear(y0, y1, p.t) - Math.sin(p.t * Math.PI) * height).setAngle(p.t * 360),
    });
    obj.setAngle(0);
  }

  // The porter catches the crate from the ship, carries it down the lane and tosses it onto the stall counter.
  private async deliverCrate(task: TaskSpec) {
    const crate = this.boatCrates[task.task_id];
    if (!crate) return;
    const p = this.porter;
    await this.arc(crate, p.x, p.y - 34, 30, 600);
    const cx = STALL_CX[task.type];
    const side = cx - 58;
    const carry = () => crate.setPosition(p.x, p.y - 34);
    await this.walk(p, [[160, 128], [side, 128], [side, COUNTER_Y + 6]], carry);
    await this.arc(crate, cx, COUNTER_Y, 22, 420);
    this.burst(cx, COUNTER_Y, TYPE_COLOR[task.type], this.harbor);
    this.cameras.main.shake(100 / this.speed, 0.004);
    this.walk(p, [[side, 128], [160, 128], [PORTER_HOME.x, PORTER_HOME.y]]);
  }

  private async onTaskPosted(task: TaskSpec, index: number, total: number) {
    if (this.inStall) await this.exitStall();
    this.current = task;
    this.bids = {};
    this.taskText.setText(`TASK ${index + 1}/${total} - ${task.type.toUpperCase()}`);
    const card = this.cards[task.task_id];
    card.stamp.setText('OPEN').setColor('#ffe08a');
    this.tweens.add({ targets: card.bg, alpha: 0.5, duration: 200, yoyo: true, repeat: 2 });
    chatPost('SHIP', `Delivering ${task.task_id.toUpperCase()} "${task.title}" to the ${task.type.toUpperCase()} stall.`);
    await this.say('PARENT SHIP', `${task.task_id.toUpperCase()}: "${task.title}". That's ${task.type} work. Porter, take it to the ${task.type.toUpperCase()} stall!`, 400);
    this.dlg.setVisible(false);
    await this.deliverCrate(task);
    await this.wait(300);
    await this.enterStall(task);
    await this.say(`${task.type.toUpperCase()} STALL`, 'Every model works this stall. Let\'s see who bids, and who is right for this job.', 500);
  }

  private async onBid(b: BidData) {
    this.bids[b.agent_id] = b;
    const k = this.keepers[b.agent_id];
    this.tweens.add({ targets: k, y: FLOOR - 6, duration: 120, yoyo: true });
    const x = KEEPER_X[b.agent_id];
    const card = this.add.container(x, 86);
    this.stall.add(card);
    this.bidCards[b.agent_id] = card;
    const bg = this.add.rectangle(-84, 0, 168, 98, 0xf3ead7).setOrigin(0).setStrokeStyle(2, 0x1c140e);
    const tail = this.add.rectangle(-4, 98, 8, 6, 0xf3ead7).setOrigin(0);
    card.add([bg, tail]);
    if (!b.ok) {
      this.txt(card, -76, 8, `No bid: ${b.error ?? 'failed'}`, { color: '#6b6b6b', wrap: 150 });
    } else {
      const q = b.promised_quality ?? 0;
      const rep = b.reputation ?? 1;
      this.txt(card, -76, 6, `"${b.pitch}"`, { color: '#3a2a1e', wrap: 152 });
      this.txt(card, -76, 36, `QUALITY ${q} x TRUST ${rep.toFixed(2)}`, { color: '#1c140e' });
      this.txt(card, -76, 48, `= ${(q * rep).toFixed(2)} EXPECTED`, { color: '#1c140e' });
      this.txt(card, -76, 60, `PRICE $${(b.predicted_cost_usd ?? 0).toFixed(4)}`, { color: '#1c140e' });
      this.txt(card, -76, 70, `(${b.predicted_output_tokens} TOKENS)`, { color: '#6b5a48' });
      this.txt(card, -76, 82, `SCORE ${(b.score ?? 0).toFixed(2)}`, { color: hex(AGENT_COLOR[b.agent_id]), bold: true, stroke: true });
    }
    card.setScale(0);
    await this.tween({ targets: card, scale: 1, duration: 260, ease: 'Back.easeOut' });
    await this.wait(900);
  }

  private async onWon(w: WonData) {
    this.winner = w.agent_id;
    await this.wait(300);
    const sold = this.txt(this.stall, W / 2, 130, 'SOLD!', { size: 32, color: '#ffe08a', bold: true, stroke: true }).setOrigin(0.5);
    sold.setScale(3).setAlpha(0);
    this.tween({ targets: sold, scale: 1, alpha: 1, duration: 260, ease: 'Back.easeOut' });
    this.cameras.main.shake(180 / this.speed, 0.006);
    for (const id of AGENTS) {
      if (id === w.agent_id) continue;
      this.tweens.add({ targets: [this.keepers[id], this.keepers[id].getData('shadow'), this.bidCards[id]], alpha: 0.3, duration: 300 });
    }
    this.tweens.add({ targets: this.keepers[w.agent_id], scale: 1.12, duration: 300, ease: 'Back.easeOut' });
    const winCard = this.bidCards[w.agent_id];
    if (winCard) this.tweens.add({ targets: winCard, y: 90, duration: 300 });
    await this.wait(1300);
    await this.tween({ targets: [sold, ...Object.values(this.bidCards)], alpha: 0, duration: 250 });
    sold.destroy();
    Object.values(this.bidCards).forEach((c) => c.destroy());
    this.bidCards = {};
    await this.showWhy(w);
  }

  private async showWhy(w: WonData) {
    const wb = this.bids[w.agent_id];
    const rb = w.runner_up_agent_id ? this.bids[w.runner_up_agent_id] : undefined;
    const exp = (b: BidData) => (b.promised_quality ?? 0) * (b.reputation ?? 1);
    const lines = [`${AGENT_NAME[w.agent_id]} scored ${(w.score ?? 0).toFixed(2)}${rb ? `, beating ${AGENT_NAME[rb.agent_id]} (${(w.runner_up_score ?? 0).toFixed(2)})` : ''}.`];
    if (wb && rb) {
      const dq = exp(wb) - exp(rb);
      const wc = wb.predicted_cost_usd ?? 0;
      const rc = rb.predicted_cost_usd ?? 0;
      if (Math.abs(dq) < 0.05) lines.push(`Same expected quality (${exp(wb).toFixed(1)}), but ${(rc / wc).toFixed(1)}x cheaper.`);
      else if (dq > 0) lines.push(`Expected quality ${exp(wb).toFixed(1)} vs ${exp(rb).toFixed(1)}: worth the extra $${(wc - rc).toFixed(4)}.`);
      else lines.push(`A bit less quality (${exp(wb).toFixed(1)} vs ${exp(rb).toFixed(1)}), but saves $${(rc - wc).toFixed(4)}.`);
    }
    const tier = AGENTS.indexOf(w.agent_id as (typeof AGENTS)[number]);

    const c = this.add.container(110, 94);
    this.stall.add(c);
    c.add(this.add.rectangle(0, 0, 420, 112, 0x10141f, 0.94).setOrigin(0).setStrokeStyle(2, AGENT_COLOR[w.agent_id]));
    this.txt(c, 12, 8, `WHY ${AGENT_NAME[w.agent_id].toUpperCase()}?`, { color: hex(AGENT_COLOR[w.agent_id]), bold: true });
    const body = this.txt(c, 12, 24, '', { color: '#e8dcc4', wrap: 396 });
    this.txt(c, 12, 70, 'MARKET VERDICT', { color: '#8a8a9a' });
    ['EASY', 'MEDIUM', 'HARD'].forEach((label, i) => {
      const on = i === tier;
      c.add(this.add.rectangle(120 + i * 70, 68, 64, 12, on ? AGENT_COLOR[w.agent_id] : 0x2a2f40).setOrigin(0));
      this.txt(c, 152 + i * 70, 70, label, { color: on ? '#10141f' : '#6b7080', bold: on }).setOrigin(0.5, 0);
    });
    const verdict = this.txt(c, 12, 88, '', { color: '#ffe08a' });
    c.setAlpha(0);
    await this.tween({ targets: c, alpha: 1, duration: 200 });
    await this.typewrite(body, lines.join(' '), 90);
    await this.typewrite(verdict, TIERS[tier], 90);
    await this.wait(2200);
    await this.tween({ targets: c, alpha: 0, duration: 250 });
    c.destroy();
  }

  private async onWorking(agentId: string) {
    const task = this.current!;
    const color = AGENT_COLOR[agentId];
    this.dlg.setVisible(false);
    if (this.plate) this.tweens.add({ targets: this.plate, alpha: 0, duration: 250 });
    for (const id of AGENTS) {
      const other = this.keepers[id];
      if (id !== agentId) this.tweens.add({ targets: [other, other.getData('shadow')], alpha: 0, duration: 300 });
    }
    const k = this.keepers[agentId];
    const spot = WORK[task.type];
    this.tweens.add({ targets: k, scale: 1, duration: 200 });
    k.setFlipX(spot.x < k.x);
    this.tweens.add({ targets: k.getData('shadow'), x: spot.x, duration: 500, ease: 'Sine.easeInOut' });
    await this.tween({ targets: k, x: spot.x, duration: 500, ease: 'Sine.easeInOut' });
    k.setFlipX(spot.flip);
    this.prop = this.buildProp(task.type);
    this.rawLog = '';

    const b = this.add.container(0, 0);
    this.stall.add(b);
    b.add(this.add.ellipse(spot.x + 4, 180, 8, 6, 0xffffff));
    b.add(this.add.ellipse(spot.x - 4, 164, 12, 9, 0xffffff));
    b.add(this.add.ellipse(spot.x - 14, 146, 18, 13, 0xffffff));
    b.add(this.add.rectangle(16, 52, 300, 84, 0xffffff).setOrigin(0).setStrokeStyle(2, color));
    this.txt(b, 26, 57, `${AGENT_NAME[agentId].toUpperCase()} THINKS...`, { color: hex(color), bold: true });
    this.thought = this.txt(b, 26, 71, '', { color: '#1c140e', wrap: 280 });

    const log = this.add.container(0, 0);
    this.stall.add(log);
    log.add(this.add.rectangle(330, 52, 294, 184, 0xf3ead7).setOrigin(0).setStrokeStyle(2, color));
    this.txt(log, 340, 58, LOG_TITLE[task.type], { color: hex(TYPE_COLOR[task.type]), bold: true, stroke: true });
    this.logBody = this.txt(log, 340, 72, '', { color: '#1c140e', wrap: 276 }).setLineSpacing(1);
    this.logMeta = this.txt(log, 616, 224, '', { color: '#6b5a48' }).setOrigin(1, 0);

    const steps = ['Reading the brief...'];
    if (task.depends_on.length) steps.push(`Reading the ${task.depends_on.join(', ').toUpperCase()} output I was handed...`);
    steps.push(`OK, ${THINKING[task.type]}.`);
    for (const s of steps) {
      await this.typewrite(this.thought, s, 70);
      await this.wait(500);
    }
  }

  private async onDone(d: DoneData) {
    const task = this.current!;
    if (!this.prop || !this.thought || !this.logBody || !this.logMeta) return;
    const chunks =
      task.type === 'writing'
        ? d.output.split(/(?<=[.!?])\s+/).filter((s) => s.trim())
        : d.output.split('\n').filter((s) => s.trim());
    const sep = task.type === 'writing' ? ' ' : '\n';
    for (const [i, chunk] of chunks.entries()) {
      const words = chunk.replace(/^[-\s]+/, '').split(/\s+/).slice(0, 6).join(' ');
      const thought =
        task.type === 'research' ? `Fishing for facts... got one! "${words}..."`
          : task.type === 'writing' ? `Hammering out the next line: "${words}..."`
            : `Inspecting this claim: "${words}..."`;
      await this.typewrite(this.thought, thought, 110);
      await this.prop.act(chunk, i);
      const prev = this.logBody.text;
      const next = this.rawLog ? `${this.rawLog}${sep}${chunk}` : chunk;
      this.rawLog = next;
      await this.typewrite(this.logBody, next, 240, prev.length);
      const f = (i + 1) / chunks.length;
      this.logMeta.setText(`TOKENS ${Math.round(d.usage.output_tokens * f)} / PREDICTED ${d.predicted_output_tokens ?? '?'}  $${(d.usage.cost_usd * f).toFixed(6)}`);
    }
    await this.typewrite(this.thought, 'Done. Sending it to the inspection booth for a blind review.', 90);
    await this.tween({ targets: this.keepers[d.agent_id], y: FLOOR - 10, duration: 150, yoyo: true });
    await this.wait(800);
  }

  private buildProp(type: string): { act: (chunk: string, i: number) => Promise<void> } {
    const c = this.stall;
    if (type === 'writing') {
      const glow = this.add.ellipse(253, 180, 64, 34, 0xff8a2a, 0.35);
      c.add(glow);
      this.tweens.add({ targets: glow, alpha: 0.12, scale: 1.15, duration: 420, yoyo: true, repeat: -1 });
      const blade = this.add.rectangle(136, 183, 6, 3, 0xff9a3c).setOrigin(0, 0.5);
      c.add(blade);
      const hammer = this.add.container(98, 222);
      hammer.add(this.add.rectangle(0, -1.5, 66, 3, 0x7a5230).setOrigin(0));
      hammer.add(this.add.rectangle(62, -7, 11, 14, 0x9aa0aa).setOrigin(0).setStrokeStyle(1, 0x3b3f4a));
      hammer.setAngle(-120);
      c.add(hammer);
      return {
        act: async (_chunk, i) => {
          for (let n = 0; n < 2; n++) {
            await this.tween({ targets: hammer, angle: -120, duration: 150 });
            await this.tween({ targets: hammer, angle: -31, duration: 90, ease: 'Cubic.easeIn' });
            this.burst(158, 182, 0xffb347);
            this.cameras.main.shake(70 / this.speed, 0.004);
            this.pop(160, 168, 'CLANG!', '#ffb347');
          }
          blade.width = Math.min(46, 6 + (i + 1) * 5);
          blade.setFillStyle(0xffd27a);
          this.tweens.add({ targets: blade, alpha: 0.7, duration: 200, yoyo: true, onComplete: () => blade.setFillStyle(0xff9a3c) });
        },
      };
    }
    if (type === 'research') {
      const hand = { x: 202, y: 226 };
      const tip = { x: 138, y: 150 };
      const bobAt = { x: 84, y: 168 };
      const bucketAt = { x: 252, y: 262 };
      const g = this.add.graphics();
      c.add(g);
      g.lineStyle(2, 0x5e3e24, 1).lineBetween(hand.x, hand.y, tip.x, tip.y);
      g.fillStyle(0x8a8f99, 1).fillRect(bucketAt.x - 12, bucketAt.y - 14, 24, 14);
      g.fillStyle(0x6b7080, 1).fillRect(bucketAt.x - 14, bucketAt.y - 16, 28, 3);
      const count = this.txt(c, bucketAt.x, bucketAt.y - 11, 'x0', { color: '#10141f', bold: true }).setOrigin(0.5, 0);
      const line = this.add.graphics();
      c.add(line);
      const bob = this.add.circle(bobAt.x, bobAt.y, 3, 0xd9534f).setStrokeStyle(1, 0xffffff);
      c.add(bob);
      const drawLine = () => line.clear().lineStyle(1, 0xf3ead7, 0.9).lineBetween(tip.x, tip.y, bob.x, bob.y);
      drawLine();
      this.tweens.add({ targets: bob, y: bobAt.y + 1.5, duration: 700, yoyo: true, repeat: -1, onUpdate: drawLine });
      return {
        act: async (_chunk, i) => {
          this.tweens.killTweensOf(bob);
          await this.tween({ targets: bob, y: bobAt.y + 6, duration: 140, yoyo: true, repeat: 1, onUpdate: drawLine });
          this.pop(bobAt.x, bobAt.y - 16, '!', '#ffe08a');
          this.burst(bobAt.x, bobAt.y, 0xe8f6ff);
          const fish = this.add.ellipse(bob.x, bob.y, 12, 6, 0xf2a65a).setStrokeStyle(1, 0x7a3a1a);
          c.add(fish);
          const p = { t: 0 };
          await this.tween({
            targets: p,
            t: 1,
            duration: 560,
            onUpdate: () => {
              fish.setPosition(Phaser.Math.Linear(bobAt.x, bucketAt.x, p.t), Phaser.Math.Linear(bobAt.y, bucketAt.y - 14, p.t) - Math.sin(p.t * Math.PI) * 50).setAngle(p.t * 360);
              bob.setPosition(fish.x, fish.y);
              drawLine();
            },
          });
          fish.destroy();
          bob.setPosition(bobAt.x, bobAt.y);
          drawLine();
          this.burst(bucketAt.x, bucketAt.y - 14, 0x7fb7c9);
          count.setText(`x${i + 1}`);
          this.tweens.add({ targets: bob, y: bobAt.y + 1.5, duration: 700, yoyo: true, repeat: -1, onUpdate: drawLine });
        },
      };
    }
    const sheet = { x: 197, y: 153, w: 56 };
    const ink = this.add.graphics();
    c.add(ink);
    const glass = this.add.container(sheet.x, sheet.y);
    glass.add(this.add.circle(0, 0, 8, 0xbfe3ff, 0.35).setStrokeStyle(2, 0xc9a24a));
    glass.add(this.add.rectangle(5, 5, 11, 3, 0x7a5230).setOrigin(0).setAngle(45));
    c.add(glass);
    return {
      act: async (chunk, i) => {
        const y = sheet.y + 2 + (i % 5) * 5;
        glass.setPosition(sheet.x, y);
        ink.fillStyle(0x3a2a1e, 0.7).fillRect(sheet.x, y, sheet.w - 10, 1);
        await this.tween({ targets: glass, x: sheet.x + sheet.w - 10, duration: 600, ease: 'Sine.easeInOut' });
        const flagged = /caveat|error|incorrect|wrong|however/i.test(chunk);
        ink.fillStyle(flagged ? 0xe8a33d : 0x3fbf5f, 1).fillRect(sheet.x + sheet.w - 6, y - 1, 3, 3);
        this.pop(sheet.x + sheet.w / 2, sheet.y - 8, flagged ? 'HMM!' : 'OK', flagged ? '#e8a33d' : '#3fbf5f');
        this.cameras.main.shake(60 / this.speed, 0.003);
      },
    };
  }

  private burst(x: number, y: number, color: number, c: Cn = this.stall) {
    for (let i = 0; i < 8; i++) {
      const p = this.add.rectangle(x, y, 2, 2, color);
      c.add(p);
      const a = Phaser.Math.FloatBetween(-Math.PI, 0);
      const d = Phaser.Math.Between(10, 26);
      this.tweens.add({ targets: p, x: x + Math.cos(a) * d, y: y + Math.sin(a) * d, alpha: 0, duration: 350, onComplete: () => p.destroy() });
    }
  }

  private pop(x: number, y: number, text: string, color: string) {
    const t = this.txt(this.stall, x, y, text, { color, bold: true, stroke: true }).setOrigin(0.5);
    this.tweens.add({ targets: t, y: y - 12, alpha: 0, duration: 500, onComplete: () => t.destroy() });
  }

  private async onGraded(g: GradedData) {
    const beam = this.add.triangle(0, 0, W, 0, 212, 100, 310, 100, 0xffe08a, 0.25).setOrigin(0);
    this.stall.add(beam);
    this.tweens.add({ targets: beam, alpha: 0.1, duration: 180, yoyo: true, repeat: -1 });
    const promised = g.promised_quality ?? g.grade;
    const color = g.grade >= promised ? 0x3fbf5f : g.grade < promised - 1 ? 0xd9534f : 0xf2c94c;
    const stamp = this.add.container(260, 100);
    this.stall.add(stamp);
    stamp.add(this.add.rectangle(0, 0, 96, 50, 0x10141f, 0.9).setStrokeStyle(3, color));
    this.txt(stamp, 0, -18, `${g.grade}/10`, { size: 24, color: hex(color), bold: true, stroke: true }).setOrigin(0.5, 0);
    this.txt(stamp, 0, 10, `PROMISED ${g.promised_quality ?? '-'}`, { color: '#e8dcc4' }).setOrigin(0.5, 0);
    stamp.setScale(3).setAngle(-8).setAlpha(0);
    await this.tween({ targets: stamp, scale: 1, alpha: 1, duration: 220, ease: 'Cubic.easeIn' });
    this.cameras.main.shake(150 / this.speed, 0.008);
    this.tweens.killTweensOf(beam);
    beam.destroy();
    await this.say('REVIEWER (BLIND)', g.rationale, 900);
    const card = this.cards[g.task_id];
    card.stamp.setText(`${g.grade}/10`).setColor(hex(color));
  }

  private async onRepUpdate(r: RepUpdateData) {
    const old = this.rep[r.agent_id][r.task_type];
    this.rep[r.agent_id][r.task_type] = r.new;
    const fill = this.trustFill[r.agent_id];
    const label = this.trustText[r.agent_id];
    const val = { v: old };
    await this.tween({
      targets: val,
      v: r.new,
      duration: 900,
      onUpdate: () => {
        fill.width = Math.max(1, Math.min(1, val.v / 2) * 136);
        label.setText(val.v.toFixed(2));
      },
    });
    const dir = r.new < r.old ? 'DOWN' : r.new > r.old ? 'UP' : 'SAME';
    const dirColor = dir === 'DOWN' ? '#ff7a6b' : dir === 'UP' ? '#7ee08a' : '#e8dcc4';
    label.setText(`${dir} ${r.new.toFixed(2)}`).setColor(dirColor);
    const k = this.keepers[r.agent_id];
    this.pop(k.x, k.y - k.displayHeight - 8, `TRUST ${dir}`, dirColor);
    const why =
      dir === 'DOWN' ? 'It promised more than it delivered, so its future bids count for less.'
        : dir === 'UP' ? 'It delivered more than it promised, so its future bids count for more.'
          : 'It delivered exactly what it promised.';
    await this.say('LEDGER', `${AGENT_NAME[r.agent_id]} ${r.task_type} trust ${r.old.toFixed(2)} -> ${r.new.toFixed(2)}. ${why}`, 1200);
  }

  private async onFinal(f: FinalData) {
    if (this.inStall) await this.exitStall();
    this.taskText.setText('JOB COMPLETE');
    chatPost('SHIP', `All crates delivered and graded. Total $${f.total_cost_usd.toFixed(5)}, mean grade ${f.mean_grade?.toFixed(2) ?? '-'}. Receipt is on screen.`);
    await this.say('PARENT SHIP', 'All crates delivered. Here is your receipt.', 400);
    this.dlg.setVisible(false);

    const c = this.add.container(0, 0);
    this.hud.add(c);
    c.add(this.add.rectangle(16, 26, 608, 318, 0x10141f, 0.96).setOrigin(0).setStrokeStyle(2, 0xffe08a));
    this.txt(c, 30, 36, 'RECEIPT - JOB COMPLETE', { color: '#ffe08a', bold: true });
    let y = 56;
    let taskSum = 0;
    for (const t of f.tasks) {
      taskSum += t.cost_usd;
      const agent = t.agent_id ? AGENT_NAME[t.agent_id] : 'FAILED';
      this.txt(c, 30, y, `${t.task_id.toUpperCase()} ${t.type.toUpperCase()}`, { color: hex(TYPE_COLOR[t.type]), bold: true });
      this.txt(c, 30, y + 11, `${agent}  ${t.grade ?? '-'}/${t.promised_quality ?? '-'}  $${t.cost_usd.toFixed(4)}`, {
        color: t.agent_id ? hex(AGENT_COLOR[t.agent_id]) : '#ff7a6b',
      });
      y += 28;
    }
    this.txt(c, 30, y, `SPLIT  $${(f.total_cost_usd - taskSum).toFixed(4)}`, { color: '#e8dcc4' });
    this.txt(c, 30, y + 16, `TOTAL  $${f.total_cost_usd.toFixed(5)}`, { color: '#ffe08a', bold: true });
    this.txt(c, 30, y + 30, `MEAN GRADE  ${f.mean_grade?.toFixed(2) ?? '-'}`, { color: '#7ee08a', bold: true });

    c.add(this.add.rectangle(262, 36, 1, 290, 0x3a3f50).setOrigin(0));
    this.txt(c, 276, 36, `DELIVERABLE${f.deliverable_task_id ? ` (FROM ${f.deliverable_task_id.toUpperCase()})` : ''}`, { color: '#ffe08a', bold: true });
    const body = this.txt(c, 276, 54, '', { color: '#e8dcc4', wrap: 334 });
    this.txt(c, W / 2, 328, 'PRESS R TO REPLAY', { color: '#8a8a9a' }).setOrigin(0.5, 0);
    c.setAlpha(0);
    await this.tween({ targets: c, alpha: 1, duration: 300 });
    this.tweens.add({ targets: this.customer, y: this.customer.y - 8, duration: 180, yoyo: true, repeat: 3 });
    await this.typewrite(body, f.deliverable ?? 'No deliverable.', 220);
  }

  // ---------- camera transitions ----------

  private async enterStall(task: TaskSpec) {
    const cam = this.cameras.main;
    const ms = 800 / this.speed;
    const f = this.stallFocus(task.type);
    cam.pan(f.x, f.y, ms, 'Sine.easeInOut');
    cam.zoomTo(f.zoom, ms, 'Sine.easeInOut');
    await this.camEvent(CAM.ZOOM_COMPLETE);
    cam.fadeOut(220 / this.speed, 0, 0, 0);
    await this.camEvent(CAM.FADE_OUT_COMPLETE);
    this.harbor.setVisible(false);
    this.buildStall(task);
    this.stall.setVisible(true);
    cam.setZoom(1);
    cam.centerOn(W / 2, H / 2);
    this.dlg.y = 0;
    cam.fadeIn(300 / this.speed, 0, 0, 0);
    await this.camEvent(CAM.FADE_IN_COMPLETE);
    this.inStall = true;
  }

  private stallFocus(type: string) {
    return { x: STALL_CX[type], y: 204, zoom: 3.2 };
  }

  private async exitStall() {
    const cam = this.cameras.main;
    const f = this.stallFocus(this.current!.type);
    cam.fadeOut(250 / this.speed, 0, 0, 0);
    await this.camEvent(CAM.FADE_OUT_COMPLETE);
    this.tweens.killTweensOf(this.stall.getAll());
    this.stall.removeAll(true).setVisible(false);
    this.harbor.setVisible(true);
    this.dlg.y = HARBOR_DLG_Y;
    cam.setZoom(f.zoom);
    cam.centerOn(f.x, f.y);
    cam.fadeIn(250 / this.speed, 0, 0, 0);
    cam.pan(W / 2, H / 2, 800 / this.speed, 'Sine.easeInOut');
    cam.zoomTo(1, 800 / this.speed, 'Sine.easeInOut');
    await this.camEvent(CAM.ZOOM_COMPLETE);
    this.inStall = false;
    this.prop = null;
    this.thought = null;
    this.logBody = null;
    this.logMeta = null;
  }

  // ---------- builders ----------

  private buildHarbor() {
    const c = this.harbor;
    c.add(this.add.image(0, 0, 'harbor').setOrigin(0).setDisplaySize(W, H));

    // Sun glitter on the sea band.
    for (let i = 0; i < 34; i++) {
      const x = 110 + ((i * 71) % 520);
      const r = this.rect(c, x, 20 + ((i * 29) % 20), 3 + (i %3) * 2, 1, 0xe8f6ff, 0.9);
      this.tweens.add({ targets: r, alpha: 0.1, duration: 600 + (i % 7) * 150, yoyo: true, repeat: -1, delay: i * 40 });
    }
    for (let i = 0; i < 12; i++) {
      const r = this.rect(c, 8 + ((i * 37) % 60), 215 + ((i * 23) % 90), 3 + (i % 3), 1, 0xe8f6ff, 0.8);
      this.tweens.add({ targets: r, alpha: 0.1, duration: 700 + (i % 5) * 160, yoyo: true, repeat: -1, delay: i * 70 });
    }
    const lamp = this.add.circle(496, 88, 5, 0xfff1b0, 0.5);
    c.add(lamp);
    this.tweens.add({ targets: lamp, alpha: 0.1, scale: 1.6, duration: 800, yoyo: true, repeat: -1 });

    this.label(c, 50, 22, 'MAIN AGENT', '#ffe08a');
    this.txt(c, 50, 32, 'PARENT SHIP', { color: '#e8f6ff', stroke: true }).setOrigin(0.5, 0);
    this.label(c, REVIEWER_POS.x, 30, 'INSPECTION', '#e3c1f0');
    this.txt(c, REVIEWER_POS.x, REVIEWER_POS.y + 2, 'BLIND REVIEWER', { color: '#ffffff', stroke: true }).setOrigin(0.5, 0);
    this.person(c, 'p_reviewer', REVIEWER_POS.x, REVIEWER_POS.y);

    this.label(c, HUB.x + HUB.w / 2, HUB.y, 'TASKS HUB', '#ffe08a');
    c.add(this.add.ellipse(DELIVERY.x, DELIVERY.y, 30, 8, 0xffe08a, 0.35).setStrokeStyle(1, 0xffe08a));

    for (const type of ['research', 'writing', 'checking']) {
      const cx = STALL_CX[type];
      const col = TYPE_COLOR[type];
      const plate = this.add.rectangle(cx, AWNING_TOP - 6, 76, 12, 0x2a1c12).setStrokeStyle(1, col);
      c.add(plate);
      this.txt(c, cx, AWNING_TOP - 10, type.toUpperCase(), { color: hex(col), bold: true }).setOrigin(0.5, 0);
      AGENTS.forEach((id, i) => {
        const x = cx + (i - 1) * 30;
        const k = this.person(c, `p_${id}`, x, KEEPER_FEET);
        this.tweens.add({ targets: k, y: KEEPER_FEET - 1, duration: 500 + i * 130, yoyo: true, repeat: -1 });
        this.txt(c, x, KEEPER_FEET + 2, PRICE_TAG[id], { color: hex(AGENT_COLOR[id]), bold: true, stroke: true }).setOrigin(0.5, 0);
      });
    }

    // Strollers wander the lanes.
    const lanes: [string, number, number, number, number][] = [
      ['p_customer', 300, 230, 600, 0xf2a6a6],
      ['p_porter', 290, 560, 200, 0xa6d8f2],
      ['p_customer', 128, 600, 440, 0xb8f2a6],
    ];
    for (const [key, y, from, to, tint] of lanes) {
      const img = this.person(c, key, from, y, false).setTint(tint).setFlipX(to < from);
      this.tweens.add({
        targets: img,
        x: to,
        duration: Math.abs(to - from) * 45,
        yoyo: true,
        repeat: -1,
        onYoyo: () => img.setFlipX(!img.flipX),
        onRepeat: () => img.setFlipX(!img.flipX),
        onUpdate: () => img.setY(y - Math.abs(Math.sin(this.time.now / 120)) * 1.5),
      });
    }

    this.porter = this.person(c, 'p_porter', PORTER_HOME.x, PORTER_HOME.y, false);
    this.customer = this.person(c, 'p_customer', W + 20, 128, false);
  }

  private person(c: Cn, key: string, x: number, y: number, shadow = true) {
    if (shadow) c.add(this.add.ellipse(x, y, 14, 4, 0x000000, 0.25));
    const img = this.add.image(x, y, key).setOrigin(0.5, 1);
    c.add(img);
    return img;
  }

  private label(c: Cn, x: number, y: number, text: string, color: string) {
    return this.txt(c, x, y, text, { color, bold: true, stroke: true }).setOrigin(0.5, 0);
  }

  private buildCard(t: TaskSpec, i: number) {
    const c = this.harbor;
    const y = HUB.y + 14 + i * 12;
    const bg = this.add.rectangle(HUB.x + HUB.w / 2, y + 5, HUB.w, 11, TYPE_COLOR[t.type]).setStrokeStyle(1, 0x1c140e);
    c.add(bg);
    this.txt(c, HUB.x + 3, y + 1, t.task_id.toUpperCase(), { color: '#ffffff', bold: true, stroke: true });
    const stamp = this.txt(c, HUB.x + HUB.w - 3, y + 1, 'WAITING', { color: '#ffffff', stroke: true }).setOrigin(1, 0);
    this.cards[t.task_id] = { bg, stamp };
  }

  private async walk(img: Img, path: [number, number][], onStep?: () => void) {
    for (const [x, y] of path) {
      const dist = Math.hypot(x - img.x, y - img.y);
      if (dist < 1) continue;
      if (Math.abs(x - img.x) > 1) img.setFlipX(x < img.x);
      const base = { y: img.y };
      await this.tween({
        targets: [img, base],
        x,
        y,
        duration: (dist / 90) * 1000,
        onUpdate: () => {
          img.setY(base.y - Math.abs(Math.sin(this.time.now / 110)) * 1.5);
          onStep?.();
        },
      });
      img.setY(y);
    }
  }

  private buildStall(task: TaskSpec) {
    const c = this.stall;
    const col = TYPE_COLOR[task.type];
    this.keepers = {};
    this.bidCards = {};
    this.trustFill = {};
    this.trustText = {};
    c.add(this.add.image(0, 0, `interior_${task.type}`).setOrigin(0).setDisplaySize(W, H));
    for (let i = 0; i < 20; i++) {
      const stripe = i % 2 ? 0xf3ead7 : col;
      this.rect(c, i * 32, 0, 32, 42, stripe);
      this.rect(c, i * 32 + 4, 42, 24, 5, stripe);
    }
    this.txt(c, W / 2, 21, `${task.type.toUpperCase()} STALL`, { size: 16, color: '#ffffff', bold: true, stroke: true }).setOrigin(0.5, 0);
    this.plate = this.add.container(0, 0);
    c.add(this.plate);
    this.rect(this.plate, 20, 52, 600, 38, 0x1c140e, 0.85);
    this.txt(this.plate, 28, 55, `${task.task_id.toUpperCase()} - ${task.title.toUpperCase()}`, { color: '#ffe08a', bold: true });
    this.txt(this.plate, 28, 67, task.brief, { color: '#e8dcc4', wrap: 584 });

    for (const id of AGENTS) {
      const shadow = this.add.ellipse(KEEPER_X[id], FLOOR, 40, 8, 0x000000, 0.3);
      c.add(shadow);
      const k = this.add.image(KEEPER_X[id], FLOOR, `b_${id}`).setOrigin(0.5, 1);
      c.add(k);
      k.setData('shadow', shadow);
      this.keepers[id] = k;
    }
    for (const id of AGENTS) {
      const x = KEEPER_X[id];
      this.rect(c, x - 74, 278, 148, 20, 0x10141f, 0.85).setStrokeStyle(1, AGENT_COLOR[id]);
      this.txt(c, x - 68, 281, `${TIER_LABEL[id]} - ${AGENT_NAME[id].toUpperCase()}`, { color: hex(AGENT_COLOR[id]), bold: true });
      const rep = this.rep[id]?.[task.type] ?? 1;
      this.trustText[id] = this.txt(c, x + 68, 281, rep.toFixed(2), { color: '#e8dcc4' }).setOrigin(1, 0);
      this.rect(c, x - 68, 292, 136, 3, 0x2a2f40);
      this.trustFill[id] = this.rect(c, x - 68, 292, Math.min(1, rep / 2) * 136, 3, AGENT_COLOR[id]);
    }
  }

  private buildHud() {
    const c = this.hud;
    this.rect(c, 0, 0, W, 18, 0x10141f, 0.75);
    this.txt(c, 8, 5, 'ABYSS MARKET', { color: '#ffe08a', bold: true });
    this.taskText = this.txt(c, W / 2, 5, 'A CUSTOMER ARRIVES', { color: '#e8dcc4' }).setOrigin(0.5, 0);
    c.add(this.add.image(W - 76, 9, 'coin'));
    this.tillText = this.txt(c, W - 68, 5, '$0.00000', { color: '#ffe08a', bold: true });
    this.txt(c, W / 2 + 130, 5, 'SPACE: FAST  R: REPLAY', { color: '#8a8a9a' }).setOrigin(0.5, 0);

    this.dlg = this.add.container(0, HARBOR_DLG_Y).setVisible(false);
    c.add(this.dlg);
    this.dlg.add(this.add.rectangle(12, 300, 616, 54, 0x10141f, 0.94).setOrigin(0).setStrokeStyle(2, 0xf3ead7));
    this.dlgName = this.txt(this.dlg, 22, 305, '', { color: '#ffe08a', bold: true });
    this.dlgText = this.txt(this.dlg, 22, 317, '', { color: '#f3ead7', wrap: 596 });
  }

  // ---------- helpers ----------

  private setSpeed(s: number) {
    this.speed = s;
    this.time.timeScale = s;
    this.tweens.timeScale = s;
  }

  private rect(c: Cn, x: number, y: number, w: number, h: number, color: number, alpha = 1) {
    const r = this.add.rectangle(x, y, w, h, color, alpha).setOrigin(0);
    c.add(r);
    return r;
  }

  private txt(c: Cn, x: number, y: number, s: string, o: TextOpts = {}) {
    const t = this.add.text(Math.round(x), Math.round(y), s, {
      fontFamily: FONT,
      fontSize: `${o.size ?? 8}px`,
      fontStyle: o.bold ? 'bold' : 'normal',
      color: o.color ?? '#ffffff',
      wordWrap: o.wrap ? { width: o.wrap } : undefined,
      lineSpacing: 2,
      stroke: o.stroke ? '#10141f' : undefined,
      strokeThickness: o.stroke ? 2 : 0,
    });
    c.add(t);
    return t;
  }

  private wait(ms: number) {
    return new Promise<void>((r) => this.time.delayedCall(ms, r));
  }

  private tween(cfg: Phaser.Types.Tweens.TweenBuilderConfig) {
    return new Promise<void>((r) => this.tweens.add({ ...cfg, onComplete: () => r() }));
  }

  private camEvent(name: string) {
    return new Promise<void>((r) => this.cameras.main.once(name, () => r()));
  }

  private typewrite(t: Txt, text: string, cps: number, from = 0) {
    const full = t.getWrappedText(text).join('\n');
    return new Promise<void>((resolve) => {
      let i = from;
      const start = this.time.now;
      // Timer events fire at most once per frame, so derive progress from game time to keep high speeds fast.
      const ev = this.time.addEvent({
        delay: 30,
        loop: true,
        callback: () => {
          i = Math.min(full.length, Math.max(i + 1, from + Math.floor(((this.time.now - start) * this.speed * cps) / 1000)));
          t.setText(full.slice(0, i));
          if (i >= full.length) {
            ev.remove();
            resolve();
          }
        },
      });
    });
  }

  private async say(name: string, text: string, hold = 1000) {
    this.dlg.setVisible(true);
    this.dlgName.setText(name);
    await this.typewrite(this.dlgText, text, 70);
    await this.wait(hold + text.length * 12);
  }

  private countTill(to: number) {
    this.tweens.add({
      targets: this.till,
      value: to,
      duration: 600,
      onUpdate: () => this.tillText.setText(`$${this.till.value.toFixed(5)}`),
    });
  }

  private sparks(x: number) {
    for (let i = 0; i < 10; i++) {
      const p = this.add.rectangle(x + Phaser.Math.Between(-24, 24), 210, 2, 2, 0xffe08a);
      this.stall.add(p);
      this.tweens.add({
        targets: p,
        y: 190 - Phaser.Math.Between(0, 20),
        alpha: 0,
        duration: 500,
        delay: i * 90,
        repeat: -1,
      });
    }
  }
}
