# Bimmer AI — Trợ lý Giọng nói Tiếng Việt Native cho BMW MGU (iDrive 7)

**Bimmer AI** là gói ứng dụng (`apps/bimmer_ai`) kèm dịch vụ hệ thống (`tools/bimmer-ai`) chuẩn **MGU Store** dành riêng cho đầu **BMW MGU (iDrive 7)** đã mở quyền cài đặt Store. Không cần cắt nối dây hay gắn phần cứng rời — tận dụng trực tiếp cặp **Mic trần zin 2 vùng (Ghế Tài & Ghế Phụ)**, nút Mic trên vô-lăng, loa theo xe và mạng dịch vụ nội bộ của MGU.

---

## Tính năng nổi bật

1. **Thu âm Mic trần zin 2 vùng & Phân biệt người nói (`audio-io.js`)**
   - Bắt tín hiệu nút Mic vô-lăng (`SteeringWheelPushButton.statusPTTButton1` — chọn nhấn 1 lần hoặc nhấn đúp để không đụng Siri CarPlay).
   - Phân tích cường độ âm thanh `dBFS` giữa kênh Trái (Mic Tài) và kênh Phải (Mic Phụ): hành khách ghế phụ nói *"Lạnh quá"* là AI tự tăng nhiệt độ đúng vùng điều hoà bên phụ.
   - Tự động nhả Mic ngay lập tức khi có cuộc gọi điện thoại hoặc CarPlay (`VoiceCall` / `CarPlayManager`).
   - Tự hạ nhỏ nhạc nền (`Audio Ducking`) khi AI phản hồi bằng giọng tiếng Việt tự nhiên.

2. **Não bộ Kép: Offline Tức Thời (`< 5ms`) + Online Gemini Multimodal (`ai-brain.js`)**
   - **Offline NLU:** Chạy ngay trên Node 8 của MGU không cần mạng (vào hầm B2/B3 mất sóng 4G vẫn điều khiển mượt điều hoà, đèn RGB, kính, rèm, cốp, van bô, YouTube TV, khám xe, kể cả câu ghép nhiều lệnh).
   - **Online Gemini Multimodal + Function Calling:** Đi qua `mgu-uplink`, nhận trực tiếp file thu âm giọng nói tiếng Việt và gọi đồng thời nhiều công cụ điều khiển xe.

3. **Chốt Chặn An Toàn Cứng (`safety-gate.js`) & Co-Pilot Chủ Động (`vehicle-bus.js`)**
   - Tách biệt hoàn toàn khỏi lời nói của AI: xe đang lăn bánh (`> 2 km/h` hoặc ngoài số `P`) sẽ **chặn cứng 100%** các lệnh mở chốt cửa, mở cốp, cụp gương hoặc bật chế độ Rạp phim.
   - **Bảo vệ máy nguội (Cold-Oil Guard):** Khi đòi mở van bô lúc dầu máy `< 75°C`, AI giữ bô zin cho ấm máy và tự động mở van bô ngay khoảnh khắc dầu chạm `75°C`.
   - **Tự thoát Rạp phim:** Đang bật *Chế độ Rạp phim* ở số `P` mà gạt sang `D`/`R` là tự động thu gọn màn hình và trả đèn về chế độ lái.
   - **Liên thông hệ sinh thái MGU Store:** Điều khiển trực tiếp **YouTube TV (`jap-ridetube-d`)**, **Đề nổ 1CR & Valet (`bimmer-link`)** và đọc cảnh báo tốc độ **VietMap (`vietmap-signs`)**.

4. **Giao diện 60fps trên ID7 (`mgu-renderd`) & Cổng QR Điện thoại / Simulator (`page.html`)**
   - Giao diện `1600×520` tiếng Việt có sóng âm 2 vùng, lịch sử hội thoại, thẻ trạng thái xe trực quan và bảng bật/tắt quyền an toàn cho từng nhóm chức năng.

---

## Chạy thử ngay trên máy Mac / PC (Live Simulator)

```sh
node scripts/live_sim.js
# Mở trình duyệt tại: http://127.0.0.1:8140/?pin=0000
```

## Dò nhanh kênh ALSA Mic trần trên xe (Chỉ đọc — an toàn 100%)

```sh
ssh root@<ip-mgu> 'sh -s' < scripts/probe-car-mic.sh
```

## Kiểm thử & Đóng gói MGU Store

```sh
node scripts/make_icon.js
node scripts/check_node8.js
node tests/bimmer_ai_test.js
python3 kit/tools/build.py --preview-only --language vi --plain-version bimmer_ai
```
