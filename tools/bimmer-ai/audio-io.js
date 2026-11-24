'use strict';
/**
 * audio-io.js - OEM BMW MGU SmartXbar / AVB Ceiling Microphone Capture, 2-Zone Speaker Localization & TTS.
 *
 * Verified on real BMW MGU (iDrive 7) hardware:
 *   - Ceiling microphones enter MGU as `DOMAIN_RAM` `Microphones` (`sourceID: 129`) -> `ECNR_Uplink_Source` (`sourceID: 389`),
 *     exposed in `/run/smartx` via Intel SmartXbar (`/usr/share/alsa/alsa.conf.d/50-smartx.conf` & `libasound.so.2`).
 *   - Uses `/var/opt/mgu-python/current/bin/python3` + `alsa-smartx.py` (`ctypes` `libasound.so.2`) when `arecord` is absent.
 *   - Supports both 2-Mic Stereo streams (`avb:MGU_GW_3_SOURCE_CF_2MIC_6REF` / `smartx:SpeechSink_CF_2MIC_1REF_SPEECH`)
 *     for Driver (Left) vs Passenger (Right) speaker localization, and 24 kHz Hardware Echo-Cancelled ECNR streams
 *     (`smartx:VoiceNotesSink_CF_24_MONO` / `smartx:AndroidAutoSink_CF_24_MONO`).
 *
 * Node 8 compatible, zero external npm dependencies.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const MGU_PYTHON = '/var/opt/mgu-python/current/bin/python3';
const SMARTX_HELPER = path.join(__dirname, 'alsa-smartx.py');

const SMARTX_PROFILES = [
    {
        match: 'avb_MGU_GW_3_SOURCE_CF_2MIC_6REF_c',
        hw: 'avb:MGU_GW_3_SOURCE_CF_2MIC_6REF',
        rate: 48000,
        hwChannels: 8,
        amRoute: null,
        label: 'Cặp Mic trần 2 vùng + 6 kênh khử vọng (AVB 2MIC_6REF)',
        score: 95,
    },
    {
        match: 'smartx_VoiceNotesSink_CF_24_MONO_c',
        hw: 'smartx:VoiceNotesSink_CF_24_MONO',
        rate: 24000,
        hwChannels: 1,
        amRoute: { sourceID: 389, sinkID: 389, fallbackSourceID: 129 },
        label: 'Mic trần khử ồn Harman ECNR 24kHz (VoiceNotesSink)',
        score: 90,
    },
    {
        match: 'smartx_AndroidAutoSink_CF_24_MONO_c',
        hw: 'smartx:AndroidAutoSink_CF_24_MONO',
        rate: 24000,
        hwChannels: 1,
        amRoute: { sourceID: 389, sinkID: 390, fallbackSourceID: 129 },
        label: 'Mic trần khử ồn Harman ECNR 24kHz (AndroidAutoSink)',
        score: 88,
    },
    {
        match: 'smartx_SpeechSink_CF_2MIC_1REF_SPEECH_c',
        hw: 'smartx:SpeechSink_CF_2MIC_1REF_SPEECH',
        rate: 24000,
        hwChannels: 3,
        amRoute: { sourceID: 129, sinkID: 387 },
        label: 'Cặp Mic trần 2 vùng SpeechSink (2MIC_1REF)',
        score: 85,
    },
];

function readTextSafe(file) {
    try { return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; }
}

function listDirSafe(dir) {
    try { return fs.readdirSync(dir); } catch (e) { return []; }
}

/**
 * Inspect Intel SmartXbar (`/run/smartx`) and ALSA (`/proc/asound`) capture streams on the MGU head unit.
 */
function probeOemAudioStack(opts) {
    const o = Object.assign({
        procAsound: '/proc/asound',
        devSnd: '/dev/snd',
        smartxDir: '/run/smartx',
        mguPython: MGU_PYTHON,
    }, opts || {});

    const cardsRaw = readTextSafe(path.join(o.procAsound, 'cards'));
    const pcmRaw = readTextSafe(path.join(o.procAsound, 'pcm'));
    const sndNodes = listDirSafe(o.devSnd).filter((n) => /^pcmC\d+D\d+c$/.test(n));
    const smartxNodes = listDirSafe(o.smartxDir);
    const hasMguPython = fs.existsSync(o.mguPython);

    const captureStreams = [];

    // 1. Intel SmartXbar / AVB roof microphone pipes on real BMW MGU
    SMARTX_PROFILES.forEach((p) => {
        if (smartxNodes.indexOf(p.match) >= 0) {
            captureStreams.push({
                hw: p.hw,
                rawHw: p.hw,
                rate: p.rate,
                hwChannels: p.hwChannels,
                amRoute: p.amRoute,
                label: p.label,
                backend: 'smartx-libasound',
                score: p.score,
            });
        }
    });

    // 2. Standard ALSA `/proc/asound/pcm` capture devices
    pcmRaw.split('\n').forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.toLowerCase().indexOf('capture') < 0) return;
        const m = /^(\d+)-(\d+):\s*([^:]+):/.exec(trimmed);
        if (m) {
            const card = Number(m[1]), dev = Number(m[2]);
            const label = m[3].trim();
            let score = 15;
            if (/mic|speech|voice|harman|i2s|smartx/i.test(label)) score += 30;
            captureStreams.push({
                hw: 'hw:' + card + ',' + dev,
                rawHw: 'hw:' + card + ',' + dev,
                card,
                device: dev,
                rate: 24000,
                hwChannels: 1,
                amRoute: null,
                label,
                backend: hasMguPython ? 'smartx-libasound' : 'arecord',
                score,
            });
        }
    });

    captureStreams.sort((a, b) => b.score - a.score);
    const recommended = captureStreams.length ? captureStreams[0] : null;

    return {
        probedAt: Date.now(),
        hasAlsaCapture: captureStreams.length > 0 || sndNodes.length > 0,
        hasMguPython,
        smartxCount: smartxNodes.length,
        recommendedDevice: recommended ? recommended.hw : 'simulated',
        recommendedProfile: recommended,
        captureStreams,
        sndCaptureNodes: sndNodes,
        cardsSummary: cardsRaw.trim().split('\n').filter(Boolean).slice(0, 12),
    };
}

/**
 * Parse a 16-bit PCM WAV buffer and compute Left/Right dBFS RMS to detect Driver (Left) vs Passenger (Right) speaker.
 */
function analyzeStereoMicBuffer(buf, opts) {
    const o = Object.assign({
        swapChannels: false,
        zoneThresholdDb: 3.2,
        noiseFloorDb: -48.0,
    }, opts || {});

    if (!Buffer.isBuffer(buf) || buf.length < 64) {
        return { channels: 0, sampleRate: 16000, durationMs: 0, leftDb: -90, rightDb: -90, speakerZone: 'driver', confidence: 0 };
    }

    let offset = 0;
    let channels = 2;
    let sampleRate = 16000;
    let bitsPerSample = 16;

    if (buf.length >= 44 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WAVE') {
        let pos = 12;
        while (pos + 8 <= buf.length) {
            const chunkId = buf.slice(pos, pos + 4).toString('ascii');
            const chunkSize = buf.readUInt32LE(pos + 4);
            if (chunkId === 'fmt ' && pos + 24 <= buf.length) {
                channels = buf.readUInt16LE(pos + 10) || 1;
                sampleRate = buf.readUInt32LE(pos + 12) || 16000;
                bitsPerSample = buf.readUInt16LE(pos + 22) || 16;
            } else if (chunkId === 'data') {
                offset = pos + 8;
                break;
            }
            pos += 8 + chunkSize + (chunkSize % 2);
        }
        if (offset === 0) offset = 44;
    }

    if (bitsPerSample !== 16 || (channels !== 1 && channels !== 2)) {
        return { channels, sampleRate, durationMs: 0, leftDb: -40, rightDb: -40, speakerZone: 'driver', confidence: 0.2 };
    }

    const bytesPerFrame = channels * 2;
    const totalFrames = Math.floor((buf.length - offset) / bytesPerFrame);
    if (totalFrames <= 0) {
        return { channels, sampleRate, durationMs: 0, leftDb: -90, rightDb: -90, speakerZone: 'driver', confidence: 0 };
    }

    let sumSqL = 0, sumSqR = 0;
    for (let i = 0; i < totalFrames; i++) {
        const base = offset + i * bytesPerFrame;
        const sL = buf.readInt16LE(base) / 32768.0;
        const sR = channels === 2 ? (buf.readInt16LE(base + 2) / 32768.0) : sL;
        sumSqL += sL * sL;
        sumSqR += sR * sR;
    }

    const rmsL = Math.sqrt(sumSqL / totalFrames);
    const rmsR = Math.sqrt(sumSqR / totalFrames);
    const toDb = (r) => (r > 1e-5 ? +(20 * Math.log10(r)).toFixed(1) : -90.0);

    const rawLeftDb = toDb(rmsL);
    const rawRightDb = toDb(rmsR);
    const driverDb = o.swapChannels ? rawRightDb : rawLeftDb;
    const passengerDb = o.swapChannels ? rawLeftDb : rawRightDb;
    const durationMs = Math.round((totalFrames / sampleRate) * 1000);

    if (channels === 1) {
        return {
            channels: 1,
            sampleRate,
            durationMs,
            leftDb: driverDb,
            rightDb: driverDb,
            speakerZone: 'driver',
            confidence: 0.5,
        };
    }

    const peakDb = Math.max(driverDb, passengerDb);
    const diffDb = driverDb - passengerDb;
    let speakerZone = 'driver';
    let confidence = 0.5;

    if (peakDb < o.noiseFloorDb) {
        speakerZone = 'cabin';
        confidence = 0.1;
    } else if (diffDb >= o.zoneThresholdDb) {
        speakerZone = 'driver';
        confidence = Math.min(0.99, +(0.55 + (diffDb / 15)).toFixed(2));
    } else if (diffDb <= -o.zoneThresholdDb) {
        speakerZone = 'passenger';
        confidence = Math.min(0.99, +(0.55 + (Math.abs(diffDb) / 15)).toFixed(2));
    } else {
        speakerZone = 'driver';
        confidence = 0.45;
    }

    return {
        channels: 2,
        sampleRate,
        durationMs,
        leftDb: driverDb,
        rightDb: passengerDb,
        speakerZone,
        confidence,
    };
}

function buildStereoWav(leftSamples, rightSamples, sampleRate) {
    const sr = sampleRate || 16000;
    const n = Math.min(leftSamples.length, rightSamples.length);
    const dataBytes = n * 4;
    const buf = Buffer.alloc(44 + dataBytes);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + dataBytes, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(2, 22);
    buf.writeUInt32LE(sr, 24);
    buf.writeUInt32LE(sr * 4, 28);
    buf.writeUInt16LE(4, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(dataBytes, 40);
    for (let i = 0; i < n; i++) {
        const l = Math.max(-1, Math.min(1, leftSamples[i]));
        const r = Math.max(-1, Math.min(1, rightSamples[i]));
        buf.writeInt16LE(Math.round(l * 32767), 44 + i * 4);
        buf.writeInt16LE(Math.round(r * 32767), 44 + i * 4 + 2);
    }
    return buf;
}

/**
 * Capture a bounded WAV clip from the OEM ceiling mic via `mgu-python` + `libasound.so.2` (or `arecord` fallback),
 * automatically connecting/disconnecting any required GENIVI AudioManager mic route and yielding on phone calls.
 */
async function captureCeilingMicClip(opts) {
    const o = Object.assign({
        mguPython: MGU_PYTHON,
        smartxHelper: SMARTX_HELPER,
        arecordBin: 'arecord',
        device: 'avb:MGU_GW_3_SOURCE_CF_2MIC_6REF',
        rate: 24000,
        hwChannels: 1,
        amRoute: null,
        connectAmRoute: null,
        disconnectAmRoute: null,
        durationSec: 4,
        outFile: '/run/bimmer-ai/capture.wav',
        swapChannels: false,
        isCallActive: () => false,
    }, opts || {});

    if (o.isCallActive()) {
        throw new Error('Đang có cuộc gọi điện thoại / CarPlay — Bimmer AI tự nhường Mic zin.');
    }

    // Look up matching SmartX profile metadata if device matches one of our known pipes
    for (let i = 0; i < SMARTX_PROFILES.length; i++) {
        if (SMARTX_PROFILES[i].hw === o.device) {
            o.rate = SMARTX_PROFILES[i].rate;
            o.hwChannels = SMARTX_PROFILES[i].hwChannels;
            if (!o.amRoute) o.amRoute = SMARTX_PROFILES[i].amRoute;
            break;
        }
    }

    let connId = null;
    if (o.amRoute && typeof o.connectAmRoute === 'function') {
        try { connId = await o.connectAmRoute(o.amRoute); } catch (e) { connId = null; }
    }

    const usePythonLibasound = fs.existsSync(o.mguPython) && fs.existsSync(o.smartxHelper);

    try {
        await new Promise((resolve, reject) => {
            let child;
            if (usePythonLibasound) {
                child = cp.spawn(o.mguPython, [
                    o.smartxHelper,
                    String(o.device),
                    o.outFile,
                    String(Math.max(1, Math.min(10, o.durationSec))),
                    String(o.rate || 24000),
                    String(o.hwChannels || 1),
                ], { stdio: ['ignore', 'pipe', 'pipe'] });
            } else {
                child = cp.spawn(o.arecordBin, [
                    '-q', '-D', String(o.device), '-f', 'S16_LE', '-c', '2', '-r', '16000',
                    '-d', String(Math.max(1, Math.min(10, Math.round(o.durationSec)))), '-t', 'wav', o.outFile,
                ], { stdio: ['ignore', 'pipe', 'pipe'] });
            }

            let out = '';
            let abortedForCall = false;
            const callWatch = setInterval(() => {
                if (o.isCallActive()) {
                    abortedForCall = true;
                    try { child.kill('SIGTERM'); } catch (e) {}
                }
            }, 150);

            const timer = setTimeout(() => {
                try { child.kill('SIGTERM'); } catch (e) {}
            }, (o.durationSec + 3) * 1000);

            child.stdout.on('data', (d) => { out += d.toString('utf8'); });
            child.stderr.on('data', (d) => { out += d.toString('utf8'); });
            child.on('error', (err) => {
                clearInterval(callWatch);
                clearTimeout(timer);
                reject(err);
            });
            child.on('close', (code) => {
                clearInterval(callWatch);
                clearTimeout(timer);
                if (abortedForCall) return reject(new Error('Đã ngắt thu âm ngay lập tức để nhường Mic cho cuộc gọi.'));
                if (code !== 0 && !fs.existsSync(o.outFile)) {
                    return reject(new Error('Thu âm (' + o.device + '): ' + (out.trim() || ('exit ' + code))));
                }
                resolve();
            });
        });
    } finally {
        if (connId !== null && typeof o.disconnectAmRoute === 'function') {
            try { await o.disconnectAmRoute(connId); } catch (e) {}
        }
    }

    const wav = fs.readFileSync(o.outFile);
    const analysis = analyzeStereoMicBuffer(wav, { swapChannels: o.swapChannels });
    return { wavBuffer: wav, file: o.outFile, analysis };
}

async function synthesizeVietnameseMp3(text, uplinkOpts, uplinkModule) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!clean || !uplinkModule) return null;
    const q = encodeURIComponent(clean);
    const ttsPath = '/translate_tts?ie=UTF-8&client=tw-ob&tl=vi&q=' + q;
    try {
        const res = await uplinkModule.request(uplinkOpts, {
            host: 'translate.googleapis.com',
            path: ttsPath,
            method: 'GET',
            binary: true,
            headers: { Accept: 'audio/mpeg,*/*' },
            timeoutMs: 8000,
        });
        if (res && res.status === 200 && res.bodyBase64 && res.bodyBase64.length > 200) {
            return Buffer.from(res.bodyBase64, 'base64');
        }
    } catch (e) {}
    return null;
}

module.exports = {
    SMARTX_PROFILES,
    probeOemAudioStack,
    analyzeStereoMicBuffer,
    buildStereoWav,
    captureCeilingMicClip,
    synthesizeVietnameseMp3,
};
