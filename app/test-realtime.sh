#!/bin/bash
# Verify the in-browser OpenAI Realtime pipeline (hook.js _kajuStartRealtime)
# end-to-end WITHOUT a live meeting: seed the mixer queue with a spoken question,
# run it in headless Chrome, and confirm the model hears + answers. Needs
# OPENAI_API_KEY in ../.env. This is the exact path a real Meet uses (minus the
# WebRTC track interception, which is the production-proven capture shared with
# the Deepgram path).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a

# Spoken question → 16kHz mono PCM (the tracks' rate; the mixer upsamples to 24k).
say -o /tmp/q.aiff "Hey Vox, what is two plus two? Answer in one short sentence." 2>/dev/null || \
  { echo "need macOS 'say'"; exit 1; }
ffmpeg -y -i /tmp/q.aiff -ac 1 -ar 16000 -f s16le -loglevel error /tmp/q16.raw

python3 - <<'PY'
import base64, os
raw = open('/tmp/q16.raw','rb').read()
b64 = base64.b64encode(raw).decode()
hook = open('hook.js').read()
key = os.environ['OPENAI_API_KEY']
html = f"""<!doctype html><meta charset=utf8><body>t<script>{hook}</script><script>
var key={key!r},b64={b64!r};var bin=atob(b64),bytes=new Uint8Array(bin.length);
for(var i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);var i16=new Int16Array(bytes.buffer);
window._kajuTrackQueues={{test:Array.prototype.slice.call(i16)}};
window._kajuStartRealtime({{key:key,model:"gpt-realtime-2.1-mini",voice:"cedar",transcribe:"gpt-4o-mini-transcribe",instructions:"Answer in one short sentence."}});
setInterval(function(){{(window._kajuDrainRealtimeEvents()||[]).forEach(function(e){{console.log("RT_EV "+e.type+" "+((e.text||"").slice(0,80)));}});}},400);
</script></body>"""
open('/tmp/rttest.html','w').write(html)
PY

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
P=$(mktemp -d)
"$CHROME" --headless=new --disable-gpu --enable-logging=stderr --v=0 \
  --autoplay-policy=no-user-gesture-required --user-data-dir="$P" --no-first-run \
  "file:///tmp/rttest.html" >/tmp/rttest.out 2>&1 &
CPID=$!; sleep 15; kill $CPID 2>/dev/null || true; rm -rf "$P" 2>/dev/null || true

echo "--- in-browser realtime events ---"
grep -oE 'RT_EV [a-z_]+ ?.*' /tmp/rttest.out | sed 's/RT_EV //;s/", source.*//'
if grep -q 'RT_EV said' /tmp/rttest.out; then echo "PASS: in-browser realtime responded"; else echo "FAIL"; exit 1; fi
