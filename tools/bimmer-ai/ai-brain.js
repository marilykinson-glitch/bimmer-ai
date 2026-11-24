'use strict';
/**
 * ai-brain.js - Hybrid Vietnamese In-Car AI Brain for BMW MGU (`bimmer-ai`).
 *
 * Dual-Engine Architecture:
 *   1. Offline Multi-Intent Vietnamese NLU (`parseOfflineVietnameseIntents`):
 *      - Zero latency (<5ms), works 100% offline in underground garages or without an API key.
 *      - Understands accented & unaccented Vietnamese, multi-clause commands in a single sentence,
 *        and 2-Zone Microphone context (`driver` vs `passenger`).
 *   2. Online Gemini Multimodal + Function Calling (`askGeminiMultimodal`):
 *      - Sends either text or raw 16kHz WAV audio from the car's ceiling mics directly to Gemini over `mgu-uplink`.
 *      - Injects live BMW vehicle telemetry + VietMap speed limits + speaker seat zone into system instructions.
 *      - Executes multiple tool calls through `VehicleController.invokeTool` (guarded by `SafetyGate`).
 *
 * Node 8 compatible, zero external npm dependencies.
 */

const Up = require('./uplink');

function stripAccents(str) {
    return String(str || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'D')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

const TOOL_DECLARATIONS = [
    {
        name: 'set_climate',
        description: 'Điều chỉnh hệ thống điều hoà BMW (nhiệt độ 16-28°C từng vùng ghế tài/ghế phụ/cả hai, mức gió 1-5, Max AC, lấy gió trong/ngoài, nước hoa Ambient Air).',
        parameters: {
            type: 'OBJECT',
            properties: {
                zone: { type: 'STRING', description: 'driver, passenger, hoặc both (nếu người nói không nêu rõ, để trống để tự theo ghế người nói)' },
                tempC: { type: 'NUMBER', description: 'Nhiệt độ mục tiêu từ 16.0 đến 28.0 độ C' },
                deltaTempC: { type: 'NUMBER', description: 'Tăng/giảm tương đối (ví dụ -1.5 khi kêu nóng, +1.5 khi kêu lạnh)' },
                fanLevel: { type: 'NUMBER', description: 'Mức quạt gió từ 1 đến 5' },
                maxAc: { type: 'BOOLEAN', description: 'Bật hoặc tắt làm lạnh sâu Max AC' },
                freshAir: { type: 'BOOLEAN', description: 'true = lấy gió ngoài, false = lấy gió trong tuần hoàn' },
                scentOn: { type: 'BOOLEAN', description: 'Bật/tắt nước hoa Ambient Air' },
                systemOn: { type: 'BOOLEAN', description: 'Bật/tắt toàn bộ điều hoà' },
            },
        },
    },
    {
        name: 'set_seat_comfort',
        description: 'Điều khiển sưởi ghế (0-3), quạt làm mát ghế (0-3), massage ghế, sưởi vô-lăng hoặc dịch ghế phụ Gentleman.',
        parameters: {
            type: 'OBJECT',
            properties: {
                seat: { type: 'STRING', description: 'driver, passenger, hoặc both' },
                heatingLevel: { type: 'NUMBER', description: 'Mức sưởi ghế 0 (tắt) đến 3' },
                coolingLevel: { type: 'NUMBER', description: 'Mức quạt thông gió làm mát ghế 0 (tắt) đến 3' },
                massage: { type: 'BOOLEAN', description: 'Bật hoặc tắt massage ghế' },
                wheelHeat: { type: 'BOOLEAN', description: 'Bật hoặc tắt sưởi vô-lăng' },
                gentlemanMove: { type: 'BOOLEAN', description: 'Dịch gọn ghế phụ lên trước (chỉ khi xe đỗ P)' },
            },
        },
    },
    {
        name: 'set_ambient_light',
        description: 'Đổi màu đèn viền nội thất RGB (m_blue, ice_cyan, sunset_purple, neon_pink, m_red, amber, emerald, ice_white, oem hoặc mã #RRGGBB), độ sáng 0-100%, hoặc bật/tắt đèn đọc sách.',
        parameters: {
            type: 'OBJECT',
            properties: {
                color: { type: 'STRING', description: 'Tên preset (m_blue, ice_cyan, sunset_purple, neon_pink, m_red, amber, emerald, ice_white, oem) hoặc mã hex #RRGGBB' },
                brightness: { type: 'NUMBER', description: 'Độ sáng từ 0 đến 100' },
                zone: { type: 'STRING', description: 'all, dash, doors, footwell, console' },
                on: { type: 'BOOLEAN', description: 'Bật/tắt đèn viền' },
                readingLight: { type: 'BOOLEAN', description: 'Bật/tắt đèn trần đọc sách' },
            },
        },
    },
    {
        name: 'control_windows_roof',
        description: 'Đóng, mở, hoặc hé kính cửa (driver, passenger, rear, all), cửa sổ trời (sunroof) hoặc rèm che nắng (blinds).',
        parameters: {
            type: 'OBJECT',
            properties: {
                target: { type: 'STRING', description: 'all, driver, passenger, rear, sunroof, hoặc blinds' },
                action: { type: 'STRING', description: 'open, close, hoặc vent (hé nhẹ 15%)' },
                percent: { type: 'NUMBER', description: 'Độ mở kính % từ 0 đến 100' },
            },
        },
    },
    {
        name: 'control_locks_trunk',
        description: 'Khoá chốt cửa (lock), mở chốt cửa (unlock), hoặc mở cốp điện sau (open_trunk). Sẽ tự động bị khoá an toàn nếu xe đang chạy.',
        parameters: {
            type: 'OBJECT',
            properties: {
                action: { type: 'STRING', description: 'lock, unlock, hoặc open_trunk' },
            },
        },
    },
    {
        name: 'control_mirrors',
        description: 'Gập (fold) hoặc mở (unfold) gương chiếu hậu bên ngoài.',
        parameters: {
            type: 'OBJECT',
            properties: {
                action: { type: 'STRING', description: 'fold hoặc unfold' },
            },
        },
    },
    {
        name: 'control_media',
        description: 'Điều khiển nhạc đang phát, chỉnh âm lượng loa xe (0-85%), tắt tiếng, hoặc tìm và phát video/nhạc trực tiếp trên YouTube TV (RideTube).',
        parameters: {
            type: 'OBJECT',
            properties: {
                action: { type: 'STRING', description: 'play, pause, next, previous, mute, unmute, volume, hoặc youtube_search_play' },
                query: { type: 'STRING', description: 'Từ khoá bài hát / ca sĩ / thể loại khi tìm phát trên YouTube TV' },
                volumePercent: { type: 'NUMBER', description: 'Mức âm lượng từ 0 đến 85' },
            },
        },
    },
    {
        name: 'set_exhaust_flap',
        description: 'Điều khiển van bô thể thao: open (mở van bô nổ giòn), close (đóng êm), hoặc oem (zin theo xe). Tự động chờ dầu máy đạt 75°C nếu máy còn nguội.',
        parameters: {
            type: 'OBJECT',
            properties: {
                mode: { type: 'STRING', description: 'open, close, hoặc oem' },
            },
        },
    },
    {
        name: 'control_camera_360',
        description: 'Bật/tắt màn hình camera 360 quanh xe, camera trước, camera lùi hoặc camera cặp lề.',
        parameters: {
            type: 'OBJECT',
            properties: {
                view: { type: 'STRING', description: '360, front, rear, side, hoặc off' },
            },
        },
    },
    {
        name: 'navigate_to',
        description: 'Đẩy địa điểm hoặc điểm đến vào hệ thống bản đồ dẫn đường BMW.',
        parameters: {
            type: 'OBJECT',
            properties: {
                destination: { type: 'STRING', description: 'Tên địa điểm hoặc địa chỉ cần tới' },
            },
        },
    },
    {
        name: 'control_1cr_valet',
        description: 'Điều khiển đề nổ làm mát từ xa Option 1CR, bật/tắt giám sát Valet khi gửi xe, hoặc chụp trạng thái xe gửi về Telegram (qua Bimmer-Link).',
        parameters: {
            type: 'OBJECT',
            properties: {
                action: { type: 'STRING', description: 'start_1cr, stop_1cr, valet_on, valet_off, hoặc snap_telegram' },
            },
        },
    },
    {
        name: 'scan_vehicle_health',
        description: 'Kiểm tra nhanh tình trạng sức khoẻ xe: điện áp bình 12V, nhiệt độ dầu máy & nước làm mát, áp suất 4 lốp, quãng đường còn lại và cảnh báo Check Control.',
        parameters: {
            type: 'OBJECT',
            properties: {},
        },
    },
    {
        name: 'run_scene',
        description: 'Kích hoạt kịch bản phối hợp nhiều thiết bị cùng lúc: chill_night (Chill đêm/hẹn hò), cool_down (Hạ nhiệt cấp tốc), cinema_park (Rạp phim/đợi trên xe khi đỗ P), focus_sport (Thể thao), normal (về mặc định).',
        parameters: {
            type: 'OBJECT',
            properties: {
                scene: { type: 'STRING', description: 'chill_night, cool_down, cinema_park, focus_sport, hoặc normal' },
                query: { type: 'STRING', description: 'Tên nhạc/video tuỳ chọn nếu bật kịch bản' },
            },
        },
    },
];

/**
 * Multi-intent Offline Vietnamese NLU Router — extracts 1..N vehicle tool calls directly from natural Vietnamese speech.
 */
function parseOfflineVietnameseIntents(rawText, speakerZone) {
    const text = String(rawText || '').trim();
    const s = stripAccents(text);
    if (!s) return [];
    const calls = [];
    const zoneHint = /\bghe phu|ben phu|phia phu\b/.test(s) ? 'passenger'
        : (/\bghe tai|ben tai|tai xe\b/.test(s) ? 'driver'
            : (/\bca hai|2 vung|hai vung|toan xe\b/.test(s) ? 'both' : (speakerZone === 'passenger' ? 'passenger' : 'driver')));

    // 1. Named Scenes ("chế độ ...")
    if (/\b(che do|kich ban)\s+(chill|hen ho|chill dem|lang man)\b|\bchill dem\b/.test(s)) {
        calls.push({ name: 'run_scene', args: { scene: 'chill_night' } });
    } else if (/\b(che do|kich ban)\s+(rap phim|xem phim|doi vo|nghi trua|cinema)\b/.test(s)) {
        calls.push({ name: 'run_scene', args: { scene: 'cinema_park' } });
    } else if (/\b(che do|kich ban)\s+(ha nhiet|lam mat nhanh|nang gat)\b/.test(s)) {
        calls.push({ name: 'run_scene', args: { scene: 'cool_down' } });
    } else if (/\b(che do|kich ban)\s+(the thao|sport|chay gat|tinh tao)\b/.test(s)) {
        calls.push({ name: 'run_scene', args: { scene: 'focus_sport' } });
    } else if (/\b(che do)\s+(binh thuong|mac dinh|zin)\b/.test(s)) {
        calls.push({ name: 'run_scene', args: { scene: 'normal' } });
    }

    // 2. Climate & Temperature & Air
    const climateArgs = {};
    if (/\bmax\s*ac|lam lanh nhanh|lanh het co\b/.test(s)) {
        climateArgs.maxAc = !/\btat\s+max\s*ac\b/.test(s);
    }
    const tempMatch = /(?:nhiet do|may lanh|dieu hoa|xuong|len|chinh|dat)\s*(\d{2}(?:[.,]\d)?)\s*(?:do\b|°|$)/.exec(s) ||
        /\b(\d{2}(?:[.,]\d)?)\s*do\s*c?\b/.exec(s);
    if (tempMatch) {
        const deg = parseFloat(tempMatch[1].replace(',', '.'));
        if (deg >= 15 && deg <= 30) {
            climateArgs.tempC = deg;
            climateArgs.zone = zoneHint;
        }
    } else if (/\b(nong qua|oi qua|buc qua|giam nhiet|ha lanh)\b/.test(s) && !calls.length) {
        climateArgs.deltaTempC = -2.0;
        climateArgs.zone = zoneHint;
    } else if (/\b(lanh qua|ret qua|tang nhiet|am len)\b/.test(s)) {
        climateArgs.deltaTempC = 1.5;
        climateArgs.zone = zoneHint;
    }
    const fanMatch = /\b(?:muc gio|quat gio|gio muc)\s*(\d)\b/.exec(s);
    if (fanMatch) climateArgs.fanLevel = Number(fanMatch[1]);
    if (/\blay gio ngoai\b/.test(s)) climateArgs.freshAir = true;
    if (/\blay gio trong\b/.test(s)) climateArgs.freshAir = false;
    if (/\b(bat|mo)\s+nuoc hoa\b/.test(s)) climateArgs.scentOn = true;
    if (/\btat\s+nuoc hoa\b/.test(s)) climateArgs.scentOn = false;
    if (/\btat\s+(dieu hoa|may lanh)\b/.test(s)) climateArgs.systemOn = false;
    else if (/\b(bat|mo)\s+(dieu hoa|may lanh)\b/.test(s) && Object.keys(climateArgs).length === 0) climateArgs.systemOn = true;
    if (Object.keys(climateArgs).length > 0) calls.push({ name: 'set_climate', args: climateArgs });

    // 3. Seats & Steering Wheel Comfort
    const seatArgs = {};
    if (/\b(lam mat ghe|quat ghe|thong gio ghe)\b/.test(s)) {
        const lv = /\bmuc\s*(\d)\b/.exec(s);
        seatArgs.seat = zoneHint;
        seatArgs.coolingLevel = /\btat\b/.test(s) ? 0 : (lv ? Number(lv[1]) : 3);
    }
    if (/\bsuoi ghe\b/.test(s)) {
        const lv = /\bmuc\s*(\d)\b/.exec(s);
        seatArgs.seat = zoneHint;
        seatArgs.heatingLevel = /\btat\b/.test(s) ? 0 : (lv ? Number(lv[1]) : 2);
    }
    if (/\bmassage|mat xa\b/.test(s)) {
        seatArgs.seat = zoneHint;
        seatArgs.massage = !/\btat\s+(massage|mat xa)\b/.test(s);
    }
    if (/\bsuoi vo\s*lang\b/.test(s)) {
        seatArgs.wheelHeat = !/\btat\s+suoi vo\s*lang\b/.test(s);
    }
    if (/\bdich ghe phu|gentleman\b/.test(s)) {
        seatArgs.gentlemanMove = true;
    }
    if (Object.keys(seatArgs).length > 0) calls.push({ name: 'set_seat_comfort', args: seatArgs });

    // 4. Ambient RGB Lighting & Reading Lights
    const ambArgs = {};
    if (/\bden doc sach|den tran\b/.test(s)) {
        ambArgs.readingLight = !/\btat\s+(den doc sach|den tran)\b/.test(s);
    }
    const colorMap = [
        [/\b(tim|purple|violet)\b/, 'sunset_purple'],
        [/\b(xanh bang|cyan|ice blue)\b/, 'ice_cyan'],
        [/\b(xanh duong|m\s*blue|xanh bmw)\b/, 'm_blue'],
        [/\b(hong|pink)\b/, 'neon_pink'],
        [/\b(do|red)\b/, 'm_red'],
        [/\b(vang|cam|ho phach|amber)\b/, 'amber'],
        [/\b(xanh la|ngoc luc|green)\b/, 'emerald'],
        [/\b(trang|white)\b/, 'ice_white'],
        [/\bmau zin\b/, 'oem'],
    ];
    if (/\b(doi den|den vien|den noi that|mau den|doi mau|chinh den)\b/.test(s)) {
        for (let i = 0; i < colorMap.length; i++) {
            if (colorMap[i][0].test(s)) { ambArgs.color = colorMap[i][1]; break; }
        }
        const br = /(\d{1,3})\s*%/.exec(s);
        if (br && !/\bam luong|volume|kinh\b/.test(s)) ambArgs.brightness = Number(br[1]);
        if (/\btat\s+(den vien|den noi that)\b/.test(s)) ambArgs.on = false;
        else if (/\b(bat|mo)\s+(den vien|den noi that)\b/.test(s) && !ambArgs.color) ambArgs.on = true;
    }
    if (Object.keys(ambArgs).length > 0) calls.push({ name: 'set_ambient_light', args: ambArgs });

    // 5. Windows, Sunroof & Blinds
    if (/\brem\b/.test(s) && /\b(keo|dong|mo|ha)\b/.test(s)) {
        calls.push({ name: 'control_windows_roof', args: { target: 'blinds', action: /\bmo\b/.test(s) ? 'open' : 'close' } });
    }
    if (/\bcua so troi|cua troi\b/.test(s)) {
        const act = /\bhe\b/.test(s) ? 'tilt' : (/\b(mo|keo ra)\b/.test(s) ? 'open' : 'close');
        calls.push({ name: 'control_windows_roof', args: { target: 'sunroof', action: act } });
    }
    if (/\bkinh\b/.test(s) && /\b(mo|ha|dong|keo|len|he)\b/.test(s)) {
        const wTarget = /\bkinh tai|ben tai\b/.test(s) ? 'driver'
            : (/\bkinh phu|ben phu\b/.test(s) ? 'passenger'
                : (/\bkinh sau|hang sau\b/.test(s) ? 'rear' : 'all'));
        const pctM = /(\d{1,3})\s*(?:%|phan tram)/.exec(s);
        const wAct = /\b(dong|keo len|len het)\b/.test(s) ? 'close' : (/\bhe\b/.test(s) ? 'vent' : 'open');
        const wArgs = { target: wTarget, action: wAct };
        if (pctM) wArgs.percent = Number(pctM[1]);
        calls.push({ name: 'control_windows_roof', args: wArgs });
    }

    // 6. Doors, Locks, Trunk & Mirrors
    if (/\bmo\s+cop\b|\bbat\s+cop\b/.test(s)) {
        calls.push({ name: 'control_locks_trunk', args: { action: 'open_trunk' } });
    }
    if (/\b(mo\s+chot\s+cua|mo\s+khoa\s+cua|mo\s+cua\s+xe|mo\s+cua)\b/.test(s) && !/\bcua\s+(so\s+)?troi|kinh\b/.test(s)) {
        calls.push({ name: 'control_locks_trunk', args: { action: 'unlock' } });
    } else if (/\b(khoa\s+cua|chot\s+cua|lock\s+cua)\b/.test(s)) {
        calls.push({ name: 'control_locks_trunk', args: { action: 'lock' } });
    }
    if (/\b(gap|cup)\s+guong\b/.test(s)) {
        calls.push({ name: 'control_mirrors', args: { action: 'fold' } });
    } else if (/\b(mo|xoe)\s+guong\b/.test(s)) {
        calls.push({ name: 'control_mirrors', args: { action: 'unfold' } });
    }

    // 7. Exhaust Flap
    if (/\b(van\s*bo|po\s*xe|tieng\s*bo|mo\s*bo|dong\s*bo)\b/.test(s)) {
        const mode = /\b(dong|em)\b/.test(s) ? 'close' : (/\bzin|oem\b/.test(s) ? 'oem' : 'open');
        calls.push({ name: 'set_exhaust_flap', args: { mode } });
    }

    // 8. Media & YouTube TV (`RideTube`)
    const ytNorm = /(?:^|\b)(?:mo|phat|bat)\s+(?:nhac|bai\s+hat|bai|video|kenh)\s+([a-z0-9\s'-]+?)(?:\s+tren\s+(?:youtube|yt)|\s+(?:youtube|yt)|$)/.exec(s) ||
        /(?:^|\b)(?:mo|phat|bat)\s+([a-z0-9\s'-]+?)\s+tren\s+(?:youtube|yt)\b/.exec(s);
    if (ytNorm && ytNorm[1]) {
        const q = ytNorm[1].replace(/\s+(di|nha|nhe|giup|dum|coi)$/, '').trim();
        if (q && !/^(tiep|sau|truoc|lai)$/.test(q)) {
            calls.push({ name: 'control_media', args: { action: 'youtube_search_play', query: q } });
        }
    } else if (/\b(mo\s+nhac|tiep\s+tuc\s+nhac|phat\s+tiep)\b/.test(s)) {
        calls.push({ name: 'control_media', args: { action: 'play' } });
    } else if (/\b(tam\s+dung\s+nhac|dung\s+nhac|tat\s+nhac|pause)\b/.test(s)) {
        calls.push({ name: 'control_media', args: { action: 'pause' } });
    } else if (/\b(qua\s+bai|bai\s+tiep|next\s+bai|chuyen\s+bai)\b/.test(s)) {
        calls.push({ name: 'control_media', args: { action: 'next' } });
    } else if (/\b(lui\s+bai|bai\s+truoc)\b/.test(s)) {
        calls.push({ name: 'control_media', args: { action: 'previous' } });
    } else if (/\b(tat\s+tieng|cam\s+tieng|mute)\b/.test(s)) {
        calls.push({ name: 'control_media', args: { action: 'mute' } });
    } else if (/\b(bat\s+tieng|mo\s+tieng|unmute)\b/.test(s)) {
        calls.push({ name: 'control_media', args: { action: 'unmute' } });
    }
    const volM = /\b(?:am\s+luong|volume|loa\s+muc)\s*(\d{1,3})\s*%?/.exec(s);
    if (volM) {
        calls.push({ name: 'control_media', args: { action: 'volume', volumePercent: Number(volM[1]) } });
    }

    // 9. Camera 360 / Sideview
    if (/\b(cam\s*360|camera\s*360|cam\s+quanh\s+xe|cam\s+truoc|cam\s+lui|cam\s+le|tat\s+cam)\b/.test(s)) {
        const view = /\btat\s+cam\b/.test(s) ? 'off'
            : (/\btruoc\b/.test(s) ? 'front'
                : (/\blui|sau\b/.test(s) ? 'rear'
                    : (/\ble\b/.test(s) ? 'side' : '360')));
        calls.push({ name: 'control_camera_360', args: { view } });
    }

    // 10. Navigation
    const navM = /(?:dan\s+duong|chi\s+duong)\s+(?:toi|den|qua|di)\s+(.+)$/i.exec(text);
    if (navM && navM[1]) {
        calls.push({ name: 'navigate_to', args: { destination: navM[1].trim() } });
    }

    // 11. 1CR / Valet / Telegram (`Bimmer-Link`)
    if (/\b1cr\b|\bde\s+no\s+tu\s+xa\b/.test(s)) {
        calls.push({ name: 'control_1cr_valet', args: { action: /\btat|dung\b/.test(s) ? 'stop_1cr' : 'start_1cr' } });
    } else if (/\bvalet\b|\bgiam\s+sat\s+rua\s+xe\b/.test(s)) {
        calls.push({ name: 'control_1cr_valet', args: { action: /\btat\b/.test(s) ? 'valet_off' : 'valet_on' } });
    } else if (/\bgui\s+telegram|chup\s+trang\s+thai\b/.test(s)) {
        calls.push({ name: 'control_1cr_valet', args: { action: 'snap_telegram' } });
    }

    // 12. Vehicle Diagnostics / Health Query
    if (/\b(kham\s+xe|quet\s+loi|tinh\s+trang\s+xe|suc\s+khoe\s+xe|binh\s+ac\s*quy|binh\s+12v|ap\s+suat\s+lop|nhiet\s+do\s+dau|bao\s+loi)\b/.test(s)) {
        calls.push({ name: 'scan_vehicle_health', args: {} });
    }

    return calls;
}

function buildSystemPrompt(telemetry, speakerZone, ownerName) {
    const t = telemetry || {};
    const who = speakerZone === 'passenger' ? 'Hành khách GHẾ PHỤ (bên phải)' : 'Tài xế GHẾ TÀI (bên trái)';
    const nameCall = ownerName ? ownerName : 'đại ca';
    return [
        'Mày là "Bimmer AI" — trợ lý giọng nói tiếng Việt thông minh gắn trực tiếp trên xe BMW iDrive 7 (MGU) của ' + nameCall + '.',
        'PHONG CÁCH: Tự nhiên, lanh lợi, ngắn gọn (tối đa 1-2 câu súc tích để tài xế tập trung lái xe), hiểu tiếng lóng Việt Nam.',
        'NGƯỜI ĐANG NÓI (xác định từ cặp Mic trần 2 vùng): ' + who + '. Nếu họ kêu nóng/lạnh/bật sưởi ghế mà không nói bên nào, ưu tiên chỉnh đúng vùng ghế của người đang nói (' + (speakerZone === 'passenger' ? 'passenger' : 'driver') + ').',
        'TRẠNG THÁI XE HIỆN TẠI:',
        '- Tốc độ: ' + (t.speedKmh || 0) + ' km/h | Cần số: ' + (t.gear || 'P') + ' | Vòng tua: ' + (t.rpm || 0) + ' rpm',
        '- Nhiệt độ dầu máy: ' + (t.oilTempC || 0) + '°C | Nước làm mát: ' + (t.coolantTempC || 0) + '°C | Bình 12V: ' + (t.battery12v || 12.6) + 'V',
        '- Điều hoà: Tài ' + (t.climate && t.climate.tempDriverC) + '°C / Phụ ' + (t.climate && t.climate.tempPassengerC) + '°C, gió mức ' + (t.climate && t.climate.fanLevel),
        '- Đèn nội thất: ' + (t.ambient && t.ambient.name) + ' (' + (t.ambient && t.ambient.brightness) + '%) | Van bô: ' + (t.exhaustMode || 'oem'),
        '- Giới hạn tốc độ VietMap hiện tại: ' + ((t.vietmap && t.vietmap.speedLimitKmh) || 60) + ' km/h',
        'QUY TẮC: Khi người dùng yêu cầu bất kỳ thao tác điều khiển xe nào, BẮT BUỘC gọi đúng tool tương ứng (có thể gọi nhiều tool cùng lúc trong 1 lượt). Nếu nhận đầu vào bằng file âm thanh giọng nói, hãy tự nghe hiểu câu tiếng Việt đó và thực thi luôn.',
    ].join('\n');
}

/**
 * Call Gemini `generateContent` with Multimodal Audio/Text + Function Declarations over `mgu-uplink`.
 */
async function callGeminiApi(opts) {
    const apiKey = String(opts.apiKey || '').trim();
    if (!apiKey) throw new Error('Chưa nhập Gemini API Key');
    const model = String(opts.model || 'gemini-2.5-flash').trim();
    const sysText = buildSystemPrompt(opts.telemetry, opts.speakerZone, opts.ownerName);

    const userParts = [];
    if (opts.audioWavBase64) {
        userParts.push({
            inlineData: {
                mimeType: opts.audioMimeType || 'audio/wav',
                data: opts.audioWavBase64,
            },
        });
        userParts.push({
            text: opts.text
                ? ('Người ngồi trên xe nói: "' + opts.text + '"')
                : 'Hãy nghe đoạn thu âm tiếng Việt từ micro trên trần xe này, thực thi các công cụ điều khiển xe phù hợp (nếu có), và trả lời ngắn gọn bằng tiếng Việt. Mở đầu phần text bằng định dạng [TRANSCRIPT: <câu người dùng nói>] rồi xuống dòng trả lời.',
        });
    } else {
        userParts.push({ text: String(opts.text || '') });
    }

    const contents = [];
    (opts.history || []).slice(-6).forEach((h) => {
        if (h && h.user) contents.push({ role: 'user', parts: [{ text: h.user }] });
        if (h && h.ai) contents.push({ role: 'model', parts: [{ text: h.ai }] });
    });
    contents.push({ role: 'user', parts: userParts });

    const bodyObj = {
        systemInstruction: { parts: [{ text: sysText }] },
        contents,
        tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
        generationConfig: {
            temperature: 0.35,
            maxOutputTokens: 350,
        },
    };

    const apiPath = '/v1beta/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(apiKey);
    const res = await Up.request(opts.uplinkOpts, {
        host: 'generativelanguage.googleapis.com',
        path: apiPath,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyObj),
        timeoutMs: 18000,
    });

    if (!res || res.status !== 200) {
        let detail = res ? res.body.slice(0, 180) : 'empty';
        try {
            const j = JSON.parse(res.body);
            if (j && j.error && j.error.message) detail = j.error.message;
        } catch (e) {}
        throw new Error('Gemini HTTP ' + (res ? res.status : 0) + ': ' + detail);
    }

    const parsed = JSON.parse(res.body);
    const cand = parsed && parsed.candidates && parsed.candidates[0];
    const parts = (cand && cand.content && cand.content.parts) || [];
    const toolCalls = [];
    const textChunks = [];

    parts.forEach((p) => {
        if (p.functionCall && p.functionCall.name) {
            toolCalls.push({
                name: p.functionCall.name,
                args: p.functionCall.args || {},
            });
        }
        if (typeof p.text === 'string' && p.text.trim()) {
            textChunks.push(p.text.trim());
        }
    });

    let rawReply = textChunks.join(' ').trim();
    let transcript = opts.text || '';
    const trMatch = /^\[TRANSCRIPT:\s*([^\]]+)\]\s*/i.exec(rawReply);
    if (trMatch) {
        if (!transcript) transcript = trMatch[1].trim();
        rawReply = rawReply.slice(trMatch[0].length).trim();
    }

    return {
        engine: 'gemini',
        model,
        transcript,
        toolCalls,
        replyText: rawReply,
    };
}

/**
 * Full conversational + vehicle-control turn:
 *   - Uses Online Gemini when `apiKey` is configured (with instant Offline NLU fallback on network/tunnel dropout!)
 *   - Executes every tool call through `vehicleController.invokeTool` (`SafetyGate` enforced!)
 *   - Composes concise Vietnamese voice feedback reflecting actual allow/defer/block outcomes.
 */
async function processAssistantTurn(params) {
    const text = String(params.text || '').trim();
    const speakerZone = params.speakerZone || 'driver';
    const vc = params.vehicleController;
    const telemetry = vc ? vc.state : (params.telemetry || {});
    let engine = 'offline';
    let transcript = text;
    let toolCalls = [];
    let aiReply = '';
    let onlineError = '';

    const canTryOnline = !!(params.apiKey && String(params.apiKey).trim()) && (!!text || !!params.audioWavBase64);

    if (canTryOnline) {
        try {
            const gem = await callGeminiApi({
                apiKey: params.apiKey,
                model: params.model,
                text,
                audioWavBase64: params.audioWavBase64,
                audioMimeType: params.audioMimeType,
                speakerZone,
                ownerName: params.ownerName,
                telemetry,
                history: params.history,
                uplinkOpts: params.uplinkOpts,
            });
            engine = 'gemini';
            if (gem.transcript) transcript = gem.transcript;
            toolCalls = gem.toolCalls || [];
            aiReply = gem.replyText || '';
        } catch (e) {
            onlineError = e.message;
        }
    }

    // Fallback or pure Offline NLU when offline / no API key / audio-less local command
    if (engine === 'offline' && transcript) {
        toolCalls = parseOfflineVietnameseIntents(transcript, speakerZone);
    }

    const results = [];
    for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i];
        const r = vc ? await vc.invokeTool(tc.name, tc.args, speakerZone) : { ok: true, summaryVi: 'Đã chạy ' + tc.name };
        results.push({
            tool: tc.name,
            args: tc.args,
            ok: !!r.ok,
            blocked: !!r.blocked,
            deferred: !!r.deferred,
            summaryVi: r.summaryVi || '',
        });
    }

    // Ensure safety blocks or deferred oil guards ALWAYS override optimistic LLM text!
    const blockedOrDeferred = results.filter((r) => r.blocked || r.deferred);
    const executedSummaries = results.map((r) => r.summaryVi).filter(Boolean);

    let finalReply = aiReply;
    if (blockedOrDeferred.length > 0) {
        finalReply = executedSummaries.join(' ');
    } else if (!finalReply && executedSummaries.length > 0) {
        finalReply = executedSummaries.join(' ');
    } else if (!finalReply) {
        if (!transcript && params.audioWavBase64 && !params.apiKey) {
            finalReply = 'Để nhận diện thu âm giọng nói tự do từ Mic trần, hãy nhập Gemini API Key trong trang QR (hoặc dùng nút Mic trình duyệt / gõ lệnh Offline ngay bên dưới).';
        } else {
            finalReply = onlineError
                ? ('Đang mất kết nối mạng hoặc khoá API (' + onlineError.slice(0, 70) + '). Em vẫn sẵn sàng nhận các lệnh điều khiển xe Offline: mở nhạc, chỉnh điều hoà, đổi màu đèn, mở kính, khám xe!')
                : 'Em nghe rõ nhưng chưa khớp lệnh điều khiển xe Offline. Đại ca thử nói kiểu: "Chỉnh máy lạnh 22 độ", "Đổi đèn màu tím", "Mở nhạc Lofi trên YouTube", hoặc nhập Gemini API Key để chém gió mọi chủ đề nhé!';
        }
    }

    return {
        at: Date.now(),
        engine,
        speakerZone,
        transcript: transcript || '(Thu âm giọng nói)',
        replyVi: finalReply,
        actions: results,
        onlineError,
    };
}

module.exports = {
    TOOL_DECLARATIONS,
    stripAccents,
    parseOfflineVietnameseIntents,
    buildSystemPrompt,
    callGeminiApi,
    processAssistantTurn,
};
