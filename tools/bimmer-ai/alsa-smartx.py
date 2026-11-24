#!/usr/bin/env python3
"""
alsa-smartx.py - Non-blocking ALSA / Intel SmartXbar PCM WAV recorder & Hands-Free VAD Listener for BMW MGU (iDrive 7).

Modes:
  1. One-shot clip capture:
       alsa-smartx.py <device> <out.wav> [duration_sec] [rate] [hw_channels]
  2. Continuous low-CPU (<0.2%) Hands-Free Speech VAD Streamer (`--vad-loop`):
       alsa-smartx.py --vad-loop <device> <out.wav> [rate] [hw_channels]
     Maintains a 720ms RAM pre-roll ring buffer so "Hey Bimmer / Ê Bimmer" is never clipped,
     adapts to cabin AC/road noise floor, and emits JSON lines `{"event":"utterance", ...}` on stdout.
"""
import array
import collections
import ctypes
import json
import math
import os
import signal
import sys
import time
import wave

SND_PCM_STREAM_CAPTURE = 1
SND_PCM_NONBLOCK = 1
SND_PCM_FORMAT_S16_LE = 2
SND_PCM_ACCESS_RW_INTERLEAVED = 3
EAGAIN = -11

STOP_FLAG = False


def _handle_sig(_signum, _frame):
    global STOP_FLAG
    STOP_FLAG = True


signal.signal(signal.SIGTERM, _handle_sig)
signal.signal(signal.SIGINT, _handle_sig)


def _load_asound():
    asound = ctypes.CDLL("libasound.so.2")
    asound.snd_strerror.argtypes = [ctypes.c_int]
    asound.snd_strerror.restype = ctypes.c_char_p
    asound.snd_pcm_open.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_char_p, ctypes.c_int, ctypes.c_int]
    asound.snd_pcm_open.restype = ctypes.c_int
    asound.snd_pcm_nonblock.argtypes = [ctypes.c_void_p, ctypes.c_int]
    asound.snd_pcm_nonblock.restype = ctypes.c_int
    asound.snd_pcm_set_params.argtypes = [
        ctypes.c_void_p,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_uint,
        ctypes.c_uint,
        ctypes.c_int,
        ctypes.c_uint,
    ]
    asound.snd_pcm_set_params.restype = ctypes.c_int
    asound.snd_pcm_prepare.argtypes = [ctypes.c_void_p]
    asound.snd_pcm_prepare.restype = ctypes.c_int
    asound.snd_pcm_start.argtypes = [ctypes.c_void_p]
    asound.snd_pcm_start.restype = ctypes.c_int
    asound.snd_pcm_readi.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulong]
    asound.snd_pcm_readi.restype = ctypes.c_long
    asound.snd_pcm_recover.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]
    asound.snd_pcm_recover.restype = ctypes.c_int
    asound.snd_pcm_close.argtypes = [ctypes.c_void_p]
    asound.snd_pcm_close.restype = ctypes.c_int
    return asound


def _open_alsa_capture(asound, device, hw_rate, hw_ch):
    pcm = ctypes.c_void_p()
    rc = asound.snd_pcm_open(ctypes.byref(pcm), device.encode("utf-8"), SND_PCM_STREAM_CAPTURE, SND_PCM_NONBLOCK)
    if rc < 0:
        err = asound.snd_strerror(rc).decode("utf-8", "replace")
        raise RuntimeError(f"snd_pcm_open({device}): {err} ({rc})")
    asound.snd_pcm_nonblock(pcm, 1)
    rc = asound.snd_pcm_set_params(
        pcm,
        SND_PCM_FORMAT_S16_LE,
        SND_PCM_ACCESS_RW_INTERLEAVED,
        hw_ch,
        hw_rate,
        1,
        120000,
    )
    if rc < 0:
        asound.snd_pcm_close(pcm)
        err = asound.snd_strerror(rc).decode("utf-8", "replace")
        raise RuntimeError(f"snd_pcm_set_params({device}, ch={hw_ch}, rate={hw_rate}): {err} ({rc})")
    asound.snd_pcm_prepare(pcm)
    asound.snd_pcm_start(pcm)
    return pcm


def _extract_pcm_chunk(raw, got, hw_ch, out_channels, decim, frame_idx):
    if hw_ch == out_channels and decim == 1:
        return raw, frame_idx + got
    bytes_per_frame = hw_ch * 2
    sample_bytes = 4 if out_channels == 2 else 2
    out = bytearray()
    for f in range(got):
        if decim == 1 or (frame_idx % decim) == 0:
            off = f * bytes_per_frame
            out.extend(raw[off : off + sample_bytes])
        frame_idx += 1
    return bytes(out), frame_idx


def _write_wav_atomic(out_wav, out_channels, out_rate, pcm_bytes):
    tmp_path = out_wav + ".tmp." + str(os.getpid())
    try:
        with wave.open(tmp_path, "wb") as wf:
            wf.setnchannels(out_channels)
            wf.setsampwidth(2)
            wf.setframerate(out_rate)
            wf.writeframes(pcm_bytes)
        os.replace(tmp_path, out_wav)
    except BaseException:
        try:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _fast_chunk_db_and_peak(pcm_bytes, channels=1):
    samples = array.array("h")
    samples.frombytes(pcm_bytes)
    if sys.byteorder != "little":
        samples.byteswap()
    n = len(samples)
    if n == 0:
        return -90.0, 0
    if channels == 2 and n >= 8:
        sub_l = samples[0::4]
        sub_r = samples[1::4]
        peak_l = max((abs(x) for x in sub_l), default=0)
        peak_r = max((abs(x) for x in sub_r), default=0)
        rms_l = math.sqrt(sum(x * x for x in sub_l) / len(sub_l)) / 32768.0 if sub_l else 0.0
        rms_r = math.sqrt(sum(x * x for x in sub_r) / len(sub_r)) / 32768.0 if sub_r else 0.0
        rms = max(rms_l, rms_r)
        peak = max(peak_l, peak_r)
        db = 20.0 * math.log10(rms) if rms > 1e-5 else -90.0
        return round(db, 1), int(peak)

    step = 4 if n >= 32 else 1
    sub = samples[::step]
    peak = 0
    acc = 0
    for x in sub:
        ax = -x if x < 0 else x
        if ax > peak:
            peak = ax
        acc += x * x
    rms = math.sqrt(acc / len(sub)) / 32768.0
    db = 20.0 * math.log10(rms) if rms > 1e-5 else -90.0
    return round(db, 1), int(peak)


def _measure_snr_and_floor(samples, out_channels, out_rate):
    if not samples:
        return 0.0, -90.0
    win = max(240, int(out_rate * 0.06)) * max(1, out_channels)
    dbs = []
    n = len(samples)
    step = 4 if win >= 480 else 1
    for i in range(0, n, win):
        seg = samples[i : i + win : step]
        if len(seg) < 16:
            continue
        acc = 0
        for x in seg:
            acc += x * x
        rms = math.sqrt(acc / len(seg)) / 32768.0
        dbs.append(20.0 * math.log10(rms) if rms > 1e-5 else -90.0)
    if not dbs:
        return 0.0, -90.0
    dbs.sort()
    p20 = dbs[int(len(dbs) * 0.20)]
    p90 = dbs[min(len(dbs) - 1, int(len(dbs) * 0.90))]
    return round(max(0.0, p90 - p20), 1), round(p20, 1)


def _condition_and_boost_pcm(pcm_bytes, out_channels, out_rate=24000):
    """
    Raw BMW MGU MEMS ceiling mics have ~24 dB headroom (normal speech sits around -37..-28 dBFS),
    and 1-mic cars leave channel 1 at digital zero (-91 dBFS).
    1. Collapse dead second channel (<25 peak) to centered mono so Gemini gets full amplitude & half upload size.
    2. Measure syllabic SNR (P90 - P20 chunk dB): only apply full +24 dB speech boost when voice modulation is present;
       cap gain on stationary silence / V8 idle hum so background noise never gets amplified above -32 dBFS.
    """
    samples = array.array("h")
    samples.frombytes(pcm_bytes)
    if sys.byteorder != "little":
        samples.byteswap()
    if not samples:
        return pcm_bytes, out_channels, 0, 0.0

    if out_channels == 2 and len(samples) >= 4:
        left = samples[0::2]
        right = samples[1::2]
        peak_l = max((abs(x) for x in left), default=0)
        peak_r = max((abs(x) for x in right), default=0)
        if peak_r < 25 and peak_l >= 60:
            samples = left
            out_channels = 1
            peak = peak_l
        elif peak_l < 25 and peak_r >= 60:
            samples = right
            out_channels = 1
            peak = peak_r
        else:
            peak = max(peak_l, peak_r)
    else:
        peak = max((abs(x) for x in samples), default=0)

    snr_db, floor_db = _measure_snr_and_floor(samples, out_channels, out_rate)

    if 55 <= peak < 18000:
        gain = min(16.0, 22000.0 / float(peak))
        if snr_db < 4.2 and floor_db > -80.0:
            max_noise_gain = 10.0 ** ((-32.0 - floor_db) / 20.0)
            gain = min(gain, max(1.0, max_noise_gain))
        if gain > 1.25:
            samples = array.array("h", (max(-32767, min(32767, int(x * gain))) for x in samples))
            peak = min(32767, int(peak * gain))

    if sys.byteorder != "little":
        samples.byteswap()
    return samples.tobytes(), out_channels, int(peak), snr_db


def record_smartx_wav(device, out_wav, duration_sec=4.0, rate=24000, hw_channels=1):
    asound = _load_asound()

    hw_rate = int(rate)
    hw_ch = max(1, int(hw_channels))
    decim = 3 if hw_rate == 48000 else 1
    out_rate = hw_rate // decim
    out_channels = 2 if hw_ch >= 2 else 1

    pcm = _open_alsa_capture(asound, device, hw_rate, hw_ch)
    try:
        total_hw_frames = max(2400, int(float(duration_sec) * hw_rate))
        chunk_frames = min(2400, total_hw_frames)
        bytes_per_frame = hw_ch * 2
        buf = ctypes.create_string_buffer(chunk_frames * bytes_per_frame)

        collected = bytearray()
        frames_read = 0
        frame_idx = 0
        saw_nonzero = False
        zero_frames = 0
        max_zero_frames = int(hw_rate * 0.35)  # Fail over in 0.35s if pipe outputs pure digital zeros!
        t0 = time.monotonic()
        first_frame_deadline = t0 + 0.75
        hard_deadline = t0 + float(duration_sec) + 1.40

        while frames_read < total_hw_frames and not STOP_FLAG:
            now = time.monotonic()
            if frames_read == 0 and now > first_frame_deadline:
                raise RuntimeError(f"no audio frames within 0.75s on {device}")
            if now > hard_deadline:
                break

            want = min(chunk_frames, total_hw_frames - frames_read)
            got = asound.snd_pcm_readi(pcm, buf, want)
            if got == EAGAIN or got == 0:
                time.sleep(0.012)
                continue
            if got < 0:
                rec = asound.snd_pcm_recover(pcm, int(got), 1)
                if rec < 0:
                    err = asound.snd_strerror(int(got)).decode("utf-8", "replace")
                    raise RuntimeError(f"snd_pcm_readi({device}): {err} ({got})")
                asound.snd_pcm_start(pcm)
                time.sleep(0.010)
                continue

            raw = buf.raw[: got * bytes_per_frame]
            chunk_out, frame_idx = _extract_pcm_chunk(raw, got, hw_ch, out_channels, decim, frame_idx)
            if not saw_nonzero:
                if any(b != 0 for b in chunk_out):
                    saw_nonzero = True
                else:
                    zero_frames += got
                    if zero_frames >= max_zero_frames:
                        raise RuntimeError(f"digital zero stream (peak=0) on {device}")
            collected.extend(chunk_out)
            frames_read += got
    finally:
        asound.snd_pcm_close(pcm)

    out_frames = len(collected) // (out_channels * 2)
    if out_frames < max(800, out_rate // 5):
        raise RuntimeError(f"insufficient frames ({out_frames}) from {device}")

    final_pcm, final_ch, peak, snr_db = _condition_and_boost_pcm(bytes(collected), out_channels, out_rate)
    _write_wav_atomic(out_wav, final_ch, out_rate, final_pcm)

    return {
        "ok": True,
        "device": device,
        "frames": out_frames,
        "sampleRate": out_rate,
        "channels": final_ch,
        "peak": peak,
        "snrDb": snr_db,
        "bytes": len(final_pcm),
    }


def emit_json(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def run_vad_loop(device, out_wav, rate=24000, hw_channels=1):
    """
    Continuous low-CPU (<0.2%) VAD loop with 720ms pre-roll ring buffer for "Hey Bimmer" / "Ê Bimmer".
    """
    asound = _load_asound()

    hw_rate = int(rate)
    hw_ch = max(1, int(hw_channels))
    decim = 3 if hw_rate == 48000 else 1
    out_rate = hw_rate // decim
    out_channels = 2 if hw_ch >= 2 else 1

    # 60ms chunk size -> ~16.6 iterations/sec (<0.1% CPU)
    chunk_hw_frames = max(480, int(hw_rate * 0.06))
    bytes_per_frame = hw_ch * 2
    buf = ctypes.create_string_buffer(chunk_hw_frames * bytes_per_frame)

    pcm = _open_alsa_capture(asound, device, hw_rate, hw_ch)
    try:
        preroll = collections.deque(maxlen=12)  # 12 * 60ms = 720ms pre-roll
        calib_dbs = []
        active_chunks = []
        in_speech = False
        hot_streak = 0
        quiet_streak = 0
        voiced_chunks = 0
        max_speech_db = -90.0
        noise_db = -45.0
        frame_idx = 0
        got_any_frame = False
        zero_Peak_streak = 0
        t_open = time.monotonic()
        last_emit_at = 0.0

        while not STOP_FLAG:
            now = time.monotonic()
            if not got_any_frame and (now - t_open) > 1.2:
                raise RuntimeError(f"vad_no_frames on {device}")

            got = asound.snd_pcm_readi(pcm, buf, chunk_hw_frames)
            if got == EAGAIN or got == 0:
                time.sleep(0.018)
                continue
            if got < 0:
                rec = asound.snd_pcm_recover(pcm, int(got), 1)
                if rec < 0:
                    err = asound.snd_strerror(int(got)).decode("utf-8", "replace")
                    raise RuntimeError(f"vad_read_err({device}): {err} ({got})")
                asound.snd_pcm_start(pcm)
                time.sleep(0.015)
                continue

            if not got_any_frame:
                got_any_frame = True
                emit_json({"event": "ready", "device": device, "sampleRate": out_rate, "channels": out_channels})

            raw = buf.raw[: got * bytes_per_frame]
            chunk_pcm, frame_idx = _extract_pcm_chunk(raw, got, hw_ch, out_channels, decim, frame_idx)
            if not chunk_pcm:
                continue

            db, peak = _fast_chunk_db_and_peak(chunk_pcm, out_channels)
            if peak == 0:
                zero_Peak_streak += 1
                if zero_Peak_streak == 25:  # 1.5s of pure digital zeros -> tell supervisor to try next pipe
                    raise RuntimeError(f"vad_digital_zero on {device}")
            else:
                zero_Peak_streak = 0

            # Calibrate initial ambient noise floor over the first 6 chunks (360ms) so V8 engine / AC idle never false-triggers!
            if len(calib_dbs) < 6:
                preroll.append(chunk_pcm)
                if db > -85.0:
                    calib_dbs.append(db)
                    s_cal = sorted(calib_dbs)
                    noise_db = s_cal[len(s_cal) // 2]
                continue

            # Trigger cleanly at +7.0 dB above rolling cabin noise floor (floor -47 dBFS, peak >= 120)
            thresh_db = max(-47.0, min(-18.0, noise_db + 7.0))
            is_hot = (db >= thresh_db) and (peak >= 120)

            if not in_speech:
                preroll.append(chunk_pcm)
                if not is_hot and db > -85.0:
                    noise_db = noise_db * 0.95 + db * 0.05
                elif is_hot and db > -85.0:
                    # Slow upward drift if cabin background noise stepped up (e.g. engine start or AC fan boost)
                    noise_db = noise_db * 0.99 + db * 0.01
                if is_hot:
                    hot_streak += 1
                    if hot_streak >= 3 and (now - last_emit_at) >= 1.2:
                        in_speech = True
                        active_chunks = list(preroll)
                        preroll.clear()
                        voiced_chunks = hot_streak
                        quiet_streak = 0
                        max_speech_db = db
                        emit_json({"event": "speech_start", "db": db, "noiseDb": round(noise_db, 1)})
                else:
                    hot_streak = 0
            else:
                active_chunks.append(chunk_pcm)
                if is_hot:
                    voiced_chunks += 1
                    quiet_streak = 0
                    if db > max_speech_db:
                        max_speech_db = db
                else:
                    quiet_streak += 1

                # Allow natural 900ms pause right after "Hey Bimmer," (<30 chunks) and 720ms after command body, max 6.6s
                hangover_chunks = 15 if len(active_chunks) < 30 else 12
                hit_ceiling = len(active_chunks) >= 110
                if quiet_streak >= hangover_chunks or hit_ceiling:
                    pcm_all = b"".join(active_chunks)
                    dur_ms = int(round((len(pcm_all) / (out_channels * 2 * out_rate)) * 1000))
                    in_speech = False
                    active_chunks = []
                    hot_streak = 0
                    quiet_streak = 0

                    raw_samples = array.array("h")
                    raw_samples.frombytes(pcm_all)
                    if sys.byteorder != "little":
                        raw_samples.byteswap()
                    clip_snr_db, clip_floor_db = _measure_snr_and_floor(raw_samples, out_channels, out_rate)

                    # Stationary drone (AC / V8 idle step) hitting 6.6s ceiling with <3.5 dB modulation: re-anchor floor & drop!
                    if clip_snr_db < 3.5:
                        if clip_floor_db > -80.0:
                            noise_db = clip_floor_db
                        emit_json({"event": "speech_cancel", "durationMs": dur_ms, "snrDb": clip_snr_db})
                    elif voiced_chunks >= 6 and dur_ms >= 550:
                        final_pcm, final_ch, _, snr_out = _condition_and_boost_pcm(pcm_all, out_channels, out_rate)
                        _write_wav_atomic(out_wav, final_ch, out_rate, final_pcm)
                        last_emit_at = time.monotonic()
                        emit_json({
                            "event": "utterance",
                            "file": out_wav,
                            "durationMs": dur_ms,
                            "speechDb": round(max_speech_db, 1),
                            "noiseDb": round(noise_db, 1),
                            "snrDb": snr_out,
                            "device": device,
                        })
                    else:
                        emit_json({"event": "speech_cancel", "durationMs": dur_ms})
    finally:
        asound.snd_pcm_close(pcm)
        tmp_leftover = out_wav + ".tmp." + str(os.getpid())
        try:
            if os.path.exists(tmp_leftover):
                os.unlink(tmp_leftover)
        except OSError:
            pass


def main():
    if len(sys.argv) >= 4 and sys.argv[1] == "--vad-loop":
        dev = sys.argv[2]
        out_wav = sys.argv[3]
        rate = int(sys.argv[4]) if len(sys.argv) > 4 else 24000
        ch = int(sys.argv[5]) if len(sys.argv) > 5 else 1
        try:
            run_vad_loop(dev, out_wav, rate, ch)
        except Exception as exc:
            emit_json({"event": "error", "error": str(exc)})
            sys.exit(1)
        sys.exit(0)

    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "usage: alsa-smartx.py <device> <out.wav> [duration_sec] [rate] [hw_channels]"}))
        sys.exit(2)
    dev = sys.argv[1]
    out_wav = sys.argv[2]
    dur = float(sys.argv[3]) if len(sys.argv) > 3 else 4.0
    rate = int(sys.argv[4]) if len(sys.argv) > 4 else 24000
    ch = int(sys.argv[5]) if len(sys.argv) > 5 else 1
    try:
        res = record_smartx_wav(dev, out_wav, dur, rate, ch)
        print(json.dumps(res))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
