#!/bin/sh
# probe-car-mic.sh - Read-only 5-second inspection script for BMW MGU OEM ceiling microphones.
# Can be executed via MGU DevLink AGY or SSH (`ssh root@<mgu-ip> 'sh -s' < scripts/probe-car-mic.sh`).

echo "=== 1. ALSA SOUND CARDS (/proc/asound/cards) ==="
cat /proc/asound/cards 2>&1 || true

echo ""
echo "=== 2. ALSA PCM STREAMS (/proc/asound/pcm) ==="
cat /proc/asound/pcm 2>&1 || true

echo ""
echo "=== 3. /dev/snd CAPTURE NODES ==="
ls -la /dev/snd/ 2>&1 || true

echo ""
echo "=== 4. ARECORD CAPTURE PCM LIST ==="
arecord -L 2>&1 | head -n 60 || true

echo ""
echo "=== 5. GENIVI AUDIOMANAGER MAIN SOURCES (SOME/IP 45088) ==="
/usr/bin/node -e '
const fs = require("fs");
try {
  const db = JSON.parse(fs.readFileSync("/etc/oap/someip/someip-interfaces.json", "utf8"));
  const iv = db.interfaces["org.genivi.am.commandinterface.CommandControl"];
  console.log("CommandControl methods:", iv ? Object.keys(iv.methods) : "absent");
  const sp = db.interfaces["de.bmw.infotainment.speech.recognizer.Recognizer"];
  console.log("Speech Recognizer fields:", sp ? Object.keys(sp.fields) : "absent");
} catch (e) { console.log("err:", e.message); }
' 2>&1 || true
