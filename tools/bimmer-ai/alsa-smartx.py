#!/usr/bin/env python3
"""
alsa-smartx.py - Native ALSA / Intel SmartXbar PCM WAV recorder for BMW MGU (iDrive 7).

Runs on `/var/opt/mgu-python/current/bin/python3` using `/usr/lib/libasound.so.2` via `ctypes`
(since Yocto Linux on MGU uses Intel SmartXbar `/run/smartx` and does not ship `arecord`).

Supports:
  - 1-channel 24 kHz Hardware ECNR streams (`smartx:VoiceNotesSink_CF_24_MONO`, `smartx:AndroidAutoSink_CF_24_MONO`)
  - Multi-channel 2-Mic streams (`avb:MGU_GW_3_SOURCE_CF_2MIC_6REF`, `smartx:SpeechSink_CF_2MIC_1REF_SPEECH`)
    extracting Channel 0 (Driver ceiling mic) and Channel 1 (Passenger ceiling mic) into a standard 2-channel WAV!
"""
import ctypes
import json
import os
import struct
import sys
import wave

SND_PCM_STREAM_CAPTURE = 1
SND_PCM_NONBLOCK = 1
SND_PCM_FORMAT_S16_LE = 2
SND_PCM_ACCESS_RW_INTERLEAVED = 3


def record_smartx_wav(device, out_wav, duration_sec=4.0, rate=24000, hw_channels=1):
    asound = ctypes.CDLL("libasound.so.2")
    asound.snd_strerror.restype = ctypes.c_char_p

    pcm = ctypes.c_void_p()
    rc = asound.snd_pcm_open(ctypes.byref(pcm), device.encode("utf-8"), SND_PCM_STREAM_CAPTURE, SND_PCM_NONBLOCK)
    if rc < 0:
        err = asound.snd_strerror(rc).decode("utf-8", "replace")
        raise RuntimeError(f"snd_pcm_open({device}): {err} ({rc})")

    try:
        asound.snd_pcm_nonblock(pcm, 0)
        rc = asound.snd_pcm_set_params(
            pcm,
            SND_PCM_FORMAT_S16_LE,
            SND_PCM_ACCESS_RW_INTERLEAVED,
            int(hw_channels),
            int(rate),
            1,
            100000,
        )
        if rc < 0:
            err = asound.snd_strerror(rc).decode("utf-8", "replace")
            raise RuntimeError(f"snd_pcm_set_params({device}, ch={hw_channels}, rate={rate}): {err} ({rc})")

        total_frames = max(1600, int(float(duration_sec) * int(rate)))
        chunk_frames = min(2400, total_frames)
        bytes_per_frame = int(hw_channels) * 2
        buf = ctypes.create_string_buffer(chunk_frames * bytes_per_frame)

        out_channels = 2 if int(hw_channels) >= 2 else 1
        collected = bytearray()
        frames_read = 0

        while frames_read < total_frames:
            want = min(chunk_frames, total_frames - frames_read)
            got = asound.snd_pcm_readi(pcm, buf, want)
            if got < 0:
                got = asound.snd_pcm_recover(pcm, got, 1)
                if got < 0:
                    break
                continue
            if got == 0:
                break
            raw = buf.raw[: got * bytes_per_frame]
            if int(hw_channels) <= 2:
                collected.extend(raw)
            else:
                # Extract Ch0 (Driver Mic) and Ch1 (Passenger Mic) from 2MIC_1REF (3ch) or 2MIC_6REF (8ch)
                step = bytes_per_frame
                for off in range(0, len(raw), step):
                    collected.extend(raw[off : off + 4])
            frames_read += got
    finally:
        asound.snd_pcm_close(pcm)

    tmp_path = out_wav + ".tmp"
    with wave.open(tmp_path, "wb") as wf:
        wf.setnchannels(out_channels)
        wf.setsampwidth(2)
        wf.setframerate(int(rate))
        wf.writeframes(bytes(collected))
    os.replace(tmp_path, out_wav)

    return {
        "ok": True,
        "device": device,
        "frames": frames_read,
        "sampleRate": int(rate),
        "channels": out_channels,
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
