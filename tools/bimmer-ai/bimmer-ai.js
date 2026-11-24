'use strict';
/**
 * bimmer-ai.js - Main Root Daemon & HTTP Voice/Simulator Server for "Bimmer AI" (BMW MGU iDrive 7).
 *
 * Responsibilities:
 *   1. Connects `VehicleController` (SOME/IP comfort, lighting, windows, locks, RideTube, Bimmer-Link 1CR, VietMap).
 *   2. Listens to Steering Wheel PTT (`statusPTTButton1`) & captures stereo 16kHz audio from the OEM ceiling mics (`audio-io.js`),
 *      automatically detecting Driver (Left) vs Passenger (Right) speaker zone and yielding during phone/CarPlay calls.
 *   3. Runs `AiBrain.processAssistantTurn` (Online Gemini Multimodal + Offline Vietnamese NLU fallback) through `SafetyGate`.
 *   4. Ducks media volume, pulses `IpaInteriorLight`, and synthesizes natural Vietnamese TTS audio (`vi`).
 *   5. Exchanges zero-flash-wear RAM state & commands with `apps/bimmer_ai` via `/run/bimmer-ai/status.json` & `app/command.json`.
 *   6. Serves the Mobile QR Voice / Config / Live Car Simulator Portal on port `8140` (with automatic `nft` rule on MGU).
 *
 * Node 8 compatible, zero external npm dependencies.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');
const urlMod = require('url');
const crypto = require('crypto');
const cp = require('child_process');

const Up = require('./uplink');
const SafetyGate = require('./safety-gate');
const VehicleBus = require('./vehicle-bus');
const AudioIO = require('./audio-io');
const AsdSynth = require('./asd-synth');
const AiBrain = require('./ai-brain');

const VERSION = '0.6.0';
const FW_TAG = 'bimmer-ai';
const APP_RE = /^bimmer_ai\d*$/;

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);

function createDaemonConfig(over) {
    return Object.assign({
        run: env('BA_RUN', '/run/bimmer-ai'),
        state: env('BA_STATE', '/var/opt/bimmer-ai'),
        oap: env('BA_OAP', '/var/opt/public/oap'),
        proc: env('BA_PROC', '/proc'),
        port: Number(env('BA_PORT', 8140)),
        host: env('BA_HOST', '0.0.0.0'),
        nft: env('BA_NFT', 'nft'),
        route: env('BA_ROUTE', '/proc/net/route'),
        ips: env('BA_IPS', ''),
        simMode: env('BA_SIM', '') === '1',
        noNft: env('BA_NO_NFT', '') === '1',
        geminiBaseUrl: env('BA_GEMINI_BASE', ''),
    }, over || {});
}

const mkdirp = (d) => {
    if (fs.existsSync(d)) return;
    mkdirp(path.dirname(d));
    try { fs.mkdirSync(d); } catch (e) { if (e.code !== 'EEXIST') throw e; }
};

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };

function writeAtomic(file, data, mode) {
    mkdirp(path.dirname(file));
    const tmp = file + '.tmp.' + process.pid + '.' + Math.floor(Math.random() * 10000);
    fs.writeFileSync(tmp, data, { mode: mode || 0o644 });
    fs.renameSync(tmp, file);
}

function defaultSettings() {
    return {
        apiKey: '',
        model: 'gemini-3-flash-preview',
        ownerName: 'Đại ca',
        handsFreeWake: true,            // Always-on "Hey Bimmer" / "Ê Bimmer" ceiling-mic VAD listener
        pttTrigger: 'short_press',      // short_press | long_press | double_press | disabled
        micDevice: 'auto',
        micDurationSec: 4,
        swapMicChannels: false,
        ttsEnabled: true,
        duckVolumePercent: 20,
        startupBriefing: true,
        vietmapCoPilot: true,
        asd: AsdSynth.normalizeAsdConfig({ enabled: false, engine: 'm5_v8', volumePercent: 75, modeFollow: true, burbles: true }),
        guards: SafetyGate.defaultGuards(),
    };
}

function normalizeModelName(rawModel, fallback) {
    const m = typeof rawModel === 'string' ? rawModel.trim() : '';
    if (!m) return fallback;
    if (/^gemini-(?:1\.5|2\.0|2\.5)-flash(?:-lite)?$/i.test(m)) {
        return 'gemini-3-flash-preview';
    }
    return m;
}

function normalizeSettings(raw) {
    const d = defaultSettings();
    const r = raw && typeof raw === 'object' ? raw : {};
    const ptt = String(r.pttTrigger || d.pttTrigger);
    return {
        apiKey: typeof r.apiKey === 'string' ? r.apiKey.trim() : d.apiKey,
        model: normalizeModelName(r.model, d.model),
        ownerName: typeof r.ownerName === 'string' && r.ownerName.trim() ? r.ownerName.trim().slice(0, 40) : d.ownerName,
        handsFreeWake: r.handsFreeWake !== false,
        pttTrigger: (ptt === 'short_press' || ptt === 'long_press' || ptt === 'double_press' || ptt === 'disabled') ? ptt : d.pttTrigger,
        micDevice: typeof r.micDevice === 'string' && r.micDevice.trim() ? r.micDevice.trim() : d.micDevice,
        micDurationSec: Math.max(2, Math.min(8, Math.round(Number(r.micDurationSec) || d.micDurationSec))),
        swapMicChannels: !!r.swapMicChannels,
        ttsEnabled: r.ttsEnabled !== false,
        duckVolumePercent: Math.max(5, Math.min(50, Math.round(Number(r.duckVolumePercent) || d.duckVolumePercent))),
        startupBriefing: r.startupBriefing !== false,
        vietmapCoPilot: r.vietmapCoPilot !== false,
        asd: AsdSynth.normalizeAsdConfig(r.asd),
        guards: SafetyGate.normalizeGuards(r.guards),
    };
}

function discoverLanAddresses(cfg) {
    if (cfg.ips) return cfg.ips.split(',').filter(Boolean);
    if (cfg.simMode) return ['127.0.0.1'];
    let via = '';
    try {
        const rows = fs.readFileSync(cfg.route, 'utf8').split('\n').slice(1)
            .map((l) => l.trim().split(/\s+/)).filter((c) => c.length > 7 && c[1] === '00000000' && c[7] === '00000000');
        rows.sort((x, y) => Number(x[6]) - Number(y[6]));
        via = rows.length ? rows[0][0] : '';
    } catch (e) { via = ''; }
    const out = [];
    const nets = os.networkInterfaces();
    Object.keys(nets).forEach((name) => (nets[name] || []).forEach((a) => {
        if (a.internal || (a.family !== 'IPv4' && a.family !== 4) || /^169\.254\./.test(a.address)) return;
        const range = /^192\.168\./.test(a.address) ? 0 : /^172\.(1[6-9]|2\d|3[01])\./.test(a.address) ? 1 : /^10\./.test(a.address) ? 2 : 3;
        out.push({ ip: a.address, rank: (name === via ? 0 : /^(wl|ml|uap|ap|wifi)/i.test(name) ? 10 : 20) + range });
    }));
    const sorted = out.sort((a, b) => a.rank - b.rank).map((a) => a.ip);
    return sorted.length ? sorted : ['127.0.0.1'];
}

function execNft(nftBin, args) {
    return new Promise((resolve, reject) => cp.execFile(nftBin, args, { timeout: 8000, maxBuffer: 2 << 20 }, (err, out, stderr) => {
        if (!err) return resolve(out);
        const e = new Error('nft ' + args.join(' ') + ': ' + (String(stderr || '').trim() || err.message));
        e.absent = err.code === 'ENOENT' || /No such file or directory/.test(String(stderr));
        reject(e);
    }));
}

async function fwClose(nftBin) {
    let out;
    try { out = await execNft(nftBin, ['-a', 'list', 'chain', 'ip', 'filter', 'input']); } catch (e) {
        if (e.absent) return 'absent';
        return 'skip';
    }
    const lines = out.split('\n').filter((l) => l.indexOf('comment "' + FW_TAG + '"') >= 0);
    for (let i = 0; i < lines.length; i++) {
        const m = /# handle (\d+)\s*$/.exec(lines[i]);
        if (m) await execNft(nftBin, ['delete', 'rule', 'ip', 'filter', 'input', 'handle', m[1]]).catch(() => {});
    }
    return 'closed';
}

async function fwOpen(nftBin, port) {
    await fwClose(nftBin);
    try {
        await execNft(nftBin, ['insert', 'rule', 'ip', 'filter', 'input', 'tcp', 'dport', String(port), 'accept', 'comment', '"' + FW_TAG + '"']);
        return 'opened';
    } catch (e) { return 'skip'; }
}

function findInstalledApp(oapRoot) {
    let dirs = [];
    try { dirs = fs.readdirSync(oapRoot).filter((d) => /^oap_\d+$/.test(d)); } catch (e) { return null; }
    for (let i = 0; i < dirs.length; i++) {
        const rels = ['source/javascript/kit/app-spec.json', 'javascript/kit/app-spec.json'];
        for (let k = 0; k < rels.length; k++) {
            const spec = readJson(path.join(oapRoot, dirs[i], rels[k]));
            if (spec && typeof spec.id === 'string' && APP_RE.test(spec.id)) {
                return { id: spec.id, root: path.join(oapRoot, dirs[i]) };
            }
        }
    }
    return null;
}

/** Chown `/run/bimmer-ai/app` to the OAP UID of `bimmer_ai` so the HMI app can write zero-flash commands. */
function grantAppRamFolder(oapRoot, runDir, procDir) {
    const appDir = path.join(runDir, 'app');
    mkdirp(appDir);
    try { fs.chmodSync(appDir, 0o775); } catch (e) {}

    const app = findInstalledApp(oapRoot);
    let uid = null, gid = null;
    if (app) {
        try {
            const pids = fs.readdirSync(procDir || '/proc').filter((d) => /^\d+$/.test(d));
            for (let i = 0; i < pids.length; i++) {
                try {
                    const cmd = fs.readFileSync(path.join(procDir || '/proc', pids[i], 'cmdline'), 'latin1');
                    if (cmd.indexOf(app.root) < 0) continue;
                    const st = fs.readFileSync(path.join(procDir || '/proc', pids[i], 'status'), 'utf8');
                    const u = /^Uid:\s+(\d+)/m.exec(st), g = /^Gid:\s+(\d+)/m.exec(st);
                    if (u && g && Number(u[1]) > 0) { uid = Number(u[1]); gid = Number(g[1]); break; }
                } catch (e) {}
            }
            if (uid === null) {
                const st = fs.statSync(path.join(app.root, 'data'));
                uid = st.uid; gid = st.gid;
            }
        } catch (e) {}
    }
    if (uid === null) {
        const mgr = path.join(oapRoot, 'oap_12201', 'data', 'apps');
        try {
            fs.readdirSync(mgr).forEach((name) => {
                const info = readJson(path.join(mgr, name));
                if (info && APP_RE.test(String(info.id || name)) && Number(info.userId) > 0) {
                    uid = Number(info.userId); gid = uid;
                }
            });
        } catch (e) {}
    }
    if (uid && uid > 0 && typeof process.getuid === 'function' && process.getuid() === 0) {
        try { fs.chownSync(appDir, uid, gid || uid); fs.chmodSync(appDir, 0o770); } catch (e) {}
    }
    return app;
}

class BimmerAiDaemon {
    constructor(overCfg) {
        this.cfg = createDaemonConfig(overCfg);
        mkdirp(this.cfg.run);
        mkdirp(path.join(this.cfg.run, 'app'));
        mkdirp(path.join(this.cfg.run, 'tts'));
        mkdirp(this.cfg.state);

        this.settingsFile = path.join(this.cfg.state, 'settings.json');
        this.settings = normalizeSettings(readJson(this.settingsFile) || {
            apiKey: env('GEMINI_API_KEY', ''),
        });
        this.pin = this.cfg.simMode ? '0000' : String(crypto.randomBytes(2).readUInt16BE(0) % 9000 + 1000);
        this.ipIdx = 0;
        this.logs = [];
        this.history = [];
        this.assistantState = 'idle'; // idle | listening | thinking | speaking
        this.wakeStatus = 'off';      // off | paused | armed | speech
        this.followUpUntil = 0;       // 2-step "Hey Bimmer!" -> active follow-up command window
        this.activeSpeakerZone = 'driver';
        this.micLevels = { leftDb: -65, rightDb: -65 };
        this.lastTurn = {
            at: Date.now(),
            engine: this.settings.apiKey ? 'gemini' : 'offline',
            speakerZone: 'driver',
            transcript: '',
            replyVi: 'Sẵn sàng! Gọi rảnh tay "Hey Bimmer / Ê Bimmer", bấm nút Mic vô-lăng hoặc mở cổng QR.',
            actions: [],
        };
        this.audioProbe = AudioIO.probeOemAudioStack();
        this.lastOverspeedWarnAt = 0;
        this.greetedDrive = false;
        this.lastCmdId = 0;
        this.seenCmdIds = [];
        this.turnBusy = false;
        this.unduckedVolume = null;
        this.unduckTimer = null;

        this.uplinkOpts = Up.options({
            stateDir: path.join(this.cfg.state, 'state'),
            noSetuid: this.cfg.simMode,
            baseUrl: this.cfg.geminiBaseUrl || '',
            log: (m) => this.log(m),
        });

        this.vehicle = new VehicleBus.VehicleController({
            onTelemetry: () => this.onVehicleStateChanged(),
            onPttEvent: (ev) => this.onSteeringWheelPtt(ev),
            onAsdCommand: (args) => this.applyAsdCommand(args),
            onLog: (m) => this.log(m),
        });
        this.vehicle.setGuards(this.settings.guards);

        this.asd = new AsdSynth.ActiveSoundController(Object.assign({
            connectAmRoute: (r) => this.vehicle.connectAudioRoute(r),
            disconnectAmRoute: (cid) => this.vehicle.disconnectAudioRoute(cid),
            getTelemetry: () => this.vehicle.state,
            shouldMute: () => !!(this.vehicle.state.callActive || this.assistantState === 'listening'),
            onStateChange: () => this.writeStatusFile(),
            onLog: (m) => this.log(m),
        }, this.cfg.asdOpts || {}));
        this.asd.config = AsdSynth.normalizeAsdConfig(this.settings.asd);
        this.vehicle.state.asd = this.asd.getStatus();

        this.wakeMonitor = new AudioIO.WakeWordMonitor({
            outFile: path.join(this.cfg.run, 'vad_utt.wav'),
            swapChannels: this.settings.swapMicChannels,
            connectAmRoute: (r) => this.vehicle.connectAudioRoute(r),
            disconnectAmRoute: (cid) => this.vehicle.disconnectAudioRoute(cid),
            shouldPause: () => {
                if (!this.settings.handsFreeWake) return true;
                if (!(this.settings.apiKey && String(this.settings.apiKey).trim())) return true;
                if (this.vehicle.state.callActive) return true;
                if (this.turnBusy || this.assistantState !== 'idle') return true;
                // Keep armed at red lights (Auto Start-Stop) & when iDrive is awake; only pause on engine-off + low 12V (<11.85V)
                const t = this.vehicle.state;
                if (t.liveCar && !t.engineRunning && t.gear === 'P' && typeof t.battery12v === 'number' && t.battery12v > 5 && t.battery12v < 11.85 && Date.now() >= this.followUpUntil) {
                    return true;
                }
                return false;
            },
            onStatusChange: (st) => {
                this.wakeStatus = st;
                this.writeStatusFile();
            },
            onSpeechStart: (ev) => {
                if (!this.cfg.simMode && this.settings.apiKey) {
                    Up.warmup(this.uplinkOpts).catch(() => {});
                }
                if (typeof ev.db === 'number') {
                    this.micLevels = { leftDb: ev.db, rightDb: ev.db };
                    this.writeStatusFile();
                }
            },
            onUtterance: (utt) => {
                if (this.turnBusy || this.assistantState !== 'idle') return;
                const inFollowUp = Date.now() < this.followUpUntil;
                this.micLevels = { leftDb: utt.analysis.leftDb, rightDb: utt.analysis.rightDb };
                const zone = utt.analysis.speakerZone === 'passenger' ? 'passenger' : 'driver';
                this.handleVoiceOrTextTurn({
                    audioWavBase64: utt.wavBuffer.toString('base64'),
                    audioMimeType: 'audio/wav',
                    speakerZone: zone,
                    wakeMode: !inFollowUp,
                }).catch((e) => this.log('wake turn error: ' + e.message));
            },
            onLog: (m) => this.log(m),
        });
    }

    markCmdSeen(id) {
        if (!id) return true;
        if (this.seenCmdIds.indexOf(id) >= 0) return false;
        this.lastCmdId = id;
        this.seenCmdIds.push(id);
        if (this.seenCmdIds.length > 64) this.seenCmdIds.shift();
        return true;
    }

    log(msg) {
        const line = new Date().toISOString() + ' ' + msg;
        this.logs.push(line);
        if (this.logs.length > 180) this.logs.shift();
        if (!this.cfg.quiet) process.stdout.write('[bimmer-ai] ' + msg + '\n');
    }

    saveSettings(patch) {
        const merged = Object.assign({}, this.settings, patch || {});
        if (patch && patch.guards) merged.guards = Object.assign({}, this.settings.guards, patch.guards);
        if (patch && patch.asd) merged.asd = Object.assign({}, this.settings.asd, patch.asd);
        this.settings = normalizeSettings(merged);
        this.vehicle.setGuards(this.settings.guards);
        if (this.asd) {
            this.asd.configure(this.settings.asd);
            this.vehicle.state.asd = this.asd.getStatus();
        }
        if (this.wakeMonitor) {
            this.wakeMonitor.setSwapChannels(this.settings.swapMicChannels);
            this.wakeMonitor.tick().catch(() => {});
        }
        writeAtomic(this.settingsFile, JSON.stringify(this.settings, null, 2) + '\n', 0o600);
        this.writeStatusFile();
        return this.publicSettings();
    }

    async applyAsdCommand(rawArgs) {
        const a = (rawArgs && typeof rawArgs === 'object') ? rawArgs : {};
        const patch = {};
        if (a.enabled !== undefined) {
            patch.enabled = !!a.enabled;
        } else if (a.engine || a.revDemo) {
            patch.enabled = true;
        }
        if (a.engine) {
            const engKey = String(a.engine).trim().toLowerCase();
            if (AsdSynth.ENGINE_PROFILES[engKey]) patch.engine = engKey;
        }
        if (a.volumePercent !== undefined) patch.volumePercent = Number(a.volumePercent);
        if (a.modeFollow !== undefined) patch.modeFollow = !!a.modeFollow;
        if (a.burbles !== undefined) patch.burbles = !!a.burbles;

        if (Object.keys(patch).length > 0) {
            this.saveSettings({ asd: patch });
        }
        if (a.revDemo && this.asd) {
            this.asd.triggerRevDemo();
        }
        if (this.asd) {
            await this.asd.syncLifecycle();
        }
        const st = this.asd ? this.asd.getStatus() : AsdSynth.normalizeAsdConfig(this.settings.asd);
        this.vehicle.state.asd = st;
        this.writeStatusFile();

        let summaryVi = '';
        if (!st.enabled) {
            summaryVi = 'Đã tắt giả lập âm thanh ống xả B&W — xe quay về âm thanh êm nguyên bản.';
        } else if (a.revDemo) {
            summaryVi = 'Đang nẹt pô thử tiếng ' + st.engineName + ' qua dàn loa B&W (âm lượng ' + st.volumePercent + '%).';
        } else {
            const modeTxt = st.modeFollow
                ? ('ăn theo chế độ ' + st.effectiveModeLabel + ' · ' + st.modeGainPercent + '%')
                : 'mở gắt cố định';
            summaryVi = 'Đã bật giả lập âm thanh ống xả B&W: ' + st.engineName + ' (âm lượng ' + st.volumePercent + '%, ' + modeTxt + ').';
        }
        return { ok: true, asd: st, summaryVi };
    }

    publicSettings() {
        const s = Object.assign({}, this.settings);
        s.hasApiKey = !!s.apiKey;
        s.apiKeyMasked = s.apiKey ? (s.apiKey.slice(0, 6) + '••••' + s.apiKey.slice(-4)) : '';
        delete s.apiKey;
        return s;
    }

    portalUrl() {
        const ips = discoverLanAddresses(this.cfg);
        const ip = ips[this.ipIdx % ips.length] || '127.0.0.1';
        return {
            url: 'http://' + ip + ':' + this.cfg.port + '/?pin=' + this.pin,
            ips,
            ip,
        };
    }

    getPublicState() {
        const netInfo = this.portalUrl();
        const asdStatus = this.asd ? this.asd.getStatus() : null;
        this.vehicle.state.asd = asdStatus;
        const asdEngines = AsdSynth.ENGINE_ORDER.map((id) => {
            const p = AsdSynth.ENGINE_PROFILES[id];
            return { id: p.id, name: p.name, shortName: p.shortName, badge: p.badge };
        });
        return {
            at: Date.now(),
            version: VERSION,
            simMode: !!this.cfg.simMode,
            url: netInfo.url,
            ips: netInfo.ips,
            pin: this.pin,
            assistantState: this.assistantState,
            wakeStatus: this.wakeStatus,
            followUpActive: Date.now() < this.followUpUntil,
            activeSpeakerZone: this.activeSpeakerZone,
            micLevels: this.micLevels,
            settings: this.publicSettings(),
            asd: asdStatus,
            asdEngines,
            audioProbe: this.audioProbe,
            telemetry: this.vehicle.state,
            guards: this.vehicle.guards,
            deferredWatches: this.vehicle.deferredWatches,
            lastTurn: this.lastTurn,
            history: this.history.slice(-12),
            recentLogs: this.logs.slice(-25),
        };
    }

    writeStatusFile() {
        try {
            writeAtomic(path.join(this.cfg.run, 'status.json'), JSON.stringify(this.getPublicState()), 0o644);
        } catch (e) {}
    }

    onVehicleStateChanged() {
        const t = this.vehicle.state;
        const now = Date.now();

        // 1. Morning / Drive Startup Briefing when engine starts (`engineRunning` transitions true)
        if (this.settings.startupBriefing && t.engineRunning && !this.greetedDrive) {
            this.greetedDrive = true;
            const tailMetric = (!t.liveCar || t.tyresLive)
                ? (', 4 lốp đều ' + t.tyresBar.fl + ' bar')
                : (', nước mát ' + t.coolantTempC + '°C, xăng ' + t.fuelPercent + '%');
            const brief = 'Chào ' + this.settings.ownerName + '! Bình 12V đạt ' + t.battery12v + 'V, dầu máy ' + t.oilTempC +
                '°C' + tailMetric + '. Chúc thượng lộ bình an!';
            this.lastTurn = {
                at: now,
                engine: 'copilot',
                speakerZone: 'driver',
                transcript: '(Tự động chào khi nổ máy)',
                replyVi: brief,
                actions: [],
            };
        } else if (!t.engineRunning && t.speedKmh === 0) {
            this.greetedDrive = false;
        }

        // 2. VietMap Speed-Limit & Camera Proactive Co-Pilot
        if (this.settings.vietmapCoPilot && t.vietmap && t.vietmap.speedLimitKmh > 0) {
            const limit = t.vietmap.speedLimitKmh;
            if (t.speedKmh > limit + 5 && (now - this.lastOverspeedWarnAt > 25000)) {
                this.lastOverspeedWarnAt = now;
                const camTxt = t.vietmap.cameraAheadM > 0 ? (' — phía trước ' + t.vietmap.cameraAheadM + 'm có camera tốc độ!') : '!';
                const alertText = 'Chú ý! Đang chạy ' + Math.round(t.speedKmh) + ' km/h vượt giới hạn ' + limit + ' km/h' + camTxt;
                this.lastTurn = {
                    at: now,
                    engine: 'copilot',
                    speakerZone: 'driver',
                    transcript: '(Cảnh báo tốc độ VietMap)',
                    replyVi: alertText,
                    actions: [{ tool: 'vietmap_alert', ok: true, summaryVi: alertText }],
                };
            }
        }

        this.writeStatusFile();
    }

    onSteeringWheelPtt(ev) {
        if (this.settings.pttTrigger === 'disabled') return;
        if (this.settings.pttTrigger === 'double_press' && ev.kind !== 'double_press') return;
        if (this.settings.pttTrigger === 'long_press' && ev.kind !== 'long_press') return;
        this.log('steering wheel PTT triggered (' + ev.kind + ', held=' + ev.heldMs + 'ms) -> capturing ceiling mic');
        this.captureAndProcessCeilingMic().catch((e) => this.log('PTT error: ' + e.message));
    }

    async captureAndProcessCeilingMic() {
        if (this.assistantState === 'listening' || this.assistantState === 'thinking') {
            return { ok: false, error: 'Đang xử lý câu trước' };
        }
        if (this.vehicle.state.callActive) {
            const msg = 'Đang có cuộc gọi điện thoại / CarPlay — Bimmer AI tự nhường Mic zin.';
            this.lastTurn = { at: Date.now(), engine: 'guard', speakerZone: 'driver', transcript: '(Nút Mic vô-lăng)', replyVi: msg, actions: [] };
            this.writeStatusFile();
            return { ok: false, error: msg };
        }

        const dev = this.settings.micDevice || 'auto';
        if (!this.audioProbe.hasAlsaCapture && dev === 'auto') {
            const msg = 'Trên máy mô phỏng hãy dùng nút Mic trên trình duyệt hoặc chọn câu lệnh thử nhanh!';
            this.lastTurn = { at: Date.now(), engine: 'sim', speakerZone: 'driver', transcript: '(Nút Mic)', replyVi: msg, actions: [] };
            this.writeStatusFile();
            return { ok: false, error: msg };
        }

        const hasKey = !!(this.settings.apiKey && String(this.settings.apiKey).trim());
        const clipSec = hasKey ? this.settings.micDurationSec : 2;

        // Pre-warm Keep-Alive TLS sockets to Gemini & TTS in parallel while user speaks!
        if (hasKey && !this.cfg.simMode) {
            Up.warmup(this.uplinkOpts).catch(() => {});
        }

        // Release continuous VAD stream & mute B&W ASD speakers before opening one-shot PTT capture
        if (this.wakeMonitor) await this.wakeMonitor.killWorker();

        this.assistantState = 'listening';
        if (this.asd) await this.asd.syncLifecycle();
        this.writeStatusFile();
        this.vehicle.pulseIpaLight('listenDriver').catch(() => {});
        try {
            const cap = await AudioIO.captureCeilingMicClip({
                device: dev,
                durationSec: clipSec,
                outFile: path.join(this.cfg.run, 'capture.wav'),
                swapChannels: this.settings.swapMicChannels,
                connectAmRoute: (r) => this.vehicle.connectAudioRoute(r),
                disconnectAmRoute: (cid) => this.vehicle.disconnectAudioRoute(cid),
                isCallActive: () => !!this.vehicle.state.callActive,
                onLog: (m) => this.log(m),
            });
            this.micLevels = { leftDb: cap.analysis.leftDb, rightDb: cap.analysis.rightDb };
            this.activeSpeakerZone = cap.analysis.speakerZone === 'passenger' ? 'passenger' : 'driver';
            this.audioProbe = AudioIO.probeOemAudioStack();

            if (!hasKey) {
                await this.vehicle.pulseIpaLight('off');
                this.assistantState = 'idle';
                const msg = 'Mic trần xe bắt tiếng tốt (' + cap.deviceUsed.split(':').pop() + ': ' + cap.analysis.leftDb + ' dB)! ' +
                    'Chỉ cần dán Gemini API Key trong trang QR để giải mã giọng nói Mic trần tự do, hoặc bấm ô nhập chữ trên iPhone rồi ấn nút 🎙️ góc bàn phím để nói Offline ngay!';
                this.lastTurn = {
                    at: Date.now(),
                    engine: 'mic_ok_need_key',
                    speakerZone: this.activeSpeakerZone,
                    transcript: '(Đã thu thử Mic trần ' + clipSec + 's · ' + cap.analysis.leftDb + ' dB)',
                    replyVi: msg,
                    actions: [],
                };
                this.writeStatusFile();
                return { ok: true, turn: this.lastTurn };
            }

            const resTurn = await this.handleVoiceOrTextTurn({
                audioWavBase64: cap.wavBuffer.toString('base64'),
                audioMimeType: 'audio/wav',
                speakerZone: this.activeSpeakerZone,
            });
            return { ok: true, turn: resTurn };
        } catch (e) {
            await this.vehicle.pulseIpaLight('off');
            this.assistantState = 'idle';
            this.log('ceiling mic error: ' + e.message);
            this.lastTurn = {
                at: Date.now(),
                engine: 'audio_err',
                speakerZone: 'driver',
                transcript: '(Thu âm Mic trần)',
                replyVi: 'Không thu được Mic trần (' + e.message.slice(0, 120) + '). Kiểm tra cổng ALSA trong trang QR.',
                actions: [],
            };
            this.writeStatusFile();
            return { ok: false, error: e.message, turn: this.lastTurn };
        }
    }

    /** Execute a full AI voice/text turn, including stereo WAV speaker localization, SafetyGate, Audio Ducking & TTS. */
    async handleVoiceOrTextTurn(req) {
        const input = req || {};
        if (this.turnBusy && input.wakeMode) {
            return { at: Date.now(), engine: 'busy', ignored: true, wakeOnly: false, speakerZone: 'driver', transcript: '', replyVi: '', actions: [], ttsAudioBase64: '', telemetry: this.vehicle.state };
        }
        this.turnBusy = true;
        try {
            let speakerZone = input.speakerZone || 'driver';

            // If stereo WAV audio was uploaded, analyze Left vs Right ceiling mic RMS energy!
            if (input.audioWavBase64 && (!input.audioMimeType || input.audioMimeType === 'audio/wav')) {
                try {
                    const wavBuf = Buffer.from(input.audioWavBase64, 'base64');
                    const ana = AudioIO.analyzeStereoMicBuffer(wavBuf, { swapChannels: this.settings.swapMicChannels });
                    if (ana.channels === 2 && ana.confidence >= 0.5) {
                        speakerZone = ana.speakerZone;
                        this.micLevels = { leftDb: ana.leftDb, rightDb: ana.rightDb };
                    }
                } catch (e) {}
            }

            this.activeSpeakerZone = speakerZone;
            if (!input.wakeMode) {
                this.assistantState = 'thinking';
                this.writeStatusFile();
            }

            const prevVolBeforeTurn = this.unduckedVolume !== null ? this.unduckedVolume : this.vehicle.state.media.volumePercent;
            const wasPlayingBeforeTurn = this.vehicle.state.media.playing;

            const turn = await AiBrain.processAssistantTurn({
                text: input.text || '',
                audioWavBase64: input.audioWavBase64 || '',
                audioMimeType: input.audioMimeType || 'audio/wav',
                wakeMode: !!input.wakeMode,
                speakerZone,
                ownerName: this.settings.ownerName,
                apiKey: this.settings.apiKey,
                model: this.settings.model,
                vehicleController: this.vehicle,
                history: this.history,
                uplinkOpts: this.uplinkOpts,
            });

            // In Hands-Free `wakeMode`, silently drop background cabin conversation that lacked "Hey Bimmer"
            if (turn.ignored) {
                this.assistantState = 'idle';
                if (this.wakeMonitor) this.wakeMonitor.holdCooldown(450);
                this.writeStatusFile();
                return Object.assign({}, turn, { ttsAudioBase64: '', telemetry: this.vehicle.state });
            }

            const turnChangedVolume = (turn.actions || []).some((a) =>
                a && a.ok && (
                    (a.tool === 'control_media' && a.args && (a.args.volumePercent !== undefined || a.args.action === 'volume' || a.args.action === 'mute')) ||
                    a.tool === 'run_scene'
                )
            );

            this.lastTurn = turn;
            this.history.push({
                at: turn.at,
                zone: turn.speakerZone,
                user: turn.transcript,
                ai: turn.replyVi,
                engine: turn.engine,
                actions: turn.actions,
            });
            if (this.history.length > 25) this.history.shift();

            // Synthesize TTS MP3 with Safe Audio Ducking & Echo-Free Cooldown
            let ttsAudioBase64 = '';
            const estSpeakMs = Math.max(2200, Math.min(5600, 1100 + String(turn.replyVi || '').length * 52));
            if (this.settings.ttsEnabled && turn.replyVi) {
                this.assistantState = 'speaking';
                if (this.wakeMonitor) this.wakeMonitor.holdCooldown(estSpeakMs + 1500);
                this.writeStatusFile();

                const shouldDuck = !turnChangedVolume && wasPlayingBeforeTurn && prevVolBeforeTurn > this.settings.duckVolumePercent;
                if (shouldDuck) {
                    if (this.unduckTimer) {
                        clearTimeout(this.unduckTimer);
                        this.unduckTimer = null;
                    }
                    this.unduckedVolume = prevVolBeforeTurn;
                    await this.vehicle.callMethodIfAvailable('audioCmd', 'setVolume', {
                        sinkID: 1,
                        volume: this.settings.duckVolumePercent,
                    });
                }

                const mp3 = await AudioIO.synthesizeVietnameseMp3(turn.replyVi, this.uplinkOpts, Up);
                let playedOnCar = false;
                if (mp3) {
                    ttsAudioBase64 = mp3.toString('base64');
                    const ttsDir = path.join(this.cfg.run, 'tts');
                    const mp3Path = path.join(ttsDir, 'reply.mp3');
                    try {
                        fs.chmodSync(this.cfg.run, 0o755);
                        fs.chmodSync(ttsDir, 0o755);
                        fs.writeFileSync(mp3Path, mp3, { mode: 0o644 });
                        playedOnCar = await this.vehicle.playTtsOnCarSpeakers(mp3Path, speakerZone);
                    } catch (e) {}
                } else {
                    await this.vehicle.pulseIpaLight('off');
                }

                // Refresh echo-guard cooldown AFTER network synthesis completes so car speakers never self-trigger VAD!
                if (this.wakeMonitor) {
                    this.wakeMonitor.holdCooldown(playedOnCar ? estSpeakMs : 600);
                }

                if (shouldDuck) {
                    const restoreTarget = this.unduckedVolume;
                    this.unduckTimer = setTimeout(() => {
                        this.unduckTimer = null;
                        this.unduckedVolume = null;
                        if (restoreTarget !== null) {
                            this.vehicle.callMethodIfAvailable('audioCmd', 'setVolume', {
                                sinkID: 1,
                                volume: restoreTarget,
                            }).catch(() => {});
                        }
                    }, playedOnCar ? estSpeakMs : 900);
                } else if (turnChangedVolume && this.unduckTimer) {
                    clearTimeout(this.unduckTimer);
                    this.unduckTimer = null;
                    this.unduckedVolume = null;
                }
            } else {
                await this.vehicle.pulseIpaLight('off');
            }

            // Open full 10s follow-up window AFTER TTS prompt starts so network latency never steals user's speaking window!
            if (turn.wakeOnly) {
                const extraSpeakHold = (this.settings.ttsEnabled && turn.replyVi) ? Math.min(3200, estSpeakMs) : 0;
                this.followUpUntil = Date.now() + 10000 + extraSpeakHold;
            } else {
                this.followUpUntil = 0;
            }

            this.assistantState = 'idle';
            this.writeStatusFile();
            return Object.assign({}, turn, { ttsAudioBase64, telemetry: this.vehicle.state });
        } finally {
            this.turnBusy = false;
        }
    }

    /** Poll commands sent from the iDrive 7 HMI screen (both RAM /run and fallback oap data dir). */
    pollHmiAppCommand() {
        const candidates = [
            path.join(this.cfg.run, 'app', 'command.json'),
        ];
        if (this.installedApp && this.installedApp.root) {
            candidates.push(path.join(this.installedApp.root, 'data', 'command.json'));
        }
        for (let i = 0; i < candidates.length; i++) {
            const c = readJson(candidates[i]);
            if (!c || !c.cmd) continue;
            try { fs.unlinkSync(candidates[i]); } catch (e) {}
            if (!this.markCmdSeen(c.id)) continue;
            this.log('HMI app command: ' + c.cmd);
            this.executeHmiCommand(c.cmd, c.arg || {}).catch((e) => this.log('hmi cmd error: ' + e.message));
        }
    }

    async executeHmiCommand(cmd, arg) {
        if (cmd === 'ptt_trigger') {
            return this.captureAndProcessCeilingMic();
        }
        if (cmd === 'quick_prompt' && arg.text) {
            return this.handleVoiceOrTextTurn({ text: String(arg.text), speakerZone: arg.speakerZone || 'driver' });
        }
        if (cmd === 'run_scene' && arg.scene) {
            return this.handleVoiceOrTextTurn({ text: 'Bật chế độ ' + arg.scene, speakerZone: 'driver' });
        }
        if (cmd === 'health_check') {
            return this.handleVoiceOrTextTurn({ text: 'Khám xe kiểm tra tình trạng bình ắc quy, dầu máy và áp suất lốp', speakerZone: 'driver' });
        }
        if (cmd === 'toggle_hands_free') {
            this.saveSettings({ handsFreeWake: !this.settings.handsFreeWake });
            return { ok: true };
        }
        if (cmd === 'toggle_guard' && arg.domain) {
            const g = Object.assign({}, this.vehicle.guards);
            g[arg.domain] = !g[arg.domain];
            this.saveSettings({ guards: g });
            return { ok: true };
        }
        if (cmd === 'asd_toggle') {
            return this.applyAsdCommand({ enabled: !(this.asd && this.asd.config.enabled) });
        }
        if (cmd === 'asd_set') {
            return this.applyAsdCommand(arg || {});
        }
        if (cmd === 'asd_rev_demo') {
            return this.applyAsdCommand({ revDemo: true });
        }
        if (cmd === 'next_ip') {
            this.ipIdx++;
            this.writeStatusFile();
            return { ok: true };
        }
        return { ok: false };
    }

    checkAuth(req, parsedUrl) {
        if (this.cfg.simMode) return true;
        const qPin = parsedUrl.query && parsedUrl.query.pin;
        const hPin = req.headers['x-bimmer-pin'];
        return String(qPin || hPin || '') === this.pin;
    }

    readBodyJson(req) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            let size = 0;
            req.on('data', (c) => {
                size += c.length;
                if (size > 8e6) { req.destroy(); reject(new Error('payload too large')); return; }
                chunks.push(c);
            });
            req.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                if (!raw) return resolve({});
                try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('invalid JSON')); }
            });
            req.on('error', reject);
        });
    }

    async handleHttp(req, res) {
        const parsed = urlMod.parse(req.url || '/', true);
        const pathname = parsed.pathname || '/';
        const sendJson = (code, obj) => {
            const body = Buffer.from(JSON.stringify(obj), 'utf8');
            res.writeHead(code, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store',
                'Content-Length': body.length,
            });
            res.end(body);
        };

        if (pathname === '/' && req.method === 'GET') {
            if (!this.checkAuth(req, parsed)) {
                res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Sai mã PIN trên màn hình xe BMW (quét lại mã QR trên màn hình Bimmer AI).');
                return;
            }
            const htmlPath = path.join(__dirname, 'page.html');
            const html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : '<h1>Bimmer AI</h1>';
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(html);
            return;
        }

        if (!this.checkAuth(req, parsed)) {
            return sendJson(403, { ok: false, error: 'PIN không hợp lệ' });
        }

        if (pathname === '/api/state' && req.method === 'GET') {
            return sendJson(200, { ok: true, state: this.getPublicState() });
        }

        if (pathname === '/api/ask' && req.method === 'POST') {
            try {
                const body = await this.readBodyJson(req);
                const result = await this.handleVoiceOrTextTurn({
                    text: body.text || '',
                    audioWavBase64: body.audioWavBase64 || '',
                    audioMimeType: body.audioMimeType || 'audio/wav',
                    speakerZone: body.speakerZone || 'driver',
                    wakeMode: !!body.wakeMode,
                });
                return sendJson(200, { ok: true, turn: result, state: this.getPublicState() });
            } catch (e) {
                return sendJson(500, { ok: false, error: e.message });
            }
        }

        if (pathname === '/api/settings' && req.method === 'POST') {
            try {
                const body = await this.readBodyJson(req);
                const saved = this.saveSettings(body);
                return sendJson(200, { ok: true, settings: saved, state: this.getPublicState() });
            } catch (e) {
                return sendJson(400, { ok: false, error: e.message });
            }
        }

        if (pathname === '/api/sim/telemetry' && req.method === 'POST') {
            try {
                const body = await this.readBodyJson(req);
                this.vehicle.patchTelemetry(body);
                if (this.asd) await this.asd.syncLifecycle();
                this.writeStatusFile();
                return sendJson(200, { ok: true, state: this.getPublicState() });
            } catch (e) {
                return sendJson(400, { ok: false, error: e.message });
            }
        }

        if (pathname === '/api/asd' && req.method === 'POST') {
            try {
                const body = await this.readBodyJson(req);
                const result = await this.applyAsdCommand(body);
                return sendJson(200, { ok: true, result, state: this.getPublicState() });
            } catch (e) {
                return sendJson(400, { ok: false, error: e.message });
            }
        }

        if (pathname === '/api/audio/probe' && req.method === 'POST') {
            this.audioProbe = AudioIO.probeOemAudioStack();
            this.writeStatusFile();
            return sendJson(200, { ok: true, audioProbe: this.audioProbe });
        }

        if (pathname === '/api/audio/ptt' && req.method === 'POST') {
            const r = await this.captureAndProcessCeilingMic();
            return sendJson(200, Object.assign({}, r, { state: this.getPublicState() }));
        }

        return sendJson(404, { ok: false, error: 'Not found' });
    }

    startCtlSocket() {
        const sockPath = path.join(this.cfg.run, 'ctl.sock');
        try { fs.chmodSync(this.cfg.run, 0o755); } catch (e) {}
        try { if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath); } catch (e) {}
        return new Promise((resolve) => {
            const srv = net.createServer((client) => {
                let buf = '';
                client.setEncoding('utf8');
                client.on('data', (chunk) => {
                    buf += chunk;
                    let idx;
                    while ((idx = buf.indexOf('\n')) >= 0) {
                        const line = buf.slice(0, idx).trim();
                        buf = buf.slice(idx + 1);
                        if (!line) continue;
                        try {
                            const c = JSON.parse(line);
                            if (c && c.cmd) {
                                if (!this.markCmdSeen(c.id)) continue;
                                this.log('HMI ctl.sock command: ' + c.cmd);
                                this.executeHmiCommand(c.cmd, c.arg || {}).catch((e) => this.log('ctl.sock error: ' + e.message));
                            }
                        } catch (e) {}
                    }
                });
                client.on('error', () => {});
            });
            srv.on('error', (e) => {
                this.log('ctl.sock warning: ' + e.message);
                resolve(null);
            });
            srv.listen(sockPath, () => {
                try { fs.chmodSync(sockPath, 0o666); } catch (e) {}
                this.ctlServer = srv;
                resolve(srv);
            });
        });
    }

    async start() {
        this.installedApp = grantAppRamFolder(this.cfg.oap, this.cfg.run, this.cfg.proc);
        await this.startCtlSocket();
        await this.vehicle.initHardwareBus();
        if (!this.cfg.noNft && !this.cfg.simMode) {
            await fwOpen(this.cfg.nft, this.cfg.port);
        }
        this.server = http.createServer((req, res) => {
            this.handleHttp(req, res).catch((err) => {
                try {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: err.message }));
                } catch (e) {}
            });
        });

        await new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(this.cfg.port, this.cfg.host, resolve);
        });

        const actualAddr = this.server.address();
        if (actualAddr && actualAddr.port) this.cfg.port = actualAddr.port;

        let tickCount = 0;
        this.pollTimer = setInterval(() => {
            tickCount++;
            if (tickCount % 4 === 1) {
                this.installedApp = grantAppRamFolder(this.cfg.oap, this.cfg.run, this.cfg.proc);
                this.vehicle.pollCompanionApps();
            }
            this.pollHmiAppCommand();
            if (tickCount % 2 === 0) {
                this.writeStatusFile();
            }
        }, 250);

        this.writeStatusFile();
        if (this.settings.apiKey && !this.cfg.simMode) {
            Up.warmup(this.uplinkOpts).catch(() => {});
        }
        if (this.wakeMonitor) this.wakeMonitor.start();
        if (this.asd) this.asd.start();
        this.log('listening on ' + this.portalUrl().url);
        return this;
    }

    async stop() {
        if (this.pollTimer) clearInterval(this.pollTimer);
        if (this.unduckTimer) {
            clearTimeout(this.unduckTimer);
            this.unduckTimer = null;
        }
        if (this.asd) await this.asd.stop();
        if (this.wakeMonitor) await this.wakeMonitor.stop();
        Up.close(this.uplinkOpts);
        if (this.vehicle && typeof this.vehicle.closeRideTube === 'function') {
            this.vehicle.closeRideTube();
        }
        if (this.ctlServer) {
            await new Promise((resolve) => this.ctlServer.close(resolve));
            this.ctlServer = null;
            try { fs.unlinkSync(path.join(this.cfg.run, 'ctl.sock')); } catch (e) {}
        }
        if (this.server) {
            await new Promise((resolve) => this.server.close(resolve));
            this.server = null;
        }
        if (!this.cfg.noNft && !this.cfg.simMode) {
            await fwClose(this.cfg.nft);
        }
    }
}

if (require.main === module) {
    const sub = process.argv[2] || 'run';
    if (sub === 'fwclose') {
        const cfg = createDaemonConfig();
        fwClose(cfg.nft).then(() => process.exit(0), () => process.exit(0));
    } else {
        const daemon = new BimmerAiDaemon();
        daemon.start().catch((err) => {
            process.stderr.write('[bimmer-ai] fatal: ' + err.message + '\n');
            process.exit(1);
        });
        const cleanExit = () => daemon.stop().then(() => process.exit(0), () => process.exit(0));
        process.on('SIGTERM', cleanExit);
        process.on('SIGINT', cleanExit);
    }
}

module.exports = {
    VERSION,
    createDaemonConfig,
    defaultSettings,
    normalizeSettings,
    BimmerAiDaemon,
};
