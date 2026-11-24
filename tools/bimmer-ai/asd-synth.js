'use strict';
/**
 * asd-synth.js - Real-Time Multi-Engine Active Sound Design (ASD) Synthesizer for BMW MGU + Bowers & Wilkins RAM.
 *
 * Designed specifically for BMW G30 / iDrive 7 cars equipped with Bowers & Wilkins / Harman RAM amplifiers where
 * factory ASD is absent (e.g. 520i / 530i without FSC 1B7) or restricted to a single engine table:
 *
 *   1. Non-Interrupting B&W Overlay Routing:
 *      Streams 24,000 Hz 16-bit PCM through GENIVI AudioManager `sourceClassID = 2` OVERLAY pipes
 *      (`HAD_Speech` sourceID 292 -> MainSink 1, fallback `AndroidAutoGuidance` 271 -> MainSink 1),
 *      mixing seamlessly over AVB Ethernet into the B&W amplifier ON TOP OF CarPlay / Spotify / Radio without pausing music!
 *   2. 6 Physical-Harmonic Engine Profiles (2D Idle/Load Otto-Cycle Wavetables + Dual Chamber Formant Resonators):
 *      - `m5_v8`:     BMW M5 F90 4.4L V8 Twin-Turbo (S63) — deep B&W under-seat subwoofer rumble + Sport burbles
 *      - `m3_s58`:    BMW M3/M4 G80 3.0L Inline-6 (S58) — metallic straight-6 rasp + crisp ZF8 shift bark
 *      - `amg_v8`:    AMG 4.0L V8 BiTurbo (M177) — heavy cross-plane thunder + shotgun overrun crackles
 *      - `gt3_flat6`: Porsche 911 GT3 4.0L Boxer-6 — high-revving naturally aspirated intake howl
 *      - `v10_na`:    Supercar 5.2L V10 NA — exotic 90-deg odd-firing harmonic wail
 *      - `iconic_m`:  BMW IconicSounds M (Hans Zimmer) — futuristic multi-voice turbine chord
 *   3. Live Driving-Mode & Load Adaptation:
 *      Automatically scales gain, exhaust valve cutoff, and overrun burbles across `ECO PRO`, `COMFORT`,
 *      `ADAPTIVE`, `SPORT` (including gearbox M/S), and `SPORT PLUS`, tracking live crankshaft RPM & torque!
 *
 * Strict ES2017 (Node 8.16) compatible, <0.3% CPU via precomputed Float32Array wavetables.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const MGU_PYTHON = '/var/opt/mgu-python/current/bin/python3';
const SMARTX_HELPER = path.join(__dirname, 'alsa-smartx.py');
const SAMPLE_RATE = 24000;
const CHUNK_MS = 40;
const CHUNK_FRAMES = Math.round((SAMPLE_RATE * CHUNK_MS) / 1000); // 960 frames = 40ms
const TABLE_SIZE = 4096;

// GENIVI AudioManager `sourceClassID: 2` (OVERLAY) playback profiles verified on BMW G30 SP18 + B&W RAM
const OVERLAY_SINKS = [
    {
        match: 'smartx_HAD_Speech_CF_24_MONO_p',
        hw: 'smartx:HAD_Speech_CF_24_MONO',
        rate: 24000,
        channels: 1,
        amRoute: { sourceID: 292, sinkID: 1 },
        label: 'B&W Overlay Channel (HAD_Speech -> MainSink)',
    },
    {
        match: 'smartx_AndroidAutoGuidance_CF_24_MONO_p',
        hw: 'smartx:AndroidAutoGuidance_CF_24_MONO',
        rate: 24000,
        channels: 1,
        amRoute: { sourceID: 271, sinkID: 1 },
        label: 'B&W Overlay Fallback (Guidance -> MainSink)',
    },
    {
        match: 'smartx_Media_Overlay_Converter_Source_CF_24_MONO_p',
        hw: 'smartx:Media_Overlay_Converter_Source_CF_24_MONO',
        rate: 24000,
        channels: 1,
        amRoute: { sourceID: 1048, sinkID: 1024 },
        label: 'Media Overlay Converter',
    },
];

// Harmonic index `k` is in units of 0.5 * crankshaft_order (so k=2 -> 1st order, k=6 -> 3rd order I6, k=8 -> 4th order V8, k=10 -> 5th order V10)
const ENGINE_PROFILES = {
    m5_v8: {
        id: 'm5_v8',
        name: 'BMW M5 V8 4.4L Twin-Turbo',
        shortName: 'M5 V8 S63',
        badge: 'V8 BITURBO',
        idleHarmonics: [[1, 0.32], [2, 0.72], [3, 0.48], [4, 0.95], [6, 0.35], [8, 1.00], [12, 0.22], [16, 0.14]],
        loadHarmonics: [[1, 0.22], [2, 0.55], [3, 0.45], [4, 0.85], [5, 0.28], [6, 0.52], [8, 1.00], [12, 0.58], [16, 0.46], [20, 0.28], [24, 0.18]],
        subFreqHz: 78,
        throatFreqHz: 520,
        throatSweepHz: 680,
        turboWhistle: 0.20,
        burbleStyle: 1.05,
        pitchScale: 1.00,
    },
    m3_s58: {
        id: 'm3_s58',
        name: 'BMW M3/M4 G80 I6 3.0L (S58)',
        shortName: 'M3/M4 I6 S58',
        badge: 'I6 M-POWER',
        idleHarmonics: [[2, 0.35], [3, 0.28], [6, 1.00], [9, 0.25], [12, 0.48], [18, 0.18]],
        loadHarmonics: [[2, 0.24], [3, 0.32], [6, 1.00], [9, 0.46], [12, 0.78], [15, 0.30], [18, 0.54], [24, 0.34], [30, 0.20]],
        subFreqHz: 96,
        throatFreqHz: 690,
        throatSweepHz: 920,
        turboWhistle: 0.24,
        burbleStyle: 0.95,
        pitchScale: 1.04,
    },
    amg_v8: {
        id: 'amg_v8',
        name: 'AMG C63/GT 4.0L V8 BiTurbo',
        shortName: 'AMG V8 4.0',
        badge: 'AMG V8',
        idleHarmonics: [[1, 0.55], [2, 0.92], [3, 0.68], [4, 0.88], [5, 0.34], [7, 0.30], [8, 0.95], [10, 0.18]],
        loadHarmonics: [[1, 0.42], [2, 0.78], [3, 0.66], [4, 0.90], [6, 0.44], [7, 0.40], [8, 1.00], [11, 0.32], [12, 0.50], [16, 0.42]],
        subFreqHz: 68,
        throatFreqHz: 430,
        throatSweepHz: 540,
        turboWhistle: 0.16,
        burbleStyle: 1.30,
        pitchScale: 0.95,
    },
    gt3_flat6: {
        id: 'gt3_flat6',
        name: 'Porsche 911 GT3 4.0L Boxer-6',
        shortName: '911 GT3 F6',
        badge: 'GT3 BOXER',
        idleHarmonics: [[2, 0.30], [4, 0.22], [6, 1.00], [12, 0.52], [18, 0.26]],
        loadHarmonics: [[2, 0.18], [6, 0.95], [9, 0.36], [12, 0.92], [18, 0.74], [24, 0.52], [30, 0.36], [36, 0.22]],
        subFreqHz: 112,
        throatFreqHz: 780,
        throatSweepHz: 1250,
        turboWhistle: 0.0,
        burbleStyle: 0.55,
        pitchScale: 1.18,
    },
    v10_na: {
        id: 'v10_na',
        name: 'Supercar 5.2L V10 Hút Khí Tự Nhiên',
        shortName: 'Supercar V10',
        badge: 'V10 NA',
        idleHarmonics: [[2, 0.28], [5, 0.62], [10, 1.00], [15, 0.32], [20, 0.40]],
        loadHarmonics: [[2, 0.16], [5, 0.58], [10, 1.00], [15, 0.52], [20, 0.84], [25, 0.44], [30, 0.55], [40, 0.26]],
        subFreqHz: 105,
        throatFreqHz: 840,
        throatSweepHz: 1320,
        turboWhistle: 0.0,
        burbleStyle: 0.85,
        pitchScale: 1.12,
    },
    iconic_m: {
        id: 'iconic_m',
        name: 'BMW IconicSounds M (Hans Zimmer)',
        shortName: 'IconicSounds M',
        badge: 'ICONIC M',
        idleHarmonics: [[2, 0.85], [3, 0.65], [4, 0.75], [6, 0.55], [8, 0.40], [12, 0.25]],
        loadHarmonics: [[2, 0.70], [3, 0.78], [4, 0.85], [6, 0.82], [8, 0.65], [12, 0.55], [16, 0.40], [24, 0.28]],
        subFreqHz: 82,
        throatFreqHz: 600,
        throatSweepHz: 1100,
        turboWhistle: 0.32,
        burbleStyle: 0.0,
        pitchScale: 1.05,
    },
};

const ENGINE_ORDER = ['m5_v8', 'm3_s58', 'amg_v8', 'gt3_flat6', 'v10_na', 'iconic_m'];

const DRIVE_MODE_TUNING = {
    eco_pro: { labelVi: 'ECO PRO', gainMult: 0.35, valveOpen: 0.22, burbleMult: 0.0 },
    comfort: { labelVi: 'COMFORT', gainMult: 0.65, valveOpen: 0.48, burbleMult: 0.22 },
    adaptive: { labelVi: 'ADAPTIVE', gainMult: 0.72, valveOpen: 0.55, burbleMult: 0.35 },
    sport: { labelVi: 'SPORT', gainMult: 1.18, valveOpen: 0.92, burbleMult: 1.00 },
    sport_plus: { labelVi: 'SPORT+', gainMult: 1.38, valveOpen: 1.00, burbleMult: 1.35 },
};

function buildWavetable(harmonics) {
    const tbl = new Float32Array(TABLE_SIZE);
    let peak = 1e-6;
    for (let h = 0; h < harmonics.length; h++) {
        const orderHalf = harmonics[h][0];
        const amp = harmonics[h][1];
        const phaseOffset = ((orderHalf * 1.37) % 6.2831853);
        for (let i = 0; i < TABLE_SIZE; i++) {
            const ang = (2 * Math.PI * orderHalf * i) / TABLE_SIZE + phaseOffset;
            tbl[i] += amp * Math.sin(ang);
        }
    }
    for (let j = 0; j < TABLE_SIZE; j++) {
        const a = Math.abs(tbl[j]);
        if (a > peak) peak = a;
    }
    const inv = 1.0 / peak;
    for (let k = 0; k < TABLE_SIZE; k++) tbl[k] *= inv;
    return tbl;
}

const WAVETABLES = {};
ENGINE_ORDER.forEach((id) => {
    const p = ENGINE_PROFILES[id];
    WAVETABLES[id] = {
        idle: buildWavetable(p.idleHarmonics),
        load: buildWavetable(p.loadHarmonics),
    };
});

function normalizeAsdConfig(raw) {
    const r = (raw && typeof raw === 'object') ? raw : {};
    const eng = String(r.engine || 'm5_v8').toLowerCase();
    const vol = Number(r.volumePercent);
    return {
        enabled: !!r.enabled,
        engine: ENGINE_PROFILES[eng] ? eng : 'm5_v8',
        volumePercent: isFinite(vol) ? Math.max(15, Math.min(100, Math.round(vol))) : 75,
        modeFollow: r.modeFollow !== false,
        burbles: r.burbles !== false,
    };
}

function resolveEffectiveDriveMode(telemetry) {
    const t = telemetry || {};
    const rawMode = String(t.driveMode || 'comfort').toLowerCase();
    const gear = String(t.gear || 'P').toUpperCase();
    // Tilting BMW gear selector left into S / M automatically engages sporty exhaust character if in Comfort/Adaptive
    if ((gear.charAt(0) === 'S' || gear.charAt(0) === 'M') && (rawMode === 'comfort' || rawMode === 'adaptive')) {
        return 'sport';
    }
    return DRIVE_MODE_TUNING[rawMode] ? rawMode : 'comfort';
}

/**
 * Pure ES2017 real-time synthesizer core (can be driven by daemon 40ms timer or unit tests).
 */
class AsdDspCore {
    constructor(sampleRate) {
        this.sr = sampleRate || SAMPLE_RATE;
        this.phase = 0.0;
        this.turboPhase = 0.0;
        this.rpmSmooth = 800;
        this.prevRpm = 800;
        this.loadSmooth = 0.25;
        this.gainSmooth = 0.0;
        this.subLp1 = 0.0;
        this.subLp2 = 0.0;
        this.bpBand = 0.0;
        this.bpLow = 0.0;
        this.lpOut = 0.0;
        this.noiseSeed = 0x12345678;
        this.burbleEnv = 0.0;
        this.burbleFreq = 180;
        this.burblePhase = 0.0;
        this.shiftBarkEnv = 0.0;
        this.lastGearNum = 0;
    }

    nextNoise() {
        let x = this.noiseSeed | 0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        this.noiseSeed = x;
        return (x / 2147483648.0);
    }

    renderBlock(frames, cfg, telemetry, revDemoRpm) {
        const out = new Int16Array(frames);
        const prof = ENGINE_PROFILES[cfg.engine] || ENGINE_PROFILES.m5_v8;
        const tables = WAVETABLES[prof.id];
        const isRevDemo = !!(revDemoRpm && revDemoRpm > 400);
        let effModeKey = cfg.modeFollow ? resolveEffectiveDriveMode(telemetry) : 'sport';
        if (isRevDemo && (effModeKey === 'eco_pro' || effModeKey === 'comfort')) {
            effModeKey = 'sport';
        }
        const modeTune = DRIVE_MODE_TUNING[effModeKey] || DRIVE_MODE_TUNING.comfort;

        const liveRpm = isRevDemo
            ? revDemoRpm
            : Math.max(0, Number((telemetry && telemetry.rpm) || 0));

        const active = cfg.enabled && liveRpm >= 420;
        const targetMasterGain = active
            ? Math.min(1.35, (cfg.volumePercent / 100.0) * 0.68 * modeTune.gainMult)
            : 0.0;

        if (!active && this.gainSmooth < 0.001) {
            this.gainSmooth = 0.0;
            return out;
        }

        const clampedRpm = Math.max(620, Math.min(7200, liveRpm || 750));
        const dtSec = frames / this.sr;
        const dRpmPerSec = (clampedRpm - this.prevRpm) / Math.max(0.01, dtSec);
        this.prevRpm = clampedRpm;

        // Estimate engine load (0..1) from real crankshaft torque (Nm), pedal %, or dRPM/dt acceleration
        let rawLoad = 0.22;
        if (revDemoRpm && revDemoRpm > 400) {
            rawLoad = dRpmPerSec >= -40 ? 0.88 : 0.05;
        } else if (telemetry) {
            if (typeof telemetry.torqueNm === 'number' && isFinite(telemetry.torqueNm)) {
                rawLoad = Math.max(0.05, Math.min(1.0, (telemetry.torqueNm + 15) / 230.0));
            } else if (typeof telemetry.pedalPct === 'number' && telemetry.pedalPct > 0) {
                rawLoad = Math.max(0.10, Math.min(1.0, telemetry.pedalPct / 75.0));
            }
            if (dRpmPerSec > 260) {
                rawLoad = Math.max(rawLoad, Math.min(1.0, 0.35 + dRpmPerSec / 1800.0));
            }
        }

        // Detect ZF8 upshift bark (`D1->D2->D3` or sharp RPM drop under load while moving)
        const gearStr = String((telemetry && telemetry.gear) || '');
        const gearMatch = /^[DSM](\d+)$/i.exec(gearStr);
        const gearNum = gearMatch ? Number(gearMatch[1]) : 0;
        if (gearNum > this.lastGearNum && this.lastGearNum >= 1 && clampedRpm > 2300 && modeTune.valveOpen >= 0.8) {
            this.shiftBarkEnv = 0.95;
        }
        this.lastGearNum = gearNum;

        // Trigger authentic Sport overrun burbles / crackles on throttle lift above 1,950 RPM
        const isDecelOverrun = (dRpmPerSec < -240 || (telemetry && typeof telemetry.torqueNm === 'number' && telemetry.torqueNm < -8)) && rawLoad < 0.22;
        if (active && cfg.burbles && prof.burbleStyle > 0 && modeTune.burbleMult > 0 && isDecelOverrun && clampedRpm >= 1950) {
            const chance = 0.42 * prof.burbleStyle * modeTune.burbleMult * Math.min(1.3, clampedRpm / 3400.0);
            if (Math.abs(this.nextNoise()) < chance && this.burbleEnv < 0.28) {
                this.burbleEnv = Math.min(1.15, (0.55 + 0.45 * Math.abs(this.nextNoise())) * prof.burbleStyle * modeTune.burbleMult);
                this.burbleFreq = 125 + Math.abs(this.nextNoise()) * 210;
            }
        }

        const rpmStep = (clampedRpm - this.rpmSmooth) / frames;
        const loadTarget = Math.max(0.08, Math.min(1.0, rawLoad * 0.72 + modeTune.valveOpen * 0.28));
        const loadStep = (loadTarget - this.loadSmooth) / frames;
        const gainStep = (targetMasterGain - this.gainSmooth) / frames;

        // Filter coefficients for B&W under-seat sub punch + resonant exhaust throat + mode lowpass
        const subCut = Math.min(0.35, (2 * Math.PI * prof.subFreqHz) / this.sr);
        const valveBrightHz = 720 + modeTune.valveOpen * 2200 + loadTarget * 900;
        const lpAlpha = Math.min(0.78, (2 * Math.PI * valveBrightHz) / this.sr);

        const idleTbl = tables.idle;
        const loadTbl = tables.load;

        for (let i = 0; i < frames; i++) {
            this.rpmSmooth += rpmStep;
            this.loadSmooth += loadStep;
            this.gainSmooth += gainStep;

            // 1 full table = 2 crankshaft revolutions (Otto 4-stroke cycle = RPM / 120 Hz)
            const cycleHz = (this.rpmSmooth * prof.pitchScale) / 120.0;
            const n = this.nextNoise();
            this.phase += (cycleHz * (1.0 + n * 0.0035)) / this.sr;
            if (this.phase >= 1.0) this.phase -= Math.floor(this.phase);

            const pos = this.phase * TABLE_SIZE;
            const idx0 = pos | 0;
            const frac = pos - idx0;
            const idx1 = (idx0 + 1) & (TABLE_SIZE - 1);

            const sIdle = idleTbl[idx0] + (idleTbl[idx1] - idleTbl[idx0]) * frac;
            const sLoad = loadTbl[idx0] + (loadTbl[idx1] - loadTbl[idx0]) * frac;
            const mix = Math.max(0.0, Math.min(1.0, this.loadSmooth));
            let sig = sIdle * (1.0 - mix) + sLoad * mix;

            // Add subtle exhaust gas flow texture under load
            sig += n * (0.025 + 0.065 * mix);

            // B&W Under-Seat Subwoofer Low-End Reinforcement
            this.subLp1 += subCut * (sig - this.subLp1);
            this.subLp2 += subCut * (this.subLp1 - this.subLp2);
            const subBass = this.subLp2 * (0.75 + 0.45 * modeTune.valveOpen);

            // State-Variable Exhaust Throat Formant Filter (sweeps upward with RPM)
            const rpmNorm = Math.max(0.0, Math.min(1.0, (this.rpmSmooth - 800) / 5200.0));
            const fThroat = prof.throatFreqHz + prof.throatSweepHz * rpmNorm;
            const svfF = Math.min(0.65, 2.0 * Math.sin((Math.PI * fThroat) / this.sr));
            const svfQ = 0.32;
            this.bpLow += svfF * this.bpBand;
            const high = sig - this.bpLow - svfQ * this.bpBand;
            this.bpBand += svfF * high;
            const throatRasp = this.bpBand * (0.55 + 0.65 * mix);

            // Optional Twin-Turbo Spool Whistle on acceleration
            let turboSig = 0.0;
            if (prof.turboWhistle > 0 && mix > 0.35) {
                const tFreq = 1650 + rpmNorm * 1650 + mix * 450;
                this.turboPhase += tFreq / this.sr;
                if (this.turboPhase >= 1.0) this.turboPhase -= 1.0;
                turboSig = Math.sin(2 * Math.PI * this.turboPhase) * prof.turboWhistle * (mix - 0.35) * 0.22;
            }

            // Overrun Exhaust Burble / Crackle Resonator
            let burbleSig = 0.0;
            if (this.burbleEnv > 0.002) {
                this.burblePhase += this.burbleFreq / this.sr;
                if (this.burblePhase >= 1.0) this.burblePhase -= 1.0;
                burbleSig = (Math.sin(2 * Math.PI * this.burblePhase) * 0.75 + n * 0.45) * this.burbleEnv;
                this.burbleEnv *= 0.9962;
            }

            // ZF8 Upshift Ignition-Cut Bark
            let barkSig = 0.0;
            if (this.shiftBarkEnv > 0.002) {
                barkSig = (sig * 1.4 + n * 0.5) * this.shiftBarkEnv;
                this.shiftBarkEnv *= 0.994;
            }

            let combined = sig * 0.62 + subBass + throatRasp + turboSig + burbleSig + barkSig;

            // Mode-dependent virtual exhaust flap low-pass filter
            this.lpOut += lpAlpha * (combined - this.lpOut);

            // Dynamic load loudness curve (prevents highway constant-RPM drone while roaring on throttle!)
            const rpmLoudness = 0.58 + 0.42 * rpmNorm;
            const loadLoudness = 0.52 + 0.48 * mix;
            let driven = this.lpOut * rpmLoudness * loadLoudness * this.gainSmooth * 1.45;

            // Smooth warm tube/muffler soft-clipper (`x / (1 + |x|*0.55)`)
            driven = driven / (1.0 + Math.abs(driven) * 0.55);
            const pcmSample = Math.max(-32767, Math.min(32767, Math.round(driven * 28500)));
            out[i] = pcmSample;
        }

        return out;
    }
}

class ActiveSoundController {
    constructor(opts) {
        this.opts = Object.assign({
            mguPython: MGU_PYTHON,
            smartxHelper: SMARTX_HELPER,
            smartxDir: '/run/smartx',
            connectAmRoute: null,
            disconnectAmRoute: null,
            getTelemetry: () => ({}),
            shouldMute: () => false,
            onStateChange: null,
            onLog: null,
        }, opts || {});

        this.config = normalizeAsdConfig({});
        this.dsp = new AsdDspCore(SAMPLE_RATE);
        this.running = false;
        this.child = null;
        this.routeToken = null;
        this.activeSink = '';
        this.sinkIdx = 0;
        this.pumpTimer = null;
        this.revDemoStartAt = 0;
        this.revDemoUntil = 0;
        this.startingStream = false;
        this.backpressureDrops = 0;
    }

    log(msg) {
        if (this.opts.onLog) this.opts.onLog(msg);
    }

    configure(patch) {
        this.config = normalizeAsdConfig(Object.assign({}, this.config, patch || {}));
        this.syncLifecycle().catch(() => {});
        if (this.opts.onStateChange) this.opts.onStateChange(this.getStatus());
        return this.config;
    }

    triggerRevDemo() {
        const now = Date.now();
        this.revDemoStartAt = now + 220;
        this.revDemoUntil = now + 4600;
        if (!this.config.enabled) {
            this.config.enabled = true;
        }
        this.syncLifecycle().catch(() => {});
        if (this.opts.onStateChange) this.opts.onStateChange(this.getStatus());
    }

    currentRevDemoRpm(now) {
        if (now >= this.revDemoUntil || this.revDemoStartAt <= 0) return 0;
        if (now < this.revDemoStartAt) return 850;
        const elapsed = now - this.revDemoStartAt;
        // Realistic twin-blip rev curve: 850 -> 4600 -> 3000 -> 6000 -> 880 RPM (triggers Sport burbles on drop!)
        if (elapsed < 800) return 850 + (elapsed / 800) * 3750;
        if (elapsed < 1350) return 4600 - ((elapsed - 800) / 550) * 1600;
        if (elapsed < 2150) return 3000 + ((elapsed - 1350) / 800) * 3000;
        return Math.max(850, 6000 - ((elapsed - 2150) / 2230) * 5150);
    }

    getStatus() {
        const tel = this.opts.getTelemetry() || {};
        const effMode = resolveEffectiveDriveMode(tel);
        const prof = ENGINE_PROFILES[this.config.engine] || ENGINE_PROFILES.m5_v8;
        const modeInfo = DRIVE_MODE_TUNING[effMode] || DRIVE_MODE_TUNING.comfort;
        return {
            enabled: this.config.enabled,
            streaming: !!this.child,
            activeSink: this.activeSink,
            engine: this.config.engine,
            engineName: prof.name,
            engineShort: prof.shortName,
            engineBadge: prof.badge,
            volumePercent: this.config.volumePercent,
            modeFollow: this.config.modeFollow,
            burbles: this.config.burbles,
            effectiveMode: effMode,
            effectiveModeLabel: modeInfo.labelVi,
            modeGainPercent: Math.round(modeInfo.gainMult * 100),
            revDemoActive: Date.now() < this.revDemoUntil,
        };
    }

    pickAvailableSinks() {
        let nodes = [];
        try { nodes = fs.readdirSync(this.opts.smartxDir); } catch (e) { nodes = []; }
        return OVERLAY_SINKS.filter((s) => nodes.indexOf(s.match) >= 0);
    }

    shouldStreamNow() {
        if (!this.running || !this.config.enabled) return false;
        if (this.opts.shouldMute && this.opts.shouldMute()) return false;
        const now = Date.now();
        if (now < this.revDemoUntil) return true;
        const tel = this.opts.getTelemetry() || {};
        return !!(tel.engineRunning || (typeof tel.rpm === 'number' && tel.rpm >= 420));
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.pumpTimer = setInterval(() => {
            this.tick();
        }, CHUNK_MS);
    }

    async stop() {
        this.running = false;
        if (this.pumpTimer) {
            clearInterval(this.pumpTimer);
            this.pumpTimer = null;
        }
        await this.teardownStream();
    }

    async teardownStream() {
        const c = this.child;
        this.child = null;
        this.activeSink = '';
        if (c) {
            await new Promise((resolve) => {
                let done = false;
                const fin = () => { if (!done) { done = true; resolve(); } };
                c.once('close', fin);
                try { c.stdin.end(); c.kill('SIGTERM'); } catch (e) { fin(); }
                setTimeout(() => { try { c.kill('SIGKILL'); } catch (e) {} fin(); }, 300);
            });
        }
        const rt = this.routeToken;
        this.routeToken = null;
        if (rt && rt.created && rt.connId !== null && typeof this.opts.disconnectAmRoute === 'function') {
            try { await this.opts.disconnectAmRoute(rt.connId); } catch (e) {}
        }
    }

    async syncLifecycle() {
        const want = this.shouldStreamNow();
        if (!want) {
            if (this.child) {
                await this.teardownStream();
                if (this.opts.onStateChange) this.opts.onStateChange(this.getStatus());
            }
            return;
        }
        if (this.child || this.startingStream) return;
        if (!fs.existsSync(this.opts.mguPython) || !fs.existsSync(this.opts.smartxHelper)) return;
        const sinks = this.pickAvailableSinks();
        if (!sinks.length) return;

        this.startingStream = true;
        try {
            const prof = sinks[this.sinkIdx % sinks.length];
            if (prof.amRoute && typeof this.opts.connectAmRoute === 'function') {
                try { this.routeToken = await this.opts.connectAmRoute(prof.amRoute); } catch (e) { this.routeToken = null; }
            }
            if (!this.shouldStreamNow()) {
                await this.teardownStream();
                return;
            }
            const child = cp.spawn(this.opts.mguPython, [
                this.opts.smartxHelper,
                '--play-loop',
                prof.hw,
                String(prof.rate || SAMPLE_RATE),
                String(prof.channels || 1),
            ], { stdio: ['pipe', 'pipe', 'ignore'] });

            this.child = child;
            this.activeSink = prof.hw;
            child.stdin.on('error', () => {});
            child.stdout.on('data', (d) => {
                const txt = d.toString('utf8');
                if (txt.indexOf('play_ready') >= 0) {
                    this.log('B&W ASD audio active on ' + prof.hw + ' (' + this.config.engine + ')');
                }
            });
            child.on('close', (code) => {
                if (this.child === child) {
                    this.child = null;
                    this.activeSink = '';
                    if (code !== 0) this.sinkIdx++;
                    if (this.opts.onStateChange) this.opts.onStateChange(this.getStatus());
                }
            });
            child.on('error', () => {
                if (this.child === child) {
                    this.child = null;
                    this.activeSink = '';
                    this.sinkIdx++;
                }
            });
            if (this.opts.onStateChange) this.opts.onStateChange(this.getStatus());
        } finally {
            this.startingStream = false;
        }
    }

    tick() {
        const want = this.shouldStreamNow();
        if (!want) {
            if (this.child) this.teardownStream().catch(() => {});
            return;
        }
        if (!this.child) {
            this.syncLifecycle().catch(() => {});
            return;
        }
        const now = Date.now();
        const demoRpm = this.currentRevDemoRpm(now);
        const tel = this.opts.getTelemetry() || {};
        const pcmInt16 = this.dsp.renderBlock(CHUNK_FRAMES, this.config, tel, demoRpm);
        const buf = Buffer.from(pcmInt16.buffer, pcmInt16.byteOffset, pcmInt16.byteLength);
        try {
            const ok = this.child.stdin.write(buf);
            if (!ok) {
                this.backpressureDrops++;
                if (this.backpressureDrops > 20) {
                    this.backpressureDrops = 0;
                    this.sinkIdx++;
                    this.teardownStream().catch(() => {});
                }
            } else {
                this.backpressureDrops = 0;
            }
        } catch (e) {}
    }
}

module.exports = {
    SAMPLE_RATE,
    CHUNK_FRAMES,
    OVERLAY_SINKS,
    ENGINE_PROFILES,
    ENGINE_ORDER,
    DRIVE_MODE_TUNING,
    normalizeAsdConfig,
    resolveEffectiveDriveMode,
    AsdDspCore,
    ActiveSoundController,
};
