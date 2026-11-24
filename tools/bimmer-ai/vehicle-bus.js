'use strict';
/**
 * vehicle-bus.js - Infotainment & Cabin Comfort Bridge for Bimmer AI.
 *
 * Uses the head unit's standard Franca / OAP service interfaces (ClimateMaster, AmbientLight,
 * FlexLight, IpaInteriorLight, WindowLifterMaster, SunBlinds, SeatFunction, MediaPlayer,
 * DynamicMediaPlayer, CommandControl, UserInteractionParkmenu, DestinationMemory) plus local
 * Unix/JSON IPC with companion MGU Store apps (`jap-ridetube-d`, `bimmer-link`, `vietmap-signs`).
 *
 * Can run either in-process (simulation / Mac testing) or as an isolated worker process (`node vehicle-bus.js worker`).
 * Node 8 compatible, zero external npm dependencies.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');

const SafetyGate = require('./safety-gate');

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const CATALOG_PATH = env('BA_CATALOG', '/etc/oap/someip/someip-interfaces.json');
const SOMEIP_PATH = env('BA_SOMEIP', '/usr/lib/someip.node');
const RIDETUBE_SOCK = env('BA_RIDETUBE_SOCK', '/run/jap-ridetube-d/ctl.sock');
const BIMMERLINK_RUN = env('BA_BIMMERLINK_RUN', '/run/bimmer-link');
const VIETMAP_RUN = env('BA_VIETMAP_RUN', '/run/vietmap-signs');
const MGU_DIAG_REPORTS = env('BA_DIAG_DIR', '/var/opt/public/oap');

const APPMGMTS = [
    '/usr/lib/oap-mainapp/src/AppManagement/AppManagement.js',
    '/usr/lib/oap-mainapp21/src/AppManagement/AppManagement.js',
];

const AMBIENT_PRESETS = {
    m_blue: { name: 'Xanh M-Blue', hex: '#0066FF', r: 0, g: 102, b: 255, program: 4 },
    ice_cyan: { name: 'Xanh băng', hex: '#00D4FF', r: 0, g: 212, b: 255, program: 5 },
    sunset_purple: { name: 'Tím hoàng hôn', hex: '#8A2BE2', r: 138, g: 43, b: 226, program: 9 },
    neon_pink: { name: 'Hồng Neon', hex: '#FF2E93', r: 255, g: 46, b: 147, program: 10 },
    m_red: { name: 'Đỏ thể thao', hex: '#FF1E38', r: 255, g: 30, b: 56, program: 3 },
    amber: { name: 'Vàng hổ phách', hex: '#FF8C00', r: 255, g: 140, b: 0, program: 1 },
    emerald: { name: 'Xanh ngọc lục', hex: '#00C853', r: 0, g: 200, b: 83, program: 7 },
    ice_white: { name: 'Trắng lạnh', hex: '#EAF6FF', r: 234, g: 246, b: 255, program: 2 },
    oem: { name: 'Màu zin theo xe', hex: '#3B82F6', r: 59, g: 130, b: 246, program: 0 },
};

function parseHexColor(input) {
    if (!input) return null;
    const key = String(input).trim().toLowerCase();
    if (AMBIENT_PRESETS[key]) return Object.assign({ key }, AMBIENT_PRESETS[key]);
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(key);
    if (m) {
        const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
        return {
            key: 'custom',
            name: '#' + m[1].toUpperCase() + m[2].toUpperCase() + m[3].toUpperCase(),
            hex: '#' + m[1].toUpperCase() + m[2].toUpperCase() + m[3].toUpperCase(),
            r, g, b, program: 4,
        };
    }
    return null;
}

function createInitialTelemetry() {
    return {
        liveCar: false,
        speedKmh: 0,
        rpm: 0,
        gear: 'P',
        engineRunning: false,
        coolantTempC: 84,
        oilTempC: 86,
        outsideTempC: 31,
        cabinTempC: 25.5,
        battery12v: 12.6,
        fuelPercent: 68,
        rangeKm: 420,
        tyresBar: { fl: 2.4, fr: 2.4, rl: 2.5, rr: 2.5 },
        doorsLocked: true,
        trunkOpen: false,
        mirrorsFolded: false,
        sunroof: 'closed',
        blindsOpen: true,
        windows: { fl: 0, fr: 0, rl: 0, rr: 0 },
        climate: {
            on: true,
            tempDriverC: 23.0,
            tempPassengerC: 23.0,
            fanLevel: 2,
            maxAc: false,
            autoMode: true,
            freshAir: true,
            scentOn: false,
            seatHeatDriver: 0,
            seatHeatPassenger: 0,
            seatCoolDriver: 0,
            seatCoolPassenger: 0,
            massageDriver: false,
            massagePassenger: false,
            wheelHeat: false,
        },
        ambient: {
            on: true,
            preset: 'm_blue',
            name: 'Xanh M-Blue',
            hex: '#0066FF',
            brightness: 75,
            zone: 'all',
            readingLight: false,
            ipaPulse: false,
        },
        media: {
            playing: false,
            source: 'Media',
            title: 'Chưa phát nhạc',
            volumePercent: 35,
            muted: false,
            youtubeConnected: false,
        },
        exhaustMode: 'oem',
        cameraView: 'off',
        activeScene: 'none',
        navigationTarget: '',
        vietmap: {
            speedLimitKmh: 60,
            nextLimitKmh: 0,
            cameraAheadM: 0,
            roadName: '',
        },
        climate1crActive: false,
        valetEnabled: false,
        callActive: false,
        pttPressed: false,
        checkControlCount: 0,
        updatedAt: Date.now(),
    };
}

function readJsonSafe(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function writeAtomicSafe(file, text) {
    try {
        const tmp = file + '.tmp.' + process.pid;
        fs.writeFileSync(tmp, text);
        fs.renameSync(tmp, file);
        return true;
    } catch (e) { return false; }
}

function loadIFConfigGenerator() {
    for (let i = 0; i < APPMGMTS.length; i++) {
        if (!fs.existsSync(APPMGMTS[i])) continue;
        const src = fs.readFileSync(APPMGMTS[i], 'utf8');
        const m = /require\(["']([^"']*IFConfigGenerator[^"']*)["']\)/.exec(src);
        if (m) {
            const resolved = path.resolve(path.dirname(APPMGMTS[i]), m[1]);
            return require(resolved);
        }
    }
    return null;
}

/** Send a single JSON command to RideTube (`jap-ridetube-d`) over its Unix socket and optionally collect search results. */
function queryRideTube(sockPath, messages, waitSearchMs) {
    return new Promise((resolve) => {
        if (!sockPath || !fs.existsSync(sockPath)) return resolve({ ok: false, error: 'RideTube socket absent' });
        let done = false, buf = '';
        const events = [];
        const finish = (res) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { client.destroy(); } catch (e) {}
            resolve(res);
        };
        const client = net.createConnection(sockPath, () => {
            messages.forEach((m) => client.write(JSON.stringify(m) + '\n'));
            if (!waitSearchMs) setTimeout(() => finish({ ok: true, events }), 180);
        });
        const timer = setTimeout(() => finish({ ok: true, events }), waitSearchMs || 600);
        client.setEncoding('utf8');
        client.on('data', (chunk) => {
            buf += chunk;
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, idx).trim();
                buf = buf.slice(idx + 1);
                if (!line) continue;
                try {
                    const ev = JSON.parse(line);
                    events.push(ev);
                    if (waitSearchMs && (ev.ev === 'search' || (Array.isArray(ev.items) && ev.items.length))) {
                        finish({ ok: true, events, items: ev.items || [] });
                    }
                } catch (e) {}
            }
        });
        client.on('error', (err) => finish({ ok: false, error: err.message }));
    });
}

class VehicleController {
    constructor(opts) {
        this.opts = Object.assign({
            catalogPath: CATALOG_PATH,
            someipPath: SOMEIP_PATH,
            ridetubeSock: RIDETUBE_SOCK,
            bimmerlinkRun: BIMMERLINK_RUN,
            vietmapRun: VIETMAP_RUN,
            onTelemetry: null,
            onPttEvent: null,
            onLog: null,
        }, opts || {});

        this.state = createInitialTelemetry();
        this.guards = SafetyGate.defaultGuards();
        this.deferredWatches = [];
        this.proxies = {};
        this.preCinemaBackup = null;
        this.pttDownAt = 0;
        this.lastShortPttAt = 0;
    }

    log(msg) {
        if (this.opts.onLog) this.opts.onLog(msg);
    }

    emitTelemetry() {
        this.state.updatedAt = Date.now();
        this.checkDeferredWatches();
        if (this.opts.onTelemetry) this.opts.onTelemetry(this.getSnapshot());
    }

    getSnapshot() {
        return JSON.parse(JSON.stringify({
            telemetry: this.state,
            guards: this.guards,
            deferredWatches: this.deferredWatches,
        }));
    }

    setGuards(nextGuards) {
        this.guards = SafetyGate.normalizeGuards(Object.assign({}, this.guards, nextGuards || {}));
        this.emitTelemetry();
        return this.guards;
    }

    /** Update simulated or live telemetry fields and trigger reactive safety/co-pilot watches. */
    patchTelemetry(patch) {
        if (!patch || typeof patch !== 'object') return this.state;
        Object.keys(patch).forEach((k) => {
            const val = patch[k];
            if (val && typeof val === 'object' && !Array.isArray(val) && this.state[k] && typeof this.state[k] === 'object') {
                Object.assign(this.state[k], val);
            } else {
                this.state[k] = val;
            }
        });
        if (typeof this.state.rpm === 'number') this.state.engineRunning = this.state.rpm >= 400;
        this.emitTelemetry();
        return this.state;
    }

    /** Sync companion app status files (`bimmer-link` & `vietmap-signs` & `jap-ridetube-d`). */
    pollCompanionApps() {
        const bl = readJsonSafe(path.join(this.opts.bimmerlinkRun, 'status.json'));
        if (bl && bl.telemetry) {
            if (bl.telemetry.climate1cr) this.state.climate1crActive = !!bl.telemetry.climate1cr.active;
            if (bl.valet) this.state.valetEnabled = !!bl.valet.enabled;
            if (typeof bl.telemetry.battery12v === 'number') this.state.battery12v = bl.telemetry.battery12v;
            if (typeof bl.telemetry.fuelPct === 'number') this.state.fuelPercent = bl.telemetry.fuelPct;
            if (typeof bl.telemetry.rangeKm === 'number') this.state.rangeKm = bl.telemetry.rangeKm;
        }
        const vm = readJsonSafe(path.join(this.opts.vietmapRun, 'status.json'));
        if (vm) {
            if (typeof vm.speedLimit === 'number') this.state.vietmap.speedLimitKmh = vm.speedLimit;
            if (typeof vm.nextLimit === 'number') this.state.vietmap.nextLimitKmh = vm.nextLimit;
            if (typeof vm.cameraDistanceM === 'number') this.state.vietmap.cameraAheadM = vm.cameraDistanceM;
            if (vm.roadName) this.state.vietmap.roadName = String(vm.roadName);
        }
        this.state.media.youtubeConnected = fs.existsSync(this.opts.ridetubeSock);
    }

    /** Connect to standard OAP SOME/IP infotainment services when running on the real MGU head unit. */
    async initHardwareBus() {
        this.pollCompanionApps();
        if (!fs.existsSync(this.opts.catalogPath) || !fs.existsSync(this.opts.someipPath)) {
            this.log('vehicle-bus: running in simulation/companion mode (no native someip.node)');
            return false;
        }
        let db = null, gen = null, someip = null;
        try {
            db = JSON.parse(fs.readFileSync(this.opts.catalogPath, 'utf8'));
            gen = loadIFConfigGenerator();
            someip = require(this.opts.someipPath);
        } catch (e) {
            this.log('vehicle-bus init warning: ' + e.message);
            return false;
        }
        if (!db || !gen || !someip) return false;

        let chain = Promise.resolve();
        const openProxy = (ifaceName, attrs, methods) => {
            if (!db.interfaces || !db.interfaces[ifaceName]) return Promise.resolve(null);
            const step = () => new Promise((res) => setImmediate(() => {
                try {
                    const spec = { instances: '*' };
                    if (attrs && Object.keys(attrs).length) spec.attributes = attrs;
                    if (methods && methods.length) spec.methods = methods;
                    const proxies = {};
                    proxies[ifaceName] = spec;
                    const generated = gen.generate(db, { proxies, services: {} });
                    const cfg = generated && generated[ifaceName];
                    if (!cfg) return res(null);
                    const inst = Object.keys(cfg.instances || { '1': 1 })[0] || '1';
                    someip.buildProxy(cfg, String(inst))
                        .then((px) => px.init().then(() => res(px)))
                        .catch(() => res(null));
                } catch (e) { res(null); }
            }));
            const p = chain.then(step, step);
            chain = p;
            return p;
        };

        const bindService = async (key, ifaceName, fieldNames, methodNames, onField) => {
            const iv = db.interfaces && db.interfaces[ifaceName];
            if (!iv) return;
            const attrs = {};
            (fieldNames || []).forEach((f) => {
                if (iv.fields && iv.fields[f]) attrs[f] = iv.fields[f].getter ? 'rs' : 's';
            });
            const validMethods = (methodNames || []).filter((m) => iv.methods && iv.methods[m]);
            const px = await openProxy(ifaceName, attrs, validMethods);
            if (!px) return;
            this.proxies[key] = px;
            this.state.liveCar = true;
            Object.keys(attrs).forEach((f) => {
                if (onField) {
                    try { px.subscribe({ name: f, onReceive: (v) => onField(f, v) }); } catch (e) {}
                    if (attrs[f].indexOf('r') >= 0) {
                        try { px.getValue(f, 2500).then((v) => onField(f, v)).catch(() => {}); } catch (e) {}
                    }
                }
            });
        };

        // 1. Driving & Thermal state
        await bindService('cds', 'de.bmw.infotainment.vehicle.CDS', ['statusEngineSpeed2', 'statusEngineTemperature'], [], (f, v) => {
            if (!v) return;
            if (f === 'statusEngineSpeed2' && v.actualValueRPMEngineCrankshaft !== undefined && v.actualValueRPMEngineCrankshaft !== 65535) {
                const rpm = v.actualValueRPMEngineCrankshaft * 0.25;
                this.patchTelemetry({ rpm: rpm < 400 ? 0 : Math.round(rpm) });
            } else if (f === 'statusEngineTemperature') {
                const p = {};
                if (v.temperatureEngineDrive !== undefined && v.temperatureEngineDrive !== 255) p.coolantTempC = v.temperatureEngineDrive - 48;
                if (v.temperatureEngineOilDrive !== undefined && v.temperatureEngineOilDrive !== 255) p.oilTempC = v.temperatureEngineOilDrive - 48;
                this.patchTelemetry(p);
            }
        });

        await bindService('vehicle2', 'de.bmw.infotainment.vehicle.Vehicle2', ['statusCarSpeed2'], [], (f, v) => {
            if (v && v.speedVehicleCentreOfGravity !== undefined && v.speedVehicleCentreOfGravity !== 65535) {
                this.patchTelemetry({ speedKmh: +(v.speedVehicleCentreOfGravity * 0.015625).toFixed(1) });
            }
        });

        await bindService('vehInfo', 'de.bmw.infrastructure.VehicleInformation', ['statusGearboxDrive'], [], (f, v) => {
            if (v && v.gearboxSelectorPosition !== undefined) {
                const g = String(v.gearboxSelectorPosition).toUpperCase();
                if (/^[PRNDSM]/.test(g)) this.patchTelemetry({ gear: g.charAt(0) });
            }
        });

        // 2. Steering wheel Push-To-Talk button (`statusPTTButton1` & `statusSpecialFunctionButton`)
        await bindService('steering', 'de.bmw.infotainment.controlelements.SteeringWheelPushButton', ['statusPTTButton1', 'statusSpecialFunctionButton'], [], (f, v) => {
            const pressed = !!(v === 1 || v === true || (v && (v.state === 1 || v.pressed === true || v.status === 1)));
            this.handleSteeringPttSignal(f, pressed);
        });

        // 3. Telephony & CarPlay voice call yield guard
        await bindService('voiceCall', 'de.bmw.infotainment.connectivity.telephony.VoiceCall', ['state'], [], (f, v) => {
            const active = !!(v && String(v).toUpperCase().indexOf('IDLE') < 0 && v !== 0);
            this.patchTelemetry({ callActive: active });
        });
        await bindService('carplay', 'de.bmw.infotainment.a4a.carplay.CarPlayManager', ['projectedTelephonyActive'], [], (f, v) => {
            if (typeof v === 'boolean') this.patchTelemetry({ callActive: v });
        });

        // 4. Comfort, Climate, Windows, Blinds, Lighting, Audio & Navigation proxies
        await bindService('climateMaster', 'de.bmw.infotainment.climate.climatemaster.ClimateMaster',
            ['statusClimateSystemOn', 'statusAirCondMaxAC', 'statusAutoMode', 'statusAirBlowLevel', 'statusScentOn'],
            ['requestTemperature', 'requestAirBlowLevel', 'requestAirCondMaxAC', 'requestAutoMode', 'requestClimateSystemOn',
                'requestAirQualityFresh', 'requestScentOn', 'requestSeatClimateSeatHeating', 'requestSeatClimateSeatCooling',
                'requestSteeringWheelHeating']);

        await bindService('windowMaster', 'de.bmw.body.windowmaster.WindowLifterMaster', ['windowStatus'], ['moveWindow', 'cancelLastRequest']);
        await bindService('sunBlinds', 'de.bmw.body.doorsandwindows.SunBlinds', ['blindStatusList'], ['openSideAndRearBlinds', 'closeSideAndRearBlinds']);
        await bindService('mirrors', 'de.bmw.body.ExteriorMirrorDynamicControl', [], ['requestExtMirrorFolding']);
        await bindService('locks', 'de.bmw.body.caraccess.CenterLockingService', [], ['requestLock', 'requestUnlock', 'requestOpenBootlid']);
        await bindService('ipaLight', 'de.bmw.body.interiorillumination.IpaInteriorLight', [], ['setIpaLightingInterior']);
        await bindService('flexLight', 'de.bmw.body.interiorillumination.flexlight.FlexLight', ['interiorLightActive'], ['setReadingLight', 'deactivateAllReadingLights']);
        await bindService('seatTarget', 'de.bmw.body.seat.SeatTargetAdjustment', [], ['setTargetPosition', 'cancelTargetPosition']);
        await bindService('audioCmd', 'org.genivi.am.commandinterface.CommandControl', [], ['setVolumeInPercent', 'setSinkMuteState']);
        await bindService('dynMedia', 'de.bmw.infotainment.entertainment.dynamicmediaplayer.DynamicMediaPlayer', ['playerState', 'currentItemMetadata'], ['sendButtonEvent']);
        await bindService('parkCam', 'de.bmw.dass.parking.parkmenu.userinteraction.UserInteractionParkmenu', ['selectedCamera'], ['hmiSelectCamera', 'requestParkingClosedown']);
        await bindService('destMem', 'de.bmw.infotainment.navigation.destinationmemory.DestinationMemory', [], ['addDestination']);

        this.log('vehicle-bus: connected proxies = ' + Object.keys(this.proxies).join(', '));
        return true;
    }

    handleSteeringPttSignal(field, pressed) {
        const now = Date.now();
        this.state.pttPressed = pressed;
        if (pressed) {
            this.pttDownAt = now;
        } else if (this.pttDownAt > 0) {
            const heldMs = now - this.pttDownAt;
            this.pttDownAt = 0;
            if (heldMs < 650) {
                const isDouble = (now - this.lastShortPttAt) < 550;
                this.lastShortPttAt = now;
                if (this.opts.onPttEvent) {
                    this.opts.onPttEvent({ button: field, kind: isDouble ? 'double_press' : 'short_press', heldMs });
                }
            } else if (this.opts.onPttEvent) {
                this.opts.onPttEvent({ button: field, kind: 'long_press', heldMs });
            }
        }
    }

    checkDeferredWatches() {
        // Auto-exit Cinema Parked mode as soon as driver shifts out of P!
        if (this.state.activeScene === 'cinema_park' && SafetyGate.isVehicleMoving(this.state)) {
            this.state.activeScene = 'none';
            if (this.preCinemaBackup) {
                this.state.ambient = Object.assign({}, this.preCinemaBackup.ambient);
                this.preCinemaBackup = null;
            }
            this.state.cameraView = 'off';
            queryRideTube(this.opts.ridetubeSock, [{ cmd: 'video', on: false }], 0).catch(() => {});
            this.log('co-pilot: auto-exited cinema_park scene because vehicle left Park');
        }

        if (!this.deferredWatches.length) return;
        const remaining = [];
        const triggered = [];
        for (let i = 0; i < this.deferredWatches.length; i++) {
            const w = this.deferredWatches[i];
            if (w.kind === 'oil_temp_min' && this.state.oilTempC >= w.targetOilC) {
                triggered.push(w);
            } else {
                remaining.push(w);
            }
        }
        this.deferredWatches = remaining;
        for (let j = 0; j < triggered.length; j++) {
            const tw = triggered[j];
            this.log('co-pilot: oil reached ' + this.state.oilTempC + 'C -> triggering deferred ' + tw.toolName);
            this.executeDirect(tw.toolName, tw.args, 'driver').catch(() => {});
        }
    }

    async callProxySafe(proxyKey, method, args) {
        const px = this.proxies[proxyKey];
        if (!px || typeof px.callMethod !== 'function') return { bus: 'simulated' };
        try {
            const res = await px.callMethod(method, args || {}, 3500);
            return { bus: 'someip', response: res };
        } catch (e) {
            return { bus: 'someip_error', error: e.message };
        }
    }

    /** Validate through `SafetyGate` and execute a vehicle tool. */
    async invokeTool(toolName, rawArgs, speakerZone) {
        this.pollCompanionApps();
        const gate = SafetyGate.evaluateToolCall(toolName, rawArgs, this.state, this.guards);
        if (gate.decision === 'block') {
            return {
                ok: false,
                blocked: true,
                code: gate.code,
                summaryVi: gate.reasonVi,
            };
        }
        if (gate.decision === 'defer') {
            this.deferredWatches = this.deferredWatches.filter((w) => w.id !== gate.watch.id).concat([gate.watch]);
            this.emitTelemetry();
            return {
                ok: true,
                deferred: true,
                code: gate.code,
                summaryVi: gate.reasonVi,
            };
        }
        return this.executeDirect(toolName, gate.normalizedArgs, speakerZone || 'driver');
    }

    async executeDirect(toolName, args, speakerZone) {
        const zoneDefault = speakerZone === 'passenger' ? 'passenger' : 'driver';

        switch (toolName) {
            case 'set_climate': {
                const targetZone = args.zone || zoneDefault;
                const changes = [];
                if (args.systemOn !== undefined) {
                    this.state.climate.on = !!args.systemOn;
                    await this.callProxySafe('climateMaster', 'requestClimateSystemOn', { on: !!args.systemOn });
                    changes.push(this.state.climate.on ? 'bật điều hoà' : 'tắt điều hoà');
                }
                if (args.maxAc !== undefined) {
                    this.state.climate.maxAc = !!args.maxAc;
                    if (args.maxAc) {
                        this.state.climate.on = true;
                        this.state.climate.tempDriverC = 16.0;
                        this.state.climate.tempPassengerC = 16.0;
                        this.state.climate.fanLevel = 5;
                    }
                    await this.callProxySafe('climateMaster', 'requestAirCondMaxAC', { on: !!args.maxAc });
                    changes.push(args.maxAc ? 'bật Max AC lạnh sâu' : 'tắt Max AC');
                }
                if (args.tempC !== undefined) {
                    this.state.climate.on = true;
                    if (targetZone === 'both' || targetZone === 'all' || targetZone === 'sync') {
                        this.state.climate.tempDriverC = args.tempC;
                        this.state.climate.tempPassengerC = args.tempC;
                        changes.push('chỉnh nhiệt độ cả 2 vùng ' + args.tempC + '°C');
                    } else if (targetZone === 'passenger') {
                        this.state.climate.tempPassengerC = args.tempC;
                        changes.push('chỉnh điều hoà ghế phụ ' + args.tempC + '°C');
                    } else {
                        this.state.climate.tempDriverC = args.tempC;
                        changes.push('chỉnh điều hoà ghế tài ' + args.tempC + '°C');
                    }
                    await this.callProxySafe('climateMaster', 'requestTemperature', { zone: targetZone, temperature: args.tempC });
                }
                if (args.deltaTempC !== undefined) {
                    const delta = Number(args.deltaTempC) || 0;
                    if (targetZone === 'passenger') {
                        this.state.climate.tempPassengerC = Math.max(16, Math.min(28, +(this.state.climate.tempPassengerC + delta).toFixed(1)));
                        changes.push('chỉnh ghế phụ sang ' + this.state.climate.tempPassengerC + '°C');
                    } else {
                        this.state.climate.tempDriverC = Math.max(16, Math.min(28, +(this.state.climate.tempDriverC + delta).toFixed(1)));
                        changes.push('chỉnh ghế tài sang ' + this.state.climate.tempDriverC + '°C');
                    }
                }
                if (args.fanLevel !== undefined) {
                    this.state.climate.fanLevel = args.fanLevel;
                    await this.callProxySafe('climateMaster', 'requestAirBlowLevel', { level: args.fanLevel });
                    changes.push('mức gió ' + args.fanLevel);
                }
                if (args.freshAir !== undefined) {
                    this.state.climate.freshAir = !!args.freshAir;
                    await this.callProxySafe('climateMaster', 'requestAirQualityFresh', { freshAir: !!args.freshAir });
                    changes.push(args.freshAir ? 'lấy gió ngoài' : 'lấy gió trong');
                }
                if (args.scentOn !== undefined) {
                    this.state.climate.scentOn = !!args.scentOn;
                    await this.callProxySafe('climateMaster', 'requestScentOn', { on: !!args.scentOn });
                    changes.push(args.scentOn ? 'bật nước hoa Ambient Air' : 'tắt nước hoa');
                }
                this.emitTelemetry();
                return { ok: true, summaryVi: 'Đã ' + (changes.join(', ') || 'cập nhật điều hoà') + '.' };
            }

            case 'set_seat_comfort': {
                const side = args.seat || zoneDefault;
                const label = side === 'passenger' ? 'ghế phụ' : (side === 'both' ? '2 ghế trước' : 'ghế tài');
                const notes = [];
                if (args.heatingLevel !== undefined) {
                    const lv = Math.max(0, Math.min(3, Math.round(Number(args.heatingLevel) || 0)));
                    if (side === 'passenger' || side === 'both') this.state.climate.seatHeatPassenger = lv;
                    if (side === 'driver' || side === 'both') this.state.climate.seatHeatDriver = lv;
                    await this.callProxySafe('climateMaster', 'requestSeatClimateSeatHeating', { seat: side, level: lv });
                    notes.push(lv > 0 ? ('bật sưởi ' + label + ' mức ' + lv) : ('tắt sưởi ' + label));
                }
                if (args.coolingLevel !== undefined) {
                    const lv = Math.max(0, Math.min(3, Math.round(Number(args.coolingLevel) || 0)));
                    if (side === 'passenger' || side === 'both') this.state.climate.seatCoolPassenger = lv;
                    if (side === 'driver' || side === 'both') this.state.climate.seatCoolDriver = lv;
                    await this.callProxySafe('climateMaster', 'requestSeatClimateSeatCooling', { seat: side, level: lv });
                    notes.push(lv > 0 ? ('bật làm mát ' + label + ' mức ' + lv) : ('tắt làm mát ' + label));
                }
                if (args.massage !== undefined) {
                    const on = !!args.massage;
                    if (side === 'passenger' || side === 'both') this.state.climate.massagePassenger = on;
                    if (side === 'driver' || side === 'both') this.state.climate.massageDriver = on;
                    notes.push((on ? 'bật massage ' : 'tắt massage ') + label);
                }
                if (args.wheelHeat !== undefined) {
                    this.state.climate.wheelHeat = !!args.wheelHeat;
                    await this.callProxySafe('climateMaster', 'requestSteeringWheelHeating', { on: !!args.wheelHeat });
                    notes.push(args.wheelHeat ? 'bật sưởi vô-lăng' : 'tắt sưởi vô-lăng');
                }
                if (args.gentlemanMove) {
                    await this.callProxySafe('seatTarget', 'setTargetPosition', { preset: 'gentleman' });
                    notes.push('dịch ghế phụ gọn lên cho hàng sau');
                }
                this.emitTelemetry();
                return { ok: true, summaryVi: 'Đã ' + (notes.join(', ') || ('cập nhật ' + label)) + '.' };
            }

            case 'set_ambient_light': {
                const notes = [];
                if (args.on !== undefined) {
                    this.state.ambient.on = !!args.on;
                    notes.push(args.on ? 'bật đèn viền nội thất' : 'tắt đèn viền nội thất');
                }
                if (args.color) {
                    const c = parseHexColor(args.color);
                    if (c) {
                        this.state.ambient.on = true;
                        this.state.ambient.preset = c.key;
                        this.state.ambient.name = c.name;
                        this.state.ambient.hex = c.hex;
                        if (args.zone) this.state.ambient.zone = String(args.zone);
                        notes.push('đổi đèn viền sang ' + c.name + (args.zone && args.zone !== 'all' ? (' vùng ' + args.zone) : ''));
                    }
                }
                if (args.brightness !== undefined) {
                    const b = Math.max(0, Math.min(100, Math.round(Number(args.brightness))));
                    this.state.ambient.brightness = b;
                    notes.push('độ sáng đèn viền ' + b + '%');
                }
                if (args.readingLight !== undefined) {
                    this.state.ambient.readingLight = !!args.readingLight;
                    if (args.readingLight) {
                        await this.callProxySafe('flexLight', 'setReadingLight', { side: zoneDefault, active: true });
                    } else {
                        await this.callProxySafe('flexLight', 'deactivateAllReadingLights', {});
                    }
                    notes.push(args.readingLight ? 'bật đèn đọc sách' : 'tắt đèn đọc sách');
                }
                await this.callProxySafe('ipaLight', 'setIpaLightingInterior', { active: true });
                this.emitTelemetry();
                return { ok: true, summaryVi: 'Đã ' + (notes.join(', ') || 'cập nhật đèn nội thất') + '.' };
            }

            case 'control_windows_roof': {
                const target = String(args.target || 'all').toLowerCase();
                const action = String(args.action || 'vent').toLowerCase();
                const notes = [];
                if (target === 'sunroof') {
                    this.state.sunroof = action === 'open' ? 'open' : (action === 'vent' || action === 'tilt' ? 'tilt' : 'closed');
                    notes.push(this.state.sunroof === 'open' ? 'mở cửa sổ trời' : (this.state.sunroof === 'tilt' ? 'hé nghiêng cửa sổ trời' : 'đóng cửa sổ trời'));
                } else if (target === 'blinds') {
                    const open = action === 'open';
                    this.state.blindsOpen = open;
                    await this.callProxySafe('sunBlinds', open ? 'openSideAndRearBlinds' : 'closeSideAndRearBlinds', {});
                    notes.push(open ? 'mở rèm che nắng' : 'kéo rèm che nắng');
                } else {
                    const pct = action === 'close' ? 0 : (action === 'vent' ? 15 : (args.percent !== undefined ? Math.max(0, Math.min(100, Math.round(Number(args.percent)))) : 100));
                    const keys = target === 'driver' || target === 'fl' ? ['fl']
                        : target === 'passenger' || target === 'fr' ? ['fr']
                            : target === 'rear' ? ['rl', 'rr']
                                : ['fl', 'fr', 'rl', 'rr'];
                    keys.forEach((k) => { this.state.windows[k] = pct; });
                    await this.callProxySafe('windowMaster', 'moveWindow', { target, openingPercent: pct });
                    const targetVi = keys.length === 4 ? 'toàn bộ kính' : (keys[0] === 'fl' ? 'kính ghế tài' : (keys[0] === 'fr' ? 'kính ghế phụ' : 'kính hàng sau'));
                    notes.push((pct === 0 ? 'đóng kín ' : (pct <= 25 ? ('hé ' + pct + '% ') : ('hạ ' + pct + '% '))) + targetVi +
                        (args.highwayClamped ? ' (giới hạn hé an toàn do xe đang chạy tốc độ cao)' : ''));
                }
                this.emitTelemetry();
                return { ok: true, summaryVi: 'Đã ' + notes.join(', ') + '.' };
            }

            case 'control_locks_trunk': {
                const action = args.action;
                if (action === 'lock') {
                    this.state.doorsLocked = true;
                    await this.callProxySafe('locks', 'requestLock', {});
                    this.emitTelemetry();
                    return { ok: true, summaryVi: 'Đã khoá chốt toàn bộ cửa xe.' };
                }
                if (action === 'unlock') {
                    this.state.doorsLocked = false;
                    await this.callProxySafe('locks', 'requestUnlock', {});
                    this.emitTelemetry();
                    return { ok: true, summaryVi: 'Đã mở chốt cửa xe (xe đang đỗ P an toàn).' };
                }
                if (action === 'open_trunk') {
                    this.state.trunkOpen = true;
                    await this.callProxySafe('locks', 'requestOpenBootlid', {});
                    this.emitTelemetry();
                    return { ok: true, summaryVi: 'Đã gửi lệnh mở cốp sau.' };
                }
                return { ok: false, summaryVi: 'Không rõ thao tác cửa/cốp.' };
            }

            case 'control_mirrors': {
                const fold = args.action === 'fold';
                this.state.mirrorsFolded = fold;
                await this.callProxySafe('mirrors', 'requestExtMirrorFolding', { fold });
                this.emitTelemetry();
                return { ok: true, summaryVi: fold ? 'Đã gập gương chiếu hậu.' : 'Đã mở gương chiếu hậu.' };
            }

            case 'control_media': {
                const act = String(args.action || 'play').toLowerCase();
                if (args.volumePercent !== undefined) {
                    this.state.media.volumePercent = args.volumePercent;
                    this.state.media.muted = args.volumePercent === 0;
                    await this.callProxySafe('audioCmd', 'setVolumeInPercent', { sinkID: 1024, volume: args.volumePercent });
                }
                if (act === 'mute' || act === 'unmute') {
                    this.state.media.muted = act === 'mute';
                    await this.callProxySafe('audioCmd', 'setSinkMuteState', { sinkID: 1024, muteState: act === 'mute' ? 1 : 0 });
                    this.emitTelemetry();
                    return { ok: true, summaryVi: act === 'mute' ? 'Đã tắt tiếng loa xe.' : 'Đã bật lại tiếng loa xe.' };
                }
                if (act === 'youtube_search_play' && args.query) {
                    const q = String(args.query).trim();
                    this.state.media.playing = true;
                    this.state.media.source = 'YouTube TV';
                    this.state.media.title = q;
                    const yt = await queryRideTube(this.opts.ridetubeSock, [{ cmd: 'search', q }], 2500);
                    if (yt.ok && yt.items && yt.items.length && yt.items[0].id) {
                        const top = yt.items[0];
                        this.state.media.title = top.title || q;
                        await queryRideTube(this.opts.ridetubeSock, [{ cmd: 'play', id: top.id, quality: 'auto' }], 0);
                    }
                    this.emitTelemetry();
                    return { ok: true, summaryVi: 'Đang phát "' + this.state.media.title + '" trên YouTube TV.' };
                }
                if (act === 'pause' || act === 'stop') {
                    this.state.media.playing = false;
                    if (this.state.media.source === 'YouTube TV') await queryRideTube(this.opts.ridetubeSock, [{ cmd: 'pause' }], 0);
                    await this.callProxySafe('dynMedia', 'sendButtonEvent', { button: 'PAUSE' });
                    this.emitTelemetry();
                    return { ok: true, summaryVi: 'Đã tạm dừng phát nhạc.' };
                }
                if (act === 'next' || act === 'previous' || act === 'play') {
                    this.state.media.playing = true;
                    if (act === 'play' && this.state.media.source === 'YouTube TV') {
                        await queryRideTube(this.opts.ridetubeSock, [{ cmd: 'resume' }], 0);
                    }
                    await this.callProxySafe('dynMedia', 'sendButtonEvent', { button: act.toUpperCase() });
                    if (act === 'next') this.state.media.title = 'Bài tiếp theo';
                    if (act === 'previous') this.state.media.title = 'Bài trước đó';
                    this.emitTelemetry();
                    return {
                        ok: true,
                        summaryVi: act === 'next' ? 'Đã chuyển sang bài tiếp theo.'
                            : (act === 'previous' ? 'Đã lùi về bài trước.'
                                : ('Đã tiếp tục phát nhạc' + (args.volumePercent !== undefined ? (' ở mức âm lượng ' + args.volumePercent + '%') : '') + '.')),
                    };
                }
                this.emitTelemetry();
                return { ok: true, summaryVi: 'Đã chỉnh âm lượng loa xe mức ' + this.state.media.volumePercent + '%.' };
            }

            case 'set_exhaust_flap': {
                const mode = args.mode || 'oem';
                this.state.exhaustMode = mode;
                this.emitTelemetry();
                const label = mode === 'open' ? 'MỞ van bô thể thao' : (mode === 'close' ? 'ĐÓNG êm van bô' : 'trả van bô về chế độ ZIN theo xe');
                return { ok: true, summaryVi: 'Đã ' + label + ' (nhiệt độ dầu máy ' + this.state.oilTempC + '°C).' };
            }

            case 'control_camera_360': {
                const view = String(args.view || '360').toLowerCase();
                this.state.cameraView = view === 'off' ? 'off' : view;
                if (view === 'off') await this.callProxySafe('parkCam', 'requestParkingClosedown', {});
                else await this.callProxySafe('parkCam', 'hmiSelectCamera', { camera: view });
                this.emitTelemetry();
                return { ok: true, summaryVi: view === 'off' ? 'Đã đóng màn hình camera.' : ('Đã bật camera ' + view.toUpperCase() + ' trên màn hình.') };
            }

            case 'navigate_to': {
                const dest = String(args.destination || '').trim();
                this.state.navigationTarget = dest;
                await this.callProxySafe('destMem', 'addDestination', { name: dest });
                this.emitTelemetry();
                return { ok: true, summaryVi: 'Đã nạp điểm đến "' + dest + '" vào bản đồ dẫn đường BMW.' };
            }

            case 'control_1cr_valet': {
                const act = String(args.action || 'status').toLowerCase();
                const cmdPath = path.join(this.opts.bimmerlinkRun, 'app', 'command.json');
                if (act === 'start_1cr') {
                    this.state.climate1crActive = true;
                    writeAtomicSafe(cmdPath, JSON.stringify({ id: Date.now(), cmd: 'start1cr', arg: {} }));
                    this.emitTelemetry();
                    return { ok: true, summaryVi: 'Đã gửi lệnh kích hoạt làm mát / đề nổ từ xa Option 1CR qua Bimmer-Link.' };
                }
                if (act === 'stop_1cr') {
                    this.state.climate1crActive = false;
                    writeAtomicSafe(cmdPath, JSON.stringify({ id: Date.now(), cmd: 'stop1cr', arg: {} }));
                    this.emitTelemetry();
                    return { ok: true, summaryVi: 'Đã tắt chế độ làm mát / đề nổ 1CR.' };
                }
                if (act === 'valet_on' || act === 'valet_off') {
                    const want = act === 'valet_on';
                    this.state.valetEnabled = want;
                    writeAtomicSafe(cmdPath, JSON.stringify({ id: Date.now(), cmd: 'valet_toggle', arg: { enabled: want } }));
                    this.emitTelemetry();
                    return { ok: true, summaryVi: want ? 'Đã bật giám sát Valet & ghim vị trí xe.' : 'Đã tắt chế độ Valet.' };
                }
                if (act === 'snap_telegram') {
                    writeAtomicSafe(cmdPath, JSON.stringify({ id: Date.now(), cmd: 'snap_now', arg: {} }));
                    return { ok: true, summaryVi: 'Đang chụp trạng thái xe gửi về Telegram của đại ca.' };
                }
                return { ok: true, summaryVi: 'Trạng thái 1CR: ' + (this.state.climate1crActive ? 'Đang chạy' : 'Đang tắt') + '.' };
            }

            case 'scan_vehicle_health': {
                const t = this.state;
                const lowTyres = [];
                Object.keys(t.tyresBar).forEach((k) => {
                    if (t.tyresBar[k] < 2.1) lowTyres.push(k.toUpperCase() + ' (' + t.tyresBar[k] + ' bar)');
                });
                const issues = [];
                if (t.battery12v < 11.9) issues.push('Bình 12V hơi yếu (' + t.battery12v + 'V)');
                if (lowTyres.length) issues.push('Lốp non hơi: ' + lowTyres.join(', '));
                if (t.oilTempC > 122) issues.push('Nhiệt độ dầu máy cao (' + t.oilTempC + '°C)');
                if (t.checkControlCount > 0) issues.push('Có ' + t.checkControlCount + ' thông báo Check Control');

                const healthSummary = issues.length === 0
                    ? ('Xe sạch lỗi! Bình 12V đạt ' + t.battery12v + 'V, dầu máy ' + t.oilTempC + '°C, nước làm mát ' + t.coolantTempC +
                        '°C, 4 lốp cân đều ~' + t.tyresBar.fl + ' bar, còn đi được khoảng ' + t.rangeKm + ' km.')
                    : ('Phát hiện lưu ý: ' + issues.join('; ') + '. Bình ' + t.battery12v + 'V, dầu máy ' + t.oilTempC + '°C.');
                return { ok: true, health: { issues, telemetry: t }, summaryVi: healthSummary };
            }

            case 'run_scene': {
                const scene = String(args.scene || 'chill_night').toLowerCase();
                this.state.activeScene = scene;
                if (scene === 'chill_night') {
                    await this.executeDirect('set_ambient_light', { color: 'sunset_purple', brightness: 45 }, speakerZone);
                    await this.executeDirect('set_climate', { tempC: 24.0, fanLevel: 2, scentOn: true, zone: 'both' }, speakerZone);
                    await this.executeDirect('control_media', { action: 'youtube_search_play', query: 'Lofi Chill Night Drive', volumePercent: 32 }, speakerZone);
                    this.emitTelemetry();
                    return { ok: true, summaryVi: 'Đã bật kịch bản Chill đêm: đèn Tím hoàng hôn 45%, điều hoà 24°C kèm nước hoa nhẹ và nhạc Lofi âm lượng 32%.' };
                }
                if (scene === 'cool_down') {
                    await this.executeDirect('set_climate', { maxAc: true }, speakerZone);
                    await this.executeDirect('set_seat_comfort', { seat: 'both', coolingLevel: 3 }, speakerZone);
                    await this.executeDirect('control_windows_roof', { target: 'blinds', action: 'close' }, speakerZone);
                    await this.executeDirect('set_ambient_light', { color: 'ice_cyan', brightness: 85 }, speakerZone);
                    this.emitTelemetry();
                    return { ok: true, summaryVi: 'Đã bật kịch bản Hạ nhiệt cấp tốc: Max AC, làm mát 2 ghế trước mức 3, kéo rèm nắng và đổi đèn Xanh băng.' };
                }
                if (scene === 'cinema_park') {
                    this.preCinemaBackup = { ambient: Object.assign({}, this.state.ambient) };
                    await this.executeDirect('set_climate', { tempC: 23.0, fanLevel: 2, freshAir: true, zone: 'both' }, speakerZone);
                    await this.executeDirect('set_seat_comfort', { seat: 'driver', massage: true }, speakerZone);
                    await this.executeDirect('control_windows_roof', { target: 'blinds', action: 'close' }, speakerZone);
                    await this.executeDirect('set_ambient_light', { color: 'amber', brightness: 20 }, speakerZone);
                    await this.executeDirect('control_media', { action: 'youtube_search_play', query: args.query || 'Top Trending Vietnam', volumePercent: 45 }, speakerZone);
                    this.emitTelemetry();
                    return { ok: true, summaryVi: 'Đã bật kịch bản Rạp phim tại chỗ (số P): lấy gió ngoài chống ngạt, bật massage ghế tài, kéo rèm, đèn Hổ phách 20% và mở YouTube TV.' };
                }
                if (scene === 'focus_sport') {
                    await this.executeDirect('set_ambient_light', { color: 'm_red', brightness: 90 }, speakerZone);
                    await this.executeDirect('set_seat_comfort', { seat: 'driver', coolingLevel: 2 }, speakerZone);
                    const exRes = await this.invokeTool('set_exhaust_flap', { mode: 'open' }, speakerZone);
                    this.emitTelemetry();
                    return { ok: true, summaryVi: 'Đã bật kịch bản Thể thao: đèn Đỏ M-Red 90%, làm mát ghế tài. ' + exRes.summaryVi };
                }
                if (scene === 'normal' || scene === 'reset') {
                    this.state.activeScene = 'none';
                    await this.executeDirect('set_ambient_light', { color: 'm_blue', brightness: 70 }, speakerZone);
                    await this.executeDirect('set_climate', { maxAc: false, tempC: 23.5, fanLevel: 2, zone: 'both' }, speakerZone);
                    await this.executeDirect('set_exhaust_flap', { mode: 'oem' }, speakerZone);
                    this.emitTelemetry();
                    return { ok: true, summaryVi: 'Đã đưa đèn, điều hoà và van bô về lại chế độ lái tiêu chuẩn.' };
                }
                return { ok: false, summaryVi: 'Chưa nhận diện được kịch bản yêu cầu.' };
            }

            default:
                return { ok: false, summaryVi: 'Công cụ điều khiển "' + toolName + '" chưa được hỗ trợ.' };
        }
    }
}

module.exports = {
    AMBIENT_PRESETS,
    parseHexColor,
    createInitialTelemetry,
    VehicleController,
};
