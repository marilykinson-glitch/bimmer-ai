'use strict';
/**
 * bimmer_ai_test.js - Automated Unit & End-to-End Integration Test Suite for Bimmer AI.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const SafetyGate = require('../tools/bimmer-ai/safety-gate');
const VehicleBus = require('../tools/bimmer-ai/vehicle-bus');
const AudioIO = require('../tools/bimmer-ai/audio-io');
const AiBrain = require('../tools/bimmer-ai/ai-brain');
const { BimmerAiDaemon } = require('../tools/bimmer-ai/bimmer-ai');

async function runAllTests() {
    let passed = 0;
    const step = (name, fn) => Promise.resolve().then(fn).then(() => {
        passed++;
        console.log('  [PASS] ' + name);
    });

    console.log('Running Bimmer AI test suite...');

    // 1. SafetyGate hard interlocks while moving vs parked
    await step('SafetyGate blocks door unlock, trunk open, mirror fold & cinema mode while driving', () => {
        const driving = { speedKmh: 62, gear: 'D', oilTempC: 90, battery12v: 13.8 };
        const guards = SafetyGate.defaultGuards();

        const rTrunk = SafetyGate.evaluateToolCall('control_locks_trunk', { action: 'open_trunk' }, driving, guards);
        assert.strictEqual(rTrunk.decision, 'block');
        assert.strictEqual(rTrunk.code, 'MOVING_LOCKOUT');

        const rUnlock = SafetyGate.evaluateToolCall('control_locks_trunk', { action: 'unlock' }, driving, guards);
        assert.strictEqual(rUnlock.decision, 'block');

        // Locking doors while driving is always safe and allowed
        const rLock = SafetyGate.evaluateToolCall('control_locks_trunk', { action: 'lock' }, driving, guards);
        assert.strictEqual(rLock.decision, 'allow');

        const rMirror = SafetyGate.evaluateToolCall('control_mirrors', { action: 'fold' }, driving, guards);
        assert.strictEqual(rMirror.decision, 'block');

        const rCinema = SafetyGate.evaluateToolCall('run_scene', { scene: 'cinema_park' }, driving, guards);
        assert.strictEqual(rCinema.decision, 'block');

        // Parked in P -> trunk & cinema allowed
        const parked = { speedKmh: 0, gear: 'P', oilTempC: 85, battery12v: 12.5 };
        assert.strictEqual(SafetyGate.evaluateToolCall('control_locks_trunk', { action: 'open_trunk' }, parked, guards).decision, 'allow');
        assert.strictEqual(SafetyGate.evaluateToolCall('run_scene', { scene: 'cinema_park' }, parked, guards).decision, 'allow');
    });

    // 2. Cold-oil deferred exhaust flap trigger & Cinema auto-exit on shifting to D
    await step('VehicleController defers exhaust flap on cold oil (52C) and auto-opens at 78C', async () => {
        const vc = new VehicleBus.VehicleController();
        vc.patchTelemetry({ rpm: 1100, oilTempC: 52, speedKmh: 30, gear: 'D' });

        const res = await vc.invokeTool('set_exhaust_flap', { mode: 'open' }, 'driver');
        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.deferred, true);
        assert.strictEqual(vc.state.exhaustMode, 'oem');
        assert.strictEqual(vc.deferredWatches.length, 1);

        // Warm oil up to 78C -> reactive watch automatically opens exhaust flap!
        vc.patchTelemetry({ oilTempC: 78 });
        await new Promise((r) => setTimeout(r, 30));
        assert.strictEqual(vc.state.exhaustMode, 'open');
        assert.strictEqual(vc.deferredWatches.length, 0);
    });

    await step('Cinema mode automatically exits when driver shifts from P to D', async () => {
        const vc = new VehicleBus.VehicleController();
        vc.patchTelemetry({ speedKmh: 0, gear: 'P', battery12v: 12.6 });
        await vc.invokeTool('run_scene', { scene: 'cinema_park' }, 'driver');
        assert.strictEqual(vc.state.activeScene, 'cinema_park');
        assert.strictEqual(vc.state.climate.massageDriver, true);

        vc.patchTelemetry({ gear: 'D', speedKmh: 5 });
        assert.strictEqual(vc.state.activeScene, 'none');
    });

    // 3. 2-Zone Stereo Ceiling Mic Localization
    await step('AudioIO.analyzeStereoMicBuffer distinguishes Driver (Left) vs Passenger (Right) voice', () => {
        const len = 8000;
        const leftLoud = [], rightQuiet = [];
        for (let i = 0; i < len; i++) {
            leftLoud.push(Math.sin(i * 0.25) * 0.55);
            rightQuiet.push(Math.sin(i * 0.25) * 0.08);
        }
        const wavDriver = AudioIO.buildStereoWav(leftLoud, rightQuiet, 16000);
        const aDriver = AudioIO.analyzeStereoMicBuffer(wavDriver);
        assert.strictEqual(aDriver.speakerZone, 'driver');
        assert.ok(aDriver.leftDb > aDriver.rightDb + 10);

        const wavPassenger = AudioIO.buildStereoWav(rightQuiet, leftLoud, 16000);
        const aPass = AudioIO.analyzeStereoMicBuffer(wavPassenger);
        assert.strictEqual(aPass.speakerZone, 'passenger');

        // Channel swap option flips driver/passenger
        const aSwapped = AudioIO.analyzeStereoMicBuffer(wavPassenger, { swapChannels: true });
        assert.strictEqual(aSwapped.speakerZone, 'driver');
    });

    // 4. Offline Multi-Intent Vietnamese NLU + 2-Zone Routing
    await step('Offline Vietnamese NLU handles multi-intent sentences and 2-Zone passenger routing', async () => {
        const vc = new VehicleBus.VehicleController();
        vc.patchTelemetry({ speedKmh: 0, gear: 'P' });

        // Passenger says "Lạnh quá tăng nhiệt độ với bật sưởi ghế cho em" -> only Passenger climate & seat changes!
        const pTurn = await AiBrain.processAssistantTurn({
            text: 'Lạnh quá tăng nhiệt độ với bật sưởi ghế cho em',
            speakerZone: 'passenger',
            vehicleController: vc,
        });
        assert.strictEqual(pTurn.engine, 'offline');
        assert.strictEqual(vc.state.climate.tempDriverC, 23.0);
        assert.strictEqual(vc.state.climate.tempPassengerC, 24.5);
        assert.strictEqual(vc.state.climate.seatHeatPassenger, 2);
        assert.strictEqual(vc.state.climate.seatHeatDriver, 0);

        // Compound command: Max AC + Purple Ambient + YouTube Lofi
        const cTurn = await AiBrain.processAssistantTurn({
            text: 'Trời nóng quá bật Max AC đổi đèn màu tím rồi mở nhạc Lofi trên YouTube',
            speakerZone: 'driver',
            vehicleController: vc,
        });
        assert.ok(cTurn.actions.length >= 3);
        assert.strictEqual(vc.state.climate.maxAc, true);
        assert.strictEqual(vc.state.ambient.preset, 'sunset_purple');
        assert.strictEqual(vc.state.media.source, 'YouTube TV');
        assert.strictEqual(vc.state.media.playing, true);
    });

    // 5. Full Daemon E2E + Mock Gemini Multimodal Server + Safety Override
    await step('BimmerAiDaemon E2E: HTTP API, Stereo WAV Gemini Multimodal, and SafetyGate override', async () => {
        // Spin up local mock Gemini API server
        const mockGemini = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                const reqJson = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                const lastMsg = reqJson.contents[reqJson.contents.length - 1];
                const hasAudio = lastMsg.parts.some((p) => p.inlineData && p.inlineData.mimeType === 'audio/wav');
                const replyPayload = {
                    candidates: [{
                        content: {
                            parts: [
                                {
                                    functionCall: {
                                        name: 'control_locks_trunk',
                                        args: { action: 'open_trunk' },
                                    },
                                },
                                {
                                    functionCall: {
                                        name: 'set_ambient_light',
                                        args: { color: 'emerald', brightness: 80 },
                                    },
                                },
                                {
                                    text: (hasAudio ? '[TRANSCRIPT: Mở cốp với đổi đèn xanh lá] ' : '') + 'Ok em mở cốp và đổi đèn xanh lá liền!',
                                },
                            ],
                        },
                    }],
                };
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(replyPayload));
            });
        });

        await new Promise((r) => mockGemini.listen(0, '127.0.0.1', r));
        const gemPort = mockGemini.address().port;

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimmer-ai-e2e-'));
        const daemon = new BimmerAiDaemon({
            run: path.join(tmpDir, 'run'),
            state: path.join(tmpDir, 'state'),
            oap: path.join(tmpDir, 'oap'),
            host: '127.0.0.1',
            port: 0,
            simMode: true,
            noNft: true,
            quiet: true,
            geminiBaseUrl: 'http://127.0.0.1:' + gemPort,
        });

        await daemon.start();
        daemon.saveSettings({ apiKey: 'TEST_GEMINI_KEY', ttsEnabled: false });

        // Put car in Drive at 70 km/h
        daemon.vehicle.patchTelemetry({ gear: 'D', speedKmh: 70 });

        // Upload a Passenger-loud stereo WAV clip -> Gemini tries to open trunk + set emerald light
        const lQuiet = new Array(3200).fill(0.03);
        const rLoud = new Array(3200).fill(0.5);
        const wavPass = AudioIO.buildStereoWav(lQuiet, rLoud, 16000);

        const askRes = await new Promise((resolve, reject) => {
            const payload = Buffer.from(JSON.stringify({
                audioWavBase64: wavPass.toString('base64'),
                audioMimeType: 'audio/wav',
            }), 'utf8');
            const rq = http.request({
                host: '127.0.0.1',
                port: daemon.cfg.port,
                path: '/api/ask?pin=' + daemon.pin,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
            }, (rs) => {
                const b = [];
                rs.on('data', (c) => b.push(c));
                rs.on('end', () => resolve(JSON.parse(Buffer.concat(b).toString('utf8'))));
            });
            rq.on('error', reject);
            rq.write(payload);
            rq.end();
        });

        assert.strictEqual(askRes.ok, true);
        assert.strictEqual(askRes.turn.engine, 'gemini');
        assert.strictEqual(askRes.turn.speakerZone, 'passenger');
        // Trunk MUST remain closed because SafetyGate intercepted Gemini's unsafe tool call at 70 km/h!
        assert.strictEqual(askRes.state.telemetry.trunkOpen, false);
        // Safe ambient light change MUST still succeed!
        assert.strictEqual(askRes.state.telemetry.ambient.preset, 'emerald');
        // Final spoken reply MUST surface the SafetyGate block reason instead of Gemini's optimistic "Ok mở cốp liền"!
        assert.ok(askRes.turn.replyVi.indexOf('Chốt an toàn chặn') >= 0);

        await daemon.stop();
        await new Promise((r) => mockGemini.close(r));
    });

    await step('SP18 Franca Schema Coercer (`coerceByDataRef`) & Seat Memory NLU', async () => {
        const mockDatatypes = {
            'de.bmw.ClimateTypes.OperationOnDR': {
                type: 'enum',
                defaultValue: 3,
                items: { AUS: 0, EIN: 1, KEINE_AUSWAHL: 2, SIGNAL_UNBEFUELLT: 3 },
            },
            'de.bmw.ClimateTypes.OperationManualBlowerLevel': {
                type: 'enum',
                defaultValue: 15,
                items: { STUFE_1: 1, STUFE_2: 2, STUFE_3: 3, SIGNAL_UNBEFUELLT: 15 },
            },
            'de.bmw.ClimateTypes.OperationAirConditioningFrontWrapper': {
                type: 'struct',
                members: [
                    { name: 'operationOnDR', dataRef: 'de.bmw.ClimateTypes.OperationOnDR', defaultValue: 3 },
                    { name: 'operationTemperatureTargetDR', dataRef: 'UInt8', defaultValue: 255 },
                    { name: 'operationManualBlowerLevelDR', dataRef: 'de.bmw.ClimateTypes.OperationManualBlowerLevel', defaultValue: 15 },
                ],
            },
        };
        const coerced = VehicleBus.coerceByDataRef(
            mockDatatypes,
            'de.bmw.ClimateTypes.OperationAirConditioningFrontWrapper',
            { operationTemperatureTargetDR: 44, operationManualBlowerLevelDR: 3 }
        );
        assert.strictEqual(coerced.operationOnDR, 'SIGNAL_UNBEFUELLT');
        assert.strictEqual(coerced.operationTemperatureTargetDR, 44);
        assert.strictEqual(coerced.operationManualBlowerLevelDR, 'STUFE_3');

        const vc = new VehicleBus.VehicleController();
        const memTurn = await AiBrain.processAssistantTurn({
            text: 'Gọi nhớ ghế số 2 đi',
            speakerZone: 'driver',
            vehicleController: vc,
        });
        assert.strictEqual(memTurn.actions.length, 1);
        assert.strictEqual(memTurn.actions[0].tool, 'set_seat_comfort');
        assert.ok(memTurn.replyVi.indexOf('nhớ ghế số 2') >= 0);
    });

    await step('Steering PTT German Enums, OAP HMI IPC Discovery & Gemini 2.5 thinkingBudget=0', async () => {
        // 1. Verify SteeringWheelPushButton German enum strings ('TASTER_BETAETIGT' -> 'TASTER_NICHT_BETAETIGT')
        const events = [];
        const vc = new VehicleBus.VehicleController({
            onPttEvent: (ev) => events.push(ev),
        });
        vc.handleSteeringPttSignal('statusPTTButton1', true, 'TASTER_BETAETIGT');
        await new Promise((r) => setTimeout(r, 60));
        vc.handleSteeringPttSignal('statusPTTButton1', false, 'TASTER_NICHT_BETAETIGT');
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].kind, 'short_press');

        // 2. Verify OAP app discovery & fallback `oap_12209/data/command.json` polling
        const tmpOap = fs.mkdtempSync(path.join(os.tmpdir(), 'bimmer-ai-oap-'));
        const appRoot = path.join(tmpOap, 'oap', 'oap_12209');
        const specDir = path.join(appRoot, 'source', 'javascript', 'kit');
        const dataDir = path.join(appRoot, 'data');
        fs.mkdirSync(path.join(tmpOap, 'oap'), 0o755);
        fs.mkdirSync(appRoot, 0o755);
        fs.mkdirSync(path.join(appRoot, 'source'), 0o755);
        fs.mkdirSync(path.join(appRoot, 'source', 'javascript'), 0o755);
        fs.mkdirSync(specDir, 0o755);
        fs.mkdirSync(dataDir, 0o755);
        fs.writeFileSync(path.join(specDir, 'app-spec.json'), JSON.stringify({ id: 'bimmer_ai' }));

        let capturedReqBody = null;
        const mockGem25 = http.createServer((req, res) => {
            const c = [];
            req.on('data', (d) => c.push(d));
            req.on('end', () => {
                capturedReqBody = JSON.parse(Buffer.concat(c).toString('utf8'));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    candidates: [{
                        content: {
                            parts: [
                                { thought: true, text: 'INTERNAL_THOUGHT_MUST_BE_FILTERED' },
                                { text: '[TRANSCRIPT: Chỉnh điều hoà 21 độ] Đã hạ điều hoà xuống 21 độ mát rượi!' },
                            ],
                        },
                    }],
                }));
            });
        });
        await new Promise((r) => mockGem25.listen(0, '127.0.0.1', r));

        const dm = new BimmerAiDaemon({
            run: path.join(tmpOap, 'run'),
            state: path.join(tmpOap, 'state'),
            oap: path.join(tmpOap, 'oap'),
            host: '127.0.0.1',
            port: 0,
            simMode: true,
            noNft: true,
            quiet: true,
            geminiBaseUrl: 'http://127.0.0.1:' + mockGem25.address().port,
        });
        await dm.start();
        dm.saveSettings({ apiKey: 'TEST_KEY_25', model: 'gemini-2.5-flash', ttsEnabled: false });
        assert.ok(dm.installedApp && dm.installedApp.id === 'bimmer_ai');

        // Simulate HMI screen writing to fallback `oap_12209/data/command.json`
        fs.writeFileSync(path.join(dataDir, 'command.json'), JSON.stringify({
            id: 999,
            cmd: 'quick_prompt',
            arg: { text: 'Chỉnh điều hoà 21 độ', speakerZone: 'driver' },
        }));
        dm.pollHmiAppCommand();
        await new Promise((r) => setTimeout(r, 250));

        assert.strictEqual(dm.settings.model, 'gemini-3.5-flash-lite'); // auto-migrated from retired 2.5-flash!
        assert.ok(capturedReqBody && capturedReqBody.generationConfig);
        assert.strictEqual(capturedReqBody.generationConfig.thinkingConfig, undefined); // no invalid thinkingBudget on 3.x!
        assert.ok(dm.lastTurn.replyVi.indexOf('INTERNAL_THOUGHT') < 0);
        // Offline NLU backup executed `set_climate` even though Gemini only emitted `[TRANSCRIPT: ...]` text!
        assert.strictEqual(dm.vehicle.state.climate.tempDriverC, 21);

        // 3. Verify instant `<1ms` `/run/bimmer-ai/ctl.sock` Unix domain socket IPC from HMI screen
        const sockPath = path.join(tmpOap, 'run', 'ctl.sock');
        assert.ok(fs.existsSync(sockPath));
        await new Promise((resolve, reject) => {
            const c = require('net').createConnection(sockPath, () => {
                c.end(JSON.stringify({
                    id: 1000,
                    cmd: 'quick_prompt',
                    arg: { text: 'Đổi đèn viền sang màu tím độ sáng 80%', speakerZone: 'driver' },
                }) + '\n');
                resolve();
            });
            c.on('error', reject);
        });
        await new Promise((r) => setTimeout(r, 250));
        assert.strictEqual(dm.vehicle.state.ambient.preset, 'sunset_purple');
        assert.strictEqual(dm.vehicle.state.ambient.brightness, 80);

        await dm.stop();
        await new Promise((r) => mockGem25.close(r));
    });

    await step('Hands-Free "Hey Bimmer" Wake Word, Chatter Filter, 2-Step Follow-Up & WakeWordMonitor', async () => {
        const tmpWake = fs.mkdtempSync(path.join(os.tmpdir(), 'bimmer-ai-wake-'));
        let mode = 'ignore';
        const mockWakeGemini = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                if (mode === 'ignore') {
                    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: '[IGNORE]' }] } }] }));
                } else if (mode === 'wake_only') {
                    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: '[WAKE_ONLY] [TRANSCRIPT: Hey Bimmer] Dạ Đại ca cần gì em?' }] } }] }));
                } else {
                    res.end(JSON.stringify({
                        candidates: [{
                            content: {
                                parts: [
                                    { functionCall: { name: 'set_seat_comfort', args: { seat: 'driver', massage: true } } },
                                    { text: '[TRANSCRIPT: Bật massage ghế tài] Đã bật massage ghế tài cho Đại ca!' },
                                ],
                            },
                        }],
                    }));
                }
            });
        });
        await new Promise((r) => mockWakeGemini.listen(0, '127.0.0.1', r));

        const dm = new BimmerAiDaemon({
            run: path.join(tmpWake, 'run'),
            state: path.join(tmpWake, 'state'),
            oap: path.join(tmpWake, 'oap'),
            host: '127.0.0.1',
            port: 0,
            simMode: true,
            noNft: true,
            quiet: true,
            geminiBaseUrl: 'http://127.0.0.1:' + mockWakeGemini.address().port,
        });
        await dm.start();
        dm.saveSettings({ apiKey: 'WAKE_KEY', handsFreeWake: true, ttsEnabled: false });

        const wavClip = AudioIO.buildStereoWav(new Array(2400).fill(0.35), new Array(2400).fill(0.04), 16000);

        // 1. Private cabin chatter -> `[IGNORE]` must NOT overwrite `lastTurn` or touch vehicle!
        const prevReply = dm.lastTurn.replyVi;
        mode = 'ignore';
        const rIgnore = await dm.handleVoiceOrTextTurn({
            audioWavBase64: wavClip.toString('base64'),
            audioMimeType: 'audio/wav',
            wakeMode: true,
        });
        assert.strictEqual(rIgnore.ignored, true);
        assert.strictEqual(dm.lastTurn.replyVi, prevReply);
        assert.strictEqual(dm.getPublicState().followUpActive, false);

        // 2. "Hey Bimmer!" (wake-only) -> answers "Dạ Đại ca cần gì em?" and opens 10s follow-up window!
        mode = 'wake_only';
        const rWake = await dm.handleVoiceOrTextTurn({
            audioWavBase64: wavClip.toString('base64'),
            audioMimeType: 'audio/wav',
            wakeMode: true,
        });
        assert.strictEqual(rWake.wakeOnly, true);
        assert.strictEqual(dm.getPublicState().followUpActive, true);
        assert.ok(dm.lastTurn.replyVi.indexOf('Dạ') >= 0);

        // 3. Follow-up command without repeating "Hey Bimmer" -> executes immediately & closes follow-up window!
        mode = 'cmd';
        await dm.handleVoiceOrTextTurn({
            audioWavBase64: wavClip.toString('base64'),
            audioMimeType: 'audio/wav',
            wakeMode: !dm.getPublicState().followUpActive,
        });
        assert.strictEqual(dm.vehicle.state.climate.massageDriver, true);
        assert.strictEqual(dm.getPublicState().followUpActive, false);

        // 4. Deterministic text `extractWakeCommand` (1-breath command vs non-wake chatter)
        assert.strictEqual(AiBrain.extractWakeCommand('Tối nay đi ăn lẩu nhé').matched, false);
        assert.strictEqual(AiBrain.extractWakeCommand('Hey Bimmer!').wakeOnly, true);
        const oneBreath = AiBrain.extractWakeCommand('Ê Bimmer chỉnh điều hoà 22 độ');
        assert.strictEqual(oneBreath.matched, true);
        assert.strictEqual(oneBreath.wakeOnly, false);

        // 5. `WakeWordMonitor` child-process supervisor & phone-call instant pause
        const fakeHelper = path.join(tmpWake, 'mock_vad.js');
        const fakeOutWav = path.join(tmpWake, 'vad_utt.wav');
        const wavB64 = wavClip.toString('base64');
        fs.writeFileSync(fakeHelper, [
            'const fs = require("fs");',
            'console.log(JSON.stringify({ event: "ready", device: "smartx:SpeechSink_CF_2MIC_1REF_SPEECH" }));',
            'setTimeout(() => {',
            '  fs.writeFileSync(process.argv[4], Buffer.from(' + JSON.stringify(wavB64) + ', "base64"));',
            '  console.log(JSON.stringify({ event: "utterance", file: process.argv[4], durationMs: 1200, speechDb: -18.5, noiseDb: -48.0 }));',
            '}, 80);',
            'setInterval(() => {}, 1000);',
        ].join('\n'));

        let gotUtterance = null;
        let callActive = false;
        const mon = new AudioIO.WakeWordMonitor({
            mguPython: process.execPath,
            smartxHelper: fakeHelper,
            outFile: fakeOutWav,
            shouldPause: () => callActive,
            onUtterance: (u) => { gotUtterance = u; },
        });
        mon.start();
        await new Promise((r) => setTimeout(r, 350));
        assert.strictEqual(mon.status, 'armed');
        assert.ok(gotUtterance && gotUtterance.analysis.speakerZone === 'driver');
        assert.strictEqual(fs.existsSync(fakeOutWav), false); // unlinked after read so never re-processed!

        // Phone call arrives -> monitor must immediately kill worker & enter `paused`!
        callActive = true;
        await mon.tick();
        assert.strictEqual(mon.status, 'paused');
        assert.strictEqual(mon.child, null);
        await mon.stop();

        await dm.stop();
        await new Promise((r) => mockWakeGemini.close(r));
    });

    /* ---------------- 10. QA v0.4.1 Edge-Case & Regression Suite ---------------- */
    await step('QA v0.4.1: IPC Dedup, 2-Zone SpeechSink Priority, Hallucination Gate, Auto Start-Stop & HMI Toggle', async () => {
        const net = require('net');
        const Module = require('module');
        const origLoad = Module._load;
        Module._load = function (reqId, parent, isMain) {
            if (reqId === './kit/qr') return { draw: () => 180 };
            return origLoad.apply(this, [reqId, parent, isMain]);
        };
        let UI;
        try {
            UI = require('../apps/bimmer_ai/ui');
        } finally {
            Module._load = origLoad;
        }

        // 1. Primary SmartX profile MUST be 2-Zone 6-Ref Stereo `SpeechSink_CF_2MIC_6REF` (`hwChannels: 8, rate: 24000`)
        assert.strictEqual(AudioIO.SMARTX_PROFILES[0].hw, 'smartx:SpeechSink_CF_2MIC_6REF');
        assert.strictEqual(AudioIO.SMARTX_PROFILES[0].hwChannels, 8);
        assert.strictEqual(AudioIO.SMARTX_PROFILES[0].rate, 24000);
        assert.strictEqual(AudioIO.SMARTX_PROFILES[1].hw, 'smartx:SpeechSink_CF_2MIC_1REF_SPEECH');

        // 1b. Node 22 `autoSelectFamily` `{ all: true }` DNS `customLookup` regression test (fixes `ERR_INVALID_IP_ADDRESS: undefined`)
        const UpMod = require('../tools/bimmer-ai/uplink');
        const lookupFn = UpMod.customLookup('', '', ['1.1.1.1']);
        await new Promise((resolve, reject) => {
            lookupFn('127.0.0.1', { all: true }, (err, res) => {
                if (err) return reject(err);
                assert.ok(Array.isArray(res) && res[0].address === '127.0.0.1' && res[0].family === 4);
                resolve();
            });
        });
        await new Promise((resolve, reject) => {
            lookupFn('127.0.0.1', {}, (err, addr, fam) => {
                if (err) return reject(err);
                assert.strictEqual(addr, '127.0.0.1');
                assert.strictEqual(fam, 4);
                resolve();
            });
        });

        // 2. Casual "BMW" / "Bim" chatter rejected, while fillers + "Hey BMW" + "Trợ lý ơi" + stripped remainder work!
        assert.strictEqual(AiBrain.extractWakeCommand('BMW mới ra bản CS đẹp quá').matched, false);
        assert.strictEqual(AiBrain.extractWakeCommand('Bim của mày chạy bốc thế').matched, false);
        assert.strictEqual(AiBrain.extractWakeCommand('Trợ lý ơi!').wakeOnly, true);
        const heyBmw = AiBrain.extractWakeCommand('Hey BMW mở cửa sổ trời');
        assert.strictEqual(heyBmw.matched, true);
        assert.strictEqual(heyBmw.wakeOnly, false);
        assert.strictEqual(heyBmw.remainder, 'mở cửa sổ trời');
        const fillerWake = AiBrain.extractWakeCommand('À Hey Bimmer, dẫn đường tới Hồ Gươm');
        assert.strictEqual(fillerWake.matched, true);
        assert.strictEqual(fillerWake.remainder, 'dẫn đường tới Hồ Gươm');

        // 3. Deterministic Wake Gate blocks LLM hallucinated tool calls when cabin chatter lacks wake word!
        const rogueGemini = http.createServer((req, res) => {
            req.on('data', () => {});
            req.on('end', () => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    candidates: [{
                        content: {
                            parts: [
                                { functionCall: { name: 'set_climate', args: { tempC: 16.5, zone: 'both' } } },
                                { text: '[TRANSCRIPT: Trời nóng quá nhỉ tí đi uống bia không] Đã hạ điều hoà!' },
                            ],
                        },
                    }],
                }));
            });
        });
        await new Promise((r) => rogueGemini.listen(0, '127.0.0.1', r));
        const roguePort = rogueGemini.address().port;

        const tmpQa = fs.mkdtempSync(path.join(os.tmpdir(), 'bimmer-ai-qa-'));
        const dm = new BimmerAiDaemon({
            run: path.join(tmpQa, 'run'),
            state: path.join(tmpQa, 'state'),
            oap: path.join(tmpQa, 'oap'),
            port: 0,
            host: '127.0.0.1',
            simMode: true,
            noNft: true,
            quiet: true,
            geminiBaseUrl: 'http://127.0.0.1:' + roguePort,
        });
        await dm.start();
        dm.saveSettings({ apiKey: 'AIzaSyFakeQaKey', handsFreeWake: true, ttsEnabled: false });

        const driverL = new Float32Array(8000);
        const passR = new Float32Array(8000);
        for (let i = 0; i < 8000; i++) {
            driverL[i] = Math.sin(i * 0.15) * 0.03;
            passR[i] = Math.sin(i * 0.15) * 0.45; // Passenger louder!
        }
        const passWav = AudioIO.buildStereoWav(driverL, passR, 16000);

        const beforeTemp = dm.vehicle.state.climate.tempDriverC;
        const rRogue = await dm.handleVoiceOrTextTurn({
            audioWavBase64: passWav.toString('base64'),
            audioMimeType: 'audio/wav',
            wakeMode: true,
        });
        assert.strictEqual(rRogue.ignored, true);
        assert.strictEqual(dm.vehicle.state.climate.tempDriverC, beforeTemp);

        // 4. Duplicate HMI Command ID sent simultaneously over `ctl.sock` AND `app/command.json` executes ONLY ONCE!
        assert.strictEqual(dm.settings.handsFreeWake, true);
        const dupPayload = JSON.stringify({ id: 987654, cmd: 'toggle_hands_free', arg: {} });
        fs.writeFileSync(path.join(tmpQa, 'run', 'app', 'command.json'), dupPayload);
        await new Promise((resolve) => {
            const c = net.createConnection(path.join(tmpQa, 'run', 'ctl.sock'), () => {
                c.end(dupPayload + '\n', resolve);
            });
        });
        dm.pollHmiAppCommand();
        await new Promise((r) => setTimeout(r, 80));
        assert.strictEqual(dm.settings.handsFreeWake, false); // Toggled ONCE (true -> false), NOT twice!
        dm.saveSettings({ handsFreeWake: true });

        // 5. Auto Start-Stop at red light (`gear: 'D', rpm: 0, battery12v: 12.3`) keeps WakeWordMonitor active,
        //    whereas parked engine-off with weak battery (`gear: 'P', rpm: 0, battery12v: 11.6`) pauses to save 12V!
        dm.vehicle.patchTelemetry({ liveCar: true, gear: 'D', rpm: 0, battery12v: 12.3 });
        assert.strictEqual(dm.wakeMonitor.opts.shouldPause(), false);
        dm.vehicle.patchTelemetry({ liveCar: true, gear: 'P', rpm: 0, battery12v: 11.6 });
        assert.strictEqual(dm.wakeMonitor.opts.shouldPause(), true);

        // 6. HMI `ui.js` Guards screen exposes direct `'aiToggleHandsFree'` touch/rotary target
        const targets = {};
        const mockCv = {
            clear: () => {},
            roundRect: () => {},
            strokeRoundRect: () => {},
            fillRect: () => {},
            circle: () => {},
            text: () => {},
            textWidth: (s) => String(s || '').length * 8,
            target: (_x, _y, _w, _h, fn, key) => { targets[key] = fn; },
        };
        const mockG = {
            TOP: 64,
            MARGIN: 24,
            withAlpha: (c) => c,
            frame: () => {},
            stripes: () => {},
            button: () => {},
            pageBottom: () => 500,
        };
        let toggledUi = 0;
        UI.draw(mockCv, mockG, { bg: '#000', text: '#fff', dim: '#888' }, {
            viewMode: 'guards',
            settings: { handsFreeWake: true, hasApiKey: true },
            guards: {},
            telemetry: dm.vehicle.state,
        }, { toggleHandsFree: () => { toggledUi++; } });
        assert.strictEqual(typeof targets.aiToggleHandsFree, 'function');
        targets.aiToggleHandsFree();
        assert.strictEqual(toggledUi, 1);

        await dm.stop();
        await new Promise((r) => rogueGemini.close(r));
    });

    console.log('\nALL ' + passed + ' TEST SUITES PASSED!');
}

runAllTests().catch((err) => {
    console.error('\nTEST FAILED:', err);
    process.exit(1);
});
