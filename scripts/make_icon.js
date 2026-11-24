'use strict';
/**
 * make_icon.js - generates the 140x140 MGU Store tile icon (`apps/bimmer_ai/icon.png`):
 * glowing BMW M-inspired AI voice aura rings + central neural voice waveform bars.
 */
const fs = require('fs');
const path = require('path');
const { Canvas } = require(path.join(__dirname, '..', 'kit', 'runtime', 'canvas'));

const c = new Canvas(140, 140);

// Outer M-Tricolour / Jarvis AI aura arcs
c.arc(70, 70, 50, 57, -140, -20, '#00d4ff');
c.arc(70, 70, 50, 57, -10, 110, '#8a2be2');
c.arc(70, 70, 50, 57, 120, 210, '#ff1e38');

// Inner glowing ring
c.arc(70, 70, 38, 42, 0, 360, '#ffffff');

// Voice equalizer waveform bars inside the core
const bars = [
    [46, 18, '#00d4ff'],
    [58, 34, '#ffffff'],
    [70, 48, '#00e5ff'],
    [82, 30, '#ffffff'],
    [94, 16, '#a855f7'],
];
bars.forEach((b) => {
    const x = b[0], h = b[1], col = b[2];
    c.roundRect(x - 4, 70 - Math.floor(h / 2), 8, h, 4, col);
});

const out = path.join(__dirname, '..', 'apps', 'bimmer_ai', 'icon.png');
fs.writeFileSync(out, c.png());
console.log('wrote ' + out);
