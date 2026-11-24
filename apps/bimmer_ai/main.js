'use strict';
/**
 * main.js - iDrive 7 60fps App Entry Point for Bimmer AI (`apps/bimmer_ai`).
 *
 * Reads live state from `/run/bimmer-ai/status.json` (written in RAM by `bimmer-ai.service`)
 * and dispatches touch/iDrive knob commands to `/run/bimmer-ai/app/command.json` (zero flash wear).
 * Includes built-in standalone preview fallback so `preview.js` / `emu.js` renders cleanly even without daemon.
 *
 * Node 8 compatible.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Canvas } = require('./kit/canvas');
const UI = require('./ui');

const RUN = process.env.BA_RUN || '/run/bimmer-ai';
const STALE_MS = 8000;
const SCENES = ['chill đêm', 'hạ nhiệt', 'rạp phim', 'thể thao', 'mặc định'];

mgu.run({
    async start(ctx) {
        const { ui, log } = ctx;
        const version = (ctx.spec && ctx.spec.version) ? ('Bản ' + ctx.spec.version) : 'Bản 0.1.0';
        let status = null, readAt = 0, cmdId = Date.now();
        let viewMode = 'main', sceneIdx = 0, animTick = 0;

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
            replyVi: 'Đã bật kịch bản Chill đêm: đèn Tím hoàng hôn 45%, điều hoà 24°C và phát nhạc Lofi trên YouTube TV.',
        };

        function readStatus(now) {
            if (now - readAt < 350) return;
            readAt = now;
            let s = null;
            try { s = JSON.parse(fs.readFileSync(path.join(RUN, 'status.json'), 'utf8')); } catch (e) { s = null; }
            status = (s && typeof s.at === 'number' && Math.abs(now - s.at) < STALE_MS) ? s : null;
        }

        function send(cmd, arg) {
            const payload = JSON.stringify({ id: ++cmdId, cmd, arg: arg || {} });
            const ramCmd = path.join(RUN, 'app', 'command.json');
            try {
                fs.writeFileSync(ramCmd + '.tmp', payload);
                fs.renameSync(ramCmd + '.tmp', ramCmd);
            } catch (e) {
                try {
                    const f = path.join(ctx.dataDir, 'command.json');
                    fs.writeFileSync(f + '.tmp', payload);
                    fs.renameSync(f + '.tmp', f);
                } catch (e2) { log.warn('cmd ' + cmd + ': ' + (e2 && e2.message)); }
            }
            readAt = 0;
        }

        const acts = {
            triggerMic: () => {
                send('ptt_trigger', {});
                if (!status) {
                    localTurn = {
                        speakerZone: 'driver',
                        transcript: 'Khám xe xem bình 12V với dầu máy ổn không?',
                        replyVi: 'Xe sạch lỗi! Bình 12V đạt 12.6V, dầu máy 86°C, 4 lốp cân đều 2.4 bar.',
                    };
                }
            },
            cycleScene: () => {
                const sc = SCENES[sceneIdx % SCENES.length];
                sceneIdx++;
                send('run_scene', { scene: sc });
                if (!status) {
                    localTurn = {
                        speakerZone: 'driver',
                        transcript: 'Bật chế độ ' + sc,
                        replyVi: 'Đã kích hoạt kịch bản "' + sc + '" cho toàn bộ khoang lái.',
                    };
                }
            },
            healthCheck: () => {
                send('health_check', {});
                if (!status) {
                    localTurn = {
                        speakerZone: 'driver',
                        transcript: 'Kiểm tra sức khoẻ xe',
                        replyVi: 'Tất cả các hộp sạch lỗi: Bình 12.6V, dầu máy 86°C, nước mát 84°C, lốp 2.4 bar.',
                    };
                }
            },
            quickCool: () => {
                send('quick_prompt', { text: 'Trời nóng quá bật Max AC làm mát ghế đi', speakerZone: 'driver' });
            },
            toggleView: () => {
                viewMode = viewMode === 'guards' ? 'main' : 'guards';
            },
            toggleGuard: (domain) => {
                localGuards[domain] = !localGuards[domain];
                send('toggle_guard', { domain });
            },
            nextIp: () => {
                send('next_ip', {});
            },
        };

        function buildModel() {
            const now = Date.now();
            readStatus(now);
            animTick++;
            const s = status;
            const hostOf = (u) => String(u || '').replace(/^http:\/\//, '').replace(/\/\?pin=\d+$/, '');
            return {
                daemonUp: !!s,
                version,
                viewMode,
                animTick,
                url: s ? s.url : 'http://192.168.10.1:8140/?pin=2468',
                host: s ? hostOf(s.url) : '192.168.10.1:8140',
                pin: s ? s.pin : '2468',
                ipCount: s && Array.isArray(s.ips) ? s.ips.length : 1,
                assistantState: s ? s.assistantState : 'idle',
                activeSpeakerZone: s ? s.activeSpeakerZone : 'driver',
                micLevels: (s && s.micLevels) || { leftDb: -32, rightDb: -54 },
                settings: (s && s.settings) || { hasApiKey: false },
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
                lastTurn: (s && s.lastTurn) || localTurn,
            };
        }

        const render = async () => {
            const m = buildModel();
            const cv = ctx.canvas(UI.W, UI.H) || new Canvas(UI.W, UI.H);
            UI.draw(cv, G, ctx.theme(), m, acts);
            await ui.image('MAIN_GFX', cv);
        };

        ctx.loop('MAIN', 12, render);

        ['BTN_MIC', 'BTN_SCENE', 'BTN_HEALTH', 'BTN_GUARDS'].forEach((b) => { if (ctx.hideButton) ctx.hideButton(b); });
        ui.onClick('BTN_MIC', acts.triggerMic);
        ui.onClick('BTN_SCENE', acts.cycleScene);
        ui.onClick('BTN_HEALTH', acts.healthCheck);
        ui.onClick('BTN_GUARDS', acts.toggleView);

        await render();
        log.info('bimmer_ai ready');
    },
});
