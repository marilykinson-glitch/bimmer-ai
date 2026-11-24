'use strict';
/**
 * live_sim.js - Launch the Bimmer AI Voice & Digital Twin Simulator locally on macOS / Linux / Windows.
 *
 * Usage:
 *   node scripts/live_sim.js
 *   GEMINI_API_KEY=... node scripts/live_sim.js
 */
const os = require('os');
const path = require('path');
const { BimmerAiDaemon } = require('../tools/bimmer-ai/bimmer-ai');

const tmpRoot = path.join(os.tmpdir(), 'bimmer-ai-sim');
const port = Number(process.env.PORT || 8140);

const daemon = new BimmerAiDaemon({
    run: path.join(tmpRoot, 'run'),
    state: path.join(tmpRoot, 'state'),
    oap: path.join(tmpRoot, 'oap'),
    host: '127.0.0.1',
    port,
    simMode: true,
    noNft: true,
});

daemon.start().then(() => {
    console.log('\n========================================================');
    console.log('  BIMMER AI — LIVE SIMULATOR SẴN SÀNG');
    console.log('  Mở trình duyệt tại: http://127.0.0.1:' + daemon.cfg.port + '/?pin=' + daemon.pin);
    console.log('========================================================\n');
}).catch((err) => {
    console.error('Simulator failed:', err);
    process.exit(1);
});
