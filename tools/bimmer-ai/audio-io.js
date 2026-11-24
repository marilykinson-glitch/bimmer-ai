'use strict';
/**
 * audio-io.js - OEM 2-Zone Ceiling Microphone Capture, Speaker Localization & Audio Ducking TTS for BMW MGU.
 *
 * Features:
 *   1. `probeOemAudioStack`: Discovers ALSA / Harman I2S / Intel SmartXbar capture devices (`/proc/asound/cards`,
 *      `/proc/asound/pcm`, `/dev/snd/*`, `arecord -L`) on the head unit without touching active phone/CarPlay streams.
 *   2. `analyzeStereoMicBuffer`: Computes per-channel RMS energy (dBFS) on 16-bit PCM stereo WAV/raw audio from the
 *      overhead roof microphones (Left = Driver, Right = Passenger) to localize who spoke (`driver` vs `passenger`).
 *   3. `captureCeilingMicClip`: Records a bounded 16 kHz stereo WAV clip via `arecord`, automatically aborting if a
 *      Bluetooth / CarPlay phone call starts (`isCallActive()`).
 *   4. `synthesizeVietnameseMp3`: Generates natural Vietnamese TTS audio (`vi`) via `mgu-uplink` for car speaker playback
 *      and browser simulator preview, paired with automatic media volume ducking.
 *
 * Node 8 compatible, zero external dependencies.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

function readTextSafe(file) {
    try { return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; }
}

function listDirSafe(dir) {
    try { return fs.readdirSync(dir); } catch (e) { return []; }
}

/**
 * Inspect ALSA capture cards and PCM streams on the Linux MGU head unit.
 */
function probeOemAudioStack(opts) {
    const o = Object.assign({
        procAsound: '/proc/asound',
        devSnd: '/dev/snd',
        arecordBin: 'arecord',
    }, opts || {});

    const cardsRaw = readTextSafe(path.join(o.procAsound, 'cards'));
    const pcmRaw = readTextSafe(path.join(o.procAsound, 'pcm'));
    const sndNodes = listDirSafe(o.devSnd).filter((n) => /^pcmC\d+D\d+c$/.test(n));

    const captureStreams = [];
    pcmRaw.split('\n').forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.toLowerCase().indexOf('capture') < 0) return;
        const m = /^(\d+)-(\d+):\s*([^:]+):/.exec(trimmed);
        if (m) {
            const card = Number(m[1]), dev = Number(m[2]);
            const label = m[3].trim();
            // Prefer Harman DSP / I2S / SmartX / Mic capture streams over loopback if present
            let score = 10;
            if (/mic|speech|voice|harman|i2s|smartx|avb|ssp/i.test(label)) score += 30;
            if (/loopback/i.test(label)) score -= 5;
            captureStreams.push({
                hw: 'plughw:' + card + ',' + dev,
                rawHw: 'hw:' + card + ',' + dev,
                card,
                device: dev,
                label,
                score,
            });
        }
    });

    captureStreams.sort((a, b) => b.score - a.score);
    const recommendedDevice = captureStreams.length ? captureStreams[0].hw : (sndNodes.length ? 'default' : 'simulated');

    return {
        probedAt: Date.now(),
        hasAlsaCapture: captureStreams.length > 0 || sndNodes.length > 0,
        recommendedDevice,
        captureStreams,
        sndCaptureNodes: sndNodes,
        cardsSummary: cardsRaw.trim().split('\n').filter(Boolean).slice(0, 12),
    };
}

/**
 * Parse a 16-bit PCM WAV (or raw stereo S16LE) buffer and compute Left/Right dBFS RMS to detect
 * whether the Driver (Left mic) or Passenger (Right mic) spoke.
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

    // Parse RIFF/WAVE header if present
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

/**
 * Build a valid 16-bit PCM WAV buffer from synthetic left/right float samples (used for unit tests & mic diagnostics).
 */
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
    buf.writeUInt16LE(1, 20);      // PCM
    buf.writeUInt16LE(2, 22);      // 2 channels (Driver + Passenger)
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
 * Capture a short stereo WAV clip from the OEM ceiling mic via ALSA `arecord`, yielding immediately if a phone call is active.
 */
function captureCeilingMicClip(opts) {
    const o = Object.assign({
        arecordBin: 'arecord',
        device: 'default',
        durationSec: 4,
        outFile: '/run/bimmer-ai/capture.wav',
        swapChannels: false,
        isCallActive: () => false,
    }, opts || {});

    return new Promise((resolve, reject) => {
        if (o.isCallActive()) {
            return reject(new Error('Đang có cuộc gọi điện thoại / CarPlay — Bimmer AI tự nhường Mic zin.'));
        }
        const args = [
            '-q',
            '-D', String(o.device || 'default'),
            '-f', 'S16_LE',
            '-c', '2',
            '-r', '16000',
            '-d', String(Math.max(1, Math.min(10, Math.round(o.durationSec)))),
            '-t', 'wav',
            o.outFile,
        ];
        let child;
        try {
            child = cp.spawn(o.arecordBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        } catch (e) {
            return reject(e);
        }

        let stderr = '';
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

        child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
        child.on('error', (err) => {
            clearInterval(callWatch);
            clearTimeout(timer);
            reject(err);
        });
        child.on('close', (code) => {
            clearInterval(callWatch);
            clearTimeout(timer);
            if (abortedForCall) {
                return reject(new Error('Đã ngắt thu âm ngay lập tức để nhường Mic cho cuộc gọi.'));
            }
            if (code !== 0 && !fs.existsSync(o.outFile)) {
                return reject(new Error('arecord (' + o.device + '): ' + (stderr.trim() || ('exit ' + code))));
            }
            let wav = null;
            try { wav = fs.readFileSync(o.outFile); } catch (e) { return reject(e); }
            const analysis = analyzeStereoMicBuffer(wav, { swapChannels: o.swapChannels });
            resolve({ wavBuffer: wav, file: o.outFile, analysis });
        });
    });
}

/**
 * Fetch natural Vietnamese TTS MP3 audio (`vi`) via `uplink.request` so the head unit can play it
 * over the car's MediaPlayer / speaker sink (or return base64 MP3 to the simulator).
 */
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
    } catch (e) { /* offline fallback: UI text + optional local chime */ }
    return null;
}

module.exports = {
    probeOemAudioStack,
    analyzeStereoMicBuffer,
    buildStereoWav,
    captureCeilingMicClip,
    synthesizeVietnameseMp3,
};
