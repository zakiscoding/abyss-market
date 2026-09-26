import Phaser from 'phaser';
import { FONT, H, W } from './art';
import { MarketScene } from './scene';

async function boot() {
  await Promise.all([document.fonts.load(`8px ${FONT}`), document.fonts.load(`bold 8px ${FONT}`)]);
  (window as unknown as { game: Phaser.Game }).game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    width: W,
    height: H,
    pixelArt: true,
    backgroundColor: '#0b1020',
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    scene: [MarketScene],
  });
}

boot();
