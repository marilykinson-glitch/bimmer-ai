'use strict';
/**
 * vehicle-bus.js - Dual-Stack SP18 (iDrive 7 SignalGateway) + SP21 BMW MGU Vehicle Controller (`v0.3.1`).
 *
 * Hardware-verified on live BMW F90LCI M5 (SP18 iDrive 7, `172.16.222.97`):
 *   1. Universal Franca Schema Coercer (`coerceByDataRef`): automatically populates struct `defaultValue`s
 *      from `/etc/oap/someip/someip-interfaces.json` `db.datatypes` and translates numeric enum values into
 *      the exact German/Franca string enum keys required by `/usr/lib/someip.node`.
 *   2. Real SP18 & Genivi interfaces verified live on MGU:
 *      - `Climate2` (`46358`): `operationAirConditioningFront` (verified `temperatureTargetDRIHKA` readback on IHKA),
 *        `operationStratificationSeatHeating`
 *      - `Climate` (`46353`): `acSpecialFunction` (Fresh Air / Recirc / Ambient Air Scent / Sync), `seatAutoClimateDR`
 *      - `ComfortFunctionIuK` (`46354`): `ambientLightInteriorColour` (`FARBAUSWAHL_1..12` + brightness)
 *      - `ComfortFunction2` (`46360`): `seatMassageFL`, `seatMassageFR`
 *      - `SteeringWheelClimate` (`20482`): `requestHeating`
 *      - `WindowLifter` (`20481`): `moveWindow` (`DRIVER`, `PASSENGER`, `DRIVER_REAR`, `PASSENGER_REAR`, `ALL_WINDOWS`)
 *      - `SunProtectionRoofWindows` (`21761`) + `ControlRoofsystem` (`5443`): panoramic/sliding sunroof & sunshade
 *      - `Vehicle2` (`46361`): `statusCarSpeed2`, `statusZVStatus`, `remoteControlDoor`, `remoteControlSignals`
 *      - `CommandControl` (`45088`): `getVolume` / `setVolume` (`sinkID: 1`) / `setSinkMuteState` (`MS_MUTED` / `MS_UNMUTED`)
 *      - `MediaPlayer` (`45122`): `CarPlayMedia`, `ExternalDeviceBtA`, `AndroidAutoProjected`, `OapGenericMedia`
 *   3. Persistent `jap-ridetube-d` YouTube TV socket (`/run/jap-ridetube-d/ctl.sock`, `ev === 'results'` + persistent play)
 *      and `iteriodev-comfort` socket (`/run/iteriodev-comfort/ctl.sock`, RGB ambient + seat memory + Gentleman + Easy Exit).
 *
 * Node 8 compatible, zero external npm dependencies.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');

const SafetyGate = require('./safety-gate');

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const CATALOG_PATH = env('BA_CATALOG', '/etc/oap/someip/someip-interfaces.json');
const SOMEIP_PATH = env('BA_SOMEIP', '/usr/lib/someip.node');
const COMFORT_SOCK = env('BA_COMFORT_SOCK', '/run/iteriodev-comfort/ctl.sock');
const RIDETUBE_SOCK = env('BA_RIDETUBE_SOCK', '/run/jap-ridetube-d/ctl.sock');
const BIMMERLINK_RUN = env('BA_BIMMERLINK_RUN', '/run/bimmer-link');
const VIETMAP_RUN = env('BA_VIETMAP_RUN', '/run/vietmap-signs');

const APPMGMTS = [
    '/usr/lib/oap-mainapp/src/AppManagement/AppManagement.js',
    '/usr/lib/oap-mainapp21/src/AppManagement/AppManagement.js',
];

const AMBIENT_PRESETS = {
    amber: { name: 'Đồng / Hổ phách', hex: '#FF8C00', r: 254, g: 140, b: 0, menuIdx: 1 },
    orange: { name: 'Cam BMW', hex: '#FF5500', r: 254, g: 85, b: 0, menuIdx: 3 },
    ice_white: { name: 'Trắng lạnh', hex: '#EAF6FF', r: 234, g: 246, b: 254, menuIdx: 5 },
    m_blue: { name: 'Xanh M-Blue', hex: '#0066FF', r: 0, g: 102, b: 254, menuIdx: 7 },
    ice_cyan: { name: 'Xanh băng', hex: '#00D4FF', r: 0, g: 212, b: 254, menuIdx: 8 },
    emerald: { name: 'Xanh ngọc lục', hex: '#00C853', r: 0, g: 200, b: 83, menuIdx: 9 },
    sunset_purple: { name: 'Tím Lilac / Hoàng hôn', hex: '#8A2BE2', r: 138, g: 43, b: 226, menuIdx: 11 },
    neon_pink: { name: 'Hồng Neon', hex: '#FF2E93', r: 254, g: 46, b: 147, menuIdx: 11 },
    m_red: { name: 'Đỏ thể thao', hex: '#FF1E38', r: 254, g: 30, b: 56, menuIdx: 3 },
    oem: { name: 'Màu zin theo xe', hex: '#3B82F6', r: 59, g: 130, b: 246, menuIdx: 7, isOem: true },
};

const CLIMATE_ZONE = { all: 0, both: 0, sync: 0, driver: 1, passenger: 2 };
const WINDOW_ID_SP21 = { fl: 0, fr: 1, rl: 2, rr: 3 };
const WINDOW_ID_SP18 = { fl: 'DRIVER', fr: 'PASSENGER', rl: 'DRIVER_REAR', rr: 'PASSENGER_REAR' };
const MEDIA_BTN_ENUM = { play: 'PLAY', pause: 'PAUSE', stop: 'STOP', previous: 'ITEM_PREV', next: 'ITEM_NEXT' };
const IPA_LIGHT = { off: 0, center: 1, listenDriver: 2, listenPassenger: 3, speakDriver: 4, speakPassenger: 5 };

function parseHexColor(input) {
    if (!input) return null;
    const key = String(input).trim().toLowerCase();
    if (AMBIENT_PRESETS[key]) return Object.assign({ key }, AMBIENT_PRESETS[key]);
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(key);
    if (m) {
        const r = Math.min(254, parseInt(m[1], 16));
        const g = Math.min(254, parseInt(m[2], 16));
        const b = Math.min(254, parseInt(m[3], 16));
        const hex = '#' + m[1].toUpperCase() + m[2].toUpperCase() + m[3].toUpperCase();
        return { key: 'custom', name: hex, hex, r, g, b, menuIdx: 7 };
    }
    return null;
}

/**
 * Coerces a partial JS payload or primitive into the exact schema expected by `/usr/lib/someip.node`,
 * automatically filling struct `defaultValue`s and converting integer enum codes into Franca enum key strings.
 */
function enumKeyForValue(enumDef, val) {
    if (!enumDef || !enumDef.items) return val;
    if (typeof val === 'string' && enumDef.items[val] !== undefined) return val;
    const keys = Object.keys(enumDef.items);
    for (let i = 0; i < keys.length; i++) {
        if (enumDef.items[keys[i]] === val) return keys[i];
    }
    if (enumDef.defaultValue !== undefined) {
        for (let j = 0; j < keys.length; j++) {
            if (enumDef.items[keys[j]] === enumDef.defaultValue) return keys[j];
        }
    }
    return keys[0];
}

function coerceByDataRef(datatypes, dataRef, val, depth) {
    if (!datatypes || !dataRef || (depth || 0) > 7) return val;
    const t = datatypes[dataRef];
    if (!t) {
        if (val !== undefined) return val;
        if (dataRef === 'Bool' || dataRef === 'Boolean') return false;
        if (dataRef === 'String') return '';
        return 0;
    }
    if (t.type === 'typedef' && t.dataRef) {
        return coerceByDataRef(datatypes, t.dataRef, val !== undefined ? val : t.defaultValue, (depth || 0) + 1);
    }
    if (t.type === 'enum') {
        return enumKeyForValue(t, val !== undefined ? val : t.defaultValue);
    }
    if (t.type === 'struct' && Array.isArray(t.members)) {
        const out = {};
        const src = (val && typeof val === 'object') ? val : {};
        for (let i = 0; i < t.members.length; i++) {
            const mb = t.members[i];
            const raw = src[mb.name] !== undefined ? src[mb.name] : mb.defaultValue;
            out[mb.name] = coerceByDataRef(datatypes, mb.dataRef, raw, (depth || 0) + 1);
        }
        return out;
    }
    if (t.type === 'array' && t.dataRef) {
        const arr = Array.isArray(val) ? val : [];
        return arr.map((item) => coerceByDataRef(datatypes, t.dataRef, item, (depth || 0) + 1));
    }
    return val !== undefined ? val : (t.defaultValue !== undefined ? t.defaultValue : 0);
}

function decodeSp18TempByte(raw) {
    if (typeof raw !== 'number' || !isFinite(raw) || raw <= 0 || raw >= 250) return null;
    if (raw >= 30 && raw <= 64) return +(raw * 0.5).toFixed(1);
    if (raw >= 0 && raw <= 28) return +(16 + raw * 0.5).toFixed(1);
    return null;
}

function encodeSp18TempByte(tempC, observedRaw) {
    if (typeof observedRaw === 'number' && observedRaw > 0 && observedRaw <= 28) {
        return Math.max(0, Math.min(28, Math.round((tempC - 16) * 2)));
    }
    return Math.max(32, Math.min(56, Math.round(tempC * 2)));
}

function createInitialTelemetry() {
    return {
        liveCar: false,
        availableProxies: [],
        lastBusTrace: '',
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
        odometerKm: 0,
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
            comfortBridge: false,
        },
        media: {
            playing: false,
            source: 'Media',
            title: 'Chưa phát nhạc',
            volumePercent: 25,
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
        const bundleText = fs.readFileSync(APPMGMTS[i], 'utf8');
        const m = /"someip-interfaces-generator\/IFConfigGenerator(?:\.js)?":(\d+)/.exec(bundleText);
        const tail = /,\{\},\[\d+\]\)\s*;?\s*$/;
        if (m && tail.test(bundleText)) {
            const bundleReq = new Function('require', 'return ' + bundleText.replace(tail, ',{},[])'))(require);
            return bundleReq(m[1]);
        }
        const start = bundleText.indexOf('/*** "./node_modules/mgu-IFA/IFConfigGenerator.js":');
        if (start >= 0) {
            const firstFn = bundleText.indexOf('function(', start);
            const end = bundleText.indexOf('\n/***/ }),', firstFn);
            if (firstFn >= 0 && end > firstFn) {
                const mod = { exports: {} };
                const fn = new Function('return (' + bundleText.slice(firstFn, end) + ')')();
                fn(mod, mod.exports, function (id) { return require(id); });
                if (mod.exports && typeof mod.exports.generate === 'function') return mod.exports;
            }
        }
    }
    return null;
}

function sendComfortOp(sockPath, payload) {
    return new Promise((resolve) => {
        if (!sockPath || !fs.existsSync(sockPath)) return resolve({ ok: false, reason: 'absent' });
        let done = false;
        const finish = (v) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { sock.destroy(); } catch (e) {}
            resolve(v);
        };
        const sock = net.createConnection(sockPath, () => {
            sock.write(JSON.stringify(payload) + '\n');
            setTimeout(() => finish({ ok: true }), 140);
        });
        const timer = setTimeout(() => finish({ ok: true }), 500);
        sock.on('error', (e) => finish({ ok: false, error: e.message }));
    });
}

class VehicleController {
    constructor(opts) {
        this.opts = Object.assign({
            catalogPath: CATALOG_PATH,
            someipPath: SOMEIP_PATH,
            comfortSock: COMFORT_SOCK,
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
        this.db = null;
        this.proxies = {};
        this.proxyIfaceMap = {};
        this.observedTempRaw = null;
        this.lockSeq = 1;
        this.preCinemaBackup = null;
        this.pttDownAt = 0;
        this.pttLongFired = false;
        this.pttHoldTimer = null;
        this.lastShortPttAt = 0;
        this.lastPttDispatchAt = 0;
        this.lastSpeechDialogState = null;

        // Persistent RideTube socket (`jap-ridetube-d` stops playback if client disconnects)
        this.rtSock = null;
        this.rtBuf = '';
        this.rtSearchWaiter = null;
    }

    log(msg) {
        if (this.opts.onLog) this.opts.onLog(msg);
    }

    recordTrace(traceMsg) {
        this.state.lastBusTrace = traceMsg;
        this.log(traceMsg);
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

    pollCompanionApps() {
        const bl = readJsonSafe(path.join(this.opts.bimmerlinkRun, 'status.json'));
        if (bl && bl.telemetry) {
            if (bl.telemetry.climate1cr) this.state.climate1crActive = !!bl.telemetry.climate1cr.active;
            if (bl.valet) this.state.valetEnabled = !!bl.valet.enabled;
            if (typeof bl.telemetry.battery12v === 'number') this.state.battery12v = bl.telemetry.battery12v;
            if (typeof bl.telemetry.fuelPct === 'number') this.state.fuelPercent = bl.telemetry.fuelPct;
            if (typeof bl.telemetry.rangeKm === 'number') this.state.rangeKm = bl.telemetry.rangeKm;
            if (typeof bl.telemetry.odometerKm === 'number') this.state.odometerKm = bl.telemetry.odometerKm;
            if (typeof bl.telemetry.ambientC === 'number') this.state.outsideTempC = bl.telemetry.ambientC;
        }
        const vm = readJsonSafe(path.join(this.opts.vietmapRun, 'status.json'));
        if (vm) {
            if (typeof vm.speedLimit === 'number') this.state.vietmap.speedLimitKmh = vm.speedLimit;
            if (typeof vm.nextLimit === 'number') this.state.vietmap.nextLimitKmh = vm.nextLimit;
            if (typeof vm.cameraDistanceM === 'number') this.state.vietmap.cameraAheadM = vm.cameraDistanceM;
            if (vm.roadName) this.state.vietmap.roadName = String(vm.roadName);
        }
        this.state.media.youtubeConnected = fs.existsSync(this.opts.ridetubeSock);
        this.state.ambient.comfortBridge = fs.existsSync(this.opts.comfortSock);
    }

    /* ---------------- Persistent RideTube Socket Client ---------------- */

    closeRideTube() {
        if (this.rtSock) {
            try { this.rtSock.destroy(); } catch (e) {}
            this.rtSock = null;
        }
        this.rtBuf = '';
    }

    ensureRideTubeClient() {
        return new Promise((resolve) => {
            if (!this.opts.ridetubeSock || !fs.existsSync(this.opts.ridetubeSock)) {
                return resolve(null);
            }
            if (this.rtSock && !this.rtSock.destroyed) {
                return resolve(this.rtSock);
            }
            this.closeRideTube();
            let settled = false;
            const sock = net.createConnection(this.opts.ridetubeSock, () => {
                this.rtSock = sock;
                if (!settled) { settled = true; resolve(sock); }
            });
            sock.setEncoding('utf8');
            sock.on('data', (chunk) => {
                this.rtBuf += chunk;
                let idx;
                while ((idx = this.rtBuf.indexOf('\n')) >= 0) {
                    const line = this.rtBuf.slice(0, idx).trim();
                    this.rtBuf = this.rtBuf.slice(idx + 1);
                    if (!line) continue;
                    try {
                        const ev = JSON.parse(line);
                        if ((ev.ev === 'results' || ev.ev === 'search') && this.rtSearchWaiter) {
                            const w = this.rtSearchWaiter;
                            this.rtSearchWaiter = null;
                            w({ ok: true, items: ev.items || [] });
                        } else if (ev.ev === 'error' && this.rtSearchWaiter) {
                            const w = this.rtSearchWaiter;
                            this.rtSearchWaiter = null;
                            w({ ok: false, error: ev.msg || 'RideTube error' });
                        } else if (ev.ev === 'state') {
                            if (ev.title && ev.title !== ev.id) this.state.media.title = String(ev.title);
                            if (ev.state === 'playing' || ev.state === 'preparing') {
                                this.state.media.playing = true;
                                this.state.media.source = 'YouTube TV';
                                this.emitTelemetry();
                            } else if (ev.state === 'paused' || ev.state === 'idle' || ev.state === 'ended') {
                                this.state.media.playing = false;
                                this.emitTelemetry();
                            }
                        }
                    } catch (e) {}
                }
            });
            sock.on('error', () => {
                this.rtSock = null;
                if (this.rtSearchWaiter) {
                    const w = this.rtSearchWaiter;
                    this.rtSearchWaiter = null;
                    w({ ok: false, error: 'socket error' });
                }
                if (!settled) { settled = true; resolve(null); }
            });
            sock.on('close', () => { this.rtSock = null; });
            setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, 800);
        });
    }

    async sendRideTubeCmd(msg) {
        const sock = await this.ensureRideTubeClient();
        if (!sock) return { ok: false, error: 'RideTube socket absent' };
        try {
            sock.write(JSON.stringify(msg) + '\n');
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    }

    async searchAndPlayRideTube(query) {
        const sock = await this.ensureRideTubeClient();
        if (!sock) return { ok: false, error: 'RideTube socket absent' };
        const searchRes = await new Promise((resolve) => {
            const timer = setTimeout(() => {
                if (this.rtSearchWaiter) {
                    this.rtSearchWaiter = null;
                    resolve({ ok: false, error: 'search timeout' });
                }
            }, 6500);
            this.rtSearchWaiter = (res) => {
                clearTimeout(timer);
                resolve(res);
            };
            sock.write(JSON.stringify({ cmd: 'search', q: query }) + '\n');
        });
        if (!searchRes.ok || !Array.isArray(searchRes.items) || !searchRes.items.length || !searchRes.items[0].id) {
            return { ok: false, error: searchRes.error || 'no results' };
        }
        const top = searchRes.items[0];
        sock.write(JSON.stringify({ cmd: 'play', id: top.id, rect: '1600x520', fill: true }) + '\n');
        return { ok: true, item: top };
    }

    /* ---------------- SOME/IP Proxy Helpers with Schema Coercion ---------------- */

    async refreshAvailableProxies() {
        const avail = [];
        const keys = Object.keys(this.proxies);
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            const px = this.proxies[k];
            if (px && typeof px.isAvailable === 'function') {
                try { if (await px.isAvailable()) avail.push(k); } catch (e) {}
            }
        }
        this.state.availableProxies = avail;
        return avail;
    }

    async isProxyAvailable(key) {
        if (!this.state.liveCar) return false;
        const px = this.proxies[key];
        if (!px || typeof px.isAvailable !== 'function') return false;
        try { return !!(await px.isAvailable()); } catch (e) { return false; }
    }

    coerceFieldPayload(key, field, partialPayload) {
        if (!this.db || !this.db.datatypes) return partialPayload;
        const ifaceName = this.proxyIfaceMap[key];
        const iv = ifaceName && this.db.interfaces && this.db.interfaces[ifaceName];
        const fd = iv && iv.fields && iv.fields[field];
        if (!fd || !fd.dataRef) return partialPayload;
        return coerceByDataRef(this.db.datatypes, fd.dataRef, partialPayload, 0);
    }

    coerceMethodArgs(key, method, rawArgs) {
        if (!this.db || !this.db.datatypes) return rawArgs || {};
        const ifaceName = this.proxyIfaceMap[key];
        const iv = ifaceName && this.db.interfaces && this.db.interfaces[ifaceName];
        const md = iv && iv.methods && iv.methods[method];
        if (!md || !Array.isArray(md.inputs)) return rawArgs || {};
        const src = rawArgs || {};
        const out = {};
        for (let i = 0; i < md.inputs.length; i++) {
            const inp = md.inputs[i];
            out[inp.name] = coerceByDataRef(this.db.datatypes, inp.dataRef, src[inp.name], 0);
        }
        return out;
    }

    async callMethodIfAvailable(key, method, args) {
        if (!this.state.liveCar) return { simulated: true, ok: true };
        if (!(await this.isProxyAvailable(key))) return { ok: false, unavailable: true };
        try {
            const coercedArgs = this.coerceMethodArgs(key, method, args);
            const res = await this.proxies[key].callMethod(method, coercedArgs, 3000);
            this.recordTrace('OK call ' + key + '.' + method);
            return { ok: true, response: res };
        } catch (e) {
            this.recordTrace('ERR call ' + key + '.' + method + ': ' + e.message);
            return { ok: false, error: e.message };
        }
    }

    async setFieldIfAvailable(key, field, partialPayload) {
        if (!this.state.liveCar) return { simulated: true, ok: true };
        if (!(await this.isProxyAvailable(key))) return { ok: false, unavailable: true };
        try {
            const coerced = this.coerceFieldPayload(key, field, partialPayload);
            const res = await this.proxies[key].setValue(field, coerced, 3000);
            this.recordTrace('OK set ' + key + '.' + field);
            return { ok: true, response: res };
        } catch (e) {
            this.recordTrace('ERR set ' + key + '.' + field + ': ' + e.message);
            return { ok: false, error: e.message };
        }
    }

    async initHardwareBus() {
        this.pollCompanionApps();
        if (!fs.existsSync(this.opts.catalogPath) || !fs.existsSync(this.opts.someipPath)) {
            this.log('vehicle-bus: running in simulation/companion mode');
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
        this.db = db;

        let chain = Promise.resolve();
        const openProxy = (ifaceName, attrs, methods, instanceHint) => {
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
                    const inst = instanceHint || Object.keys(cfg.instances || { '1': 1 })[0] || '1';
                    if (cfg.instances && !cfg.instances[inst]) return res(null);
                    someip.buildProxy(cfg, String(inst))
                        .then((px) => px.init().then(() => res(px)))
                        .catch(() => res(null));
                } catch (e) { res(null); }
            }));
            const p = chain.then(step, step);
            chain = p;
            return p;
        };

        const bindService = async (key, ifaceName, fieldNames, methodNames, onField, instanceHint) => {
            const iv = db.interfaces && db.interfaces[ifaceName];
            if (!iv) return;
            const attrs = {};
            (fieldNames || []).forEach((f) => {
                const fd = iv.fields && iv.fields[f];
                if (!fd) return;
                let fl = '';
                if (fd.getter && fd.getter.id) fl += 'r';
                if (fd.notifier && fd.notifier.id) fl += 's';
                if (fd.setter && fd.setter.id) fl += 'w';
                if (fl) attrs[f] = fl;
            });
            const validMethods = (methodNames || []).filter((m) => iv.methods && iv.methods[m]);
            if (!Object.keys(attrs).length && !validMethods.length) return;
            const px = await openProxy(ifaceName, attrs, validMethods, instanceHint);
            if (!px) return;
            this.proxies[key] = px;
            this.proxyIfaceMap[key] = ifaceName;
            this.state.liveCar = true;
            Object.keys(attrs).forEach((f) => {
                if (onField && (attrs[f].indexOf('s') >= 0 || attrs[f].indexOf('r') >= 0)) {
                    if (attrs[f].indexOf('s') >= 0) {
                        try { px.subscribe({ name: f, onReceive: (v) => onField(f, v) }); } catch (e) {}
                    }
                    if (attrs[f].indexOf('r') >= 0) {
                        try { px.getValue(f, 2500).then((v) => onField(f, v)).catch(() => {}); } catch (e) {}
                    }
                }
            });
        };

        // 1. Core Driving, Thermal & Central Locking Telemetry (`CDS`, `Vehicle2`, `VehicleInformation`)
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

        await bindService('vehicle2', 'de.bmw.infotainment.vehicle.Vehicle2', [
            'statusCarSpeed2',
            'statusZVStatus',
            'remoteControlDoor',
            'remoteControlSignals',
        ], [], (f, v) => {
            if (!v) return;
            if (f === 'statusCarSpeed2' && v.speedVehicleCentreOfGravity !== undefined && v.speedVehicleCentreOfGravity !== 65535) {
                this.patchTelemetry({ speedKmh: +(v.speedVehicleCentreOfGravity * 0.015625).toFixed(1) });
            } else if (f === 'statusZVStatus') {
                const patch = {};
                if (typeof v.statusCentralLockingSystem === 'number') {
                    if (v.statusCentralLockingSystem === 1) patch.doorsLocked = false;
                    else if (v.statusCentralLockingSystem === 2 || v.statusCentralLockingSystem === 3) patch.doorsLocked = true;
                }
                if (v.statusContactBootLid === 1 || v.statusContactBootLid === 'HK_IST_OFFEN') {
                    patch.trunkOpen = true;
                } else if (v.statusContactBootLid === 0 || v.statusContactBootLid === 'HK_IST_GESCHLOSSEN') {
                    patch.trunkOpen = false;
                }
                if (Object.keys(patch).length > 0) this.patchTelemetry(patch);
            }
        });

        await bindService('vehInfo', 'de.bmw.infrastructure.VehicleInformation', ['statusGearboxDrive'], [], (f, v) => {
            if (v && v.gearboxSelectorPosition !== undefined) {
                const g = String(v.gearboxSelectorPosition).toUpperCase();
                if (/^[PRNDSM]/.test(g)) this.patchTelemetry({ gear: g.charAt(0) });
            }
        });

        // 2. Steering wheel Push-To-Talk button (`SteeringWheelPushButton.statusPTTButton1`)
        //    IMPORTANT: Enum value `1` = `PTT_MINUS_TASTER_GEDRUECKT` (physical press), while `2` = `PTT_MINUS_TASTER_BERUEHRT`
        //    (capacitive finger touch sensor on M5 wheel!). Treat `2` / `BERUEHRT` strictly as NOT pressed!
        await bindService('steering', 'de.bmw.infotainment.controlelements.SteeringWheelPushButton', [
            'statusPTTButton1',
        ], [], (f, v) => {
            if (v === null || v === undefined) return;
            let raw = v;
            if (raw && typeof raw === 'object') {
                const keys = Object.keys(raw);
                if (!keys.length) return;
                raw = raw[keys[0]];
            }
            if (raw === null || raw === undefined) return;
            const sRaw = String(raw).toUpperCase();
            if (raw === 3 || raw === 15 || raw === 255 || /UNGUELTIG|UNBEFUELLT|INVALID/.test(sRaw)) return;
            let pressed = false;
            if (typeof raw === 'boolean') {
                pressed = raw;
            } else if (typeof raw === 'number') {
                pressed = (raw === 1);
            } else {
                const isReleased = /NICHT|BERUEHRT|RESERVIERT|LOSGELASSEN|RELEASE|IDLE|AUS|KEINE/.test(sRaw);
                const isActuated = /BETAETIGT|GEDRUECKT|PRESSED|KURZ|LANG|EIN|ACTIVE/.test(sRaw);
                pressed = !isReleased && isActuated;
            }
            this.handleSteeringPttSignal(f, pressed, raw);
        });

        // 2b. BMW Speech Dialog & Native Prompt Aborter (catches M-wheel PTT edge & silences "Không khả dụng" voice prompt)
        await bindService('speechDialog', 'de.bmw.infotainment.speech.dialog.Dialog', ['dialogState'], [], (f, v) => {
            if (v === null || v === undefined) return;
            const prev = this.lastSpeechDialogState;
            this.lastSpeechDialogState = v;
            this.log('speechDialog.' + f + ' = ' + String(v));
            const sVal = String(v).toUpperCase();
            const isRunning = (v === 2 || sVal === 'RUNNING');
            if (prev !== null && prev !== v && isRunning) {
                this.abortNativeSpeechPrompt();
                const now = Date.now();
                if (!this.state.pttPressed && (now - this.lastPttDispatchAt) > 1500) {
                    this.lastPttDispatchAt = now;
                    if (this.opts.onPttEvent) {
                        this.opts.onPttEvent({ button: 'speechDialog', kind: 'short_press', heldMs: 120 });
                    }
                }
            }
        }, 'HMISpeechHU');
        await bindService('speechPrompter', 'de.bmw.infotainment.speech.prompter.Prompter', [], ['abortPrompt'], null, 'PALSpeechHU');
        await bindService('voicePrompt', 'de.bmw.infotainment.speech.voiceprompt.VoicePrompt', [], ['abort']);

        // 3. Telephony & CarPlay voice call yield guard
        await bindService('voiceCall', 'de.bmw.infotainment.connectivity.telephony.VoiceCall', ['state'], [], (f, v) => {
            const active = !!(v && String(v).toUpperCase().indexOf('IDLE') < 0 && String(v).toUpperCase().indexOf('NONE') < 0 && v !== 0);
            this.patchTelemetry({ callActive: active });
        });
        await bindService('carplay', 'de.bmw.infotainment.a4a.carplay.CarPlayManager', ['projectedTelephonyActive'], [], (f, v) => {
            if (typeof v === 'boolean') this.patchTelemetry({ callActive: v });
        });

        // 4. SP18 Verified Interfaces (`Climate2`, `Climate`, `ComfortFunctionIuK`, `ComfortFunction2`, `WindowLifter`, `SteeringWheelClimate`, `SunProtectionRoofWindows`, `ControlRoofsystem`)
        await bindService('sp18Climate2', 'de.bmw.infotainment.climate.Climate2', [
            'operationAirConditioningFront',
            'operationStratificationSeatHeating',
            'statusAirConditionDRStatus',
            'statusAirConditionPSStatus',
        ], [], (f, v) => {
            if (!v) return;
            if (f === 'statusAirConditionDRStatus') {
                if (typeof v.temperatureTargetDRIHKA === 'number' && v.temperatureTargetDRIHKA !== 255) {
                    this.observedTempRaw = v.temperatureTargetDRIHKA;
                    const c = decodeSp18TempByte(v.temperatureTargetDRIHKA);
                    if (c !== null) this.state.climate.tempDriverC = c;
                }
                if (typeof v.statusBlowerSettingDR === 'number' && v.statusBlowerSettingDR >= 1 && v.statusBlowerSettingDR <= 9) {
                    this.state.climate.fanLevel = Math.min(5, v.statusBlowerSettingDR);
                }
                this.emitTelemetry();
            } else if (f === 'statusAirConditionPSStatus') {
                if (typeof v.temperatureTargetPSIHKA === 'number' && v.temperatureTargetPSIHKA !== 255) {
                    const c = decodeSp18TempByte(v.temperatureTargetPSIHKA);
                    if (c !== null) this.state.climate.tempPassengerC = c;
                    this.emitTelemetry();
                }
            }
        });

        await bindService('sp18Climate1', 'de.bmw.infotainment.climate.Climate', ['acSpecialFunction', 'seatAutoClimateDR', 'seatAutoClimatePS'], []);
        await bindService('sp18Comfort2', 'de.bmw.infotainment.misc.ComfortFunction2', ['seatMassageFL', 'seatMassageFR'], []);
        await bindService('sp18WheelHeat', 'de.bmw.body.steeringwheelcomfort.SteeringWheelClimate', [], ['requestHeating']);
        await bindService('sp18Ambient', 'de.bmw.infotainment.misc.ComfortFunctionIuK', ['ambientLightInteriorColour', 'statusAmbientLightInteriorColour'], []);
        await bindService('windowLifter', 'de.bmw.body.windowmaster.WindowLifter', [], ['moveWindow']);
        await bindService('sp18SunRoof', 'de.bmw.body.doorsandwindows.SunProtectionRoofWindows', ['operationSHDMDS', 'controlShadowingPanoramicRoof'], []);
        await bindService('sp18RoofSys', 'de.bmw.infrastructure.ControlRoofsystem', ['controlRoofSystem'], []);
        await bindService('sp18LockGw', 'de.bmw.body.centrallockingsystem.CentralLockingSystemGW', ['requestCentralLockingSystem'], []);
        await bindService('sp18DrivingExcitement', 'de.bmw.infotainment.drivingexcitement.DrivingExcitement', ['controlFESDriveStrategy'], []);

        // 5. SP21 Method Interfaces (auto-used when available on iDrive 8 / SP21)
        await bindService('climateMaster', 'de.bmw.infotainment.climate.climatemaster.ClimateMaster',
            ['statusClimateSystemOn'],
            ['requestTemperature', 'requestDeltaTemperature', 'requestAirBlowLevel', 'requestAirCondMaxAC',
                'requestClimateSystemOn', 'requestAirQualityFresh', 'requestScentOn',
                'requestSeatClimateSeatHeating', 'requestSeatClimateSeatCooling', 'requestSteeringWheelHeating']);
        await bindService('windowMaster', 'de.bmw.body.windowmaster.WindowLifterMaster', ['windowStatus'], ['moveWindow', 'cancelLastRequest']);
        await bindService('sunBlinds', 'de.bmw.body.doorsandwindows.SunBlinds', ['blindStatusList'], ['openSideAndRearBlinds', 'closeSideAndRearBlinds']);
        await bindService('mirrors', 'de.bmw.body.ExteriorMirrorDynamicControl', [], ['requestExtMirrorFolding']);
        await bindService('locks', 'de.bmw.body.caraccess.CenterLockingService', [], ['requestLock', 'requestUnlock', 'requestOpenBootlid']);
        await bindService('ipaLight', 'de.bmw.body.interiorillumination.IpaInteriorLight', [], ['setIpaLightingInterior']);
        await bindService('flexLight', 'de.bmw.body.interiorillumination.flexlight.FlexLight', ['interiorLightActive'], ['setReadingLight', 'deactivateAllReadingLights']);

        // 6. Audio Manager, Media Players & Park Camera
        await bindService('audioCmd', 'org.genivi.am.commandinterface.CommandControl', ['listOfMainConnections'],
            ['connect', 'disconnect', 'getListMainSinks', 'getVolume', 'setVolume', 'volumeStep', 'setSinkMuteState'], null, '1');
        await bindService('mediaPlayer', 'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer', ['playerState'],
            ['playFile', 'sendButtonEvent'], null, 'OapGenericMedia');
        await bindService('mediaCarPlay', 'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer', ['playerState'],
            ['sendButtonEvent'], null, 'CarPlayMedia');
        await bindService('mediaBtA', 'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer', ['playerState'],
            ['sendButtonEvent'], null, 'ExternalDeviceBtA');
        await bindService('mediaAa', 'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer', ['playerState'],
            ['sendButtonEvent'], null, 'AndroidAutoProjected');
        await bindService('parkCam', 'de.bmw.dass.parking.parkmenu.userinteraction.UserInteractionParkmenu', ['selectedCamera'],
            ['hmiSelectCamera', 'requestParkingClosedown']);

        await new Promise((r) => setTimeout(r, 1500));
        await this.refreshAvailableProxies();

        if (await this.isProxyAvailable('audioCmd')) {
            try {
                const sinks = await this.proxies.audioCmd.callMethod('getListMainSinks', {}, 2500);
                const list = (sinks && sinks.listMainSinks) || [];
                for (let i = 0; i < list.length; i++) {
                    if (list[i].sinkID === 1) {
                        if (typeof list[i].volume === 'number' && list[i].volume > 0) {
                            this.state.media.volumePercent = list[i].volume;
                        }
                        this.state.media.muted = list[i].muteState === 'MS_MUTED' || list[i].muteState === 1;
                    }
                }
            } catch (e) {}
        }

        this.log('vehicle-bus v0.3.2 ready. Available proxies: ' + this.state.availableProxies.join(', '));
        this.emitTelemetry();
        return true;
    }

    abortNativeSpeechPrompt() {
        const doAbort = () => {
            this.callMethodIfAvailable('speechPrompter', 'abortPrompt', {}).catch(() => {});
            this.callMethodIfAvailable('voicePrompt', 'abort', {}).catch(() => {});
        };
        setTimeout(doAbort, 60);
        setTimeout(doAbort, 260);
    }

    handleSteeringPttSignal(field, pressed, raw) {
        const now = Date.now();
        if (pressed === this.state.pttPressed && (!pressed || this.pttDownAt > 0)) return;
        this.state.pttPressed = pressed;
        this.log('steering PTT signal: ' + field + ' raw=' + String(raw) + ' pressed=' + pressed);

        if (pressed) {
            this.pttDownAt = now;
            this.pttLongFired = false;
            if (this.pttHoldTimer) clearTimeout(this.pttHoldTimer);
            // Fire `long_press` immediately at 650ms while button is held so user can speak right away
            this.pttHoldTimer = setTimeout(() => {
                this.pttHoldTimer = null;
                if (this.state.pttPressed && !this.pttLongFired) {
                    this.pttLongFired = true;
                    this.lastPttDispatchAt = Date.now();
                    if (this.opts.onPttEvent) {
                        this.opts.onPttEvent({ button: field, kind: 'long_press', heldMs: Date.now() - this.pttDownAt });
                    }
                }
            }, 650);
        } else if (this.pttDownAt > 0) {
            if (this.pttHoldTimer) {
                clearTimeout(this.pttHoldTimer);
                this.pttHoldTimer = null;
            }
            const heldMs = now - this.pttDownAt;
            const alreadyLong = this.pttLongFired;
            this.pttDownAt = 0;
            this.pttLongFired = false;
            if (alreadyLong) return;
            if (heldMs >= 30) {
                this.abortNativeSpeechPrompt();
                const isDouble = (now - this.lastShortPttAt) < 650;
                this.lastShortPttAt = now;
                this.lastPttDispatchAt = now;
                if (this.opts.onPttEvent) {
                    this.opts.onPttEvent({ button: field, kind: isDouble ? 'double_press' : 'short_press', heldMs });
                }
            }
        }
    }

    async connectAudioRoute(route) {
        if (!(await this.isProxyAvailable('audioCmd')) || !route) return null;
        const tryPair = async (srcId, snkId) => {
            const r = await this.proxies.audioCmd.callMethod('connect', { sourceID: srcId, sinkID: snkId }, 2500);
            if (r && (r.amError === 'E_OK' || r.amError === 'E_ALREADY_EXISTS' || r.amError === 0) && r.mainConnectionID !== undefined) {
                return {
                    connId: r.mainConnectionID,
                    created: (r.amError === 'E_OK' || r.amError === 0),
                };
            }
            return null;
        };
        try {
            const tok1 = await tryPair(route.sourceID, route.sinkID);
            if (tok1 !== null) return tok1;
            if (route.fallbackSourceID) return await tryPair(route.fallbackSourceID, route.sinkID);
        } catch (e) {}
        return null;
    }

    async disconnectAudioRoute(mainConnectionID) {
        if (!(await this.isProxyAvailable('audioCmd')) || mainConnectionID === null || mainConnectionID === undefined) return;
        try {
            await this.proxies.audioCmd.callMethod('disconnect', { mainConnectionID }, 2500);
        } catch (e) {}
    }

    async pulseIpaLight(mode) {
        const val = IPA_LIGHT[mode] !== undefined ? IPA_LIGHT[mode] : 0;
        await this.callMethodIfAvailable('ipaLight', 'setIpaLightingInterior', {
            ipaInteriorLightFunction: { ipaInteriorLightFunction: val },
        });
    }

    async playTtsOnCarSpeakers(mp3File, speakerZone) {
        await this.pulseIpaLight(speakerZone === 'passenger' ? 'speakPassenger' : 'speakDriver');
        if (!(await this.isProxyAvailable('audioCmd')) || !(await this.isProxyAvailable('mediaPlayer')) || !fs.existsSync(mp3File)) {
            setTimeout(() => { this.pulseIpaLight('off').catch(() => {}); }, 1600);
            return false;
        }
        if (this.state.media.playing && this.state.media.source === 'YouTube TV') {
            setTimeout(() => { this.pulseIpaLight('off').catch(() => {}); }, 1800);
            return false;
        }
        let routeTok = null;
        try {
            const retryDelays = [0, 220, 450];
            for (let di = 0; di < retryDelays.length; di++) {
                if (retryDelays[di]) await new Promise((r) => setTimeout(r, retryDelays[di]));
                routeTok = await this.connectAudioRoute({ sourceID: 1046, sinkID: 1024 });
                if (routeTok) break;
            }
            const pf = await this.proxies.mediaPlayer.callMethod('playFile', { path: mp3File, languageCode: 7695972 }, 4000);
            if (pf && pf.EntError && pf.EntError !== 'OK' && pf.EntError !== 0) {
                throw new Error('playFile ' + pf.EntError);
            }
            setTimeout(() => {
                this.callMethodIfAvailable('mediaPlayer', 'sendButtonEvent', { button: 'STOP', action: 'PRESS' }).catch(() => {});
                if (routeTok && routeTok.created && routeTok.connId !== null) {
                    this.disconnectAudioRoute(routeTok.connId).catch(() => {});
                }
                this.pulseIpaLight('off').catch(() => {});
            }, 4200);
            return true;
        } catch (e) {
            this.log('playTtsOnCarSpeakers warning: ' + e.message);
            if (routeTok && routeTok.created && routeTok.connId !== null) {
                await this.disconnectAudioRoute(routeTok.connId);
            }
            await this.pulseIpaLight('off');
            return false;
        }
    }

    checkDeferredWatches() {
        if (this.state.activeScene === 'cinema_park' && SafetyGate.isVehicleMoving(this.state)) {
            this.state.activeScene = 'none';
            if (this.preCinemaBackup) {
                this.state.ambient = Object.assign({}, this.preCinemaBackup.ambient);
                this.preCinemaBackup = null;
            }
            this.state.cameraView = 'off';
            this.sendRideTubeCmd({ cmd: 'video', on: false }).catch(() => {});
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

    async invokeTool(toolName, rawArgs, speakerZone) {
        this.pollCompanionApps();
        await this.refreshAvailableProxies();
        const gate = SafetyGate.evaluateToolCall(toolName, rawArgs, this.state, this.guards);
        if (gate.decision === 'block') {
            return { ok: false, blocked: true, code: gate.code, summaryVi: gate.reasonVi };
        }
        if (gate.decision === 'defer') {
            this.deferredWatches = this.deferredWatches.filter((w) => w.id !== gate.watch.id).concat([gate.watch]);
            this.emitTelemetry();
            return { ok: true, deferred: true, code: gate.code, summaryVi: gate.reasonVi };
        }
        return this.executeDirect(toolName, gate.normalizedArgs, speakerZone || 'driver');
    }

    async executeDirect(toolName, args, speakerZone) {
        const zoneDefault = speakerZone === 'passenger' ? 'passenger' : 'driver';

        switch (toolName) {
            case 'set_climate': {
                const targetZone = args.zone || zoneDefault;
                const opZone = CLIMATE_ZONE[targetZone] !== undefined ? CLIMATE_ZONE[targetZone] : 1;
                const sp18Front = {};
                const sp18Spec = {};
                let sp18FrontTouched = false;
                let sp18SpecTouched = false;
                let anyBusOk = !this.state.liveCar;
                const changes = [];

                if (args.systemOn !== undefined) {
                    this.state.climate.on = !!args.systemOn;
                    sp18Front.operationOnDR = args.systemOn ? 'EIN' : 'AUS';
                    sp18Front.operationOnPS = args.systemOn ? 'EIN' : 'AUS';
                    sp18FrontTouched = true;
                    const r21 = await this.callMethodIfAvailable('climateMaster', 'requestClimateSystemOn', {
                        clientGroupId: 0,
                        climateSystemOn: [{ airConditioningOn: !!args.systemOn, operationZone: 0, saveLUM: true }],
                    });
                    if (r21.ok) anyBusOk = true;
                    changes.push(this.state.climate.on ? 'bật điều hoà' : 'tắt điều hoà');
                }
                if (args.maxAc !== undefined) {
                    this.state.climate.maxAc = !!args.maxAc;
                    sp18Front.operationMaximumAirCondition = args.maxAc ? 'EIN' : 'AUS';
                    if (args.maxAc) {
                        this.state.climate.on = true;
                        this.state.climate.tempDriverC = 16.0;
                        this.state.climate.tempPassengerC = 16.0;
                        this.state.climate.fanLevel = 5;
                        sp18Front.operationOnDR = 'EIN';
                        sp18Front.operationAircon = 'EIN';
                    }
                    sp18FrontTouched = true;
                    const r21 = await this.callMethodIfAvailable('climateMaster', 'requestAirCondMaxAC', {
                        clientGroupId: 0,
                        airCondMaxAC: [{ maxAirConditioning: !!args.maxAc, operationZone: 1, saveLUM: true }],
                    });
                    if (r21.ok) anyBusOk = true;
                    changes.push(args.maxAc ? 'bật Max AC lạnh sâu' : 'tắt Max AC');
                }
                if (args.tempC !== undefined) {
                    this.state.climate.on = true;
                    const rawByte = encodeSp18TempByte(args.tempC, this.observedTempRaw);
                    if (opZone === 0) {
                        this.state.climate.tempDriverC = args.tempC;
                        this.state.climate.tempPassengerC = args.tempC;
                        sp18Front.operationTemperatureTargetDR = rawByte;
                        sp18Front.operationTemperatureTargetPS = rawByte;
                        changes.push('chỉnh nhiệt độ cả 2 vùng ' + args.tempC + '°C');
                    } else if (opZone === 2) {
                        this.state.climate.tempPassengerC = args.tempC;
                        sp18Front.operationTemperatureTargetPS = rawByte;
                        changes.push('chỉnh điều hoà ghế phụ ' + args.tempC + '°C');
                    } else {
                        this.state.climate.tempDriverC = args.tempC;
                        sp18Front.operationTemperatureTargetDR = rawByte;
                        changes.push('chỉnh điều hoà ghế tài ' + args.tempC + '°C');
                    }
                    sp18FrontTouched = true;
                    const r21 = await this.callMethodIfAvailable('climateMaster', 'requestTemperature', {
                        clientGroupId: 0,
                        temperatureAbsolute: opZone === 0
                            ? [{ targetTemperature: args.tempC, operationZone: 1, saveLUM: true }, { targetTemperature: args.tempC, operationZone: 2, saveLUM: true }]
                            : [{ targetTemperature: args.tempC, operationZone: opZone, saveLUM: true }],
                    });
                    if (r21.ok) anyBusOk = true;
                }
                if (args.deltaTempC !== undefined) {
                    const delta = Number(args.deltaTempC) || 0;
                    if (opZone === 2) {
                        this.state.climate.tempPassengerC = Math.max(16, Math.min(28, +(this.state.climate.tempPassengerC + delta).toFixed(1)));
                        sp18Front.operationTemperatureTargetPS = encodeSp18TempByte(this.state.climate.tempPassengerC, this.observedTempRaw);
                        changes.push('chỉnh ghế phụ sang ' + this.state.climate.tempPassengerC + '°C');
                    } else {
                        this.state.climate.tempDriverC = Math.max(16, Math.min(28, +(this.state.climate.tempDriverC + delta).toFixed(1)));
                        sp18Front.operationTemperatureTargetDR = encodeSp18TempByte(this.state.climate.tempDriverC, this.observedTempRaw);
                        changes.push('chỉnh ghế tài sang ' + this.state.climate.tempDriverC + '°C');
                    }
                    sp18FrontTouched = true;
                    const r21 = await this.callMethodIfAvailable('climateMaster', 'requestDeltaTemperature', {
                        clientGroupId: 0,
                        temperatureDelta: [{ deltaTemperature: delta, operationZone: opZone === 2 ? 2 : 1, saveLUM: true }],
                    });
                    if (r21.ok) anyBusOk = true;
                }
                if (args.fanLevel !== undefined) {
                    const lv = Math.max(1, Math.min(5, args.fanLevel));
                    if (opZone === 1 || opZone === 0) {
                        sp18Front.operationIntensityDR = 'KLIMASTIL_' + lv;
                        sp18Front.operationManualBlowerLevelDR = 'STUFE_' + lv;
                    }
                    if (opZone === 2 || opZone === 0) {
                        sp18Front.operationIntensityPS = 'KLIMASTIL_' + lv;
                        sp18Front.operationManualBlowerLevelPS = 'STUFE_' + lv;
                    }
                    sp18FrontTouched = true;
                    const r21 = await this.callMethodIfAvailable('climateMaster', 'requestAirBlowLevel', {
                        clientGroupId: 0,
                        airBlowLevel: [{ configuredManLevel: lv, gradientIntensity: 0, operationZone: opZone === 2 ? 2 : 1, saveLUM: true }],
                    });
                    if (r21.ok) anyBusOk = true;
                    this.state.climate.fanLevel = lv;
                    changes.push('mức gió ' + lv);
                }
                if (args.freshAir !== undefined) {
                    this.state.climate.freshAir = !!args.freshAir;
                    sp18Spec.operationAUCFront = args.freshAir ? 'FRISCHLUFT_GEWAEHLT' : 'UMLUFT_GEWAEHLT';
                    sp18SpecTouched = true;
                    const r21 = await this.callMethodIfAvailable('climateMaster', 'requestAirQualityFresh', {
                        clientGroupId: 0,
                        freshAir: args.freshAir ? 0 : 2,
                        saveLUM: true,
                    });
                    if (r21.ok) anyBusOk = true;
                    changes.push(args.freshAir ? 'lấy gió ngoài' : 'lấy gió trong');
                }
                if (args.scentOn !== undefined) {
                    this.state.climate.scentOn = !!args.scentOn;
                    sp18Spec.operationScent = args.scentOn ? 'BEDUFTER_AN' : 'BEDUFTER_AUS';
                    sp18SpecTouched = true;
                    const r21 = await this.callMethodIfAvailable('climateMaster', 'requestScentOn', {
                        scentOperation: { clientGroupId: 0, scentGeneratorOnOff: !!args.scentOn, saveLUM: true },
                    });
                    if (r21.ok) anyBusOk = true;
                    changes.push(args.scentOn ? 'bật nước hoa Ambient Air' : 'tắt nước hoa');
                }

                if (sp18FrontTouched) {
                    const r18 = await this.setFieldIfAvailable('sp18Climate2', 'operationAirConditioningFront', sp18Front);
                    if (r18.ok) anyBusOk = true;
                }
                if (sp18SpecTouched) {
                    const rSpec = await this.setFieldIfAvailable('sp18Climate1', 'acSpecialFunction', sp18Spec);
                    if (rSpec.ok) anyBusOk = true;
                }
                this.emitTelemetry();
                return {
                    ok: anyBusOk,
                    summaryVi: anyBusOk
                        ? ('Đã ' + (changes.join(', ') || 'cập nhật điều hoà') + '.')
                        : 'Không tìm thấy cổng điều khiển điều hoà khả dụng trên bus xe.',
                };
            }

            case 'set_seat_comfort': {
                const side = args.seat || zoneDefault;
                const zones = side === 'both' ? [1, 2] : [side === 'passenger' ? 2 : 1];
                const label = side === 'passenger' ? 'ghế phụ' : (side === 'both' ? '2 ghế trước' : 'ghế tài');
                const okNotes = [];
                const failNotes = [];

                if (args.gentlemanMove) {
                    const rg = !this.state.liveCar ? { ok: true } : await sendComfortOp(this.opts.comfortSock, { op: 'gentleman' });
                    if (rg.ok) okNotes.push('dịch gọn ghế phụ (Gentleman)');
                    else failNotes.push('chưa kết nối dịch vụ iteriodev-comfort để dịch ghế Gentleman');
                }
                if (args.memorySlot !== undefined) {
                    const slot = Math.max(0, Math.min(2, (Number(args.memorySlot) || 1) - 1));
                    const rm = !this.state.liveCar ? { ok: true } : await sendComfortOp(this.opts.comfortSock, {
                        op: 'memory',
                        seat: side === 'passenger' ? 'passenger' : 'driver',
                        slot,
                        save: false,
                    });
                    if (rm.ok) okNotes.push('gọi vị trí nhớ ghế số ' + (slot + 1));
                    else failNotes.push('chưa kết nối dịch vụ iteriodev-comfort để gọi nhớ ghế số ' + (slot + 1));
                }

                if (args.heatingLevel !== undefined || args.coolingLevel !== undefined) {
                    const hLv = args.heatingLevel !== undefined ? Math.max(0, Math.min(3, Math.round(Number(args.heatingLevel) || 0))) : 255;
                    const cLv = args.coolingLevel !== undefined ? Math.max(0, Math.min(3, Math.round(Number(args.coolingLevel) || 0))) : 255;
                    const sp18Seats = {};
                    let seatHwOk = !this.state.liveCar;

                    if (side === 'driver' || side === 'both') {
                        if (hLv !== 255) sp18Seats.oPFunctionStageSeatHeaterAICDriver = 'STUFE_' + hLv;
                        if (cLv !== 255) sp18Seats.oPFunctionStageSeatClimateAICDriver = 'STUFE_' + cLv;
                        const rAutoDr = await this.setFieldIfAvailable('sp18Climate1', 'seatAutoClimateDR', {
                            operationSeatHeaterStageDRS: hLv !== 255 ? ('STUFE_' + hLv) : 'SIGNAL_UNGUELTIG',
                            operationSeatHeaterActivationDRS: hLv !== 255 ? (hLv > 0 ? 'SITZHEIZUNGSFUNKTION_AN' : 'SITZHEIZUNGSFUNKTION_AUS') : 'SIGNAL_UNGUELTIG',
                            operationSeatVentilationStageDRS: cLv !== 255 ? ('STUFE_' + cLv) : 'SIGNAL_UNGUELTIG',
                            operationSeatVentilationActivationDRS: cLv !== 255 ? (cLv > 0 ? 'SITZLUEFTUNGSFUNKTION_AN' : 'SITZLUEFTUNGSFUNKTION_AUS') : 'SIGNAL_UNGUELTIG',
                        });
                        if (rAutoDr.ok) seatHwOk = true;
                    }
                    if (side === 'passenger' || side === 'both') {
                        if (hLv !== 255) sp18Seats.oPFunctionStageSeatHeaterAICPassenger = 'STUFE_' + hLv;
                        if (cLv !== 255) sp18Seats.oPFunctionStageSeatClimateAICPassenger = 'STUFE_' + cLv;
                        const rAutoPs = await this.setFieldIfAvailable('sp18Climate1', 'seatAutoClimatePS', {
                            operationSeatHeaterStagePSS: hLv !== 255 ? ('STUFE_' + hLv) : 'SIGNAL_UNGUELTIG',
                            operationSeatHeaterActivationPSS: hLv !== 255 ? (hLv > 0 ? 'SITZHEIZUNGSFUNKTION_AN' : 'SITZHEIZUNGSFUNKTION_AUS') : 'SIGNAL_UNGUELTIG',
                            operationSeatVentilationStagePSS: cLv !== 255 ? ('STUFE_' + cLv) : 'SIGNAL_UNGUELTIG',
                            operationSeatVentilationActivationPSS: cLv !== 255 ? (cLv > 0 ? 'SITZLUEFTUNGSFUNKTION_AN' : 'SITZLUEFTUNGSFUNKTION_AUS') : 'SIGNAL_UNGUELTIG',
                        });
                        if (rAutoPs.ok) seatHwOk = true;
                    }
                    if (Object.keys(sp18Seats).length > 0) {
                        const rStrat = await this.setFieldIfAvailable('sp18Climate2', 'operationStratificationSeatHeating', sp18Seats);
                        if (rStrat.ok) seatHwOk = true;
                    }
                    if (hLv !== 255) {
                        const r21 = await this.callMethodIfAvailable('climateMaster', 'requestSeatClimateSeatHeating', {
                            clientGroupId: 0,
                            seatClimateHeating: zones.map((z) => ({ configuredIntensityLevel: hLv, operationZone: z, saveLUM: true })),
                        });
                        if (r21.ok) seatHwOk = true;
                        if (seatHwOk) {
                            if (side === 'driver' || side === 'both') this.state.climate.seatHeatDriver = hLv;
                            if (side === 'passenger' || side === 'both') this.state.climate.seatHeatPassenger = hLv;
                            okNotes.push(hLv > 0 ? ('bật sưởi ' + label + ' mức ' + hLv) : ('tắt sưởi ' + label));
                        } else {
                            failNotes.push('cổng sưởi ' + label + ' không phản hồi');
                        }
                    }
                    if (cLv !== 255) {
                        const r21 = await this.callMethodIfAvailable('climateMaster', 'requestSeatClimateSeatCooling', {
                            clientGroupId: 0,
                            seatClimateCooling: zones.map((z) => ({ configuredIntensityLevel: cLv, operationZone: z, saveLUM: true })),
                        });
                        if (r21.ok) seatHwOk = true;
                        if (seatHwOk) {
                            if (side === 'driver' || side === 'both') this.state.climate.seatCoolDriver = cLv;
                            if (side === 'passenger' || side === 'both') this.state.climate.seatCoolPassenger = cLv;
                            okNotes.push(cLv > 0 ? ('bật làm mát ' + label + ' mức ' + cLv) : ('tắt làm mát ' + label));
                        } else {
                            failNotes.push('cổng quạt làm mát ' + label + ' không phản hồi');
                        }
                    }
                }
                if (args.massage !== undefined) {
                    const on = !!args.massage;
                    let msgOk = !this.state.liveCar;
                    if (side === 'driver' || side === 'both') {
                        const r = await this.setFieldIfAvailable('sp18Comfort2', 'seatMassageFL', {
                            operationMassageFLH: on ? 'MASSAGE_ACTIVE' : 'MASSAGE_INACTIVE',
                            operationPneumaticSeatFLHIntensity: 'STUFE_2',
                            operationPneumaticSeatFLHProgram: 'PROGRAMM_1',
                        });
                        if (!this.state.liveCar || r.ok) {
                            this.state.climate.massageDriver = on;
                            msgOk = true;
                        }
                    }
                    if (side === 'passenger' || side === 'both') {
                        const r = await this.setFieldIfAvailable('sp18Comfort2', 'seatMassageFR', {
                            operationMassageFRH: on ? 'MASSAGE_ACTIVE' : 'MASSAGE_INACTIVE',
                            operationPneumaticSeatFRHIntensity: 'STUFE_2',
                            operationPneumaticSeatFRHProgram: 'PROGRAMM_1',
                        });
                        if (!this.state.liveCar || r.ok) {
                            this.state.climate.massagePassenger = on;
                            msgOk = true;
                        }
                    }
                    if (msgOk) okNotes.push((on ? 'bật massage ' : 'tắt massage ') + label);
                    else failNotes.push('không tìm thấy mô-đun massage ' + label);
                }
                if (args.wheelHeat !== undefined) {
                    const r18 = await this.callMethodIfAvailable('sp18WheelHeat', 'requestHeating', {
                        requestor: [0, 0, 0, 0, 1],
                        heating: !!args.wheelHeat,
                    });
                    const r21 = await this.callMethodIfAvailable('climateMaster', 'requestSteeringWheelHeating', {
                        clientGroupId: 0,
                        steeringWheelHeating: args.wheelHeat ? 3 : 0,
                        saveLUM: true,
                    });
                    const whOk = !this.state.liveCar || r18.ok || r21.ok;
                    if (whOk) {
                        this.state.climate.wheelHeat = !!args.wheelHeat;
                        okNotes.push(args.wheelHeat ? 'bật sưởi vô-lăng' : 'tắt sưởi vô-lăng');
                    } else {
                        failNotes.push('xe không trang bị hoặc khoá cổng sưởi vô-lăng');
                    }
                }
                this.emitTelemetry();
                const allOk = failNotes.length === 0 && okNotes.length > 0;
                const partsMsg = [];
                if (okNotes.length) partsMsg.push('Đã ' + okNotes.join(', ') + '.');
                if (failNotes.length) partsMsg.push('Lưu ý: ' + failNotes.join('; ') + '.');
                return { ok: allOk, summaryVi: partsMsg.join(' ') || ('Không thể cập nhật ' + label + '.') };
            }

            case 'set_ambient_light': {
                const okNotes = [];
                const failNotes = [];
                const comfortPatch = {};
                const sp18Amb = {};
                let sp18Touched = false;
                let ambHwOk = !this.state.liveCar;

                if (args.on !== undefined) {
                    comfortPatch.on = !!args.on;
                    sp18Amb.controlModeAmbientePanoramicRoofInteriorLighting = args.on ? 'EIN' : 'AUS';
                    if (!args.on) sp18Amb.controlMenuAmbientePanoramicRoofInteriorLighting = 'AMBIENTEBELEUCHTUNG_AUS';
                    sp18Touched = true;
                }
                if (args.brightness !== undefined) {
                    const b = Math.max(5, Math.min(100, Math.round(Number(args.brightness))));
                    comfortPatch.bright = b;
                    sp18Amb.controlBrightnessValueBrightnessOffsetAmbientePanoramicRoofInteriorLighting = b;
                    sp18Touched = true;
                }
                let parsedColor = null;
                if (args.color) {
                    parsedColor = parseHexColor(args.color);
                    if (parsedColor) {
                        sp18Amb.controlModeAmbientePanoramicRoofInteriorLighting = 'EIN';
                        sp18Amb.controlMenuAmbientePanoramicRoofInteriorLighting = 'FARBAUSWAHL_' + (parsedColor.menuIdx || 7);
                        sp18Touched = true;
                        if (parsedColor.isOem) {
                            comfortPatch.on = false;
                        } else if (args.zone && args.zone !== 'all') {
                            comfortPatch.on = true;
                            comfortPatch.zones = {};
                            comfortPatch.zones[args.zone] = { rgb: [parsedColor.r, parsedColor.g, parsedColor.b] };
                        } else {
                            comfortPatch.on = true;
                            comfortPatch.rgb = [parsedColor.r, parsedColor.g, parsedColor.b];
                            comfortPatch.zones = {
                                'dash': null,
                                'dash.line': null,
                                'console': null,
                                'doors': null,
                                'doors.line': null,
                                'doors.decor': null,
                                'doors.pocket': null,
                                'footwell': null,
                                'roof': null,
                            };
                        }
                    }
                }
                if (sp18Touched) {
                    const r18 = await this.setFieldIfAvailable('sp18Ambient', 'ambientLightInteriorColour', sp18Amb);
                    if (r18.ok) ambHwOk = true;
                }
                if (Object.keys(comfortPatch).length > 0) {
                    const rc = await sendComfortOp(this.opts.comfortSock, { op: 'ambient', settings: comfortPatch });
                    if (rc.ok) ambHwOk = true;
                }
                if (sp18Touched) {
                    if (ambHwOk) {
                        if (args.on !== undefined) {
                            this.state.ambient.on = !!args.on;
                            okNotes.push(args.on ? 'bật đèn viền nội thất' : 'tắt đèn viền nội thất');
                        }
                        if (args.brightness !== undefined) {
                            const b = Math.max(5, Math.min(100, Math.round(Number(args.brightness))));
                            this.state.ambient.brightness = b;
                            okNotes.push('chỉnh độ sáng đèn viền ' + b + '%');
                        }
                        if (parsedColor) {
                            this.state.ambient.on = true;
                            this.state.ambient.preset = parsedColor.key;
                            this.state.ambient.name = parsedColor.name;
                            this.state.ambient.hex = parsedColor.hex;
                            this.state.ambient.zone = (args.zone && args.zone !== 'all') ? String(args.zone) : 'all';
                            okNotes.push('đổi đèn viền sang ' + parsedColor.name + (args.zone && args.zone !== 'all' ? (' vùng ' + args.zone) : ''));
                        }
                    } else {
                        failNotes.push('cổng điều khiển đèn viền nội thất không phản hồi');
                    }
                }
                if (args.readingLight !== undefined) {
                    const rf = args.readingLight
                        ? await this.callMethodIfAvailable('flexLight', 'setReadingLight', { position: zoneDefault === 'passenger' ? 2 : 1, enable: true })
                        : await this.callMethodIfAvailable('flexLight', 'deactivateAllReadingLights', {});
                    const rdOk = !this.state.liveCar || rf.ok;
                    if (rdOk) {
                        this.state.ambient.readingLight = !!args.readingLight;
                        okNotes.push(args.readingLight ? 'bật đèn đọc sách' : 'tắt đèn đọc sách');
                    } else {
                        failNotes.push('đèn đọc sách trên BMW iDrive 7 dùng nút vật lý trên cụm trần xe, không bật/tắt qua phần mềm được');
                    }
                }
                this.emitTelemetry();
                const allOk = failNotes.length === 0 && okNotes.length > 0;
                const msgParts = [];
                if (okNotes.length) msgParts.push('Đã ' + okNotes.join(', ') + '.');
                if (failNotes.length) msgParts.push('Chưa thực hiện: ' + failNotes.join('; ') + '.');
                return { ok: allOk, summaryVi: msgParts.join(' ') || 'Không thực hiện được lệnh đèn nội thất.' };
            }

            case 'control_windows_roof': {
                const target = String(args.target || 'all').toLowerCase();
                const action = String(args.action || 'vent').toLowerCase();
                let anyOk = !this.state.liveCar;

                if (target === 'sunroof') {
                    const nextSunroof = action === 'open' ? 'open' : (action === 'vent' || action === 'tilt' ? 'tilt' : 'closed');
                    const shdEnum = action === 'open' ? 'MAUT_AUF__S__AUF_2' : (action === 'vent' || action === 'tilt' ? 'HEBEN' : 'MAUT_ZU__S__ZU_2');
                    const r1 = await this.setFieldIfAvailable('sp18SunRoof', 'operationSHDMDS', { operationSwitchSHDMDS: shdEnum });
                    const r2 = await this.setFieldIfAvailable('sp18RoofSys', 'controlRoofSystem', {
                        controlSHD2: action === 'open' ? 'KOMFORT_POSITION' : (action === 'vent' || action === 'tilt' ? 'TILT_POSITION' : 'POSITION'),
                        controlSHD1: action === 'open' ? 100 : (action === 'vent' || action === 'tilt' ? 20 : 0),
                    });
                    if (r1.ok || r2.ok) anyOk = true;
                    if (anyOk) this.state.sunroof = nextSunroof;
                    this.emitTelemetry();
                    return {
                        ok: anyOk,
                        summaryVi: anyOk
                            ? ('Đã ' + (nextSunroof === 'open' ? 'mở cửa sổ trời.' : (nextSunroof === 'tilt' ? 'hé cửa sổ trời.' : 'đóng cửa sổ trời.')))
                            : 'Xe không mở cổng điều khiển cửa sổ trời qua SOME/IP.',
                    };
                }
                if (target === 'blinds') {
                    const open = action === 'open';
                    const r18 = await this.setFieldIfAvailable('sp18RoofSys', 'controlRoofSystem', {
                        controlFrontESH2: open ? 'PANORAMA_OPEN' : 'POSITION',
                        controlFrontESH1: open ? 100 : 0,
                    });
                    const r21 = await this.callMethodIfAvailable('sunBlinds', open ? 'openSideAndRearBlinds' : 'closeSideAndRearBlinds', { displaySource: 6 });
                    if (r18.ok || r21.ok) anyOk = true;
                    if (anyOk) this.state.blindsOpen = open;
                    this.emitTelemetry();
                    return {
                        ok: anyOk,
                        summaryVi: anyOk ? (open ? 'Đã mở rèm che nắng.' : 'Đã kéo rèm che nắng.') : 'Xe không hỗ trợ rèm che nắng điện qua SOME/IP.',
                    };
                }

                // Power Windows: SP18 `WindowLifter.moveWindow` (`svc=20481`) + SP21 `WindowLifterMaster`
                const pct = action === 'close' ? 0 : (action === 'vent' ? 15 : (args.percent !== undefined ? Math.max(0, Math.min(100, Math.round(Number(args.percent)))) : 100));
                const keys = target === 'driver' || target === 'fl' ? ['fl']
                    : target === 'passenger' || target === 'fr' ? ['fr']
                        : target === 'rear' ? ['rl', 'rr']
                            : ['fl', 'fr', 'rl', 'rr'];
                if (keys.length === 4) {
                    const rAll = await this.callMethodIfAvailable('windowLifter', 'moveWindow', {
                        windowId: 'ALL_WINDOWS',
                        windowControl: pct,
                    });
                    if (rAll.ok) anyOk = true;
                }
                for (let i = 0; i < keys.length; i++) {
                    const k = keys[i];
                    if (!anyOk) {
                        const r18 = await this.callMethodIfAvailable('windowLifter', 'moveWindow', {
                            windowId: WINDOW_ID_SP18[k],
                            windowControl: pct,
                        });
                        if (r18.ok) anyOk = true;
                    }
                    const r21 = await this.callMethodIfAvailable('windowMaster', 'moveWindow', {
                        priorityGroup: 6,
                        consumerId: 16,
                        windowControl: { windowId: WINDOW_ID_SP21[k], windowPosition: pct },
                        windowKeySearch: 0,
                    });
                    if (r21.ok) anyOk = true;
                }
                if (anyOk) {
                    for (let j = 0; j < keys.length; j++) this.state.windows[keys[j]] = pct;
                }
                this.emitTelemetry();
                return {
                    ok: anyOk,
                    summaryVi: anyOk
                        ? ('Đã gửi lệnh ' + (pct === 0 ? 'đóng ' : ('hạ ' + pct + '% ')) + (keys.length === 4 ? 'toàn bộ kính.' : 'kính cửa.'))
                        : 'Hộp điều khiển kính cửa trên xe từ chối lệnh nâng/hạ kính qua màn hình.',
                };
            }

            case 'control_locks_trunk': {
                const action = args.action;
                if (action === 'lock' || action === 'unlock') {
                    const wantLock = action === 'lock';
                    if (this.state.liveCar && this.state.doorsLocked === wantLock) {
                        return {
                            ok: true,
                            summaryVi: wantLock ? 'Toàn bộ chốt cửa xe hiện đã khoá sẵn rồi.' : 'Chốt cửa xe hiện đã mở sẵn rồi (đang đỗ P).',
                        };
                    }
                    const rV2 = await this.setFieldIfAvailable('vehicle2', 'remoteControlDoor', {
                        requestZVRemoteServiceDoor: 'GESAMTES_FAHRZEUG__HECKKLAPPE_UND_ALLE_TUEREN',
                        requestZVRemoteServiceControl: wantLock ? 'VERRIEGELN' : 'ENTRIEGELN',
                    });
                    const rGw = await this.setFieldIfAvailable('sp18LockGw', 'requestCentralLockingSystem', {
                        idFunctionCentralLockingSystemRequest: 2,
                        centralLockingSystemRequest: wantLock ? 2 : 1,
                        requestCentralLockingSystemID: (++this.lockSeq),
                    });
                    const r21 = await this.callMethodIfAvailable('locks', wantLock ? 'requestLock' : 'requestUnlock', { requesterID: 3 });

                    let verified = !this.state.liveCar || r21.ok || rGw.ok;
                    if (this.state.liveCar && !verified && rV2.ok && (await this.isProxyAvailable('vehicle2'))) {
                        await new Promise((r) => setTimeout(r, 850));
                        try {
                            const zv = await this.proxies.vehicle2.getValue('statusZVStatus', 1500);
                            if (zv && typeof zv.statusCentralLockingSystem === 'number') {
                                const nowLocked = (zv.statusCentralLockingSystem === 2 || zv.statusCentralLockingSystem === 3);
                                this.state.doorsLocked = nowLocked;
                                verified = (nowLocked === wantLock);
                            }
                        } catch (e) {}
                    }
                    if (verified) this.state.doorsLocked = wantLock;
                    this.emitTelemetry();
                    return {
                        ok: verified,
                        summaryVi: verified
                            ? (wantLock ? 'Đã khoá chốt toàn bộ cửa xe.' : 'Đã mở chốt cửa xe (xe đang đỗ P an toàn).')
                            : 'Chốt cửa chưa đổi — hộp thân xe BDC trên BMW iDrive 7 khoá lệnh chốt/mở từ màn hình khi chìa khoá hoặc người lái đang nổ máy trong xe.',
                    };
                }
                if (action === 'open_trunk') {
                    if (this.state.liveCar && this.state.trunkOpen === true) {
                        return { ok: true, summaryVi: 'Cốp sau hiện đang mở sẵn rồi.' };
                    }
                    const r21 = await this.callMethodIfAvailable('locks', 'requestOpenBootlid', { requesterID: 3 });
                    const rV2 = await this.setFieldIfAvailable('vehicle2', 'remoteControlDoor', {
                        requestZVRemoteServiceDoor: 'HECKKLAPPE',
                        requestZVRemoteServiceControl: 'OEFFNEN',
                    });
                    let verified = !this.state.liveCar || r21.ok;
                    if (this.state.liveCar && !verified && rV2.ok && (await this.isProxyAvailable('vehicle2'))) {
                        await new Promise((r) => setTimeout(r, 850));
                        try {
                            const zv = await this.proxies.vehicle2.getValue('statusZVStatus', 1500);
                            if (zv && (zv.statusContactBootLid === 1 || zv.statusContactBootLid === 'HK_IST_OFFEN')) {
                                verified = true;
                            }
                        } catch (e) {}
                    }
                    if (verified) this.state.trunkOpen = true;
                    this.emitTelemetry();
                    return {
                        ok: verified,
                        summaryVi: verified
                            ? 'Đã mở cốp điện phía sau.'
                            : 'Cốp sau chưa mở — trên BMW iDrive 7 (SP18), hộp BDC khoá quyền bật cốp từ màn hình khi đang nổ máy trong xe (đại ca bấm nút mở cốp bên hông cửa tài nhé).',
                    };
                }
                return { ok: false, summaryVi: 'Không rõ thao tác cửa/cốp.' };
            }

            case 'control_mirrors': {
                const fold = args.action === 'fold';
                const r21 = await this.callMethodIfAvailable('mirrors', 'requestExtMirrorFolding', {
                    consumerID: 16,
                    priorityGroup: 6,
                    targetFoldingStatus: fold,
                });
                const ok = !this.state.liveCar || r21.ok;
                if (ok) this.state.mirrorsFolded = fold;
                this.emitTelemetry();
                return {
                    ok,
                    summaryVi: ok
                        ? (fold ? 'Đã gập gương chiếu hậu.' : 'Đã mở gương chiếu hậu.')
                        : 'Gương chưa gập — trên BMW iDrive 7 (SP18), gập gương đi dây LIN thẳng cụm công tắc cửa tài, không mở qua phần mềm MGU.',
                };
            }

            case 'control_media': {
                const act = String(args.action || 'play').toLowerCase();
                let anyOk = !this.state.liveCar;

                if (args.volumePercent !== undefined) {
                    const rv = await this.callMethodIfAvailable('audioCmd', 'setVolume', {
                        sinkID: 1,
                        volume: args.volumePercent,
                    });
                    if (!this.state.liveCar || (rv.ok && rv.response && (rv.response.amError === 'E_OK' || rv.response.amError === 0))) {
                        this.state.media.volumePercent = args.volumePercent;
                        this.state.media.muted = args.volumePercent === 0;
                        anyOk = true;
                    }
                }
                if (act === 'mute' || act === 'unmute') {
                    const rm = await this.callMethodIfAvailable('audioCmd', 'setSinkMuteState', {
                        sinkID: 1,
                        muteState: act === 'mute' ? 'MS_MUTED' : 'MS_UNMUTED',
                    });
                    const ok = !this.state.liveCar || (rm.ok && rm.response && (rm.response.amError === 'E_OK' || rm.response.amError === 0));
                    if (ok) this.state.media.muted = act === 'mute';
                    this.emitTelemetry();
                    return {
                        ok,
                        summaryVi: ok
                            ? (act === 'mute' ? 'Đã tắt tiếng loa xe.' : 'Đã bật lại tiếng loa xe.')
                            : 'Bộ quản lý âm thanh trên xe chưa phản hồi lệnh tắt/bật tiếng.',
                    };
                }
                if (act === 'youtube_search_play' && args.query) {
                    const q = String(args.query).trim();
                    if (!this.state.liveCar) {
                        this.state.media.playing = true;
                        this.state.media.source = 'YouTube TV';
                        this.state.media.title = q;
                    } else {
                        const yt = await this.searchAndPlayRideTube(q);
                        if (yt.ok && yt.item) {
                            this.state.media.playing = true;
                            this.state.media.source = 'YouTube TV';
                            this.state.media.title = yt.item.title || q;
                            anyOk = true;
                        }
                    }
                    this.emitTelemetry();
                    return {
                        ok: anyOk,
                        summaryVi: anyOk
                            ? ('Đang phát "' + this.state.media.title + '" trên YouTube TV.')
                            : 'Chưa phát được "' + q + '" trên YouTube TV (kiểm tra ứng dụng RideTube hoặc kết nối mạng).',
                    };
                }
                if (act === 'pause' || act === 'stop') {
                    if (this.rtSock) {
                        const yt = await this.sendRideTubeCmd({ cmd: act === 'stop' ? 'stop' : 'pause' });
                        if (yt.ok) anyOk = true;
                    }
                    const btnEnum = MEDIA_BTN_ENUM[act] || 'PAUSE';
                    const players = ['mediaCarPlay', 'mediaBtA', 'mediaAa', 'mediaPlayer'];
                    for (let i = 0; i < players.length; i++) {
                        const rp = await this.callMethodIfAvailable(players[i], 'sendButtonEvent', { button: btnEnum, action: 'PRESS' });
                        await this.callMethodIfAvailable(players[i], 'sendButtonEvent', { button: btnEnum, action: 'RELEASE' });
                        if (rp.ok) anyOk = true;
                    }
                    if (anyOk) this.state.media.playing = false;
                    this.emitTelemetry();
                    return { ok: anyOk, summaryVi: anyOk ? 'Đã tạm dừng phát nhạc.' : 'Không tìm thấy nguồn nhạc đang phát để tạm dừng.' };
                }
                if (act === 'next' || act === 'previous' || act === 'play') {
                    if (act === 'play' && this.rtSock) {
                        const yt = await this.sendRideTubeCmd({ cmd: 'resume' });
                        if (yt.ok) anyOk = true;
                    }
                    const btnEnum = MEDIA_BTN_ENUM[act] || 'PLAY';
                    const players = ['mediaCarPlay', 'mediaBtA', 'mediaAa', 'mediaPlayer'];
                    for (let i = 0; i < players.length; i++) {
                        const rp = await this.callMethodIfAvailable(players[i], 'sendButtonEvent', { button: btnEnum, action: 'PRESS' });
                        await this.callMethodIfAvailable(players[i], 'sendButtonEvent', { button: btnEnum, action: 'RELEASE' });
                        if (rp.ok) anyOk = true;
                    }
                    if (anyOk) {
                        this.state.media.playing = true;
                        if (act === 'next') this.state.media.title = 'Bài tiếp theo';
                        if (act === 'previous') this.state.media.title = 'Bài trước đó';
                    }
                    this.emitTelemetry();
                    return {
                        ok: anyOk,
                        summaryVi: anyOk
                            ? (act === 'next' ? 'Đã chuyển sang bài tiếp theo.'
                                : (act === 'previous' ? 'Đã lùi về bài trước.'
                                    : ('Đã gửi lệnh phát nhạc' + (args.volumePercent !== undefined ? (' ở mức âm lượng ' + args.volumePercent + '%') : '') + '.')))
                            : 'Không tìm thấy nguồn phát nhạc khả dụng (CarPlay / Bluetooth / Media).',
                    };
                }
                this.emitTelemetry();
                return {
                    ok: anyOk,
                    summaryVi: anyOk
                        ? ('Đã chỉnh âm lượng loa xe mức ' + this.state.media.volumePercent + '%.')
                        : 'Không chỉnh được mức âm lượng loa xe.',
                };
            }

            case 'set_exhaust_flap': {
                const mode = args.mode || 'oem';
                const soundEnum = mode === 'open' ? 'MOTORSOUND_SPORTLICH'
                    : (mode === 'close' ? 'MOTORSOUND_ZURUECKHALTEND' : 'MOTORSOUND_FES_ABHAENGIG');
                const rSound = await this.setFieldIfAvailable('sp18DrivingExcitement', 'controlFESDriveStrategy', {
                    operationAdjustEngineSoundVehicle: soundEnum,
                });
                const ok = !this.state.liveCar || rSound.ok;
                if (ok) this.state.exhaustMode = mode;
                this.emitTelemetry();
                const label = mode === 'open' ? 'MỞ thể thao (Sporty)' : (mode === 'close' ? 'ĐÓNG êm (Reduced)' : 'ZIN theo chế độ lái');
                return {
                    ok,
                    summaryVi: ok
                        ? ('Đã chuyển chế độ âm thanh động cơ / van bô sang ' + label + ' (dầu máy ' + this.state.oilTempC + '°C).')
                        : 'Van bô thể thao trên BMW M5 nối thẳng hộp DME — đại ca bấm nút ống xả vật lý cạnh cần số nhé.',
                };
            }

            case 'control_camera_360': {
                const view = String(args.view || '360').toLowerCase();
                const rc = view === 'off'
                    ? await this.callMethodIfAvailable('parkCam', 'requestParkingClosedown', {})
                    : await this.callMethodIfAvailable('parkCam', 'hmiSelectCamera', { camera: 1 });
                const ok = !this.state.liveCar || rc.ok;
                if (ok) this.state.cameraView = view === 'off' ? 'off' : view;
                this.emitTelemetry();
                return {
                    ok,
                    summaryVi: ok
                        ? (view === 'off' ? 'Đã đóng màn hình camera.' : ('Đã bật camera ' + view.toUpperCase() + ' trên màn hình.'))
                        : 'Camera 360 trên BMW iDrive 7 chỉ kích hoạt qua nút Park (P) cạnh cần số hoặc khi vào số R.',
                };
            }

            case 'navigate_to': {
                const dest = String(args.destination || '').trim();
                if (!this.state.liveCar) {
                    this.state.navigationTarget = dest;
                    this.emitTelemetry();
                    return { ok: true, summaryVi: 'Đã ghi nhận điểm đến "' + dest + '" cho lộ trình dẫn đường.' };
                }
                return {
                    ok: false,
                    summaryVi: 'Đầu MGU chưa hỗ trợ đẩy thẳng địa chỉ "' + dest + '" vào bản đồ gốc — đại ca tìm trên Google Maps / VietMap CarPlay nhé.',
                };
            }

            case 'control_1cr_valet': {
                const act = String(args.action || 'status').toLowerCase();
                const hasBimmerLink = !this.state.liveCar || fs.existsSync(path.join(this.opts.bimmerlinkRun, 'status.json'));
                if (!hasBimmerLink) {
                    return {
                        ok: false,
                        summaryVi: 'Xe hiện chưa cài hoặc chưa bật dịch vụ Bimmer-Link (Option 1CR / Valet / Telegram).',
                    };
                }
                const cmdPath = path.join(this.opts.bimmerlinkRun, 'app', 'command.json');
                if (act === 'start_1cr') {
                    const ok = !this.state.liveCar || writeAtomicSafe(cmdPath, JSON.stringify({ id: Date.now(), cmd: 'start1cr', arg: {} }));
                    if (ok) this.state.climate1crActive = true;
                    this.emitTelemetry();
                    return { ok, summaryVi: ok ? 'Đã gửi lệnh kích hoạt làm mát / đề nổ từ xa Option 1CR qua Bimmer-Link.' : 'Không ghi được lệnh sang Bimmer-Link.' };
                }
                if (act === 'stop_1cr') {
                    const ok = !this.state.liveCar || writeAtomicSafe(cmdPath, JSON.stringify({ id: Date.now(), cmd: 'stop1cr', arg: {} }));
                    if (ok) this.state.climate1crActive = false;
                    this.emitTelemetry();
                    return { ok, summaryVi: ok ? 'Đã tắt chế độ làm mát / đề nổ 1CR.' : 'Không ghi được lệnh sang Bimmer-Link.' };
                }
                if (act === 'valet_on' || act === 'valet_off') {
                    const want = act === 'valet_on';
                    const ok = !this.state.liveCar || writeAtomicSafe(cmdPath, JSON.stringify({ id: Date.now(), cmd: 'valet_toggle', arg: { enabled: want } }));
                    if (ok) this.state.valetEnabled = want;
                    this.emitTelemetry();
                    return { ok, summaryVi: ok ? (want ? 'Đã bật giám sát Valet & ghim vị trí xe.' : 'Đã tắt chế độ Valet.') : 'Không gửi được lệnh Valet sang Bimmer-Link.' };
                }
                if (act === 'snap_telegram') {
                    const ok = !this.state.liveCar || writeAtomicSafe(cmdPath, JSON.stringify({ id: Date.now(), cmd: 'snap_now', arg: {} }));
                    return { ok, summaryVi: ok ? 'Đã gửi yêu cầu chụp trạng thái xe về Telegram qua Bimmer-Link.' : 'Không gửi được yêu cầu chụp sang Bimmer-Link.' };
                }
                return { ok: true, summaryVi: 'Trạng thái 1CR: ' + (this.state.climate1crActive ? 'Đang chạy' : 'Đang tắt') + '.' };
            }

            case 'scan_vehicle_health': {
                const t = this.state;
                const lowTyres = [];
                if (!t.liveCar || t.tyresLive) {
                    Object.keys(t.tyresBar).forEach((k) => {
                        if (t.tyresBar[k] < 2.1) lowTyres.push(k.toUpperCase() + ' (' + t.tyresBar[k] + ' bar)');
                    });
                }
                const issues = [];
                if (t.battery12v < 11.9) issues.push('Bình 12V hơi yếu (' + t.battery12v + 'V)');
                if (lowTyres.length) issues.push('Lốp non hơi: ' + lowTyres.join(', '));
                if (t.oilTempC > 122) issues.push('Nhiệt độ dầu máy cao (' + t.oilTempC + '°C)');
                if (t.rangeKm > 0 && t.rangeKm <= 40) issues.push('Sắp hết xăng (còn ~' + t.rangeKm + ' km)');

                const odoTxt = t.odometerKm > 0 ? (', ODO ' + t.odometerKm + ' km') : '';
                const healthSummary = issues.length === 0
                    ? ('Xe sạch lỗi! Tua máy ' + t.rpm + ' RPM, bình 12V đạt ' + t.battery12v + 'V, dầu máy ' + t.oilTempC + '°C, nước làm mát ' + t.coolantTempC +
                        '°C, xăng còn ' + t.fuelPercent + '%' + odoTxt + '.')
                    : ('Chú ý: ' + issues.join('; ') + '! Tua máy ' + t.rpm + ' RPM, dầu máy ' + t.oilTempC + '°C, nước mát ' + t.coolantTempC + '°C.');
                return { ok: true, health: { issues, telemetry: t }, summaryVi: healthSummary };
            }

            case 'run_scene': {
                const scene = String(args.scene || 'chill_night').toLowerCase();
                this.state.activeScene = scene;
                if (scene === 'chill_night') {
                    const rAmb = await this.executeDirect('set_ambient_light', { color: 'sunset_purple', brightness: 50 }, speakerZone);
                    const rClim = await this.executeDirect('set_climate', { tempC: 24.0, fanLevel: 2, zone: 'both' }, speakerZone);
                    const rYt = await this.executeDirect('control_media', { action: 'youtube_search_play', query: 'Lofi Chill Night Drive', volumePercent: 32 }, speakerZone);
                    this.emitTelemetry();
                    return {
                        ok: !!(rAmb.ok || rClim.ok),
                        summaryVi: 'Kịch bản Chill đêm: ' + [rAmb.summaryVi, rClim.summaryVi, rYt.summaryVi].filter(Boolean).join(' '),
                    };
                }
                if (scene === 'cool_down') {
                    const rClim = await this.executeDirect('set_climate', { maxAc: true }, speakerZone);
                    const rSeat = await this.executeDirect('set_seat_comfort', { seat: 'both', coolingLevel: 3 }, speakerZone);
                    const rAmb = await this.executeDirect('set_ambient_light', { color: 'ice_cyan', brightness: 85 }, speakerZone);
                    this.emitTelemetry();
                    return {
                        ok: !!(rClim.ok || rSeat.ok),
                        summaryVi: 'Kịch bản Hạ nhiệt cấp tốc: ' + [rClim.summaryVi, rSeat.summaryVi, rAmb.summaryVi].filter(Boolean).join(' '),
                    };
                }
                if (scene === 'cinema_park') {
                    this.preCinemaBackup = { ambient: Object.assign({}, this.state.ambient) };
                    const rClim = await this.executeDirect('set_climate', { tempC: 23.0, fanLevel: 2, zone: 'both' }, speakerZone);
                    const rSeat = await this.executeDirect('set_seat_comfort', { seat: 'driver', massage: true }, speakerZone);
                    const rAmb = await this.executeDirect('set_ambient_light', { color: 'amber', brightness: 25 }, speakerZone);
                    const rYt = await this.executeDirect('control_media', { action: 'youtube_search_play', query: args.query || 'Top Trending Vietnam', volumePercent: 40 }, speakerZone);
                    this.emitTelemetry();
                    return {
                        ok: !!(rClim.ok || rAmb.ok),
                        summaryVi: 'Kịch bản Rạp phim tại chỗ (số P): ' + [rClim.summaryVi, rSeat.summaryVi, rAmb.summaryVi, rYt.summaryVi].filter(Boolean).join(' '),
                    };
                }
                if (scene === 'focus_sport') {
                    const rAmb = await this.executeDirect('set_ambient_light', { color: 'm_red', brightness: 90 }, speakerZone);
                    const rSeat = await this.executeDirect('set_seat_comfort', { seat: 'driver', coolingLevel: 2 }, speakerZone);
                    const exRes = await this.invokeTool('set_exhaust_flap', { mode: 'open' }, speakerZone);
                    this.emitTelemetry();
                    return {
                        ok: !!(rAmb.ok || rSeat.ok),
                        summaryVi: 'Kịch bản Thể thao: ' + [rAmb.summaryVi, rSeat.summaryVi, exRes.summaryVi].filter(Boolean).join(' '),
                    };
                }
                if (scene === 'normal' || scene === 'reset') {
                    this.state.activeScene = 'none';
                    const rAmb = await this.executeDirect('set_ambient_light', { color: 'oem', brightness: 70 }, speakerZone);
                    const rClim = await this.executeDirect('set_climate', { maxAc: false, tempC: 23.5, fanLevel: 2, zone: 'both' }, speakerZone);
                    this.emitTelemetry();
                    return {
                        ok: !!(rAmb.ok || rClim.ok),
                        summaryVi: 'Về mặc định: ' + [rAmb.summaryVi, rClim.summaryVi].filter(Boolean).join(' '),
                    };
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
    coerceByDataRef,
    decodeSp18TempByte,
    encodeSp18TempByte,
    createInitialTelemetry,
    loadIFConfigGenerator,
    VehicleController,
};
