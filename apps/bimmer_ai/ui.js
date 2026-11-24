'use strict';
/**
 * ui.js - 1600x520 60fps GPU Canvas UI for Bimmer AI (`apps/bimmer_ai`, `v0.6.0`).
 *
 * 3 Header Tabs (`viewMode`):
 *   0. `main`:   Trợ lý Bimmer AI (Voice Orb + 2-Zone Mic Meters + QR + Conversation + 3 Live Cards + Quick Buttons)
 *   1. `asd`:    Pô B&W (ASD) — Real-Time Bowers & Wilkins Multi-Engine Exhaust Synthesizer (6 Engines + On/Off + Rev Demo + Mode-Follow)
 *   2. `guards`: Quyền an toàn (Hands-Free "Hey Bimmer" switch + 6 SafetyGate domain switches)
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
    ['exhaustAndDiag', 'Pô B&W, Van bô & Khám xe'],
];

const ASD_ENGINE_CARDS = [
    {
        id: 'm5_v8',
        title: 'BMW M5 V8 4.4L',
        badge: 'S63 BITURBO',
        sub: 'Trầm uy lực sub gầm ghế B&W + lụp bụp Sport',
        color: '#f97316',
    },
    {
        id: 'm3_s58',
        title: 'BMW M3/M4 I6 3.0L',
        badge: 'S58 M-POWER',
        sub: 'Gầm kim loại đặc trưng M-Power + dứt số ZF8',
        color: '#38bdf8',
    },
    {
        id: 'amg_v8',
        title: 'AMG 4.0L V8 BiTurbo',
        badge: 'M177 THUNDER',
        sub: 'Tiếng sấm V8 cơ bắp + nổ bô giòn rát khi nhả ga',
        color: '#ef4444',
    },
    {
        id: 'gt3_flat6',
        title: 'Porsche 911 GT3 4.0',
        badge: 'BOXER-6 NA',
        sub: 'Hút khí tự nhiên tua cao gào vút không trễ turbo',
        color: '#2fd27a',
    },
    {
        id: 'v10_na',
        title: 'Supercar 5.2L V10',
        badge: 'V10 HÚT KHÍ',
        sub: 'Âm sắc siêu xe V10 lệch góc đốt 90° đầy phấn khích',
        color: '#eab308',
    },
    {
        id: 'iconic_m',
        title: 'BMW IconicSounds M',
        badge: 'HANS ZIMMER',
        sub: 'Âm thanh vòm đa tầng tương lai chuẩn BMW M',
        color: '#a855f7',
    },
];

const ASD_VOL_STEPS = [45, 65, 80, 100];

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

function formatDriveModeVi(mode) {
    const m = String(mode || 'comfort').toLowerCase();
    if (m === 'sport_plus') return 'SPORT+';
    if (m === 'sport') return 'SPORT';
    if (m === 'eco_pro') return 'ECO PRO';
    if (m === 'adaptive') return 'ADAPTIVE';
    return 'COMFORT';
}

function drawGuardsPane(cv, G, t, lx, top, v, act) {
    const guards = (v && v.guards) || {};
    const hfEnabled = !(v && v.settings && v.settings.handsFreeWake === false);
    const w = 324, h = 390;
    cv.roundRect(lx, top, w, h, 16, G.withAlpha('#ffffff', 0.05));
    cv.strokeRoundRect(lx, top, w, h, 16, 1.4, G.withAlpha('#ffffff', 0.22));
    cv.text('QUYỀN & HEY BIMMER', lx + 18, top + 30, 17, t.text, { literal: true, font: 'bold' });
    cv.text('Đóng', lx + w - 18, top + 30, 15, t.accent2 || '#4da6ff', { literal: true, align: 'right', font: 'bold' });
    if (cv.target && act.toggleView) cv.target(lx + w - 84, top, 84, 42, act.toggleView, 'aiCloseGuards');

    // Row 0: Direct iDrive toggle for 100% Hands-Free "Hey Bimmer / Ê Bimmer"
    const hfCol = hfEnabled ? '#00e5ff' : (t.dim || '#94a3b8');
    const hfY = top + 44;
    cv.roundRect(lx + 14, hfY, w - 28, 42, 10, G.withAlpha('#00e5ff', hfEnabled ? 0.14 : 0.03));
    cv.strokeRoundRect(lx + 14, hfY, w - 28, 42, 10, 1.2, G.withAlpha(hfCol, 0.75));
    cv.circle(lx + 32, hfY + 21, 6, hfCol);
    cv.text(fit(cv, 'Gọi rảnh tay "Hey Bimmer"', 15, { literal: true, font: 'bold' }, w - 115), lx + 48, hfY + 27, 15, t.text, { literal: true, font: 'bold' });
    cv.text(hfEnabled ? 'BẬT' : 'TẮT', lx + w - 28, hfY + 27, 14, hfCol, { literal: true, align: 'right', font: 'bold' });
    if (cv.target && act.toggleHandsFree) {
        cv.target(lx + 14, hfY, w - 28, 42, act.toggleHandsFree, 'aiToggleHandsFree');
    }

    for (let i = 0; i < GUARD_ITEMS.length; i++) {
        const key = GUARD_ITEMS[i][0];
        const label = GUARD_ITEMS[i][1];
        const enabled = guards[key] !== false;
        const ry = top + 94 + i * 47;
        const col = enabled ? (t.go || '#2fd27a') : (t.crit || '#ef2b2d');
        cv.roundRect(lx + 14, ry, w - 28, 41, 10, G.withAlpha('#ffffff', enabled ? 0.06 : 0.025));
        cv.strokeRoundRect(lx + 14, ry, w - 28, 41, 10, 1, G.withAlpha(col, 0.55));
        cv.circle(lx + 32, ry + 20, 6, col);
        cv.text(fit(cv, label, 15, { literal: true, font: 'bold' }, w - 115), lx + 48, ry + 26, 15, t.text, { literal: true, font: 'bold' });
        cv.text(enabled ? 'BẬT' : 'KHOÁ', lx + w - 28, ry + 26, 14, col, { literal: true, align: 'right', font: 'bold' });
        if (cv.target && act.toggleGuard) {
            const domainKey = key;
            cv.target(lx + 14, ry, w - 28, 41, () => act.toggleGuard(domainKey), 'aiGuard_' + domainKey);
        }
    }
}

function drawVoiceAndQrPane(cv, G, t, lx, top, v, act) {
    const w = 324;
    const phase = (v.animTick || 0) * 0.12;
    const state = v.assistantState || 'idle';
    const wakeArmed = (v.wakeStatus === 'armed' || v.wakeStatus === 'speech' || v.followUpActive);
    const orbColor = state === 'listening' || v.wakeStatus === 'speech' ? '#00e5ff'
        : (state === 'thinking' ? '#a855f7'
            : (state === 'speaking' || wakeArmed ? '#2fd27a' : (t.accent2 || '#4da6ff')));

    // Top mini card: Animated Voice Orb + 2-Zone Ceiling Mic Meters
    cv.roundRect(lx, top, w, 112, 16, G.withAlpha('#ffffff', 0.05));
    cv.strokeRoundRect(lx, top, w, 112, 16, 1.3, G.withAlpha(orbColor, (state === 'idle' && !wakeArmed) ? 0.35 : 0.9));

    const cx = lx + 52, cy = top + 56;
    const pulseR = (state === 'idle' && !wakeArmed) ? 24 : (24 + Math.round(Math.sin(phase) * (state === 'idle' ? 2 : 5)));
    cv.circle(cx, cy, pulseR + 8, G.withAlpha(orbColor, 0.18));
    cv.circle(cx, cy, pulseR, G.withAlpha(orbColor, 0.88));
    cv.circle(cx, cy, 10, '#ffffff');
    if (cv.target && act.triggerMic) cv.target(lx, top, w, 112, act.triggerMic, 'aiTapOrb');

    const hfEnabled = !(v.settings && v.settings.handsFreeWake === false);
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
        cv.text('& Pô B&W', infoX, qTop + 92, 13, t.dim, { literal: true, font: 'label' });
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

function drawAsdPane(cv, G, t, top, v, act) {
    const tel = v.telemetry || {};
    const asd = v.asd || tel.asd || {
        enabled: false,
        engine: 'm5_v8',
        engineShort: 'M5 V8 S63',
        volumePercent: 75,
        modeFollow: true,
        burbles: true,
        effectiveMode: tel.driveMode || 'comfort',
        effectiveModeLabel: formatDriveModeVi(tel.driveMode),
        modeGainPercent: 65,
        revDemoActive: false,
    };

    const lx = 48, lw = 440;
    const isOn = !!asd.enabled;
    const effModeLabel = asd.effectiveModeLabel || formatDriveModeVi(asd.effectiveMode || tel.driveMode);
    const isSporty = (asd.effectiveMode === 'sport' || asd.effectiveMode === 'sport_plus');
    const heroCol = !isOn ? '#64748b' : (isSporty ? '#f97316' : '#38bdf8');

    // 1. Left Hero Status & Live RPM/DriveMode Card
    const hh = 146;
    cv.roundRect(lx, top, lw, hh, 16, G.withAlpha(heroCol, isOn ? 0.12 : 0.04));
    cv.strokeRoundRect(lx, top, lw, hh, 16, 1.6, G.withAlpha(heroCol, isOn ? 0.88 : 0.35));

    cv.text('BOWERS & WILKINS ACTIVE SOUND', lx + 20, top + 28, 14, heroCol, { literal: true, font: 'bold' });
    const statusHeadline = isOn
        ? (asd.revDemoActive ? ('ĐANG NẸT PÔ · ' + (asd.engineShort || 'M5 V8')) : ('ĐANG BẬT · ' + (asd.engineShort || 'M5 V8')))
        : 'ĐANG TẮT (ÊM NGUYÊN BẢN)';
    cv.text(fit(cv, statusHeadline, 22, { literal: true, font: 'bold' }, lw - 40), lx + 20, top + 60, 22, t.text, { literal: true, font: 'bold' });

    const modeGainTxt = asd.modeFollow
        ? ('Chế độ lái: ' + effModeLabel + ' (công suất ' + (asd.modeGainPercent || 65) + '%)')
        : 'Chế độ: MỞ GẮT CỐ ĐỊNH (118%)';
    cv.text(fit(cv, modeGainTxt, 15, { literal: true, font: 'bold' }, lw - 40), lx + 20, top + 90, 15, isSporty ? '#fdba74' : '#93c5fd', { literal: true, font: 'bold' });

    const liveRpm = asd.revDemoActive
        ? (2800 + Math.round(Math.abs(Math.sin((v.animTick || 0) * 0.35)) * 2900))
        : Math.round(tel.rpm || 0);
    const rpmNorm = Math.max(0.04, Math.min(1, liveRpm / 6500));
    const barW = lw - 150;
    cv.roundRect(lx + 20, top + 108, barW, 14, 7, G.withAlpha('#ffffff', 0.12));
    cv.roundRect(lx + 20, top + 108, Math.max(12, Math.round(barW * rpmNorm)), 14, 7, isOn ? heroCol : '#475569');
    cv.text(liveRpm + ' RPM', lx + lw - 20, top + 121, 15, t.text, { literal: true, align: 'right', font: 'bold' });
    if (cv.target && act.asdToggle) cv.target(lx, top, lw, hh, act.asdToggle, 'asdMasterToggle');

    // 2. Power ON/OFF + Rev Demo Buttons
    const btnY = top + 158, btnH = 50, btnW = Math.floor((lw - 14) / 2);
    G.button(cv, t, lx, btnY, btnW, btnH,
        isOn ? 'TẮT PÔ B&W' : 'BẬT PÔ B&W',
        act.asdToggle || nop,
        { key: 'asdBtnPower', color: isOn ? '#2fd27a' : '#38bdf8', primary: isOn });

    G.button(cv, t, lx + btnW + 14, btnY, btnW, btnH,
        asd.revDemoActive ? 'Đang nẹt pô…' : 'Nẹt pô thử',
        act.asdRevDemo || nop,
        { key: 'asdBtnRev', color: '#f97316', primary: !!asd.revDemoActive });

    // 3. Volume Pills Row (`45% / 65% / 80% / 100%`)
    const volY = top + 220;
    cv.roundRect(lx, volY, lw, 46, 12, G.withAlpha('#ffffff', 0.045));
    cv.strokeRoundRect(lx, volY, lw, 46, 12, 1.1, G.withAlpha('#ffffff', 0.16));
    cv.text('Âm lượng pô:', lx + 16, volY + 29, 15, t.text, { literal: true, font: 'bold' });

    const curVol = Number(asd.volumePercent || 75);
    const pillStart = lx + 146;
    const pillGap = 8;
    const pillW = Math.floor((lw - 160 - 3 * pillGap) / 4);
    for (let vi = 0; vi < ASD_VOL_STEPS.length; vi++) {
        const stepVal = ASD_VOL_STEPS[vi];
        const px = pillStart + vi * (pillW + pillGap);
        const activeVol = Math.abs(curVol - stepVal) <= 9;
        const pCol = activeVol ? '#f97316' : '#64748b';
        cv.roundRect(px, volY + 7, pillW, 32, 8, G.withAlpha(pCol, activeVol ? 0.28 : 0.08));
        cv.strokeRoundRect(px, volY + 7, pillW, 32, 8, 1.1, G.withAlpha(pCol, activeVol ? 0.95 : 0.35));
        cv.text(stepVal + '%', px + pillW / 2, volY + 28, 14, activeVol ? '#ffffff' : t.dim, { literal: true, align: 'center', font: 'bold' });
        if (cv.target && act.asdSetVolume) {
            const vTarget = stepVal;
            cv.target(px, volY + 4, pillW, 38, () => act.asdSetVolume(vTarget), 'asdVol_' + stepVal);
        }
    }

    // 4. Driving-Mode Follow Switch
    const mfY = top + 276;
    const mfOn = asd.modeFollow !== false;
    const mfCol = mfOn ? '#2fd27a' : '#ffb020';
    cv.roundRect(lx, mfY, lw, 44, 12, G.withAlpha(mfCol, 0.09));
    cv.strokeRoundRect(lx, mfY, lw, 44, 12, 1.2, G.withAlpha(mfCol, 0.65));
    cv.circle(lx + 22, mfY + 22, 6, mfCol);
    cv.text('Ăn theo chế độ lái (Sport tự gắt hơn)', lx + 38, mfY + 28, 15, t.text, { literal: true, font: 'bold' });
    cv.text(mfOn ? 'BẬT' : 'TẮT', lx + lw - 18, mfY + 28, 14, mfCol, { literal: true, align: 'right', font: 'bold' });
    if (cv.target && act.asdToggleModeFollow) cv.target(lx, mfY, lw, 44, act.asdToggleModeFollow, 'asdToggleModeFollow');

    // 5. Overrun Burbles Switch
    const bbY = top + 330;
    const bbOn = asd.burbles !== false;
    const bbCol = bbOn ? '#f97316' : '#94a3b8';
    cv.roundRect(lx, bbY, lw, 44, 12, G.withAlpha(bbCol, bbOn ? 0.10 : 0.04));
    cv.strokeRoundRect(lx, bbY, lw, 44, 12, 1.2, G.withAlpha(bbCol, bbOn ? 0.65 : 0.30));
    cv.circle(lx + 22, bbY + 22, 6, bbCol);
    cv.text('Nổ lụp bụp khi nhả ga (Sport Burbles)', lx + 38, bbY + 28, 15, t.text, { literal: true, font: 'bold' });
    cv.text(bbOn ? 'BẬT' : 'TẮT', lx + lw - 18, bbY + 28, 14, bbCol, { literal: true, align: 'right', font: 'bold' });
    if (cv.target && act.asdToggleBurbles) cv.target(lx, bbY, lw, 44, act.asdToggleBurbles, 'asdToggleBurbles');

    // 6. Right 6-Engine Selector Grid (2 columns x 3 rows)
    const rx = 510;
    const rw = W - 48 - rx;
    cv.text('DANH SÁCH 6 ĐỘNG CƠ (CHẠM LÀ ĐỔI TIẾNG · TRỘN NỀN KHÔNG NGẮT NHẠC CARPLAY)', rx, top + 24, 15, '#93c5fd', { literal: true, font: 'bold' });

    const gapX = 18, gapY = 14;
    const cardW = Math.floor((rw - gapX) / 2);
    const cardH = 108;
    const gridTop = top + 38;

    for (let i = 0; i < ASD_ENGINE_CARDS.length; i++) {
        const item = ASD_ENGINE_CARDS[i];
        const col = i % 2;
        const row = Math.floor(i / 2);
        const cx = rx + col * (cardW + gapX);
        const cy = gridTop + row * (cardH + gapY);
        const selected = (asd.engine === item.id);
        const activeCard = selected && isOn;
        const accent = item.color;

        cv.roundRect(cx, cy, cardW, cardH, 14, G.withAlpha(accent, activeCard ? 0.18 : (selected ? 0.09 : 0.035)));
        cv.strokeRoundRect(cx, cy, cardW, cardH, 14, activeCard ? 2.2 : 1.2, G.withAlpha(accent, activeCard ? 0.98 : (selected ? 0.65 : 0.32)));
        cv.fillRect(cx + 1, cy + 14, 5, cardH - 28, activeCard ? accent : G.withAlpha(accent, 0.45));

        cv.text(fit(cv, item.title, 20, { literal: true, font: 'bold' }, cardW - 165), cx + 20, cy + 34, 20, t.text, { literal: true, font: 'bold' });
        const badgeTxt = activeCard ? ('● ĐANG PHÁT') : item.badge;
        cv.text(badgeTxt, cx + cardW - 18, cy + 32, 13, activeCard ? '#2fd27a' : accent, { literal: true, align: 'right', font: 'bold' });

        cv.text(fit(cv, item.sub, 15, { literal: true, font: 'label' }, cardW - 36), cx + 20, cy + 68, 15, selected ? '#e2e8f0' : t.dim, { literal: true, font: 'label' });
        cv.text(selected ? (isOn ? 'Chạm để nghe nẹt thử / Đang chọn' : 'Đã chọn sẵn (Bấm BẬT PÔ để phát)') : 'Chạm để kích hoạt tiếng động cơ này',
            cx + 20, cy + 92, 13, activeCard ? accent : G.withAlpha('#ffffff', 0.45), { literal: true, font: 'label' });

        if (cv.target && act.asdSelectEngine) {
            const engId = item.id;
            cv.target(cx, cy, cardW, cardH, () => act.asdSelectEngine(engId), 'asdEng_' + engId);
        }
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
    const asd = v.asd || tel.asd || { enabled: false, engineShort: 'M5 V8 S63', volumePercent: 75 };
    const moving = (tel.speedKmh || 0) > 2 || (tel.gear && tel.gear !== 'P');
    const tabIdx = v.viewMode === 'asd' ? 1 : (v.viewMode === 'guards' ? 2 : 0);

    const headerBadges = [
        asd.enabled
            ? { text: 'PÔ B&W: ' + (asd.engineShort || 'BẬT'), color: 'ok' }
            : { text: 'PÔ B&W: TẮT', color: 'dim' },
        moving ? { text: 'ĐANG LÁI · KHOÁ CỐP', color: 'warn' } : { text: 'SỐ P · AN TOÀN', color: 'ok' },
    ];
    G.frame(cv, t, ['Trợ lý Bimmer AI', 'Pô B&W (ASD)', 'Quyền an toàn'], tabIdx, headerBadges);

    const lx = 48;
    const top = G.TOP + 16;
    const bottom = G.pageBottom(cv) - (cv.own ? G.MARGIN : 8);

    if (v.viewMode === 'asd') {
        drawAsdPane(cv, G, t, top, v, act);
        return cv;
    }

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

    // Conversation Bubble (color-coded by hardware execution truth: amber on fail/block, green on verified actuation)
    const bubY = top + 60, bubH = 106;
    const actsList = Array.isArray(turn.actions) ? turn.actions : [];
    const hasFailOrBlock = actsList.some((a) => a && (!a.ok || a.blocked));
    const hasOkAction = !hasFailOrBlock && actsList.some((a) => a && a.ok);
    const bubBorder = hasFailOrBlock ? (t.warn || '#ffb020') : (hasOkAction ? (t.go || '#2fd27a') : '#38bdf8');
    const aiTextColor = hasFailOrBlock ? '#fde68a' : t.text;
    cv.roundRect(rx, bubY, rw, bubH, 14, G.withAlpha('#ffffff', 0.055));
    cv.strokeRoundRect(rx, bubY, rw, bubH, 14, 1.4, G.withAlpha(bubBorder, 0.65));

    const whoTag = turn.speakerZone === 'passenger' ? '[GHẾ PHỤ]' : '[GHẾ TÀI]';
    const userLine = turn.transcript ? (whoTag + ' "' + turn.transcript + '"') : (whoTag + ' Nhấn "Nói lệnh AI" hoặc nút Mic trên vô-lăng để ra lệnh tiếng Việt');
    const aiLine = turn.replyVi || 'Sẵn sàng điều khiển điều hoà, đèn RGB, giả lập pô B&W 6 động cơ, kính, rèm, YouTube TV và khám xe.';

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

    const asdHeadline = asd.enabled
        ? ('Pô B&W: ' + (asd.engineShort || 'M5 V8'))
        : ('Pô B&W: TẮT · ' + formatDriveModeVi(tel.driveMode));
    domainCard(cv, G, t, rx + cw + gap, cy, cw, ch, {
        key: 'aiCardAsdBody',
        title: 'Pô B&W (ASD) & Máy',
        accent: asd.enabled ? '#f97316' : (t.go || '#2fd27a'),
        headline: asdHeadline,
        line1: 'Chế độ: ' + formatDriveModeVi(tel.driveMode) + ' · Tua ' + Math.round(tel.rpm || 0) + ' RPM',
        line2: 'Dầu ' + (tel.oilTempC != null ? tel.oilTempC : 86) + '°C · Bình ' + (tel.battery12v != null ? tel.battery12v : 12.6) + 'V · Chạm mở Pô B&W',
        line2Color: asd.enabled ? '#fdba74' : t.dim,
        onTap: act.openAsd || act.healthCheck,
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
        asd.enabled ? ('Pô: ' + (asd.engineShort || 'BẬT')) : 'Pô B&W (ASD)',
        act.openAsd || nop,
        { key: 'aiBtnAsd', color: '#f97316', primary: !!asd.enabled });

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

module.exports = { draw, W, H, ASD_ENGINE_CARDS };
