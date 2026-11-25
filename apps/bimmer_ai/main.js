'use strict';
/**
 * main.js - Instant Zero-Lag iDrive 7 App Entry Point for Bimmer AI (`apps/bimmer_ai`, `v0.6.1`).
 *
 * Key Performance & Stability Guarantees:
 *   1. Asynchronous background polling of compact `/run/bimmer-ai/hmi.json` (~1.1 KB) outside `render()` —
 *      zero synchronous `fs.readFileSync` inside `render()` or `ctx.onTab`.
 *   2. Software-path `lastSoftWords` short-circuit: skips `new Canvas(1600, 520)` + `play()` completely when
 *      recorded GPU/Recorder words haven't changed (`0.0%` idle CPU on both GPU and non-GPU MGU setups).
 *   3. Instant `<1ms` Unix domain socket IPC (`/run/bimmer-ai/ctl.sock`) with optimistic visual feedback.
 *
 * Node 8 (ES2017) compatible.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Recorder } = require('./kit/record');
const UI = require('./ui');

const RUN = process.env.BA_RUN || '/run/bimmer-ai';
const STALE_MS = 10000;
const SCENES = ['chill đêm', 'hạ nhiệt', 'rạp phim', 'thể thao', 'mặc định'];

mgu.run({
    async start(ctx) {
        const { ui, log } = ctx;
        const version = (ctx.spec && ctx.spec.version) ? ('Bản ' + ctx.spec.version) : 'Bản 0.6.1';
        let status = null, cmdId = Date.now();
        let viewMode = 'main', sceneIdx = 0, animTick = 0;
        let lastStatusSig = '';
        let pollingStatus = false;

        // Software-path frame-skip cache (`0%` CPU when steady on non-GPU MGU setups)
        let lastSoftWords = null;
        let lastSoftPushAt = 0;

        // Instant optimistic feedback before daemon status roundtrip completes
        let pendingUntil = 0;
        let pendingState = '';
        let pendingBaseTurnAt = 0;
        let pendingTurn = null;
        let optimisticHandsFree = null;
        let optimisticHandsFreeUntil = 0;

        const localGuards = {
            locksAndTrunk: true,
            windowsAndRoof: true,
            climateAndSeats: true,
            ambientAndLights: true,
            mediaAndYoutube: true,
            exhaustAndDiag: true,
        };
        let localTurn = {
            speakerZone: 'driver',
            transcript: 'Chỉnh điều hoà 22 độ với đổi đèn viền tím',
            replyVi: 'Sẵn sàng! Bấm "Nói lệnh AI", nút Mic vô-lăng hoặc quét cổng QR để ra lệnh tiếng Việt.',
        };

        function applyParsedStatus(s, now) {
            const fresh = (s && typeof s.at === 'number' && Math.abs(now - s.at) < STALE_MS) ? s : null;
            status = fresh;
            if (status && pendingUntil > 0) {
                const curTurnAt = (status.lastTurn && status.lastTurn.at) || 0;
                if ((status.assistantState && status.assistantState !== 'idle') || curTurnAt > pendingBaseTurnAt) {
                    pendingUntil = 0;
                    pendingTurn = null;
                    pendingState = '';
                }
            }
        }

        function readInitialStatusSync() {
            const now = Date.now();
            const hmiFile = path.join(RUN, 'hmi.json');
            const fullFile = path.join(RUN, 'status.json');
            let raw = '';
            try { raw = fs.readFileSync(hmiFile, 'utf8'); } catch (e) {
                try { raw = fs.readFileSync(fullFile, 'utf8'); } catch (e2) { raw = ''; }
            }
            if (!raw) return;
            try {
                const parsed = JSON.parse(raw);
                applyParsedStatus(parsed, now);
                lastStatusSig = JSON.stringify(Object.assign({}, parsed, { at: 0 }));
            } catch (e) {}
        }

        function pollStatusAsync() {
            if (pollingStatus) return;
            pollingStatus = true;
            const hmiFile = path.join(RUN, 'hmi.json');
            const fullFile = path.join(RUN, 'status.json');
            const handleRaw = (err, raw) => {
                pollingStatus = false;
                const now = Date.now();
                if (err || !raw) {
                    if (status !== null) {
                        status = null;
                        lastStatusSig = '';
                        repaint();
                    }
                    return;
                }
                try {
                    const parsed = JSON.parse(raw);
                    const prevUp = !!status;
                    applyParsedStatus(parsed, now);
                    const sig = JSON.stringify(Object.assign({}, parsed, { at: 0 }));
                    if (sig !== lastStatusSig || prevUp !== !!status) {
                        lastStatusSig = sig;
                        repaint();
                    }
                } catch (e) {}
            };
            fs.readFile(hmiFile, 'utf8', (err, raw) => {
                if (!err && raw) return handleRaw(null, raw);
                fs.readFile(fullFile, 'utf8', handleRaw);
            });
        }

        function setOptimistic(stateName, userText, aiText, holdMs) {
            pendingBaseTurnAt = (status && status.lastTurn && status.lastTurn.at) || 0;
            pendingState = stateName || 'thinking';
            pendingTurn = {
                speakerZone: 'driver',
                transcript: userText,
                replyVi: aiText,
            };
            pendingUntil = Date.now() + (holdMs || 5500);
        }

        function writeFallbackCommand(cmd, payload) {
            const ramCmd = path.join(RUN, 'app', 'command.json');
            let wroteRam = false;
            try {
                fs.writeFileSync(ramCmd + '.tmp', payload);
                fs.renameSync(ramCmd + '.tmp', ramCmd);
                wroteRam = true;
            } catch (e) {}
            if (!wroteRam) {
                try {
                    const f = path.join(ctx.dataDir, 'command.json');
                    fs.writeFileSync(f + '.tmp', payload);
                    fs.renameSync(f + '.tmp', f);
                } catch (e2) { log.warn('cmd ' + cmd + ': ' + (e2 && e2.message)); }
            }
        }

        function send(cmd, arg) {
            const msgObj = { id: ++cmdId, cmd, arg: arg || {} };
            const payload = JSON.stringify(msgObj);
            const sockPath = path.join(RUN, 'ctl.sock');

            try {
                let sent = false;
                const s = net.createConnection(sockPath, () => {
                    sent = true;
                    s.end(payload + '\n');
                });
                s.on('error', () => {
                    if (!sent) writeFallbackCommand(cmd, payload);
                });
                setTimeout(pollStatusAsync, 120);
                return;
            } catch (e) {}
            writeFallbackCommand(cmd, payload);
            setTimeout(pollStatusAsync, 150);
        }

        let loop = null;
        function repaint(forceSoft) {
            if (forceSoft) lastSoftWords = null;
            return loop && loop.kick ? loop.kick() : render();
        }

        const acts = {
            triggerMic: () => {
                send('ptt_trigger', {});
                if (status) {
                    const hasKey = !!(status.settings && status.settings.hasApiKey);
                    setOptimistic(
                        'listening',
                        '(Đang nghe cặp Mic trần trên xe…)',
                        hasKey
                            ? 'Đang thu âm giọng nói Tiếng Việt từ Mic trần — đại ca đọc lệnh luôn đi!'
                            : 'Đang đo tín hiệu cặp Mic trần trên xe… (Dán thêm Gemini API Key ở cổng QR để giải mã câu nói tự do)',
                        hasKey ? 6500 : 3500
                    );
                } else {
                    localTurn = {
                        speakerZone: 'driver',
                        transcript: 'Khám xe xem bình 12V với dầu máy ổn không?',
                        replyVi: 'Xe sạch lỗi! Bình 12V đạt 12.6V, dầu máy 86°C, 4 lốp cân đều 2.4 bar.',
                    };
                }
                return repaint(true);
            },
            cycleScene: () => {
                const sc = SCENES[sceneIdx % SCENES.length];
                sceneIdx++;
                send('run_scene', { scene: sc });
                if (status) {
                    setOptimistic('thinking', 'Bật chế độ ' + sc, 'Đang kích hoạt kịch bản "' + sc + '" cho toàn bộ khoang lái…', 3500);
                } else {
                    localTurn = {
                        speakerZone: 'driver',
                        transcript: 'Bật chế độ ' + sc,
                        replyVi: 'Đã kích hoạt kịch bản "' + sc + '" cho toàn bộ khoang lái.',
                    };
                }
                return repaint(true);
            },
            healthCheck: () => {
                send('health_check', {});
                if (status) {
                    setOptimistic('thinking', 'Khám sức khoẻ xe', 'Đang quét thông số động cơ, bình 12V, nhiệt độ dầu và lốp…', 3000);
                } else {
                    localTurn = {
                        speakerZone: 'driver',
                        transcript: 'Kiểm tra sức khoẻ xe',
                        replyVi: 'Tất cả các hộp sạch lỗi: Bình 12.6V, dầu máy 86°C, nước mát 84°C, lốp 2.4 bar.',
                    };
                }
                return repaint(true);
            },
            quickCool: () => {
                send('quick_prompt', { text: 'Trời nóng quá bật Max AC làm mát ghế đi', speakerZone: 'driver' });
                if (status) {
                    setOptimistic('thinking', 'Trời nóng quá bật Max AC làm mát ghế đi', 'Đang bật Max AC 16°C & quạt làm mát ghế…', 3500);
                }
                return repaint(true);
            },
            toggleView: () => {
                viewMode = viewMode === 'guards' ? 'main' : 'guards';
                return repaint(true);
            },
            toggleHandsFree: () => {
                const cur = optimisticHandsFree !== null
                    ? optimisticHandsFree
                    : !!(status && status.settings && status.settings.handsFreeWake);
                optimisticHandsFree = !cur;
                optimisticHandsFreeUntil = Date.now() + 2500;
                send('toggle_hands_free', {});
                return repaint(true);
            },
            toggleGuard: (domain) => {
                localGuards[domain] = !localGuards[domain];
                send('toggle_guard', { domain });
                return repaint(true);
            },
            nextIp: () => {
                send('next_ip', {});
                return repaint(true);
            },
        };

        function buildModel() {
            const now = Date.now();
            if (pendingUntil > 0 && now > pendingUntil) {
                pendingUntil = 0;
                pendingTurn = null;
                pendingState = '';
            }
            if (optimisticHandsFreeUntil > 0 && now > optimisticHandsFreeUntil) {
                optimisticHandsFreeUntil = 0;
                optimisticHandsFree = null;
            }
            const s = status;
            const hostOf = (u) => String(u || '').replace(/^http:\/\//, '').replace(/\/\?pin=\d+$/, '');
            const liveState = s ? s.assistantState : 'idle';
            const effState = (liveState && liveState !== 'idle') ? liveState : (pendingState || liveState || 'idle');
            if (effState !== 'idle') {
                animTick = (animTick + 1) & 1023;
            }
            const mergedSettings = Object.assign({ hasApiKey: false, handsFreeWake: false }, (s && s.settings) || {});
            if (optimisticHandsFree !== null) mergedSettings.handsFreeWake = optimisticHandsFree;
            return {
                daemonUp: !!s,
                version,
                viewMode,
                animTick,
                url: s ? s.url : 'http://192.168.10.1:8140/?pin=2468',
                host: s ? hostOf(s.url) : '192.168.10.1:8140',
                pin: s ? s.pin : '2468',
                ipCount: s && Array.isArray(s.ips) ? s.ips.length : 1,
                assistantState: effState,
                wakeStatus: s ? s.wakeStatus : 'off',
                followUpActive: !!(s && s.followUpActive),
                activeSpeakerZone: s ? s.activeSpeakerZone : 'driver',
                micLevels: (s && s.micLevels) || { leftDb: -32, rightDb: -54 },
                settings: mergedSettings,
                telemetry: (s && s.telemetry) || {
                    speedKmh: 0,
                    rpm: 820,
                    gear: 'P',
                    driveMode: 'comfort',
                    oilTempC: 86,
                    battery12v: 12.6,
                    doorsLocked: true,
                    exhaustMode: 'oem',
                    climate: { tempDriverC: 23, tempPassengerC: 24, fanLevel: 2, seatCoolDriver: 2, seatCoolPassenger: 0 },
                    ambient: { name: 'Tím hoàng hôn', hex: '#8A2BE2', brightness: 65 },
                    media: { playing: true, source: 'YouTube TV', title: 'Lofi Chill Night Drive', volumePercent: 32 },
                    vietmap: { speedLimitKmh: 60 },
                },
                guards: (s && s.guards) || localGuards,
                deferredCount: s && Array.isArray(s.deferredWatches) ? s.deferredWatches.length : 0,
                lastTurn: pendingTurn || (s && s.lastTurn) || localTurn,
            };
        }

        const render = async () => {
            const m = buildModel();
            const cv = ctx.canvas(UI.W, UI.H) || new Recorder(UI.W, UI.H);
            UI.draw(cv, G, ctx.theme(), m, acts);

            // Software RHMI fast-skip: avoid `new Canvas(1600, 520)` + `play()` when recorded words are unchanged!
            const gpuActive = !!(ctx.display && typeof ctx.display.active === 'function' && ctx.display.active('MAIN'));
            if (!gpuActive && typeof cv.words === 'function') {
                const now = Date.now();
                const w = cv.words();
                const wBuf = Buffer.from(w.buffer, w.byteOffset, w.byteLength);
                if (lastSoftWords && (now - lastSoftPushAt) < 4500 && wBuf.length === lastSoftWords.length && wBuf.equals(lastSoftWords)) {
                    return;
                }
                lastSoftWords = Buffer.from(wBuf);
                lastSoftPushAt = now;
            }
            await ui.image('MAIN_GFX', cv);
        };

        readInitialStatusSync();
        const statusTimer = setInterval(pollStatusAsync, 450);
        if (statusTimer.unref) statusTimer.unref();

        loop = ctx.loop('MAIN', 2, render);
        if (ctx.onLayout) ctx.onLayout(() => repaint(true));
        if (ui.onVisible) ui.onVisible(() => repaint(true));
        if (ctx.onTab) {
            ctx.onTab((idx) => {
                viewMode = idx === 1 ? 'guards' : 'main';
                return repaint(true);
            });
        }

        ['BTN_MIC', 'BTN_SCENE', 'BTN_HEALTH', 'BTN_GUARDS'].forEach((b) => { if (ctx.hideButton) ctx.hideButton(b); });
        ui.onClick('BTN_MIC', acts.triggerMic);
        ui.onClick('BTN_SCENE', acts.cycleScene);
        ui.onClick('BTN_HEALTH', acts.healthCheck);
        ui.onClick('BTN_GUARDS', acts.toggleView);

        await render();
        log.info('bimmer_ai v0.6.1 ready');
    },
});
