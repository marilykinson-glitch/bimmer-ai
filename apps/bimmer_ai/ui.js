'use strict';
/**
 * ui.js - 1600x520 60fps GPU Canvas UI for Bimmer AI (`apps/bimmer_ai`).
 *
 * Left pane:
 *   - Default mode: Animated AI Voice Orb + 2-Zone Ceiling Mic Bars (MIC TÀI / MIC PHỤ) + QR Code & PIN
 *   - Guards mode: 6 Touch/Controller Permission Switches for every vehicle domain (`SafetyGate`)
 * Right pane:
 *   - Header + Online/Offline Brain Status + Live Safety Gate Badge
 *   - Conversation Bubble (Last Transcript + AI Vietnamese Reply)
 *   - 3 Live Vehicle Domain Cards (Climate & Ambient RGB, Body/Exhaust/Safety, Media/YouTube/VietMap)
 *   - 4 Action Buttons (Mic PTT, Scene Cycle, Vehicle Health Scan, AI Permissions Toggle)
 *
 * Node 8 compatible.
 */
const QR = require('./kit/qr');

const W = 1600, H = 520;
const nop = () => {};

const GUARD_ITEMS = [
    ['locksAndTrunk', 'Khoá cửa & Mở cốp'],
    ['windowsAndRoof', 'Kính, Rèm & Cửa trời'],
    ['climateAndSeats', 'Điều hoà, Ghế & 1CR'],
    ['ambientAndLights', 'Đèn viền RGB & Đèn trần'],
    ['mediaAndYoutube', 'Nhạc & YouTube TV'],
    ['exhaustAndDiag', 'Van bô & Khám xe'],
];

function fit(cv, str, size, o, max) {
    str = String(str || '');
    if (cv.textWidth(str, size, o) <= max) return str;
    while (str.length > 1 && cv.textWidth(str + '…', size, o) > max) str = str.slice(0, -1);
    return str + '…';
}

function dbToNorm(db) {
    if (typeof db !== 'number' || !isFinite(db)) return 0.08;
    return Math.max(0.06, Math.min(1, (db + 65) / 55));
}

function drawGuardsPane(cv, G, t, lx, top, guards, act) {
    const w = 324, h = 390;
    cv.roundRect(lx, top, w, h, 16, G.withAlpha('#ffffff', 0.05));
    cv.strokeRoundRect(lx, top, w, h, 16, 1.4, G.withAlpha('#ffffff', 0.22));
    cv.text('QUYỀN ĐIỀU KHIỂN AI', lx + 18, top + 32, 18, t.text, { literal: true, font: 'bold' });
    cv.text('Đóng', lx + w - 18, top + 32, 15, t.accent2 || '#4da6ff', { literal: true, align: 'right', font: 'bold' });
    if (cv.target && act.toggleView) cv.target(lx + w - 84, top, 84, 44, act.toggleView, 'aiCloseGuards');

    for (let i = 0; i < GUARD_ITEMS.length; i++) {
        const key = GUARD_ITEMS[i][0];
        const label = GUARD_ITEMS[i][1];
        const enabled = guards[key] !== false;
        const ry = top + 48 + i * 54;
        const col = enabled ? (t.go || '#2fd27a') : (t.crit || '#ef2b2d');
        cv.roundRect(lx + 14, ry, w - 28, 46, 10, G.withAlpha('#ffffff', enabled ? 0.06 : 0.025));
        cv.strokeRoundRect(lx + 14, ry, w - 28, 46, 10, 1, G.withAlpha(col, 0.55));
        cv.circle(lx + 32, ry + 23, 6, col);
        cv.text(fit(cv, label, 16, { literal: true, font: 'bold' }, w - 115), lx + 48, ry + 29, 16, t.text, { literal: true, font: 'bold' });
        cv.text(enabled ? 'BẬT' : 'KHOÁ', lx + w - 28, ry + 29, 14, col, { literal: true, align: 'right', font: 'bold' });
        if (cv.target && act.toggleGuard) {
            const domainKey = key;
            cv.target(lx + 14, ry, w - 28, 46, () => act.toggleGuard(domainKey), 'aiGuard_' + domainKey);
        }
    }
}

function drawVoiceAndQrPane(cv, G, t, lx, top, v, act) {
    const w = 324;
    const phase = (v.animTick || 0) * 0.12;
    const state = v.assistantState || 'idle';
    const orbColor = state === 'listening' ? '#00e5ff'
        : (state === 'thinking' ? '#a855f7'
            : (state === 'speaking' ? '#2fd27a' : (t.accent2 || '#4da6ff')));

    // Top mini card: Animated Voice Orb + 2-Zone Ceiling Mic Meters
    cv.roundRect(lx, top, w, 112, 16, G.withAlpha('#ffffff', 0.05));
    cv.strokeRoundRect(lx, top, w, 112, 16, 1.3, G.withAlpha(orbColor, state === 'idle' ? 0.35 : 0.9));

    const cx = lx + 52, cy = top + 56;
    const pulseR = state === 'idle' ? 24 : (24 + Math.round(Math.sin(phase) * 5));
    cv.circle(cx, cy, pulseR + 8, G.withAlpha(orbColor, 0.18));
    cv.circle(cx, cy, pulseR, G.withAlpha(orbColor, 0.88));
    cv.circle(cx, cy, 10, '#ffffff');
    if (cv.target && act.triggerMic) cv.target(lx, top, w, 112, act.triggerMic, 'aiTapOrb');

    const stateVi = state === 'listening' ? 'ĐANG NGHE MIC TRẦN…'
        : (state === 'thinking' ? 'ĐANG XỬ LÝ LỆNH…'
            : (state === 'speaking' ? 'BIMMER AI ĐANG NÓI…'
                : (v.telemetry && v.telemetry.callActive ? 'NHƯỜNG MIC CUỘC GỌI' : 'MIC ZIN 2 VÙNG SẴN SÀNG')));
    cv.text(fit(cv, stateVi, 15, { literal: true, font: 'bold' }, w - 112), lx + 102, top + 30, 15, orbColor, { literal: true, font: 'bold' });

    const lNorm = dbToNorm(v.micLevels && v.micLevels.leftDb);
    const rNorm = dbToNorm(v.micLevels && v.micLevels.rightDb);
    const barW = 136;

    cv.text('TÀI', lx + 102, top + 60, 13, v.activeSpeakerZone === 'driver' ? '#ffffff' : t.dim, { literal: true, font: 'bold' });
    cv.roundRect(lx + 144, top + 49, barW, 10, 5, G.withAlpha('#ffffff', 0.12));
    cv.roundRect(lx + 144, top + 49, Math.max(10, Math.round(barW * lNorm)), 10, 5, '#38bdf8');

    cv.text('PHỤ', lx + 102, top + 86, 13, v.activeSpeakerZone === 'passenger' ? '#ffffff' : t.dim, { literal: true, font: 'bold' });
    cv.roundRect(lx + 144, top + 75, barW, 10, 5, G.withAlpha('#ffffff', 0.12));
    cv.roundRect(lx + 144, top + 75, Math.max(10, Math.round(barW * rNorm)), 10, 5, '#c084fc');

    // Bottom QR Card
    const qTop = top + 124;
    cv.roundRect(lx, qTop, w, 266, 16, G.withAlpha('#ffffff', 0.04));
    cv.strokeRoundRect(lx, qTop, w, 266, 16, 1.2, G.withAlpha('#ffffff', 0.16));

    if (v.daemonUp && v.url) {
        let qSide = 0;
        try { qSide = QR.draw(cv, v.url, lx + 18, qTop + 18, 5); } catch (e) { qSide = 0; }
        const qs = qSide || 185;
        const infoX = lx + 28 + qs;
        const infoW = w - (28 + qs) - 12;
        cv.text('CỔNG QR', infoX, qTop + 46, 15, t.accent2 || '#4da6ff', { literal: true, font: 'bold' });
        cv.text('Cài API Key', infoX, qTop + 72, 13, t.dim, { literal: true, font: 'label' });
        cv.text('& Mic ĐT', infoX, qTop + 92, 13, t.dim, { literal: true, font: 'label' });
        cv.text('PIN:', infoX, qTop + 132, 13, t.dim, { literal: true, font: 'bold' });
        cv.text(String(v.pin || '----'), infoX, qTop + 162, 26, t.text, { literal: true, font: 'bold' });

        const hostTxt = fit(cv, (v.host || '') + (v.ipCount > 1 ? ' [Đổi IP]' : ''), 13, { literal: true, font: 'label' }, w - 32);
        cv.text(hostTxt, lx + w / 2, qTop + 244, 13, G.withAlpha('#ffffff', 0.5), { literal: true, align: 'center', font: 'label' });
        if (v.ipCount > 1 && cv.target && act.nextIp) {
            cv.target(lx + 12, qTop + 220, w - 24, 38, act.nextIp, 'aiNextIp');
        }
        if (infoW < 10) nop();
    } else {
        cv.text('ĐANG KẾT NỐI BIMMER-AI…', lx + w / 2, qTop + 128, 16, t.dim, { literal: true, align: 'center', font: 'bold' });
        cv.text('Chế độ mô phỏng sẵn sàng', lx + w / 2, qTop + 156, 14, t.dim, { literal: true, align: 'center', font: 'label' });
    }
}

function domainCard(cv, G, t, x, y, w, h, spec) {
    const accent = spec.accent || '#38bdf8';
    cv.roundRect(x, y, w, h, 14, G.withAlpha('#ffffff', 0.045));
    cv.strokeRoundRect(x, y, w, h, 14, 1.4, G.withAlpha(accent, 0.72));
    cv.fillRect(x + 1, y + 14, 4, h - 28, accent);

    cv.text(fit(cv, spec.title, 19, { literal: true, font: 'bold' }, w - 32), x + 18, y + 30, 19, t.text, { literal: true, font: 'bold' });
    cv.text(fit(cv, spec.headline, 21, { literal: true, font: 'bold' }, w - 32), x + 18, y + 62, 21, accent, { literal: true, font: 'bold' });
    cv.text(fit(cv, spec.line1, 15, { literal: true, font: 'label' }, w - 32), x + 18, y + 92, 15, t.dim, { literal: true, font: 'label' });
    cv.text(fit(cv, spec.line2, 15, { literal: true, font: 'label' }, w - 32), x + 18, y + 116, 15, spec.line2Color || t.dim, { literal: true, font: 'label' });

    if (spec.onTap && cv.target) cv.target(x, y, w, h, spec.onTap, spec.key || spec.title);
}

function draw(cv, G, t, v, act) {
    act = act || {};
    cv.clear(t.bg);
    const tel = v.telemetry || {};
    const moving = (tel.speedKmh || 0) > 2 || (tel.gear && tel.gear !== 'P');
    G.frame(cv, t, ['Trợ lý Bimmer AI', 'Quyền an toàn'], v.viewMode === 'guards' ? 1 : 0, [
        moving ? { text: 'ĐANG LÁI · KHOÁ CỐP', color: 'warn' } : { text: 'SỐ P · AN TOÀN', color: 'ok' },
    ]);

    const lx = 48;
    const top = G.TOP + 16;
    const bottom = G.pageBottom(cv) - (cv.own ? G.MARGIN : 8);

    if (v.viewMode === 'guards') {
        drawGuardsPane(cv, G, t, lx, top, v.guards || {}, act);
    } else {
        drawVoiceAndQrPane(cv, G, t, lx, top, v, act);
    }

    const rx = 396;
    const rw = W - 44 - rx;
    const clim = tel.climate || {};
    const amb = tel.ambient || {};
    const med = tel.media || {};
    const turn = v.lastTurn || {};

    // Title + M-Tricolour Stripes + Brain Mode + Safety Gate Status
    cv.text('BIMMER AI', rx, top + 34, 34, t.text, { literal: true, font: 'bold', spacing: 2 });
    G.stripes(cv, t, rx, top + 44, 192);

    const onlineReady = !!(v.settings && v.settings.hasApiKey);
    const modeColor = onlineReady ? (t.ok || '#2fd27a') : '#38bdf8';
    const modeText = onlineReady ? 'Gemini Multimodal + Offline NLU' : 'Offline NLU Tức Thời (<5ms)';
    cv.circle(rx + 226, top + 25, 6, modeColor);
    cv.text(modeText, rx + 240, top + 32, 17, modeColor, { literal: true, font: 'bold' });

    const gateColor = moving ? (t.warn || '#ffb020') : (t.ok || '#2fd27a');
    const gateLabel = moving
        ? ('ĐANG LÁI (' + (tel.gear || 'D') + ' · ' + Math.round(tel.speedKmh || 0) + ' km/h) — KHOÁ CỬA/CỐP')
        : 'ĐỖ SỐ P — CHỐT AN TOÀN MỞ';
    cv.text(gateLabel, W - 44, top + 32, 15, gateColor, { literal: true, align: 'right', font: 'bold' });

    // Conversation Bubble
    const bubY = top + 60, bubH = 106;
    cv.roundRect(rx, bubY, rw, bubH, 14, G.withAlpha('#ffffff', 0.055));
    cv.strokeRoundRect(rx, bubY, rw, bubH, 14, 1.3, G.withAlpha('#38bdf8', 0.45));

    const whoTag = turn.speakerZone === 'passenger' ? '[GHẾ PHỤ]' : '[GHẾ TÀI]';
    const userLine = turn.transcript ? (whoTag + ' "' + turn.transcript + '"') : (whoTag + ' Nhấn "Nói lệnh AI" hoặc nút Mic trên vô-lăng để ra lệnh tiếng Việt');
    const aiLine = turn.replyVi || 'Sẵn sàng điều khiển điều hoà, đèn RGB, kính, rèm, cốp, ghế massage, van bô, YouTube TV và khám xe.';

    cv.text(fit(cv, userLine, 16, { literal: true, font: 'bold' }, rw - 32), rx + 18, bubY + 32, 16, '#93c5fd', { literal: true, font: 'bold' });
    cv.text(fit(cv, 'AI: ' + aiLine, 18, { literal: true, font: 'bold' }, rw - 32), rx + 18, bubY + 66, 18, t.text, { literal: true, font: 'bold' });
    if (v.deferredCount > 0) {
        cv.text('Đang canh tự động mở van bô khi dầu máy chạm 75°C…', rx + 18, bubY + 92, 14, t.warn || '#ffb020', { literal: true, font: 'label' });
    }

    // 3 Live Domain Status Cards
    const gap = 16;
    const cw = Math.floor((rw - 2 * gap) / 3);
    const cy = bubY + bubH + 16, ch = 134;

    domainCard(cv, G, t, rx, cy, cw, ch, {
        key: 'aiCardClimAmb',
        title: 'Điều hoà & Đèn RGB',
        accent: amb.hex || '#38bdf8',
        headline: (clim.maxAc ? 'MAX AC' : ((clim.tempDriverC || 23) + '°C / ' + (clim.tempPassengerC || 23) + '°C')) + ' · Gió ' + (clim.fanLevel || 2),
        line1: 'Đèn: ' + (amb.name || 'Xanh M-Blue') + ' (' + (amb.brightness != null ? amb.brightness : 75) + '%)',
        line2: 'Quạt ghế: T' + (clim.seatCoolDriver || 0) + '/P' + (clim.seatCoolPassenger || 0) +
            (clim.massageDriver ? ' · Massage BẬT' : '') + (tel.climate1crActive ? ' · 1CR BẬT' : ''),
        onTap: act.quickCool,
    });

    const winOpen = tel.windows && (tel.windows.fl || tel.windows.fr || tel.windows.rl || tel.windows.rr);
    const exText = tel.exhaustMode === 'open' ? 'Bô MỞ' : (tel.exhaustMode === 'close' ? 'Bô ÊM' : 'Bô ZIN');
    domainCard(cv, G, t, rx + cw + gap, cy, cw, ch, {
        key: 'aiCardBodyHealth',
        title: 'Thân xe, Van bô & Máy',
        accent: (!tel.doorsLocked || tel.trunkOpen) ? (t.warn || '#ffb020') : (t.go || '#2fd27a'),
        headline: (tel.doorsLocked !== false ? 'Cửa KHOÁ' : 'Cửa MỞ') + (tel.trunkOpen ? ' · Cốp MỞ' : '') + ' · ' + exText,
        line1: 'Kính: ' + (winOpen ? ('Mở ' + winOpen + '%') : 'Kín') + ' · Rèm: ' + (tel.blindsOpen === false ? 'Đóng' : 'Mở'),
        line2: 'Dầu ' + (tel.oilTempC != null ? tel.oilTempC : 86) + '°C · Bình ' + (tel.battery12v != null ? tel.battery12v : 12.6) + 'V',
        onTap: act.healthCheck,
    });

    const vmLimit = (tel.vietmap && tel.vietmap.speedLimitKmh) || 60;
    const overSpeed = (tel.speedKmh || 0) > vmLimit + 3;
    domainCard(cv, G, t, rx + 2 * (cw + gap), cy, cw, ch, {
        key: 'aiCardMediaScene',
        title: 'Giải trí & Co-Pilot',
        accent: overSpeed ? (t.crit || '#ef2b2d') : '#a855f7',
        headline: med.playing ? (med.title || 'Đang phát nhạc') : 'Nhạc đang dừng',
        line1: (med.source || 'Media') + ' · Loa ' + (med.volumePercent != null ? med.volumePercent : 35) + '%',
        line2: 'Giới hạn VietMap: ' + vmLimit + ' km/h' + (tel.activeScene && tel.activeScene !== 'none' ? (' · ' + tel.activeScene) : ''),
        line2Color: overSpeed ? (t.crit || '#ef2b2d') : t.dim,
        onTap: act.cycleScene,
    });

    // Bottom 4 HMI Buttons
    const by = bottom - 50;
    const bgap = 14;
    const bw = Math.floor((rw - 3 * bgap) / 4);

    G.button(cv, t, rx, by, bw, 50,
        v.assistantState === 'listening' ? 'Đang nghe…' : 'Nói lệnh AI',
        act.triggerMic || nop,
        { key: 'aiBtnMic', color: '#00d4ff', primary: v.assistantState === 'listening' });

    G.button(cv, t, rx + (bw + bgap), by, bw, 50,
        'Đổi kịch bản',
        act.cycleScene || nop,
        { key: 'aiBtnScene', color: '#a855f7' });

    G.button(cv, t, rx + 2 * (bw + bgap), by, bw, 50,
        'Khám sức khoẻ xe',
        act.healthCheck || nop,
        { key: 'aiBtnHealth', color: t.go || '#2fd27a' });

    G.button(cv, t, rx + 3 * (bw + bgap), by, bw, 50,
        v.viewMode === 'guards' ? 'Hiện cổng QR' : 'Quyền AI',
        act.toggleView || nop,
        { key: 'aiBtnGuards', primary: v.viewMode === 'guards' });

    return cv;
}

module.exports = { draw, W, H };
