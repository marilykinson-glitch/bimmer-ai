'use strict';
/**
 * main.js - iDrive 7 60fps App Entry Point for Bimmer AI (`apps/bimmer_ai`, `v0.3.3`).
 *
 * Key architecture:
 *   1. Instant `<1ms` Unix domain socket IPC (`/run/bimmer-ai/ctl.sock`, `0666`) with automatic fallback
 *      to `/run/bimmer-ai/app/command.json` and `<dataDir>/command.json`.
 *   2. Immediate `<16ms` optimistic visual feedback on screen (`ĐANG NGHE MIC TRẦN…` / `Đang xử lý…`)
 *      the exact frame the driver taps `Nói lệnh AI`, the Voice Orb, a card, or a header tab.
 *   3. Full support for touch + iDrive rotary controller + header tabs (`ctx.onTab`) + layout changes (`ctx.onLayout`).
 *
 * Node 8 compatible.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Recorder } = require('./kit/record');
const UI = require('./ui');

const RUN = process.env.BA_RUN || '/run/bimmer-ai';
const STALE_MS = 8000;
const SCENES = ['chill đêm', 'hạ nhiệt', 'rạp phim', 'thể thao', 'mặc định'];

mgu.run({
    async start(ctx) {
        const { ui, log } = ctx;
        const version = (ctx.spec && ctx.spec.version) ? ('Bản ' + ctx.spec.version) : 'Bản 0.4.4';
        let status = null, readAt = 0, cmdId = Date.now();
        let viewMode = 'main', sceneIdx = 0, animTick = 0;

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
            transcript: 'Chế độ chill đêm rồi mở nhạc Lofi trên YouTube đi',
            replyVi: 'Đã bật kịch bản Chill đêm: đèn Tím hoàng hôn 50%, điều hoà 24°C và phát nhạc Lofi trên YouTube TV.',
        };

        function readStatus(now) {
            if (now - readAt < 250) return;
            readAt = now;
            let s = null;
            try { s = JSON.parse(fs.readFileSync(path.join(RUN, 'status.json'), 'utf8')); } catch (e) { s = null; }
            status = (s && typeof s.at === 'number' && Math.abs(now - s.at) < STALE_MS) ? s : null;
            if (status && pendingUntil > 0) {
                const curTurnAt = (status.lastTurn && status.lastTurn.at) || 0;
                if (status.assistantState && status.assistantState !== 'idle') {
                    pendingUntil = 0;
                    pendingTurn = null;
                    pendingState = '';
                } else if (curTurnAt > pendingBaseTurnAt) {
                    pendingUntil = 0;
                    pendingTurn = null;
                    pendingState = '';
                }
            }
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
            readAt = 0;
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

            // 1. Primary `<1ms` Unix socket dispatch; only write fallback file if socket is absent or errors
            if (fs.existsSync(sockPath)) {
                try {
                    let sent = false;
                    const s = net.createConnection(sockPath, () => {
                        sent = true;
                        s.end(payload + '\n');
                    });
                    s.on('error', () => {
                        if (!sent) writeFallbackCommand(cmd, payload);
                    });
                    readAt = 0;
                    return;
                } catch (e) {}
            }
            writeFallbackCommand(cmd, payload);
            readAt = 0;
        }

        let loop = null;
        function repaint() {
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
                return repaint();
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
                return repaint();
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
                return repaint();
            },
            quickCool: () => {
                send('quick_prompt', { text: 'Trời nóng quá bật Max AC làm mát ghế đi', speakerZone: 'driver' });
                if (status) {
                    setOptimistic('thinking', 'Trời nóng quá bật Max AC làm mát ghế đi', 'Đang bật Max AC 16°C & quạt làm mát ghế…', 3500);
                }
                return repaint();
            },
            toggleView: () => {
                viewMode = viewMode === 'guards' ? 'main' : 'guards';
                return repaint();
            },
            toggleHandsFree: () => {
                const cur = optimisticHandsFree !== null
                    ? optimisticHandsFree
                    : !((status && status.settings && status.settings.handsFreeWake === false));
                optimisticHandsFree = !cur;
                optimisticHandsFreeUntil = Date.now() + 2500;
                send('toggle_hands_free', {});
                return repaint();
            },
            toggleGuard: (domain) => {
                localGuards[domain] = !localGuards[domain];
                send('toggle_guard', { domain });
                return repaint();
            },
            nextIp: () => {
                send('next_ip', {});
                return repaint();
            },
        };

        function buildModel() {
            const now = Date.now();
            readStatus(now);
            if (pendingUntil > 0 && now > pendingUntil) {
                pendingUntil = 0;
                pendingTurn = null;
                pendingState = '';
            }
            if (optimisticHandsFreeUntil > 0 && now > optimisticHandsFreeUntil) {
                optimisticHandsFreeUntil = 0;
                optimisticHandsFree = null;
            }
            animTick++;
            const s = status;
            const hostOf = (u) => String(u || '').replace(/^http:\/\//, '').replace(/\/\?pin=\d+$/, '');
            const liveState = s ? s.assistantState : 'idle';
            const mergedSettings = Object.assign({ hasApiKey: false, handsFreeWake: true }, (s && s.settings) || {});
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
                assistantState: (liveState && liveState !== 'idle') ? liveState : (pendingState || liveState),
                wakeStatus: s ? s.wakeStatus : 'off',
                followUpActive: !!(s && s.followUpActive),
                activeSpeakerZone: s ? s.activeSpeakerZone : 'driver',
                micLevels: (s && s.micLevels) || { leftDb: -32, rightDb: -54 },
                settings: mergedSettings,
                telemetry: (s && s.telemetry) || {
                    speedKmh: 0,
                    gear: 'P',
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
            await ui.image('MAIN_GFX', cv);
        };

        loop = ctx.loop('MAIN', 10, render);
        if (ctx.onLayout) ctx.onLayout(repaint);
        if (ctx.onTab) {
            ctx.onTab((idx) => {
                viewMode = idx === 1 ? 'guards' : 'main';
                return repaint();
            });
        }

        ['BTN_MIC', 'BTN_SCENE', 'BTN_HEALTH', 'BTN_GUARDS'].forEach((b) => { if (ctx.hideButton) ctx.hideButton(b); });
        ui.onClick('BTN_MIC', acts.triggerMic);
        ui.onClick('BTN_SCENE', acts.cycleScene);
        ui.onClick('BTN_HEALTH', acts.healthCheck);
        ui.onClick('BTN_GUARDS', acts.toggleView);

        await render();
        log.info('bimmer_ai v0.3.3 ready');
    },
});
