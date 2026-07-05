import bambooTallUrl from './generated-assets/bamboo-tall.jpg';
import deskStripUrl from './generated-assets/desk-strip.jpg';
import deskWideUrl from './generated-assets/desk-wide.jpg';
import diagramWideUrl from './generated-assets/diagram-wide.jpg';
import lotusWideUrl from './generated-assets/lotus-wide.jpg';
import mountainTallUrl from './generated-assets/mountain-tall.jpg';
import mountainWideUrl from './generated-assets/mountain-wide.jpg';
import orchidTallUrl from './generated-assets/orchid-tall.jpg';
import paperNarrowUrl from './generated-assets/paper-narrow.jpg';
import paperWhiteUrl from './generated-assets/paper-white.jpg';
import roofWideUrl from './generated-assets/roof-wide.jpg';
import scrollTallUrl from './generated-assets/scroll-tall.jpg';

export const inkMountainSvg =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 580 460'%3E%3Cdefs%3E%3ClinearGradient id='sky' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='0' stop-color='%23d9d2c5'/%3E%3Cstop offset='1' stop-color='%23f5f0e8'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='580' height='460' fill='url(%23sky)'/%3E%3Cpath d='M0 330 C70 245 126 245 178 322 C250 178 340 156 440 328 C496 268 540 263 580 336 L580 460 L0 460 Z' fill='%238d9a8d' opacity='.52'/%3E%3Cpath d='M0 372 C78 310 162 300 240 360 C330 270 442 280 580 352 L580 460 L0 460 Z' fill='%233b3a35' opacity='.25'/%3E%3Cpath d='M0 410 C150 374 278 384 580 398' stroke='%236f7f73' stroke-width='18' fill='none' opacity='.25'/%3E%3Ccircle cx='466' cy='88' r='38' fill='%23f7edcf' opacity='.82'/%3E%3C/svg%3E";

export const ricePaperSvg =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 580 560'%3E%3Crect width='580' height='560' fill='%23faf6f0'/%3E%3Cg opacity='.18' stroke='%238b4513' stroke-width='1'%3E%3Cpath d='M80 80H500M80 160H500M80 240H500M80 320H500M80 400H500M80 480H500'/%3E%3Cpath d='M100 55V505M210 55V505M320 55V505M430 55V505'/%3E%3C/g%3E%3Ccircle cx='460' cy='420' r='54' fill='%23a03020' opacity='.10'/%3E%3C/svg%3E";

export const generatedCardAssets = {
  bambooTall: bambooTallUrl,
  deskStrip: deskStripUrl,
  deskWide: deskWideUrl,
  diagramWide: diagramWideUrl,
  lotusWide: lotusWideUrl,
  mountainTall: mountainTallUrl,
  mountainWide: mountainWideUrl,
  orchidTall: orchidTallUrl,
  paperNarrow: paperNarrowUrl,
  paperWhite: paperWhiteUrl,
  roofWide: roofWideUrl,
  scrollTall: scrollTallUrl,
} as const;
