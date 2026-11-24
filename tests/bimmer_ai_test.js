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

    console.log('\nALL ' + passed + ' TEST SUITES PASSED!');
}

runAllTests().catch((err) => {
    console.error('\nTEST FAILED:', err);
    process.exit(1);
});
