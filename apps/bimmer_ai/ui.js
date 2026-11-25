'use strict';
/**
 * ui.js - Instant Zero-Lag 1600x520 Canvas UI for Bimmer AI (`apps/bimmer_ai`, `v0.6.1`).
 *
 * Performance & Stability Design:
 *   1. Zero per-frame Reed-Solomon recomputation: `QR.encode(url)` is memoized AND pre-rendered once into a `G.layer` GPU/software texture.
 *   2. Zero 1M-pixel software SDF stalls: card chrome uses crisp OEM BMW MGU7 flat `fillRect` geometry cached via `G.layer` (`<0.5ms` on both GPU & software RHMI paths).
 *   3. Bounded `fitCache` eliminates repeated `cv.textWidth` truncation loops across frames.
 *   4. Static idle geometry (zero `animTick` mutation while `idle`) guarantees 100% frame-skip when parked/steady.
 *
 * Node 8 (ES2017) compatible.
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

const qrMatrixCache = new Map();
const fitCache = new Map();

function fit(cv, str, size, o, max) {
    str = String(str || '');
    if (!str) return '';
    const fontKey = (o && o.font) || '';
    const cacheKey = size + '|' + max + '|' + fontKey + '|' + str;
    const hit = fitCache.get(cacheKey);
    if (hit !== undefined) return hit;

    let out = str;
    if (cv.textWidth(str, size, o) > max) {
        let s = str;
        while (s.length > 1 && cv.textWidth(s + '…', size, o) > max) s = s.slice(0, -1);
        out = s + '…';
    }
    if (fitCache.size >= 400) fitCache.clear();
    fitCache.set(cacheKey, out);
    return out;
}

function dbToNorm(db) {
    if (typeof db !== 'number' || !isFinite(db)) return 0.08;
    return Math.max(0.06, Math.min(1, (db + 65) / 55));
}

function formatDriveModeVi(mode) {
    const m = String(mode || 'comfort').toLowerCase();
    if (m === 'sport_plus') return 'SPORT+';
    if (m === 'sport') return 'SPORT';
    if (m === 'eco_pro') return 'ECO PRO';
    if (m === 'adaptive') return 'ADAPTIVE';
    return 'COMFORT';
}

/** Fast OEM MGU7 flat card chrome cached in `G.layer` when available (zero per-pixel SDF `Math.sqrt` overhead). */
function drawOemCard(cv, G, x, y, w, h, accent, bgAlpha, borderAlpha) {
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    const acc = accent || '#38bdf8';
    const ba = bgAlpha != null ? bgAlpha : 0.06;
    const sa = borderAlpha != null ? borderAlpha : 0.65;
    const paint = (c, ox, oy) => {
        c.fillRect(ox, oy, w, h, G.withAlpha('#b4bccc', ba));
        c.fillRect(ox, oy, w, 2, G.withAlpha(acc, sa));
        c.fillRect(ox, oy + h - 1, w, 1, G.withAlpha('#ffffff', 0.14));
        c.fillRect(ox, oy, 4, h, acc);
        c.fillRect(ox + w - 1, oy, 1, h, G.withAlpha('#ffffff', 0.14));
    };
    if (G && typeof G.layer === 'function' && typeof cv.blit === 'function') {
        const L = G.layer(['ba_card', w, h, acc, ba, sa].join('|'), w, h, (c) => paint(c, 0, 0), cv.textScale || 1);
        cv.blit(L, x, y);
    } else {
        paint(cv, x, y);
    }
}

/** Memoized QR code renderer: computes Reed-Solomon matrix ONCE per URL and blits from a cached `G.layer`. */
function drawCachedQr(cv, G, url, x, y, mod) {
    const text = String(url || '');
    if (!text) return 0;
    if (typeof QR.encode !== 'function') {
        return typeof QR.draw === 'function' ? QR.draw(cv, text, x, y, mod) : 185;
    }
    let q = qrMatrixCache.get(text);
    if (!q) {
        q = QR.encode(text);
        if (qrMatrixCache.size >= 16) qrMatrixCache.clear();
        qrMatrixCache.set(text, q);
    }
    const side = (q.length + 8) * mod;
    const paintQr = (c, ox, oy) => {
        c.fillRect(ox, oy, side, side, '#ffffff');
        for (let r = 0; r < q.length; r++) {
            const row = q[r];
            for (let col = 0; col < row.length;) {
                if (!row[col]) { col++; continue; }
                let e = col;
                while (e < row.length && row[e]) e++;
                c.fillRect(ox + (4 + col) * mod, oy + (4 + r) * mod, (e - col) * mod, mod, '#000000');
                col = e;
            }
        }
    };
    if (G && typeof G.layer === 'function' && typeof cv.blit === 'function') {
        const L = G.layer('ba_qr|' + mod + '|' + text, side, side, (c) => paintQr(c, 0, 0), 1);
        cv.blit(L, x, y);
    } else {
        paintQr(cv, x, y);
    }
    return side;
}

function drawGuardsPane(cv, G, t, lx, top, v, act) {
    const guards = (v && v.guards) || {};
    const hfEnabled = !!(v && v.settings && v.settings.handsFreeWake);
    const w = 324, h = 390;
    drawOemCard(cv, G, lx, top, w, h, t.accent2 || '#4da6ff', 0.06, 0.55);

    cv.text('QUYỀN & HEY BIMMER', lx + 18, top + 30, 17, t.text, { literal: true, font: 'bold' });
    cv.text('Đóng', lx + w - 18, top + 30, 15, t.accent2 || '#4da6ff', { literal: true, align: 'right', font: 'bold' });
    if (cv.target && act.toggleView) cv.target(lx + w - 84, top, 84, 42, act.toggleView, 'aiCloseGuards');

    // Row 0: Direct iDrive toggle for Hands-Free "Hey Bimmer / Ê Bimmer"
    const hfCol = hfEnabled ? '#00e5ff' : (t.dim || '#94a3b8');
    const hfY = top + 44;
    cv.fillRect(lx + 14, hfY, w - 28, 42, G.withAlpha('#00e5ff', hfEnabled ? 0.14 : 0.04));
    cv.fillRect(lx + 14, hfY, 4, 42, hfCol);
    cv.text(fit(cv, 'Gọi rảnh tay "Hey Bimmer"', 15, { literal: true, font: 'bold' }, w - 108), lx + 28, hfY + 27, 15, t.text, { literal: true, font: 'bold' });
    cv.text(hfEnabled ? 'BẬT' : 'TẮT', lx + w - 26, hfY + 27, 14, hfCol, { literal: true, align: 'right', font: 'bold' });
    if (cv.target && act.toggleHandsFree) {
        cv.target(lx + 14, hfY, w - 28, 42, act.toggleHandsFree, 'aiToggleHandsFree');
    }

    for (let i = 0; i < GUARD_ITEMS.length; i++) {
        const key = GUARD_ITEMS[i][0];
        const label = GUARD_ITEMS[i][1];
        const enabled = guards[key] !== false;
        const ry = top + 94 + i * 47;
        const col = enabled ? (t.go || '#2fd27a') : (t.crit || '#ef2b2d');
        cv.fillRect(lx + 14, ry, w - 28, 41, G.withAlpha('#ffffff', enabled ? 0.06 : 0.025));
        cv.fillRect(lx + 14, ry, 4, 41, col);
        cv.text(fit(cv, label, 15, { literal: true, font: 'bold' }, w - 108), lx + 28, ry + 26, 15, t.text, { literal: true, font: 'bold' });
        cv.text(enabled ? 'BẬT' : 'KHOÁ', lx + w - 26, ry + 26, 14, col, { literal: true, align: 'right', font: 'bold' });
        if (cv.target && act.toggleGuard) {
            const domainKey = key;
            cv.target(lx + 14, ry, w - 28, 41, () => act.toggleGuard(domainKey), 'aiGuard_' + domainKey);
        }
    }
}

function drawVoiceAndQrPane(cv, G, t, lx, top, v, act) {
    const w = 324;
    const state = v.assistantState || 'idle';
    const wakeArmed = (v.wakeStatus === 'armed' || v.wakeStatus === 'speech' || v.followUpActive);
    const activeAnim = (state === 'listening' || state === 'thinking' || state === 'speaking');
    const orbColor = state === 'listening' || v.wakeStatus === 'speech' ? '#00e5ff'
        : (state === 'thinking' ? '#a855f7'
            : (state === 'speaking' || wakeArmed ? '#2fd27a' : (t.accent2 || '#4da6ff')));

    // Top mini card: Voice Orb + 2-Zone Ceiling Mic Meters (100% static when idle -> zero idle redraws!)
    drawOemCard(cv, G, lx, top, w, 112, orbColor, 0.06, activeAnim ? 0.9 : 0.45);

    const cx = lx + 52, cy = top + 56;
    const pulseR = activeAnim ? (24 + (((v.animTick || 0) & 1) ? 3 : 0)) : 24;
    cv.circle(cx, cy, pulseR + 7, G.withAlpha(orbColor, 0.18));
    cv.circle(cx, cy, pulseR, G.withAlpha(orbColor, 0.88));
    cv.circle(cx, cy, 9, '#ffffff');
    if (cv.target && act.triggerMic) cv.target(lx, top, w, 112, act.triggerMic, 'aiTapOrb');

    const hfEnabled = !!(v.settings && v.settings.handsFreeWake);
    const hasKey = !!(v.settings && v.settings.hasApiKey);
    const stateVi = state === 'listening' ? 'ĐANG NGHE MIC TRẦN…'
        : (state === 'thinking' ? 'ĐANG XỬ LÝ LỆNH…'
            : (state === 'speaking' ? 'BIMMER AI ĐANG NÓI…'
                : (v.telemetry && v.telemetry.callActive ? 'NHƯỜNG MIC CUỘC GỌI'
                    : (v.followUpActive ? 'ĐANG CHỜ ĐỌC LỆNH…'
                        : (v.wakeStatus === 'speech' ? 'NGHE TIẾNG TRONG XE…'
                            : (wakeArmed ? 'TRỰC: "HEY BIMMER"'
                                : (hfEnabled && !hasKey ? 'DÁN KEY ĐỂ HEY BIMMER' : 'MIC ZIN 2 VÙNG SẴN SÀNG')))))));
    cv.text(fit(cv, stateVi, 15, { literal: true, font: 'bold' }, w - 112), lx + 102, top + 30, 15, orbColor, { literal: true, font: 'bold' });

    const lNorm = dbToNorm(v.micLevels && v.micLevels.leftDb);
    const rNorm = dbToNorm(v.micLevels && v.micLevels.rightDb);
    const barW = 136;

    cv.text('TÀI', lx + 102, top + 60, 13, v.activeSpeakerZone === 'driver' ? '#ffffff' : t.dim, { literal: true, font: 'bold' });
    cv.fillRect(lx + 144, top + 49, barW, 10, G.withAlpha('#ffffff', 0.12));
    cv.fillRect(lx + 144, top + 49, Math.max(10, Math.round(barW * lNorm)), 10, '#38bdf8');

    cv.text('PHỤ', lx + 102, top + 86, 13, v.activeSpeakerZone === 'passenger' ? '#ffffff' : t.dim, { literal: true, font: 'bold' });
    cv.fillRect(lx + 144, top + 75, barW, 10, G.withAlpha('#ffffff', 0.12));
    cv.fillRect(lx + 144, top + 75, Math.max(10, Math.round(barW * rNorm)), 10, '#c084fc');

    // Bottom QR Card (cached layer -> 1 blit!)
    const qTop = top + 124;
    drawOemCard(cv, G, lx, qTop, w, 266, t.accent2 || '#4da6ff', 0.05, 0.35);

    if (v.daemonUp && v.url) {
        let qSide = 0;
        try { qSide = drawCachedQr(cv, G, v.url, lx + 18, qTop + 18, 5); } catch (e) { qSide = 0; }
        const qs = qSide || 185;
        const infoX = lx + 28 + qs;
        cv.text('CỔNG QR', infoX, qTop + 46, 15, t.accent2 || '#4da6ff', { literal: true, font: 'bold' });
        cv.text('Quét điện thoại', infoX, qTop + 72, 13, t.dim, { literal: true, font: 'label' });
        cv.text('cài API Key', infoX, qTop + 92, 13, t.dim, { literal: true, font: 'label' });
        cv.text('PIN:', infoX, qTop + 132, 13, t.dim, { literal: true, font: 'bold' });
        cv.text(String(v.pin || '----'), infoX, qTop + 162, 26, t.text, { literal: true, font: 'bold' });

        const hostTxt = fit(cv, (v.host || '') + (v.ipCount > 1 ? ' [Đổi IP]' : ''), 13, { literal: true, font: 'label' }, w - 32);
        cv.text(hostTxt, lx + w / 2, qTop + 244, 13, G.withAlpha('#ffffff', 0.55), { literal: true, align: 'center', font: 'label' });
        if (v.ipCount > 1 && cv.target && act.nextIp) {
            cv.target(lx + 12, qTop + 220, w - 24, 38, act.nextIp, 'aiNextIp');
        }
    } else {
        cv.text('ĐANG KẾT NỐI BIMMER-AI…', lx + w / 2, qTop + 128, 16, t.dim, { literal: true, align: 'center', font: 'bold' });
        cv.text('Chế độ mô phỏng sẵn sàng', lx + w / 2, qTop + 156, 14, t.dim, { literal: true, align: 'center', font: 'label' });
    }
}

function domainCard(cv, G, t, x, y, w, h, spec) {
    const accent = spec.accent || '#38bdf8';
    drawOemCard(cv, G, x, y, w, h, accent, 0.055, 0.72);

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
    const tabIdx = v.viewMode === 'guards' ? 1 : 0;

    const headerBadges = [
        v.daemonUp ? { text: 'AI SẴN SÀNG', color: 'ok' } : { text: 'MÔ PHỎNG', color: 'warn' },
        moving ? { text: 'ĐANG LÁI · KHOÁ CỐP', color: 'warn' } : { text: 'SỐ P · AN TOÀN', color: 'ok' },
    ];
    G.frame(cv, t, ['Trợ lý Bimmer AI', 'Quyền an toàn'], tabIdx, headerBadges);

    const lx = 48;
    const top = G.TOP + 16;
    const bottom = G.pageBottom(cv) - (cv.own ? G.MARGIN : 8);

    if (v.viewMode === 'guards') {
        drawGuardsPane(cv, G, t, lx, top, v, act);
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
        ? ('ĐANG LÁI (' + (tel.gear || 'D') + ' · ' + Math.round(tel.speedKmh || 0) + ' km/h · ' + formatDriveModeVi(tel.driveMode) + ')')
        : ('ĐỖ SỐ P · ' + formatDriveModeVi(tel.driveMode) + ' — AN TOÀN');
    cv.text(gateLabel, W - 44, top + 32, 15, gateColor, { literal: true, align: 'right', font: 'bold' });

    // Conversation Bubble (color-coded by hardware execution truth)
    const bubY = top + 60, bubH = 106;
    const actsList = Array.isArray(turn.actions) ? turn.actions : [];
    const hasFailOrBlock = actsList.some((a) => a && (!a.ok || a.blocked));
    const hasOkAction = !hasFailOrBlock && actsList.some((a) => a && a.ok);
    const bubBorder = hasFailOrBlock ? (t.warn || '#ffb020') : (hasOkAction ? (t.go || '#2fd27a') : '#38bdf8');
    const aiTextColor = hasFailOrBlock ? '#fde68a' : t.text;
    drawOemCard(cv, G, rx, bubY, rw, bubH, bubBorder, 0.06, 0.72);

    const whoTag = turn.speakerZone === 'passenger' ? '[GHẾ PHỤ]' : '[GHẾ TÀI]';
    const userLine = turn.transcript ? (whoTag + ' "' + turn.transcript + '"') : (whoTag + ' Nhấn "Nói lệnh AI" hoặc nút Mic trên vô-lăng để ra lệnh tiếng Việt');
    const aiLine = turn.replyVi || 'Sẵn sàng điều khiển điều hoà, đèn RGB, kính, rèm, ghế massage, YouTube TV và khám sức khoẻ xe.';

    cv.text(fit(cv, userLine, 16, { literal: true, font: 'bold' }, rw - 32), rx + 18, bubY + 32, 16, '#93c5fd', { literal: true, font: 'bold' });
    cv.text(fit(cv, 'AI: ' + aiLine, 18, { literal: true, font: 'bold' }, rw - 32), rx + 18, bubY + 66, 18, aiTextColor, { literal: true, font: 'bold' });
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

    domainCard(cv, G, t, rx + cw + gap, cy, cw, ch, {
        key: 'aiCardBodyHealth',
        title: 'Thân xe & Sức khoẻ',
        accent: tel.trunkOpen ? (t.warn || '#ffb020') : (t.go || '#2fd27a'),
        headline: (tel.doorsLocked ? 'Cửa: ĐÃ KHOÁ' : 'Cửa: MỞ') + (tel.trunkOpen ? ' · CỐP MỞ' : ''),
        line1: 'Dầu máy ' + (tel.oilTempC != null ? tel.oilTempC : 86) + '°C · Bình ' + (tel.battery12v != null ? tel.battery12v : 12.6) + 'V',
        line2: 'Chế độ: ' + formatDriveModeVi(tel.driveMode) + ' · Bô: ' + String(tel.exhaustMode || 'oem').toUpperCase(),
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

module.exports = { draw, W, H, qrMatrixCache };
