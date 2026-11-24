'use strict';
/**
 * safety-gate.js - Deterministic Hardware-State & Domain Permission Gatekeeper for Bimmer AI.
 *
 * CRITICAL PRINCIPLE:
 *   Never trust an LLM's prompt alone to prevent dangerous physical actions on a moving vehicle.
 *   Every tool invocation (from Online Gemini, Offline NLU, Telegram, or UI) MUST pass through
 *   `evaluateToolCall(toolName, args, telemetry, guards)` before touching `/usr/lib/someip.node` or `InternalTasu`.
 *
 * Decisions returned:
 *   - `{ decision: 'allow', normalizedArgs }`  -> safe to execute immediately
 *   - `{ decision: 'defer', watch, reasonVi }` -> safe to queue until condition is met (e.g., oil >= 75°C for exhaust flap)
 *   - `{ decision: 'block', code, reasonVi }`  -> HARD REJECTED, zero bus packets transmitted
 *
 * Node 8 compatible, zero external dependencies.
 */

const SPEED_PARKED_MAX_KMH = 2.0;
const SPEED_MIRROR_FOLD_MAX_KMH = 15.0;
const OIL_WARM_MIN_C = 75;
const BATTERY_LOW_MIN_V = 11.7;

const DOMAIN_KEYS = [
    'locksAndTrunk',
    'windowsAndRoof',
    'climateAndSeats',
    'ambientAndLights',
    'mediaAndYoutube',
    'exhaustAndDiag',
];

const DOMAIN_LABELS = {
    locksAndTrunk: 'Khoá cửa & Cốp',
    windowsAndRoof: 'Kính, Rèm & Cửa trời',
    climateAndSeats: 'Điều hoà, Ghế & 1CR',
    ambientAndLights: 'Đèn viền RGB & Đèn trần',
    mediaAndYoutube: 'Nhạc & YouTube TV',
    exhaustAndDiag: 'Pô B&W, Van bô & Khám xe',
};

function defaultGuards() {
    return {
        locksAndTrunk: true,
        windowsAndRoof: true,
        climateAndSeats: true,
        ambientAndLights: true,
        mediaAndYoutube: true,
        exhaustAndDiag: true,
        coldOilExhaustGuard: true,
    };
}

function normalizeGuards(raw) {
    const d = defaultGuards();
    const r = raw && typeof raw === 'object' ? raw : {};
    const out = {};
    DOMAIN_KEYS.forEach((k) => { out[k] = r[k] !== undefined ? !!r[k] : d[k]; });
    out.coldOilExhaustGuard = r.coldOilExhaustGuard !== undefined ? !!r.coldOilExhaustGuard : d.coldOilExhaustGuard;
    return out;
}

function isVehicleMoving(telemetry) {
    const t = telemetry && typeof telemetry === 'object' ? telemetry : {};
    const spd = typeof t.speedKmh === 'number' && isFinite(t.speedKmh) ? t.speedKmh : 0;
    const gear = String(t.gear || 'P').toUpperCase();
    if (spd > SPEED_PARKED_MAX_KMH) return true;
    if (gear === 'D' || gear === 'R' || gear === 'S' || gear === 'M' || /^D\d|^M\d|^S\d/.test(gear)) {
        // In drive/reverse gear, treat as not parked even if creeping at 0-2 km/h
        return true;
    }
    return false;
}

function toolDomain(toolName) {
    switch (toolName) {
        case 'control_locks_trunk':
            return 'locksAndTrunk';
        case 'control_windows_roof':
        case 'control_mirrors':
            return 'windowsAndRoof';
        case 'set_climate':
        case 'set_seat_comfort':
        case 'control_1cr_valet':
            return 'climateAndSeats';
        case 'set_ambient_light':
            return 'ambientAndLights';
        case 'control_media':
        case 'navigate_to':
        case 'control_camera_360':
            return 'mediaAndYoutube';
        case 'set_exhaust_flap':
        case 'control_engine_sound':
        case 'scan_vehicle_health':
            return 'exhaustAndDiag';
        case 'run_scene':
            return null; // evaluated per sub-effect inside `evaluateToolCall`
        default:
            return null;
    }
}

/**
 * Deterministically validates a tool call against live vehicle state and user domain switches.
 */
function evaluateToolCall(toolName, rawArgs, telemetry, rawGuards) {
    const args = Object.assign({}, rawArgs && typeof rawArgs === 'object' ? rawArgs : {});
    const t = telemetry && typeof telemetry === 'object' ? telemetry : {};
    const guards = normalizeGuards(rawGuards);
    const spd = typeof t.speedKmh === 'number' && isFinite(t.speedKmh) ? Math.round(t.speedKmh * 10) / 10 : 0;
    const gear = String(t.gear || 'P').toUpperCase();
    const moving = isVehicleMoving(t);

    // 1. Check user-configured domain permission switch
    const dom = toolDomain(toolName);
    if (dom && !guards[dom]) {
        return {
            decision: 'block',
            code: 'DOMAIN_DISABLED',
            domain: dom,
            reasonVi: 'Nhóm quyền "' + DOMAIN_LABELS[dom] + '" đang tắt trong bảng Quyền AI trên màn hình.',
        };
    }

    // 2. Hard Safety Rules for Locks & Trunk
    if (toolName === 'control_locks_trunk') {
        const action = String(args.action || '').toLowerCase();
        if (action === 'lock') {
            return { decision: 'allow', normalizedArgs: { action: 'lock' } };
        }
        if (action === 'unlock' || action === 'open_trunk') {
            if (moving) {
                return {
                    decision: 'block',
                    code: 'MOVING_LOCKOUT',
                    reasonVi: 'Chốt an toàn chặn lệnh ' + (action === 'open_trunk' ? 'mở cốp' : 'mở chốt cửa') +
                        ' vì xe đang ở số ' + gear + ' (' + spd + ' km/h). Chỉ cho phép khi đỗ hẳn về P!',
                };
            }
            return { decision: 'allow', normalizedArgs: { action } };
        }
        return { decision: 'block', code: 'INVALID_ARGS', reasonVi: 'Lệnh khoá/cốp không hợp lệ.' };
    }

    // 3. Hard Safety Rules for Exterior Mirrors & Gentleman Seat Move
    if (toolName === 'control_mirrors') {
        const action = String(args.action || 'fold').toLowerCase();
        if (action === 'fold' && spd > SPEED_MIRROR_FOLD_MAX_KMH) {
            return {
                decision: 'block',
                code: 'SPEED_MIRROR_LOCKOUT',
                reasonVi: 'Xe đang chạy ' + spd + ' km/h — chốt an toàn cấm cụp gương chiếu hậu khi đang chạy trên 15 km/h!',
            };
        }
        return { decision: 'allow', normalizedArgs: { action: action === 'unfold' ? 'unfold' : 'fold' } };
    }

    if (toolName === 'set_seat_comfort' && args.gentlemanMove && moving) {
        return {
            decision: 'block',
            code: 'MOVING_SEAT_LOCKOUT',
            reasonVi: 'Tính năng dịch ghế Gentleman chỉ hoạt động khi xe đang đỗ ở số P.',
        };
    }

    // 4. Hard Safety Rules for Cinema / Parked-Only Scenes & Low 12V Battery
    if (toolName === 'run_scene') {
        const scene = String(args.scene || '').toLowerCase();
        if (scene === 'cinema_park' && moving) {
            return {
                decision: 'block',
                code: 'MOVING_SCENE_LOCKOUT',
                reasonVi: 'Chế độ Rạp phim / Đợi trên xe chỉ được bật khi đã về số P đỗ hẳn (hiện đang số ' + gear + ', ' + spd + ' km/h).',
            };
        }
        if (scene === 'cinema_park' && typeof t.battery12v === 'number' && t.battery12v > 5 && t.battery12v < BATTERY_LOW_MIN_V && !t.engineRunning) {
            return {
                decision: 'block',
                code: 'LOW_12V_BATTERY',
                reasonVi: 'Bình 12V đang yếu (' + t.battery12v.toFixed(2) + 'V) trong khi máy tắt — chặn bật Rạp phim để tránh sập nguồn xe.',
            };
        }
        return { decision: 'allow', normalizedArgs: args };
    }

    // 5. Cold-Engine Thermal Guard for Exhaust Flap & Clear DTC Guard
    if (toolName === 'set_exhaust_flap') {
        const mode = String(args.mode || 'oem').toLowerCase();
        const oil = typeof t.oilTempC === 'number' && isFinite(t.oilTempC) ? Math.round(t.oilTempC) : null;
        if (mode === 'open' && guards.coldOilExhaustGuard && !args.force && oil !== null && oil > 0 && oil < OIL_WARM_MIN_C) {
            return {
                decision: 'defer',
                code: 'COLD_OIL_DEFERRED',
                watch: {
                    id: 'exhaust_open_on_warm_oil',
                    kind: 'oil_temp_min',
                    targetOilC: OIL_WARM_MIN_C,
                    toolName: 'set_exhaust_flap',
                    args: { mode: 'open', force: true },
                },
                reasonVi: 'Dầu máy mới ' + oil + '°C thôi đại ca — em giữ van bô zin cho ấm máy, đúng lúc chạm ' + OIL_WARM_MIN_C + '°C em tự mở van bô luôn!',
            };
        }
        return { decision: 'allow', normalizedArgs: { mode: mode === 'open' || mode === 'close' ? mode : 'oem' } };
    }

    if (toolName === 'scan_vehicle_health') {
        // AI is strictly read-only on diagnostics while driving; clearing fault codes requires parked + explicit flag
        if (args.clearFaults && moving) {
            return {
                decision: 'block',
                code: 'MOVING_CLEAR_DTC_LOCKOUT',
                reasonVi: 'Tuyệt đối không xoá mã lỗi ECU khi xe đang lăn bánh (xoá lỗi có thể làm khởi động lại hộp điều khiển)!',
            };
        }
        return { decision: 'allow', normalizedArgs: { clearFaults: !!args.clearFaults } };
    }

    // 6. Clamp Climate Temperatures & Window Opening Percentages to safe physical bounds
    if (toolName === 'set_climate') {
        if (args.tempC !== undefined && args.tempC !== null) {
            const c = Number(args.tempC);
            if (isFinite(c)) args.tempC = Math.max(16.0, Math.min(28.0, Math.round(c * 2) / 2));
            else delete args.tempC;
        }
        if (args.fanLevel !== undefined && args.fanLevel !== null) {
            const f = Math.round(Number(args.fanLevel));
            if (isFinite(f)) args.fanLevel = Math.max(1, Math.min(5, f));
            else delete args.fanLevel;
        }
        return { decision: 'allow', normalizedArgs: args };
    }

    if (toolName === 'control_windows_roof') {
        // Prevent full window open above 90 km/h highway speeds unless venting (<= 20%)
        const act = String(args.action || 'vent').toLowerCase();
        if (act === 'open' && spd > 90 && (args.percent === undefined || Number(args.percent) > 25)) {
            args.percent = 20;
            args.highwayClamped = true;
        }
        return { decision: 'allow', normalizedArgs: args };
    }

    if (toolName === 'control_media') {
        if (args.volumePercent !== undefined && args.volumePercent !== null) {
            const v = Math.round(Number(args.volumePercent));
            if (isFinite(v)) args.volumePercent = Math.max(0, Math.min(85, v)); // cap AI sudden blast at 85%
            else delete args.volumePercent;
        }
        return { decision: 'allow', normalizedArgs: args };
    }

    if (toolName === 'control_engine_sound') {
        if (args.volumePercent !== undefined && args.volumePercent !== null) {
            const v = Math.round(Number(args.volumePercent));
            if (isFinite(v)) args.volumePercent = Math.max(15, Math.min(100, v));
            else delete args.volumePercent;
        }
        return { decision: 'allow', normalizedArgs: args };
    }

    return { decision: 'allow', normalizedArgs: args };
}

module.exports = {
    SPEED_PARKED_MAX_KMH,
    SPEED_MIRROR_FOLD_MAX_KMH,
    OIL_WARM_MIN_C,
    BATTERY_LOW_MIN_V,
    DOMAIN_KEYS,
    DOMAIN_LABELS,
    defaultGuards,
    normalizeGuards,
    isVehicleMoving,
    toolDomain,
    evaluateToolCall,
};
