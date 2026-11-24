#!/usr/bin/env python3
"""
alsa-smartx.py - Non-blocking ALSA / Intel SmartXbar PCM WAV recorder for BMW MGU (iDrive 7).

Key reliability guarantees:
  1. Keeps `SND_PCM_NONBLOCK` enabled with a 0.9s first-frame watchdog + full duration deadline so
     unrouted or busy SmartX/AVB pipes fail fast (<0.9s) instead of hanging inside `libasound.so.2`.
  2. Extracts Ch0 (Driver ceiling mic) + Ch1 (Passenger ceiling mic) from 3ch/8ch pipes and
     downsamples 48 kHz -> 16 kHz (`3:1`) for fast upload over mobile hotspot.
  3. Reports exact `frames` and `peak` amplitude so `audio-io.js` can automatically fail over
     if a pipe returns digital zeros (`peak == 0`).
"""
import array
import ctypes
import json
import os
import sys
import time
import wave

SND_PCM_STREAM_CAPTURE = 1
SND_PCM_NONBLOCK = 1
SND_PCM_FORMAT_S16_LE = 2
SND_PCM_ACCESS_RW_INTERLEAVED = 3
EAGAIN = -11


def record_smartx_wav(device, out_wav, duration_sec=4.0, rate=24000, hw_channels=1):
    asound = ctypes.CDLL("libasound.so.2")
    asound.snd_strerror.restype = ctypes.c_char_p

    pcm = ctypes.c_void_p()
    rc = asound.snd_pcm_open(ctypes.byref(pcm), device.encode("utf-8"), SND_PCM_STREAM_CAPTURE, SND_PCM_NONBLOCK)
    if rc < 0:
        err = asound.snd_strerror(rc).decode("utf-8", "replace")
        raise RuntimeError(f"snd_pcm_open({device}): {err} ({rc})")

    hw_rate = int(rate)
    hw_ch = max(1, int(hw_channels))
    decim = 3 if hw_rate == 48000 else 1
    out_rate = hw_rate // decim
    out_channels = 2 if hw_ch >= 2 else 1

    try:
        asound.snd_pcm_nonblock(pcm, 1)
        rc = asound.snd_pcm_set_params(
            pcm,
            SND_PCM_FORMAT_S16_LE,
            SND_PCM_ACCESS_RW_INTERLEAVED,
            hw_ch,
            hw_rate,
            1,
            100000,
        )
        if rc < 0:
            err = asound.snd_strerror(rc).decode("utf-8", "replace")
            raise RuntimeError(f"snd_pcm_set_params({device}, ch={hw_ch}, rate={hw_rate}): {err} ({rc})")

        asound.snd_pcm_prepare(pcm)
        asound.snd_pcm_start(pcm)

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

        while frames_read < total_hw_frames:
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
            if hw_ch == 1 and decim == 1:
                collected.extend(raw)
            elif hw_ch == 2 and decim == 1:
                collected.extend(raw)
            else:
                sample_bytes = 4 if out_channels == 2 else 2
                for f in range(got):
                    if decim == 1 or (frame_idx % decim) == 0:
                        off = f * bytes_per_frame
                        collected.extend(raw[off : off + sample_bytes])
                    frame_idx += 1
            frames_read += got
    finally:
        asound.snd_pcm_close(pcm)

    out_frames = len(collected) // (out_channels * 2)
    if out_frames < max(800, out_rate // 5):
        raise RuntimeError(f"insufficient frames ({out_frames}) from {device}")

    samples = array.array("h")
    samples.frombytes(collected)
    if sys.byteorder != "little":
        samples.byteswap()
    peak = max((abs(x) for x in samples), default=0)

    tmp_path = out_wav + ".tmp." + str(os.getpid())
    with wave.open(tmp_path, "wb") as wf:
        wf.setnchannels(out_channels)
        wf.setsampwidth(2)
        wf.setframerate(out_rate)
        wf.writeframes(bytes(collected))
    os.replace(tmp_path, out_wav)

    return {
        "ok": True,
        "device": device,
        "frames": out_frames,
        "sampleRate": out_rate,
        "channels": out_channels,
        "peak": int(peak),
        "bytes": len(collected),
    }


def main():
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
