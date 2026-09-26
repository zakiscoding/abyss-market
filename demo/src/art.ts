import Phaser from 'phaser';

export const W = 640;
export const H = 360;
export const FONT = 'Silkscreen';

export const AGENTS = ['haiku', 'sonnet', 'opus'] as const;
export const AGENT_NAME: Record<string, string> = { haiku: 'Haiku 4.5', sonnet: 'Sonnet 5', opus: 'Opus 5' };
export const AGENT_COLOR: Record<string, number> = { haiku: 0x4fb3a9, sonnet: 0xe8a33d, opus: 0x8e6cc9 };
export const TYPE_COLOR: Record<string, number> = { research: 0x4f8fd9, writing: 0x58b368, checking: 0xd9534f };
export const hex = (n: number) => '#' + n.toString(16).padStart(6, '0');

const PERSON = [
  '...hhhh...',
  '..hhhhhh..',
  '..ssssss..',
  '..sesses..',
  '..ssssss..',
  '...ssss...',
  '..bbbbbb..',
  '.bbbbbbbb.',
  '.sbbbbbbs.',
  '.sbbbbbbs.',
  '..bbbbbb..',
  '..llllll..',
  '..ll..ll..',
  '..ll..ll..',
  '..kk..kk..',
  '..........',
];

const CAPTAIN = [
  '..nnnnnn..',
  '.kkkkkkkk.',
  '..ssssss..',
  '..sesses..',
  '..ssssss..',
  '..wwwwww..',
  '..nnwwnn..',
  '.nnnnnnnn.',
  '.snnggnns.',
  '.snnnnnns.',
  '..nnggnn..',
  '..llllll..',
  '..ll..ll..',
  '..ll..ll..',
  '..kk..kk..',
  '..........',
];

const COIN = ['..ggg..', '.gyyyg.', 'gyygyyg', 'gyygyyg', 'gyygyyg', '.gyyyg.', '..ggg..'];

const BASE = { s: 0xf1c27d, e: 0x1b1b1b, l: 0x2f3b52, k: 0x1b1b1b, w: 0xf4f4f4, g: 0xf2c94c };

function bake(scene: Phaser.Scene, key: string, rows: string[], pal: Record<string, number>) {
  if (scene.textures.exists(key)) return;
  const g = scene.make.graphics({}, false);
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const c = pal[ch];
      if (c === undefined) return;
      g.fillStyle(c, 1);
      g.fillRect(x, y, 1, 1);
    });
  });
  g.generateTexture(key, rows[0].length, rows.length);
  g.destroy();
}

export const ART = ['harbor', 'characters', 'interior_research', 'interior_writing', 'interior_checking'];
// Left-to-right order of the figures in art/characters.png.
const SHEET = ['haiku', 'sonnet', 'opus', 'customer', 'porter', 'reviewer'];
export const SMALL_H = 30;
export const BIG_H = 72;

export function preloadArt(scene: Phaser.Scene) {
  for (const key of ART) scene.load.image(key, `art/${key}.png`);
}

// The character sheet is six figures on a magenta backdrop in equal columns. Key out the
// backdrop, crop each figure, and bake a small (market) and big (stall) texture: `p_<id>`, `b_<id>`.
export function sliceCharacters(scene: Phaser.Scene) {
  if (scene.textures.exists('p_haiku')) return;
  const src = scene.textures.get('characters').getSourceImage() as HTMLImageElement;
  const keyed = document.createElement('canvas');
  keyed.width = src.width;
  keyed.height = src.height;
  const ctx = keyed.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, src.width, src.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
    if (r > 100 && g < r * 0.45 && b > g * 1.4 && b < r + 10) d[i + 3] = 0;
  }
  ctx.putImageData(img, 0, 0);

  // Figures aren't evenly spaced, so split on runs of empty pixel columns instead of fixed columns.
  const opaque = (x: number, y: number) => d[(y * src.width + x) * 4 + 3] > 0;
  const used: boolean[] = [];
  for (let x = 0; x < src.width; x++) {
    let n = 0;
    for (let y = 0; y < src.height; y++) if (opaque(x, y)) n++;
    used.push(n > 2);
  }
  const runs: [number, number][] = [];
  for (let x = 0; x < src.width; x++) {
    if (!used[x]) continue;
    const last = runs[runs.length - 1];
    if (last && x - last[1] <= 8) last[1] = x;
    else runs.push([x, x]);
  }
  const figures = runs.sort((a, b) => b[1] - b[0] - (a[1] - a[0])).slice(0, SHEET.length).sort((a, b) => a[0] - b[0]);
  SHEET.forEach((id, n) => {
    const [x0, x1] = figures[n];
    let [y0, y1] = [Infinity, -1];
    for (let y = 0; y < src.height; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!opaque(x, y)) continue;
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
        break;
      }
    }
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    for (const [prefix, th] of [['p', SMALL_H], ['b', BIG_H]] as const) {
      const out = document.createElement('canvas');
      out.height = th;
      out.width = Math.max(1, Math.round((w * th) / h));
      const o = out.getContext('2d')!;
      o.imageSmoothingEnabled = true;
      o.imageSmoothingQuality = 'high';
      o.drawImage(keyed, x0, y0, w, h, 0, 0, out.width, out.height);
      scene.textures.addCanvas(`${prefix}_${id}`, out);
    }
  });
}

export function makeTextures(scene: Phaser.Scene) {
  bake(scene, 'customer', PERSON, { ...BASE, h: 0x6b4226, b: 0x3b82c4 });
  bake(scene, 'captain', CAPTAIN, { ...BASE, n: 0x25407a, k: 0x14213d, l: 0x14213d });
  bake(scene, 'k_haiku', PERSON, { ...BASE, h: 0x222a35, b: AGENT_COLOR.haiku });
  bake(scene, 'k_sonnet', PERSON, { ...BASE, h: 0x8a5a2b, b: AGENT_COLOR.sonnet });
  bake(scene, 'k_opus', PERSON, { ...BASE, h: 0xd8d8e8, b: AGENT_COLOR.opus });
  bake(scene, 'porter', PERSON, { ...BASE, h: 0x3b2a1e, b: 0xc0703a, l: 0x5a3e2a });
  bake(scene, 'coin', COIN, { g: 0xb8860b, y: 0xf2c94c });
  bake(scene, 'npc_a', PERSON, { ...BASE, h: 0xe8d6a8, b: 0xe8a8b0, l: 0xe8a8b0 });
  bake(scene, 'npc_b', PERSON, { ...BASE, h: 0x5b3b2a, b: 0xf3ead7, l: 0xc9b89a });
  bake(scene, 'npc_c', PERSON, { ...BASE, h: 0xe8d6a8, b: 0x9fc5a8, l: 0x9fc5a8 });
}
