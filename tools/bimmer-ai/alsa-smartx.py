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


def _fast_chunk_db_and_peak(pcm_bytes):
    samples = array.array("h")
    samples.frombytes(pcm_bytes)
    if sys.byteorder != "little":
        samples.byteswap()
    n = len(samples)
    if n == 0:
        return -90.0, 0
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


def record_smartx_wav(device, out_wav, duration_sec=4.0, rate=24000, hw_channels=1):
    asound = ctypes.CDLL("libasound.so.2")
    asound.snd_strerror.restype = ctypes.c_char_p

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
        t0 = time.monotonic()
        first_frame_deadline = t0 + 0.90
        hard_deadline = t0 + float(duration_sec) + 1.40

        while frames_read < total_hw_frames and not STOP_FLAG:
            now = time.monotonic()
            if frames_read == 0 and now > first_frame_deadline:
                raise RuntimeError(f"no audio frames within 0.9s on {device}")
            if now > hard_deadline:
                break

            want = min(chunk_frames, total_hw_frames - frames_read)
            got = asound.snd_pcm_readi(pcm, buf, want)
            if got == EAGAIN or got == 0:
                time.sleep(0.012)
                continue
            if got < 0:
                rec = asound.snd_pcm_recover(pcm, got, 1)
                if rec < 0:
                    err = asound.snd_strerror(got).decode("utf-8", "replace")
                    raise RuntimeError(f"snd_pcm_readi({device}): {err} ({got})")
                time.sleep(0.010)
                continue

            raw = buf.raw[: got * bytes_per_frame]
            chunk_out, frame_idx = _extract_pcm_chunk(raw, got, hw_ch, out_channels, decim, frame_idx)
            collected.extend(chunk_out)
            frames_read += got
    finally:
        asound.snd_pcm_close(pcm)

    out_frames = len(collected) // (out_channels * 2)
    if out_frames < max(800, out_rate // 5):
        raise RuntimeError(f"insufficient frames ({out_frames}) from {device}")

    _, peak = _fast_chunk_db_and_peak(collected)
    _write_wav_atomic(out_wav, out_channels, out_rate, bytes(collected))

    return {
        "ok": True,
        "device": device,
        "frames": out_frames,
        "sampleRate": out_rate,
        "channels": out_channels,
        "peak": peak,
        "bytes": len(collected),
    }


def emit_json(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def run_vad_loop(device, out_wav, rate=24000, hw_channels=1):
    """
    Continuous low-CPU (<0.2%) VAD loop with 720ms pre-roll ring buffer for "Hey Bimmer" / "Ê Bimmer".
    """
    asound = ctypes.CDLL("libasound.so.2")
    asound.snd_strerror.restype = ctypes.c_char_p

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
        active_chunks = []
        in_speech = False
        hot_streak = 0
        quiet_streak = 0
        voiced_chunks = 0
        max_speech_db = -90.0
        noise_db = -52.0
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
                rec = asound.snd_pcm_recover(pcm, got, 1)
                if rec < 0:
                    err = asound.snd_strerror(got).decode("utf-8", "replace")
                    raise RuntimeError(f"vad_read_err({device}): {err} ({got})")
                time.sleep(0.015)
                continue

            if not got_any_frame:
                got_any_frame = True
                emit_json({"event": "ready", "device": device, "sampleRate": out_rate, "channels": out_channels})

            raw = buf.raw[: got * bytes_per_frame]
            chunk_pcm, frame_idx = _extract_pcm_chunk(raw, got, hw_ch, out_channels, decim, frame_idx)
            if not chunk_pcm:
                continue

            db, peak = _fast_chunk_db_and_peak(chunk_pcm)
            if peak == 0:
                zero_Peak_streak += 1
                if zero_Peak_streak == 25:  # 1.5s of pure digital zeros -> tell supervisor to try next pipe
                    raise RuntimeError(f"vad_digital_zero on {device}")
            else:
                zero_Peak_streak = 0

            # Dynamic threshold: at least -37 dBFS AND +9.5 dB above rolling cabin noise floor
            thresh_db = max(-37.0, min(-18.0, noise_db + 9.5))
            is_hot = (db >= thresh_db) and (peak >= 320)

            if not in_speech:
                preroll.append(chunk_pcm)
                if not is_hot and db > -85.0:
                    noise_db = noise_db * 0.96 + db * 0.04
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
                if quiet_streak >= hangover_chunks or len(active_chunks) >= 110:
                    pcm_all = b"".join(active_chunks)
                    dur_ms = int(round((len(pcm_all) / (out_channels * 2 * out_rate)) * 1000))
                    in_speech = False
                    active_chunks = []
                    hot_streak = 0
                    quiet_streak = 0

                    # Require >= 7 voiced chunks (~420ms actual voice) & >= 600ms total to ignore door slams / clicks
                    if voiced_chunks >= 7 and dur_ms >= 600:
                        _write_wav_atomic(out_wav, out_channels, out_rate, pcm_all)
                        last_emit_at = time.monotonic()
                        emit_json({
                            "event": "utterance",
                            "file": out_wav,
                            "durationMs": dur_ms,
                            "speechDb": round(max_speech_db, 1),
                            "noiseDb": round(noise_db, 1),
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
