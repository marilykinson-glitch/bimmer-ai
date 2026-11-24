'use strict';
/**
 * audio-io.js - OEM BMW MGU SmartXbar / AVB Ceiling Microphone Capture, Auto-Failover, 2-Zone Localization & TTS (`v0.3.2`).
 *
 * Key upgrades in `v0.3.2`:
 *   1. Automatic multi-pipe failover across `VoiceNotesSink` (Harman ECNR 24kHz), `SpeechSink` (2-Mic Stereo 24kHz),
 *      `AndroidAutoSink` (Harman ECNR 24kHz), and `avb:MGU_GW_3_SOURCE_CF_2MIC_6REF` (2-Mic 48->16kHz), remembering
 *      the last working non-zero pipe (`lastWorkingHw`) so subsequent PTT presses open instantaneously.
 *   2. Unlinks stale `capture.wav` before every recording so crashed/busy attempts can never reuse an old file.
 *   3. Only disconnects GENIVI AudioManager routes that were newly created by us (`routeToken.created === true`),
 *      never tearing down BMW's persistent `129 -> 387` (`SpeechSink`) connection.
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
        match: 'smartx_VoiceNotesSink_CF_24_MONO_c',
        hw: 'smartx:VoiceNotesSink_CF_24_MONO',
        rate: 24000,
        hwChannels: 1,
        amRoute: { sourceID: 389, sinkID: 389, fallbackSourceID: 129 },
        label: 'Mic trần khử ồn Harman ECNR 24kHz (VoiceNotesSink)',
        score: 96,
    },
    {
        match: 'smartx_SpeechSink_CF_2MIC_1REF_SPEECH_c',
        hw: 'smartx:SpeechSink_CF_2MIC_1REF_SPEECH',
        rate: 24000,
        hwChannels: 3,
        amRoute: { sourceID: 129, sinkID: 387 },
        label: 'Cặp Mic trần 2 vùng SpeechSink (2MIC_1REF)',
        score: 94,
    },
    {
        match: 'smartx_AndroidAutoSink_CF_24_MONO_c',
        hw: 'smartx:AndroidAutoSink_CF_24_MONO',
        rate: 24000,
        hwChannels: 1,
        amRoute: { sourceID: 389, sinkID: 390, fallbackSourceID: 129 },
        label: 'Mic trần khử ồn Harman ECNR 24kHz (AndroidAutoSink)',
        score: 90,
    },
    {
        match: 'avb_MGU_GW_3_SOURCE_CF_2MIC_6REF_c',
        hw: 'avb:MGU_GW_3_SOURCE_CF_2MIC_6REF',
        rate: 48000,
        hwChannels: 8,
        amRoute: null,
        label: 'Cặp Mic trần 2 vùng + 6 kênh khử vọng (AVB 2MIC_6REF)',
        score: 85,
    },
];

let lastWorkingHw = '';

function readTextSafe(file) {
    try { return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; }
}

function listDirSafe(dir) {
    try { return fs.readdirSync(dir); } catch (e) { return []; }
}

function unlinkSafe(file) {
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (e) {}
}

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
                score: p.hw === lastWorkingHw ? p.score + 10 : p.score,
            });
        }
    });

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

function analyzeStereoMicBuffer(buf, opts) {
    const o = Object.assign({
        swapChannels: false,
        zoneThresholdDb: 3.2,
        noiseFloorDb: -48.0,
    }, opts || {});

    if (!Buffer.isBuffer(buf) || buf.length < 64) {
        return { channels: 0, sampleRate: 16000, durationMs: 0, leftDb: -90, rightDb: -90, peak: 0, speakerZone: 'driver', confidence: 0 };
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
        return { channels, sampleRate, durationMs: 0, leftDb: -40, rightDb: -40, peak: 100, speakerZone: 'driver', confidence: 0.2 };
    }

    const bytesPerFrame = channels * 2;
    const totalFrames = Math.floor((buf.length - offset) / bytesPerFrame);
    if (totalFrames <= 0) {
        return { channels, sampleRate, durationMs: 0, leftDb: -90, rightDb: -90, peak: 0, speakerZone: 'driver', confidence: 0 };
    }

    let sumSqL = 0, sumSqR = 0, peak = 0;
    for (let i = 0; i < totalFrames; i++) {
        const base = offset + i * bytesPerFrame;
        const rawL = buf.readInt16LE(base);
        const rawR = channels === 2 ? buf.readInt16LE(base + 2) : rawL;
        const absL = Math.abs(rawL), absR = Math.abs(rawR);
        if (absL > peak) peak = absL;
        if (absR > peak) peak = absR;
        const sL = rawL / 32768.0;
        const sR = rawR / 32768.0;
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
            peak,
            speakerZone: 'driver',
            confidence: 0.5,
        };
    }

    const peakDb = Math.max(driverDb, passengerDb);
    const diffDb = driverDb - passengerDb;
    let speakerZone = 'driver';
    let confidence = 0.5;

    if (peakDb < o.noiseFloorDb) {
        speakerZone = 'driver';
        confidence = 0.2;
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
        peak,
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

async function captureSingleDevice(profile, o) {
    let routeToken = null;
    if (profile.amRoute && typeof o.connectAmRoute === 'function') {
        try { routeToken = await o.connectAmRoute(profile.amRoute); } catch (e) { routeToken = null; }
    }

    unlinkSafe(o.outFile);
    const usePythonLibasound = fs.existsSync(o.mguPython) && fs.existsSync(o.smartxHelper);

    try {
        await new Promise((resolve, reject) => {
            let child;
            if (usePythonLibasound) {
                child = cp.spawn(o.mguPython, [
                    o.smartxHelper,
                    String(profile.hw),
                    o.outFile,
                    String(Math.max(1, Math.min(10, o.durationSec))),
                    String(profile.rate || 24000),
                    String(profile.hwChannels || 1),
                ], { stdio: ['ignore', 'pipe', 'pipe'] });
            } else {
                child = cp.spawn(o.arecordBin, [
                    '-q', '-D', String(profile.hw), '-f', 'S16_LE', '-c', '2', '-r', '16000',
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
                try { child.kill('SIGKILL'); } catch (e) {}
            }, Math.round((o.durationSec + 2.2) * 1000));

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
                if (abortedForCall) {
                    const abortErr = new Error('Đã ngắt thu âm ngay lập tức để nhường Mic cho cuộc gọi.');
                    abortErr.callAborted = true;
                    return reject(abortErr);
                }
                if (code !== 0 || !fs.existsSync(o.outFile)) {
                    let detail = out.trim();
                    try {
                        const j = JSON.parse(detail);
                        if (j && j.error) detail = j.error;
                    } catch (e) {}
                    return reject(new Error(profile.hw + ': ' + (detail || ('exit ' + code))));
                }
                resolve(out);
            });
        });
    } catch (err) {
        if (routeToken && routeToken.created && routeToken.connId !== null && typeof o.disconnectAmRoute === 'function') {
            try { await o.disconnectAmRoute(routeToken.connId); } catch (e) {}
        }
        throw err;
    }

    if (routeToken && routeToken.created && routeToken.connId !== null && typeof o.disconnectAmRoute === 'function') {
        try { await o.disconnectAmRoute(routeToken.connId); } catch (e) {}
    }

    const wav = fs.readFileSync(o.outFile);
    const analysis = analyzeStereoMicBuffer(wav, { swapChannels: o.swapChannels });
    return { wavBuffer: wav, file: o.outFile, deviceUsed: profile.hw, analysis };
}

/**
 * Capture a bounded WAV clip from the OEM ceiling mic with automatic SmartXbar failover.
 */
async function captureCeilingMicClip(opts) {
    const o = Object.assign({
        mguPython: MGU_PYTHON,
        smartxHelper: SMARTX_HELPER,
        arecordBin: 'arecord',
        device: 'auto',
        rate: 24000,
        hwChannels: 1,
        amRoute: null,
        connectAmRoute: null,
        disconnectAmRoute: null,
        durationSec: 4,
        outFile: '/run/bimmer-ai/capture.wav',
        swapChannels: false,
        isCallActive: () => false,
        onLog: null,
    }, opts || {});

    if (o.isCallActive()) {
        throw new Error('Đang có cuộc gọi điện thoại / CarPlay — Bimmer AI tự nhường Mic zin.');
    }

    // Build ordered candidate list (prefer `lastWorkingHw`, then all present SmartX pipes)
    const candidates = [];
    const addCandidate = (prof) => {
        if (!prof || !prof.hw) return;
        for (let i = 0; i < candidates.length; i++) {
            if (candidates[i].hw === prof.hw) return;
        }
        candidates.push(prof);
    };

    if (o.device && o.device !== 'auto') {
        let matched = null;
        for (let i = 0; i < SMARTX_PROFILES.length; i++) {
            if (SMARTX_PROFILES[i].hw === o.device) { matched = SMARTX_PROFILES[i]; break; }
        }
        addCandidate(matched || { hw: o.device, rate: o.rate || 24000, hwChannels: o.hwChannels || 1, amRoute: o.amRoute });
    }

    if (lastWorkingHw) {
        for (let i = 0; i < SMARTX_PROFILES.length; i++) {
            if (SMARTX_PROFILES[i].hw === lastWorkingHw) addCandidate(SMARTX_PROFILES[i]);
        }
    }

    const smartxNodes = listDirSafe('/run/smartx');
    SMARTX_PROFILES.forEach((p) => {
        if (!smartxNodes.length || smartxNodes.indexOf(p.match) >= 0) {
            addCandidate(p);
        }
    });

    const errors = [];
    let bestZeroClip = null;

    for (let idx = 0; idx < candidates.length; idx++) {
        const cand = candidates[idx];
        try {
            const clip = await captureSingleDevice(cand, o);
            if (clip.analysis.peak > 0) {
                lastWorkingHw = cand.hw;
                if (o.onLog) o.onLog('mic capture ok on ' + cand.hw + ' (peak=' + clip.analysis.peak + ', L=' + clip.analysis.leftDb + 'dB, R=' + clip.analysis.rightDb + 'dB)');
                return clip;
            }
            if (!bestZeroClip) bestZeroClip = clip;
            errors.push(cand.hw + ': digital zero (peak=0)');
        } catch (err) {
            if (err && err.callAborted) throw err;
            errors.push(err.message);
            if (o.onLog) o.onLog('mic failover (' + err.message + ')');
        }
    }

    if (bestZeroClip) return bestZeroClip;
    throw new Error(errors.join(' | ') || 'Không tìm thấy luồng Mic trần SmartX khả dụng');
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
