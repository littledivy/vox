(function () {
  window._kajuTracks = [];
  window._kajuLocalStreamIds = new Set();
  window._kajuPeerConnections = [];
  window._kajuPendingTracks = []; // audio tracks seen before capture starts

  // --- Intercept audio at the API boundary ------------------------------------
  // Meet plays remote audio somewhere — an <audio>/<video> element srcObject OR
  // an internal Web Audio graph. Wherever it routes it, that stream carries the
  // REAL audio (the raw RTCPeerConnection receiver tracks are silent decoys).
  // Hook both entry points and grab every audio track Meet feeds to playback.
  function _kajuMaybeProcess(track) {
    if (!track || track.kind !== "audio") return;
    if (window._kajuCapturing && typeof _kajuProcessTrack === "function") {
      _kajuProcessTrack(track);
    } else {
      window._kajuPendingTracks.push(track);
    }
  }
  function _kajuGrabStream(s) {
    try {
      if (s && s.getAudioTracks) s.getAudioTracks().forEach(_kajuMaybeProcess);
    } catch (e) {}
  }
  try {
    var mediaDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "srcObject");
    if (mediaDesc && mediaDesc.set) {
      Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
        configurable: true,
        enumerable: mediaDesc.enumerable,
        get: function () { return mediaDesc.get.call(this); },
        set: function (s) {
          _kajuGrabStream(s);
          return mediaDesc.set.call(this, s);
        },
      });
    }
  } catch (e) { console.log("[kaju] srcObject hook failed: " + e); }

  try {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (AC && AC.prototype.createMediaStreamSource) {
      var origCMSS = AC.prototype.createMediaStreamSource;
      AC.prototype.createMediaStreamSource = function (stream) {
        _kajuGrabStream(stream);
        return origCMSS.call(this, stream);
      };
    }
    if (window.MediaStreamAudioSourceNode) {
      var OrigNode = window.MediaStreamAudioSourceNode;
      window.MediaStreamAudioSourceNode = function (ctx, opts) {
        if (opts && opts.mediaStream) _kajuGrabStream(opts.mediaStream);
        return new OrigNode(ctx, opts);
      };
      window.MediaStreamAudioSourceNode.prototype = OrigNode.prototype;
    }
  } catch (e) { console.log("[kaju] AudioContext hook failed: " + e); }

  // --- Active speaker detection (for Flux mode) ---
  // --- Per-channel energy tracking for speaker detection (Flux mode) ---
  // Accumulates RMS energy per channel between StartOfTurn and EndOfTurn.
  window._kajuChannelEnergy = []; // per-channel accumulated energy
  window._kajuChannelSamples = 0; // total samples accumulated
  window._kajuInTurn = false; // true between StartOfTurn and EndOfTurn

  function _kajuResetEnergy() {
    var n = window._kajuChannelCount || 1;
    window._kajuChannelEnergy = [];
    for (var i = 0; i < n; i++) {
      window._kajuChannelEnergy.push(0);
    }
    window._kajuChannelSamples = 0;
  }

  // Returns array of channel indices that had significant energy during the turn.
  function _kajuGetActiveSpeakers() {
    var energy = window._kajuChannelEnergy;
    var samples = window._kajuChannelSamples;
    if (!energy.length || samples === 0) return [];

    // Compute RMS per channel.
    var rms = [];
    var maxRms = 0;
    for (var i = 0; i < energy.length; i++) {
      var r = Math.sqrt(energy[i] / samples);
      rms.push(r);
      if (r > maxRms) maxRms = r;
    }

    // A channel is "active" if its RMS is above a noise floor AND
    // at least 10% of the loudest channel (handles volume differences).
    var threshold = 0.0005; // absolute noise floor
    var relThreshold = maxRms * 0.1;
    var active = [];
    for (var i = 0; i < rms.length; i++) {
      if (rms[i] > threshold && rms[i] > relThreshold) {
        active.push(i);
      }
    }

    // If no channel passed the threshold, pick the loudest one — someone was
    // definitely speaking if Flux detected an EndOfTurn.
    if (active.length === 0 && maxRms > 0) {
      for (var i = 0; i < rms.length; i++) {
        if (rms[i] === maxRms) {
          active.push(i);
          break;
        }
      }
    }

    console.log(
      "[kaju] turn energy: " + rms.map(function (r) {
        return r.toFixed(4);
      }).join(", ") +
        " → active channels: " + JSON.stringify(active),
    );
    return active;
  }

  // --- PCM capture + Deepgram STT state ---
  window._kajuCaptureCtx = null;
  window._kajuCaptureProcessor = null;
  window._kajuDeepgramWS = null;
  window._kajuDeepgramEvents = []; // transcript events for Go to drain

  // --- TTS playback state ---
  window._kajuAudioCtx = null;
  window._kajuTTSDest = null;
  window._kajuPlayingNow = false;

  // Hook getUserMedia to track local streams and inject entity video.
  var origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
    navigator.mediaDevices,
  );
  navigator.mediaDevices.getUserMedia = function (constraints) {
    var wantsVideo = constraints && constraints.video && window._kajuEntityVideoTrack;
    // When video is requested, DON'T ask Chrome for a real camera (there is none
    // in the container — that path needs the fake device, whose 1kHz test tone
    // leaks into the meeting). Instead take audio from the real device (the
    // PulseAudio vox_mic that carries our TTS) and supply the shader canvas as
    // the video track ourselves. No fake device, no beep.
    if (wantsVideo) {
      var audioConstraints = constraints.audio || false;
      var buildStream = function (audioStream) {
        var out = new MediaStream();
        if (audioStream) {
          audioStream.getAudioTracks().forEach(function (t) { out.addTrack(t); });
          window._kajuLocalStreamIds.add(audioStream.id);
        }
        out.addTrack(window._kajuEntityVideoTrack);
        window._kajuLocalStreamIds.add(out.id);
        console.log("[kaju] built stream: real audio + shader video (no camera)");
        return out;
      };
      if (audioConstraints) {
        return origGetUserMedia
          .call(navigator.mediaDevices, { audio: audioConstraints })
          .then(buildStream)
          .catch(function () { return buildStream(null); });
      }
      return Promise.resolve(buildStream(null));
    }
    return origGetUserMedia.apply(navigator.mediaDevices, arguments).then(
      function (stream) {
        window._kajuLocalStreamIds.add(stream.id);
        return stream;
      },
    );
  };

  // Advertise a synthetic camera so Meet enables its "Turn on camera" control
  // even though the container has no real camera device. When the camera is
  // switched on, Meet calls getUserMedia({video}) and the hook above supplies
  // the shader canvas. This avoids --use-fake-device-for-media-stream (whose
  // 1kHz test tone would leak into the meeting audio).
  if (navigator.mediaDevices.enumerateDevices) {
    var origEnum = navigator.mediaDevices.enumerateDevices.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.enumerateDevices = function () {
      return origEnum().then(function (devices) {
        var hasCam = devices.some(function (d) {
          return d.kind === "videoinput";
        });
        if (!hasCam) {
          devices = devices.concat([
            {
              deviceId: "vox-entity-cam",
              kind: "videoinput",
              label: "Vox Camera",
              groupId: "vox-entity",
              toJSON: function () {
                return this;
              },
            },
          ]);
        }
        return devices;
      });
    };
  }

  if (navigator.mediaDevices.getDisplayMedia) {
    var origGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getDisplayMedia = function () {
      return origGetDisplayMedia
        .apply(navigator.mediaDevices, arguments)
        .then(function (stream) {
          window._kajuLocalStreamIds.add(stream.id);
          return stream;
        });
    };
  }

  // Proxy RTCPeerConnection to capture remote audio tracks.
  var OrigRTC = window.RTCPeerConnection;
  window.RTCPeerConnection = new Proxy(OrigRTC, {
    construct: function (target, args, newTarget) {
      var pc = Reflect.construct(target, args, newTarget);
      window._kajuPeerConnections.push(pc);
      pc.addEventListener("track", function (event) {
        var t = event.track;
        var streamIds = event.streams
          ? event.streams.map(function (s) {
            return s.id;
          })
          : [];
        var mid = event.transceiver ? event.transceiver.mid : "?";
        console.log(
          "[kaju] Remote track:",
          t.kind,
          "id=" + t.id,
          "label=" + t.label,
          "mid=" + mid,
          "streams=" + JSON.stringify(streamIds),
          "state:" + t.readyState,
        );
        // Collect remote AUDIO tracks — the reliable participant signal in a
        // headless audio-only join (Meet's DOM participant tiles don't render, so
        // scraping [data-self-name] undercounts and the bot wrongly thinks it's in
        // a 1:1). Each remote participant has one audio stream; counting distinct
        // live streams tells us how many OTHERS are really in the call.
        if (t.kind === "audio") {
          if (!window._kajuAudioTracks) window._kajuAudioTracks = [];
          window._kajuAudioTracks.push({ track: t, streams: streamIds });
        }
        // Collect all remote video tracks. Capture frames from whichever is live.
        if (t.kind === "video") {
          if (!window._kajuVideoTracks) window._kajuVideoTracks = [];
          window._kajuVideoTracks.push(t);
          console.log("[kaju] added video track " + t.id + " (total: " + window._kajuVideoTracks.length + ")");

          // Start the capture loop once (polls all tracks for the best live one).
          if (!window._kajuScreenCaptureInterval) {
            var captureCanvas = document.createElement("canvas");
            captureCanvas.width = 1280;
            captureCanvas.height = 720;
            var captureCtx = captureCanvas.getContext("2d");
            var captureVideo = document.createElement("video");
            captureVideo.muted = true;
            captureVideo.playsInline = true;
            var currentTrackId = null;

            window._kajuScreenCaptureInterval = setInterval(function () {
              // Find the best live video track (prefer later ones — likely screen share).
              var best = null;
              for (var i = window._kajuVideoTracks.length - 1; i >= 0; i--) {
                var vt = window._kajuVideoTracks[i];
                if (vt.readyState === "live" && !vt.muted) {
                  best = vt;
                  break;
                }
              }
              if (!best) {
                window._kajuScreenShareActive = false;
                return;
              }
              // Switch video element source if track changed.
              if (best.id !== currentTrackId) {
                captureVideo.srcObject = new MediaStream([best]);
                captureVideo.play();
                currentTrackId = best.id;
                console.log("[kaju] screen capture switched to track " + best.id);
              }
              if (captureVideo.videoWidth === 0) return; // not ready yet
              window._kajuScreenShareActive = true;
              captureCtx.drawImage(captureVideo, 0, 0, 1280, 720);
              var dataUrl = captureCanvas.toDataURL("image/jpeg", 0.9);
              window._kajuLatestScreenFrame = dataUrl.split(",")[1];
            }, 10000); // 1 frame per 10s
            console.log("[kaju] screen capture loop started (1 frame/10s, 1280x720)");
          }
        }

        if (t.kind === "audio") {
          window._kajuTracks.push(t);
          // If capture already started, process this new track immediately;
          // otherwise it'll be picked up when _kajuStartPCMCapture runs.
          if (window._kajuCapturing && typeof _kajuProcessTrack === "function") {
            _kajuProcessTrack(t);
          }
        }
      });
      return pc;
    },
  });

  // --- PCM audio capture + Deepgram STT (in-browser) ---
  // Captures remote audio as 16kHz Int16 PCM and sends directly to Deepgram
  // via WebSocket. Transcript events are queued for Go to drain.

  window._kajuChannelCount = 0;
  window._kajuMaxChannels = 8; // pre-allocated merger size
  window._kajuCaptureMerger = null; // exposed for hot-adding tracks
  window._kajuDeepgramConfig = null; // set by Go before starting

  // Connect to Deepgram WebSocket from browser.
  // Supports two modes: "flux" (v2, via proxy) and "nova-3" (v1, direct).
  function _kajuConnectDeepgram(numChannels) {
    var cfg = window._kajuDeepgramConfig;
    if (!cfg) {
      console.error("[kaju] Deepgram config not set");
      return;
    }

    var mode = cfg.mode || "nova-3";
    var ws;

    if (mode === "flux") {
      // Connect DIRECTLY to Deepgram (wss) using the token subprotocol for
      // auth. This avoids a local ws://127.0.0.1 proxy, which Chrome's Private
      // Network Access blocks from the https Meet page.
      if (cfg.url && cfg.apiKey) {
        ws = new WebSocket(cfg.url, ["token", cfg.apiKey]);
        console.log("[kaju] Deepgram connecting Flux v2 (direct)");
      } else if (cfg.proxyURL) {
        ws = new WebSocket(cfg.proxyURL);
        console.log("[kaju] Deepgram connecting via Flux proxy: " + cfg.proxyURL);
      } else {
        console.error("[kaju] Deepgram Flux url/apiKey not set");
        return;
      }
    } else {
      if (!cfg.apiKey) {
        console.error("[kaju] Deepgram API key not set");
        return;
      }
      var multichannel = numChannels > 1 ? "&multichannel=true" : "";
      var url = "wss://api.deepgram.com/v1/listen?" +
        "model=nova-3" +
        "&encoding=linear16&sample_rate=16000&channels=" + numChannels +
        "&interim_results=true" +
        "&endpointing=150" +
        "&vad_events=true&smart_format=true&no_delay=true" + multichannel;
      ws = new WebSocket(url, ["token", cfg.apiKey]);
      console.log(
        "[kaju] Deepgram connecting Nova-3 (v1, " + numChannels + " channels)",
      );
    }

    ws.binaryType = "arraybuffer";

    ws.onopen = function () {
      console.log("[kaju] Deepgram connected (" + mode + ")");
      window._kajuDeepgramWS = ws;
    };

    ws.onmessage = function (evt) {
      try {
        var msg = JSON.parse(evt.data);

        if (msg.type === "TurnInfo") {
          // Flux v2 events — only log StartOfTurn/EndOfTurn and Updates with transcript.
          if (msg.event !== "Update" || msg.transcript) {
            console.log(
              "[kaju] Deepgram: TurnInfo event=" + msg.event +
                (msg.transcript ? ' t="' + msg.transcript + '"' : ""),
            );
          }
          if (msg.event === "EndOfTurn") {
            var transcript = (msg.transcript || "").trim();
            if (transcript) {
              // Determine who spoke using per-channel audio energy.
              var activeSpeakers = _kajuGetActiveSpeakers();
              var ev = {
                type: "transcript",
                transcript: transcript,
                is_final: true,
                speech_final: true,
                speaker: activeSpeakers.length === 1 ? activeSpeakers[0] : -1,
                speakers: activeSpeakers,
              };
              window._kajuDeepgramEvents.push(ev);
            }
            window._kajuInTurn = false;
            window._kajuDeepgramEvents.push({ type: "end_of_turn" });
          } else if (msg.event === "EagerEndOfTurn") {
            var transcript = (msg.transcript || "").trim();
            if (transcript) {
              var activeSpeakers = _kajuGetActiveSpeakers();
              window._kajuDeepgramEvents.push({
                type: "eager_end_of_turn",
                transcript: transcript,
                speaker: activeSpeakers.length === 1 ? activeSpeakers[0] : -1,
                speakers: activeSpeakers,
              });
            }
          } else if (msg.event === "TurnResumed") {
            window._kajuDeepgramEvents.push({ type: "turn_resumed" });
          } else if (msg.event === "StartOfTurn") {
            _kajuResetEnergy();
            window._kajuInTurn = true;
            window._kajuDeepgramEvents.push({ type: "speech_started" });
          }
        } else if (msg.type === "Results") {
          // Nova-3 v1 results with speaker attribution.
          var alts = msg.channel && msg.channel.alternatives;
          if (alts && alts.length > 0 && alts[0].transcript) {
            var speaker = -1;
            if (msg.channel_index && msg.channel_index.length > 0) {
              speaker = msg.channel_index[0];
            } else if (alts[0].words && alts[0].words.length > 0) {
              speaker = alts[0].words[0].speaker;
            }
            window._kajuDeepgramEvents.push({
              type: "transcript",
              transcript: alts[0].transcript,
              is_final: !!msg.is_final,
              speech_final: !!msg.speech_final,
              speaker: speaker,
            });
            // speech_final = end of turn (nova-3 mode).
            if (msg.speech_final) {
              window._kajuDeepgramEvents.push({ type: "end_of_turn" });
            }
          }
        } else if (msg.type === "SpeechStarted") {
          window._kajuDeepgramEvents.push({ type: "speech_started" });
        } else if (msg.type === "UtteranceEnd") {
          // Fallback end-of-turn for nova-3.
          window._kajuDeepgramEvents.push({ type: "end_of_turn" });
        }
      } catch (e) {}
    };

    var reconnect = function (why) {
      window._kajuDeepgramWS = null;
      if (window._kajuDGReconnecting) return;
      window._kajuDGReconnecting = true;
      console.log("[kaju] Deepgram reconnecting (" + why + ") in 1.5s");
      setTimeout(function () {
        window._kajuDGReconnecting = false;
        if (!window._kajuDeepgramWS) _kajuConnectDeepgram(numChannels);
      }, 1500);
    };

    ws.onerror = function () {
      console.error("[kaju] Deepgram WebSocket error");
      try { ws.close(); } catch (e) {}
      reconnect("error");
    };

    ws.onclose = function (e) {
      console.log("[kaju] Deepgram WebSocket closed: code=" + e.code + " wasClean=" + e.wasClean);
      reconnect("close");
    };

    // Watchdog: if it doesn't OPEN within 4s (PNA/localhost hang), retry.
    setTimeout(function () {
      if (ws.readyState !== WebSocket.OPEN) {
        console.log("[kaju] Deepgram WS never opened, retrying");
        try { ws.close(); } catch (e) {}
        reconnect("open-timeout");
      }
    }, 4000);

    // No KeepAlive control message — Flux v2 rejects it ("unknown variant
    // KeepAlive"). The mixer sends continuous audio (silence in gaps) instead,
    // which keeps the socket alive.
  }

  // Chrome delivers audio from a remote WebRTC track into Web Audio only when
  // the track is also consumed by a media element. Attach a muted, playing
  // <audio> sink so createMediaStreamSource actually receives samples. Muted +
  // global --mute-audio means it produces no audible output.
  // A muted, playing <audio> sink "activates" a remote WebRTC track so Chrome
  // actually delivers its audio into Web Audio (createMediaStreamSource on a
  // remote track is otherwise silent). Muted = no speaker output = no echo,
  // but a muted element still decodes, so capture still receives samples.
  function _kajuSinkTrack(track) {
    window._kajuSinks = window._kajuSinks || {};
    if (window._kajuSinks[track.id]) return window._kajuSinks[track.id];
    var a = new Audio();
    a.srcObject = new MediaStream([track]);
    a.muted = true;
    a.autoplay = true;
    a.play().catch(function () {});
    window._kajuSinks[track.id] = a;
    return a;
  }

  // Kill echo: the bot's Chrome plays every remote participant out the local
  // speakers. Mute all page media elements (ours are already muted; Meet's are
  // the culprit). They keep decoding, so capture is unaffected.
  window._kajuMuteAllPlayback = function () {
    try {
      var els = document.querySelectorAll("audio,video");
      for (var i = 0; i < els.length; i++) {
        if (!els[i].muted) els[i].muted = true;
        els[i].volume = 0;
      }
    } catch (e) {}
  };

  // Capture Meet's own playing <audio>/<video> elements. Meet mixes the real
  // downlink audio into these elements (the raw RTCPeerConnection receiver
  // tracks it exposes stay muted/silent). createMediaElementSource pulls that
  // audible mix into Web Audio AND reroutes it off the speakers, so it both
  // fixes capture and removes the local echo. Rescanned periodically.
  function _kajuCaptureMeetElements() {
    if (!window._kajuCaptureCtx || !window._kajuCaptureMerger) return;
    var ctx = window._kajuCaptureCtx, merger = window._kajuCaptureMerger;
    window._kajuElSources = window._kajuElSources || [];
    window._kajuCapturedStreamIds = window._kajuCapturedStreamIds || {};
    var els = document.querySelectorAll("audio,video");
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var stream = el.srcObject;
      if (!stream || !stream.getAudioTracks || stream.getAudioTracks().length === 0) continue;
      // Do NOT mute: on this Chrome, createMediaStreamSource only receives
      // samples while the element is actually PLAYING (audible). Muting kills
      // the capture. Echo is avoided with headphones (or headless later).
      if (window._kajuCapturedStreamIds[stream.id]) continue;
      var idx = window._kajuChannelCount;
      if (idx >= window._kajuMaxChannels) break;
      try {
        // Tap the stream (NOT createMediaElementSource, which hijacks the
        // element and makes Meet recreate it — the source of the flakiness).
        var src = ctx.createMediaStreamSource(stream);
        src.connect(merger, 0, idx);
        window._kajuChannelCount = idx + 1;
        window._kajuElSources.push(src);
        window._kajuCapturedStreamIds[stream.id] = true;
        console.log("[kaju] tapped Meet audio stream " + stream.id + " -> channel " + idx);
      } catch (e) {
        console.log("[kaju] tap failed: " + e);
      }
    }
  }

  // Capture remote audio with MediaStreamTrackProcessor: reads raw AudioData
  // frames directly off each WebRTC track — NO audible playback required. This
  // avoids the createMediaStreamSource-needs-playback silence bug, works with
  // the bot's Chrome muted (so it never echoes), and mixes ALL participants.
  window._kajuTrackQueues = {}; // trackId -> Int16 sample array (16kHz mono)

  function _kajuProcessTrack(track) {
    if (!track || track.kind !== "audio" || track.__kajuProc) return;
    if (typeof MediaStreamTrackProcessor === "undefined") {
      console.log("[kaju] MediaStreamTrackProcessor unavailable");
      return;
    }
    track.__kajuProc = true;
    window._kajuTrackQueues[track.id] = [];
    // Activate the track: a muted, playing <audio> sink makes Chrome actually
    // flow media through an otherwise-idle remote track, so the processor gets
    // frames. Muted + the bot's --mute-audio => no audible output, no echo.
    try {
      window._kajuSinks = window._kajuSinks || {};
      if (!window._kajuSinks[track.id]) {
        var a = new Audio();
        a.srcObject = new MediaStream([track]);
        a.muted = true;
        a.autoplay = true;
        a.play().catch(function () {});
        window._kajuSinks[track.id] = a;
      }
    } catch (e) {}
    var reader;
    try {
      reader = new MediaStreamTrackProcessor({ track: track }).readable.getReader();
    } catch (e) {
      console.log("[kaju] trackprocessor failed: " + e);
      return;
    }
    console.log("[kaju] processing audio track " + track.id);
    function pump() {
      reader.read().then(function (r) {
        if (r.done) { delete window._kajuTrackQueues[track.id]; return; }
        var ad = r.value;
        try {
          var sr = ad.sampleRate || 48000;
          var opts = { planeIndex: 0, format: "f32-planar" };
          var size = ad.allocationSize(opts);
          var f32 = new Float32Array(size / 4);
          ad.copyTo(f32, opts);
          var n = f32.length;
          window._kajuFrameN = (window._kajuFrameN || 0) + 1;
          if (window._kajuFrameN <= 2) {
          }
          var q = window._kajuTrackQueues[track.id];
          if (q) {
            var ratio = 16000 / sr;
            var outN = Math.floor(n * ratio);
            for (var i = 0; i < outN; i++) {
              var s = f32[Math.floor(i / ratio)] || 0;
              if (s > 1) s = 1; else if (s < -1) s = -1;
              q.push(s < 0 ? s * 0x8000 : s * 0x7fff);
            }
            if (q.length > 32000) q.splice(0, q.length - 32000); // cap if WS down
          }
        } catch (e) {
          window._kajuCopyErr = (window._kajuCopyErr || 0) + 1;
          if (window._kajuCopyErr <= 2) console.log("[kaju] copyTo error: " + e);
        }
        ad.close();
        pump();
      }).catch(function () { delete window._kajuTrackQueues[track.id]; });
    }
    pump();
  }

  // Process every audio track we can find: the RTCPeerConnection receiver
  // tracks AND the tracks inside Meet's <audio>/<video> element srcObjects.
  // Whichever actually carries audio produces frames; the mixer sums them and
  // silent/decoy tracks contribute nothing. _kajuProcessTrack dedupes by track.
  function _kajuScanTracks() {
    (window._kajuTracks || []).forEach(_kajuProcessTrack);
    var els = document.querySelectorAll("audio,video");
    var elAudio = 0;
    for (var i = 0; i < els.length; i++) {
      var s = els[i].srcObject;
      if (!s || !s.getAudioTracks) continue;
      var at = s.getAudioTracks();
      elAudio += at.length;
      at.forEach(_kajuProcessTrack);
    }
    // Belt-and-suspenders on top of the bot Chrome's --mute-audio: keep Meet's
    // own playback elements muted so remote audio never comes back out.
    if (typeof window._kajuMuteAllPlayback === "function") window._kajuMuteAllPlayback();
  }

  window._kajuStartPCMCapture = function () {
    if (window._kajuCapturing) return;
    window._kajuCapturing = true;
    _kajuConnectDeepgram(1); // mono mix
    // Process any audio tracks intercepted before capture started.
    (window._kajuPendingTracks || []).forEach(_kajuProcessTrack);
    window._kajuPendingTracks = [];
    _kajuScanTracks();
    window._kajuElScanTimer = setInterval(_kajuScanTracks, 1000);
    // Mixer: every 40ms, sum 640 samples (40ms @ 16kHz) from each track and
    // ALWAYS send (silence fills gaps) so Deepgram stays open without a
    // KeepAlive control message (Flux v2 rejects those).
    window._kajuMixTimer = setInterval(function () {
      var ws = window._kajuDeepgramWS;
      if (!ws || ws.readyState !== 1) return;
      var N = 640, out = new Int16Array(N);
      for (var id in window._kajuTrackQueues) {
        var q = window._kajuTrackQueues[id];
        if (!q || q.length < N) continue;
        for (var i = 0; i < N; i++) {
          var v = out[i] + q[i];
          out[i] = v > 32767 ? 32767 : (v < -32768 ? -32768 : v);
        }
        q.splice(0, N);
      }
      var mx = 0;
      for (var k = 0; k < N; k++) { var a = out[k] < 0 ? -out[k] : out[k]; if (a > mx) mx = a; }
      if (mx > (window._kajuPeak || 0)) window._kajuPeak = mx;
      window._kajuMixN = (window._kajuMixN || 0) + 1;
      if (window._kajuMixN % 50 === 0) {
        window._kajuPeak = 0;
      }
      ws.send(out.buffer);
    }, 40);
    console.log("[kaju] PCM capture via MediaStreamTrackProcessor (all tracks)");
  };

  // Drain transcript events (called by Go). Works for both Deepgram and Meet captions.
  window._kajuDrainTranscripts = function () {
    var events = window._kajuDeepgramEvents;
    window._kajuDeepgramEvents = [];
    return events;
  };

  // Drain latest screen share frame (returns base64 JPEG or null).
  window._kajuLatestScreenFrame = null;
  window._kajuScreenShareActive = false;
  window._kajuScreenCaptureInterval = null;
  window._kajuDrainScreenFrame = function () {
    var frame = window._kajuLatestScreenFrame;
    window._kajuLatestScreenFrame = null;
    return frame;
  };

  window._kajuStopPCMCapture = function () {
    if (window._kajuCaptureProcessor) {
      window._kajuCaptureProcessor.disconnect();
      window._kajuCaptureProcessor = null;
    }
    window._kajuCaptureMerger = null;
    if (window._kajuCaptureCtx) {
      window._kajuCaptureCtx.close();
      window._kajuCaptureCtx = null;
    }
    if (window._kajuDeepgramWS) {
      window._kajuDeepgramWS.close();
      window._kajuDeepgramWS = null;
    }
  };

  // --- TTS audio playback queue with barge-in support ---

  function _kajuEnsureTTSContext() {
    if (window._kajuAudioCtx) return;
    window._kajuAudioCtx = new AudioContext({ sampleRate: 24000 });
    window._kajuTTSDest = window._kajuAudioCtx.createMediaStreamDestination();
    // Silent oscillator keeps the dest stream alive between TTS chunks.
    var silence = window._kajuAudioCtx.createOscillator();
    var silenceGain = window._kajuAudioCtx.createGain();
    silenceGain.gain.value = 0;
    silence.connect(silenceGain);
    silenceGain.connect(window._kajuTTSDest);
    silence.start();
    console.log("[kaju] TTS AudioContext created");
  }

  function _kajuReplaceOutgoingTrack() {
    _kajuEnsureTTSContext();
    var ttsTrack = window._kajuTTSDest.stream.getAudioTracks()[0];
    if (!ttsTrack) return;
    window._kajuPeerConnections.forEach(function (pc) {
      try {
        pc.getSenders().forEach(function (sender) {
          if (sender.track && sender.track.kind === "audio") {
            sender.replaceTrack(ttsTrack);
          }
        });
      } catch (e) {}
    });
  }

  // Queue raw PCM audio (Int16LE, 24kHz, mono from ElevenLabs) for gapless playback.
  // Uses precise scheduling (source.start(time)) to eliminate gaps between chunks.
  window._kajuNextPlayTime = 0; // AudioContext time for next chunk
  window._kajuScheduledSources = []; // track scheduled sources for barge-in

  window._kajuQueuePCM = function (base64PCM) {
    _kajuEnsureTTSContext();
    _kajuReplaceOutgoingTrack();

    try {
      // Decode base64 to raw bytes.
      var binary = atob(base64PCM);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      // Convert Int16LE PCM to Float32 for Web Audio.
      var int16 = new Int16Array(bytes.buffer);
      var float32 = new Float32Array(int16.length);
      for (var i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768.0;
      }

      var ctx = window._kajuAudioCtx;
      var audioBuffer = ctx.createBuffer(1, float32.length, 24000);
      audioBuffer.copyToChannel(float32, 0);

      var source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(window._kajuTTSDest);

      // Schedule gaplessly: start right after the previous chunk ends.
      var now = ctx.currentTime;
      var startTime = Math.max(now, window._kajuNextPlayTime);
      window._kajuNextPlayTime = startTime + audioBuffer.duration;

      window._kajuPlayingNow = true;
      window._kajuScheduledSources.push(source);

      source.onended = function () {
        var idx = window._kajuScheduledSources.indexOf(source);
        if (idx !== -1) window._kajuScheduledSources.splice(idx, 1);
        if (window._kajuScheduledSources.length === 0) {
          window._kajuPlayingNow = false;
        }
      };
      source.start(startTime);
    } catch (e) {
      console.error("[kaju] PCM play error:", e);
    }
  };

  // Stop all playback immediately (barge-in).
  window._kajuStopPlayback = function () {
    window._kajuPlayingNow = false;
    window._kajuNextPlayTime = 0;
    var sources = window._kajuScheduledSources.slice();
    window._kajuScheduledSources = [];
    for (var i = 0; i < sources.length; i++) {
      try {
        sources[i].stop();
      } catch (e) {}
    }
    console.log("[kaju] playback stopped (barge-in)");
  };

  // --- OpenAI Realtime IN-BROWSER bridge (no Docker, no PulseAudio) ------------
  // Runs the whole realtime voice session inside the page, mirroring the
  // Deepgram-in-browser design: capture the meeting audio off the WebRTC tracks,
  // stream it to OpenAI's Realtime API over a WebSocket (API key in the
  // subprotocol — the same trick the Deepgram path uses), and play the model's
  // voice back into the outgoing mic track via _kajuQueuePCM. Go just starts it
  // and drains events. This is what makes realtime Meet work with only an OpenAI
  // key and no container.
  window._kajuRealtimeEvents = [];
  window._kajuRealtimeWS = null;

  window._kajuStartRealtime = function (cfg) {
    if (window._kajuRealtimeWS) return;
    var url = "wss://api.openai.com/v1/realtime?model=" + encodeURIComponent(cfg.model);
    var ws = new WebSocket(url, ["realtime", "openai-insecure-api-key." + cfg.key]);
    window._kajuRealtimeWS = ws;
    ws.onopen = function () {
      ws.send(JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          instructions: cfg.instructions || "",
          output_modalities: ["audio"],
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              // Semantic VAD so it waits for a real end-of-utterance; auto-respond
              // is on, and the wait_for_user tool lets the model stay silent when
              // it wasn't addressed (multi-party etiquette without a Go round-trip).
              turn_detection: { type: "semantic_vad", eagerness: "low", create_response: true, interrupt_response: true },
              transcription: { model: cfg.transcribe || "gpt-4o-mini-transcribe" },
            },
            output: { format: { type: "audio/pcm", rate: 24000 }, voice: cfg.voice || "cedar" },
          },
          tools: [{
            type: "function",
            name: "wait_for_user",
            description: "Call this to STAY SILENT and keep listening whenever the latest audio was NOT addressed to you — someone else is being spoken to, side conversation, or general chatter. Strongly prefer this when unsure you were directly addressed.",
            parameters: { type: "object", properties: {} },
          }].concat(cfg.tools || []),
          tool_choice: "auto",
        },
      }));
      _kajuStartRealtimeCapture();
      window._kajuState = "listening";
      window._kajuRealtimeEvents.push({ type: "open" });
    };
    ws.onmessage = function (e) {
      var m; try { m = JSON.parse(e.data); } catch (_) { return; }
      var t = m.type || "";
      if (t.indexOf("output_audio.delta") >= 0 && m.delta) {
        window._kajuQueuePCM(m.delta);
        window._kajuState = "speaking";
      } else if (t === "input_audio_buffer.speech_started") {
        if (window._kajuStopPlayback) window._kajuStopPlayback();
        window._kajuState = "listening";
      } else if (t.indexOf("input_audio_transcription.completed") >= 0 && m.transcript) {
        window._kajuRealtimeEvents.push({ type: "heard", text: m.transcript });
      } else if (t === "response.output_audio_transcript.done" && m.transcript) {
        window._kajuRealtimeEvents.push({ type: "said", text: m.transcript });
      } else if (t.indexOf("function_call_arguments.done") >= 0) {
        // A tool call (web_search/read_document/write_file/run_shell/…). Hand
        // it to Go, which runs it and calls _kajuRealtimeToolResult.
        if (m.name === "wait_for_user") return;
        window._kajuRealtimeEvents.push({ type: "tool", callId: m.call_id, name: m.name, args: m.arguments || "{}" });
      } else if (t === "response.done") {
        window._kajuState = "listening";
      } else if (t === "error") {
        window._kajuRealtimeEvents.push({ type: "error", text: (m.error && m.error.message) || "error" });
      }
    };
    ws.onclose = function (ev) {
      window._kajuRealtimeEvents.push({ type: "closed", code: ev.code, reason: ev.reason || "" });
      window._kajuRealtimeWS = null;
      // Stop the capture mixer + track scan so they don't run forever after an
      // unexpected close (they only checked ws.readyState and would spin idle).
      clearInterval(window._kajuRTMixTimer);
      clearInterval(window._kajuElScanTimer);
      window._kajuCapturing = false;
    };
    ws.onerror = function () { window._kajuRealtimeEvents.push({ type: "error", text: "ws error" }); };
  };

  function _kajuStartRealtimeCapture() {
    if (window._kajuCapturing) return;
    window._kajuCapturing = true;
    (window._kajuPendingTracks || []).forEach(_kajuProcessTrack);
    window._kajuPendingTracks = [];
    _kajuScanTracks();
    window._kajuElScanTimer = setInterval(_kajuScanTracks, 1000);
    // Mixer: every 40ms, sum 640 samples (40ms @ the tracks' 16kHz) across all
    // participants, then upsample 640→960 (16k→24k) because OpenAI Realtime
    // requires a 24kHz input. Silence fills gaps.
    window._kajuRTMixTimer = setInterval(function () {
      var ws = window._kajuRealtimeWS;
      if (!ws || ws.readyState !== 1) return;
      var IN = 640, OUT = 960;
      var mono = new Float64Array(IN);
      for (var id in window._kajuTrackQueues) {
        var q = window._kajuTrackQueues[id];
        for (var i = 0; i < IN; i++) mono[i] += q.length ? q.shift() : 0;
      }
      var out = new Int16Array(OUT);
      for (var i = 0; i < OUT; i++) {
        var sp = i * (IN - 1) / (OUT - 1);
        var lo = Math.floor(sp), hi = lo + 1 < IN ? lo + 1 : IN - 1, f = sp - lo;
        var v = mono[lo] * (1 - f) + mono[hi] * f;
        out[i] = v > 32767 ? 32767 : (v < -32768 ? -32768 : v);
      }
      var bytes = new Uint8Array(out.buffer), bin = "";
      for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: btoa(bin) }));
    }, 40);
  }

  window._kajuDrainRealtimeEvents = function () {
    var e = window._kajuRealtimeEvents;
    window._kajuRealtimeEvents = [];
    return e;
  };
  // Go calls this with a tool result; feed it back to the model so it speaks the answer.
  window._kajuRealtimeToolResult = function (callId, output) {
    var ws = window._kajuRealtimeWS;
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: String(output) } }));
    ws.send(JSON.stringify({ type: "response.create" }));
  };
  window._kajuStopRealtime = function () {
    try { if (window._kajuRealtimeWS) window._kajuRealtimeWS.close(); } catch (_) {}
    window._kajuRealtimeWS = null;
    clearInterval(window._kajuRTMixTimer);
    clearInterval(window._kajuElScanTimer);
    window._kajuCapturing = false;
  };

  // --- Entity renderer (inlined for single-file embed) ---
  function createEntity(canvas, opts) {
    opts = opts || {};
    var getAmplitude = opts.getAmplitude || function () { return 0; };
    var c = canvas.getContext("2d");
    var W = canvas.width, H = canvas.height;
    var cx = W / 2, cy = H / 2;
    var _time = 0, smoothAmp = 0, glitchTimer = 0, glitchIntensity = 0, animId = null;

    function getCoreShape(t, amp, numPoints, baseR) {
      var pts = [];
      for (var i = 0; i < numPoints; i++) {
        var a = (i / numPoints) * Math.PI * 2;
        var r = baseR;
        r += Math.sin(a * 3 + t * 0.7) * (15 + amp * 25);
        r += Math.sin(a * 5 - t * 1.3) * (8 + amp * 15);
        r += Math.cos(a * 7 + t * 0.5) * (5 + amp * 10);
        var sharpness = Math.sin(a * 2 + t * 0.4);
        if (sharpness > 0.7) r += (sharpness - 0.7) * 40 * (1 + amp);
        pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
      }
      return pts;
    }
    function drawScanLines(t) {
      c.save();
      c.globalAlpha = 0.03 + glitchIntensity * 0.06;
      for (var y = 0; y < H; y += 3) {
        c.fillStyle = y % 6 === 0 ? "rgba(0,0,0,0.5)" : "rgba(20,40,50,0.15)";
        c.fillRect(0, y, W, 1);
      }
      var scanY = ((t * 40) % (H + 60)) - 30;
      var scanGrad = c.createLinearGradient(0, scanY - 15, 0, scanY + 15);
      scanGrad.addColorStop(0, "rgba(0,255,200,0)");
      scanGrad.addColorStop(0.5, "rgba(0,255,200," + (0.06 + glitchIntensity * 0.1) + ")");
      scanGrad.addColorStop(1, "rgba(0,255,200,0)");
      c.fillStyle = scanGrad;
      c.fillRect(0, scanY - 15, W, 30);
      c.restore();
    }
    function drawGlitch(t) {
      if (glitchIntensity < 0.01) return;
      c.save();
      var slices = Math.floor(3 + glitchIntensity * 8);
      for (var i = 0; i < slices; i++) {
        var y = Math.random() * H;
        var h = 1 + Math.random() * (4 + glitchIntensity * 15);
        var shift = (Math.random() - 0.5) * glitchIntensity * 40;
        try { var imgData = c.getImageData(0, Math.floor(y), W, Math.floor(h)); c.putImageData(imgData, shift, Math.floor(y)); } catch (e) {}
      }
      if (glitchIntensity > 0.3) { c.globalCompositeOperation = "screen"; c.globalAlpha = glitchIntensity * 0.15; c.drawImage(canvas, 2, 0); c.globalCompositeOperation = "source-over"; }
      c.restore();
    }
    function drawCore(t, amp) {
      var outerPts = getCoreShape(t, amp, 64, 70 + amp * 20);
      var innerPts = getCoreShape(t * 1.3, amp, 48, 40 + amp * 12);
      var coreGlow = c.createRadialGradient(cx, cy, 0, cx, cy, 100 + amp * 40);
      var speaking = amp > 0.2;
      if (speaking) { coreGlow.addColorStop(0, "rgba(255,60,30," + (0.2 + amp * 0.3) + ")"); coreGlow.addColorStop(0.3, "rgba(200,0,60," + (0.1 + amp * 0.15) + ")"); coreGlow.addColorStop(0.6, "rgba(0,150,180," + (0.05 + amp * 0.05) + ")"); coreGlow.addColorStop(1, "rgba(0,40,60,0)"); }
      else { coreGlow.addColorStop(0, "rgba(0,180,160,0.15)"); coreGlow.addColorStop(0.4, "rgba(0,80,120,0.06)"); coreGlow.addColorStop(1, "rgba(0,20,40,0)"); }
      c.fillStyle = coreGlow; c.fillRect(0, 0, W, H);
      c.beginPath(); for (var i = 0; i < outerPts.length; i++) { if (i === 0) c.moveTo(outerPts[i].x, outerPts[i].y); else c.lineTo(outerPts[i].x, outerPts[i].y); } c.closePath();
      var shellColor = speaking ? "rgba(255,40,20," : "rgba(0,200,180,";
      c.strokeStyle = shellColor + (0.3 + amp * 0.5) + ")"; c.lineWidth = 1.5 + amp * 1.5; c.shadowColor = shellColor + "0.6)"; c.shadowBlur = 10 + amp * 25; c.stroke(); c.shadowBlur = 0;
      c.fillStyle = "rgba(0,10,15,0.6)"; c.fill();
      c.beginPath(); for (var i = 0; i < innerPts.length; i++) { if (i === 0) c.moveTo(innerPts[i].x, innerPts[i].y); else c.lineTo(innerPts[i].x, innerPts[i].y); } c.closePath();
      c.strokeStyle = shellColor + (0.15 + amp * 0.3) + ")"; c.lineWidth = 0.8; c.stroke();
      c.save(); c.globalAlpha = 0.1 + amp * 0.2;
      for (var i = 0; i < outerPts.length; i += 4) { var inner_i = Math.floor((i / outerPts.length) * innerPts.length); c.strokeStyle = shellColor + "0.3)"; c.lineWidth = 0.5; c.beginPath(); c.moveTo(outerPts[i].x, outerPts[i].y); c.lineTo(innerPts[inner_i].x, innerPts[inner_i].y); c.stroke(); }
      c.restore();
      var pulseR = 8 + Math.sin(t * 3) * 3 + amp * 15;
      var pulseGrad = c.createRadialGradient(cx, cy, 0, cx, cy, pulseR);
      if (speaking) { pulseGrad.addColorStop(0, "rgba(255,80,40," + (0.9 + amp * 0.1) + ")"); pulseGrad.addColorStop(0.5, "rgba(200,20,40," + (0.4 + amp * 0.2) + ")"); pulseGrad.addColorStop(1, "rgba(100,0,30,0)"); }
      else { pulseGrad.addColorStop(0, "rgba(0,255,220,0.7)"); pulseGrad.addColorStop(0.5, "rgba(0,120,140,0.3)"); pulseGrad.addColorStop(1, "rgba(0,40,60,0)"); }
      c.fillStyle = pulseGrad; c.beginPath(); c.arc(cx, cy, pulseR, 0, Math.PI * 2); c.fill();
    }
    function drawWaveform(t, amp) {
      if (amp < 0.05) return;
      c.save(); c.globalAlpha = amp;
      var waveR = 95 + amp * 25; c.beginPath();
      for (var i = 0; i <= 200; i++) { var a = (i / 200) * Math.PI * 2; var wave = Math.sin(a * 20 + t * 8) * amp * 12 + Math.sin(a * 35 - t * 12) * amp * 6; var r = waveR + wave; var x = cx + Math.cos(a) * r; var y = cy + Math.sin(a) * r; if (i === 0) c.moveTo(x, y); else c.lineTo(x, y); }
      c.closePath(); c.strokeStyle = "rgba(255,60,30," + (amp * 0.6) + ")"; c.lineWidth = 1; c.stroke(); c.restore();
    }
    function draw(t, amp) {
      c.fillStyle = "#000000"; c.fillRect(0, 0, W, H);
      var vig = c.createRadialGradient(cx, cy, 50, cx, cy, 350); vig.addColorStop(0, "rgba(0,0,0,0)"); vig.addColorStop(1, "rgba(0,0,0,0.5)"); c.fillStyle = vig; c.fillRect(0, 0, W, H);
      drawCore(t, amp); drawWaveform(t, amp); drawScanLines(t); drawGlitch(t);
    }
    function animate() {
      _time += 0.03;
      var targetAmp = getAmplitude(); smoothAmp += (targetAmp - smoothAmp) * 0.08;
      glitchTimer -= 0.03; if (glitchTimer <= 0) { glitchTimer = 2 + Math.random() * 6; glitchIntensity = 0.2 + Math.random() * 0.6; }
      glitchIntensity *= 0.92; if (smoothAmp > 0.3) glitchIntensity = Math.max(glitchIntensity, smoothAmp * 0.3);
      draw(_time, smoothAmp); animId = requestAnimationFrame(animate);
    }
    return { start: function () { if (!animId) animate(); }, stop: function () { if (animId) { cancelAnimationFrame(animId); animId = null; } } };
  }

  // --- Dithering shader entity ---
  // WebGL fragment shader: domain-warped fbm field, ordered (Bayer) dithering,
  // Apple-blue → purple duotone that warms + speeds up with audio amplitude.
  // Rendered to a canvas captured as the outgoing video track.
  function createShaderEntity(canvas, opts) {
    var gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (!gl) {
      console.log("[kaju] WebGL unavailable, falling back to 2D entity");
      return createEntity(canvas, opts);
    }
    var vsSrc = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";
    // paper.design-style dithering: a smooth, slowly flowing domain-warped field
    // sampled on a COARSE pixel grid and quantized with an 8x8 Bayer matrix, so
    // the tones break into the characteristic chunky ordered-dither dots.
    var fsSrc = [
      "precision highp float;",
      "uniform vec2 u_res;uniform float u_time;uniform float u_amp;uniform vec3 u_col;",
      "float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}",
      "float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);",
      " float a=hash(i),b=hash(i+vec2(1,0)),c=hash(i+vec2(0,1)),d=hash(i+vec2(1,1));",
      " return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);}",
      "float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<4;i++){v+=a*noise(p);p*=2.0;a*=.5;}return v;}",
      // 8x8 ordered Bayer via three nested 2x2 layers -> 64 threshold levels.
      "float bayer2(vec2 a){a=floor(mod(a,2.0));return mix(mix(0.0,0.5,a.x),mix(0.75,0.25,a.x),a.y);}",
      "float bayer4(vec2 a){return bayer2(floor(mod(a,4.0)*0.5))*0.25+bayer2(a);}",
      "float bayer8(vec2 a){return bayer4(floor(mod(a,8.0)*0.5))*0.25+bayer2(a);}",
      "void main(){",
      // Fine pixel grid — subtle dither texture, not chunky pixelation.
      " float PX=max(u_res.x/340.0,1.0);",
      " vec2 cell=floor(gl_FragCoord.xy/PX);",
      " vec2 uv=(cell*PX+0.5*PX)/u_res;",
      " float amp=clamp(u_amp,0.,1.);",
      // Slow, gentle flow — calm and elegant, barely creeping when idle.
      " float t=u_time*(0.018+amp*0.05);",
      " vec2 q=uv*2.2;",
      // Smooth, large-scale domain warp — soft flowing blobs, not grain.
      " vec2 warp=vec2(fbm(q+vec2(t,0.)),fbm(q+vec2(0.,t)+5.2));",
      " float f=fbm(q+warp*(0.7+amp*0.3)+vec2(t*0.22,-t*0.18));",
      // Radial falloff so the shape reads as a soft orb centered in the disc.
      " vec2 pc=(gl_FragCoord.xy-0.5*u_res)/min(u_res.x,u_res.y);",
      " float r=length(pc);",
      " float b=smoothstep(0.05,0.95,f)*smoothstep(0.20,0.02,r)+amp*0.15;",
      // Ordered dithering — many levels so tones read as a smooth gradient with
      // just a hint of dither grain, not harsh 3-tone banding.
      " float d=bayer8(cell);",
      " float levels=8.0;",
      " float qz=floor(b*levels+d)/levels;",
      " vec3 lo=vec3(0.01,0.02,0.06);",
      // Base color comes from the live voice state (idle/listening/thinking/
      // speaking), brightening a touch with amplitude.
      " vec3 hi=u_col*(0.8+amp*0.4);",
      " vec3 col=mix(lo,hi,qz);",
      // Small circular container: shader inside the disc, pure black outside, soft
      // edge + a gentle rim glow that lifts with amplitude.
      " float disc=smoothstep(0.20,0.17,r);",
      " float rim=smoothstep(0.15,0.20,r)*smoothstep(0.24,0.20,r);",
      " col=col*disc+hi*rim*(0.25+amp*0.6);",
      " gl_FragColor=vec4(col,1.0);",
      "}",
    ].join("\n");
    function sh(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.log("[kaju] shader compile: " + gl.getShaderInfoLog(s));
      }
      return s;
    }
    var prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    var uRes = gl.getUniformLocation(prog, "u_res");
    var uTime = gl.getUniformLocation(prog, "u_time");
    var uAmp = gl.getUniformLocation(prog, "u_amp");
    var uCol = gl.getUniformLocation(prog, "u_col");
    var start = performance.now();
    var lastDraw = 0;
    var FRAME_MS = 45; // ~22fps — software WebGL (SwiftShader) is CPU-heavy; an
    // ambient avatar doesn't need 60fps, and this ~3x cut lets two bots share a host.
    var smoothAmp = 0;
    // Per-state color + animation intensity, set by the Go side via
    // window._kajuState (idle | listening | thinking | speaking).
    var STATES = {
      idle:      { col: [0.13, 0.28, 0.62], amp: 0.06 },
      listening: { col: [0.10, 0.78, 1.00], amp: 0.20 },
      thinking:  { col: [1.00, 0.62, 0.14], amp: 0.16 },
      speaking:  { col: [0.22, 0.90, 0.52], amp: 0.32 },
    };
    var smoothCol = [0.13, 0.28, 0.62];
    var animId = null;
    function frame() {
      animId = requestAnimationFrame(frame);
      // Throttle the actual GL work to FRAME_MS — the rAF keeps ticking but we skip
      // most draws, cutting CPU ~3x on software WebGL.
      var ts = performance.now();
      if (ts - lastDraw < FRAME_MS) return;
      lastDraw = ts;
      var st = STATES[window._kajuState] || STATES.idle;
      // Amplitude: prefer a real audio signal if present, else a gentle
      // state-driven pulse so the orb breathes by what it's doing.
      var audio = opts.getAmplitude ? opts.getAmplitude() : 0;
      var tnow = (performance.now() - start) / 1000;
      // Slow, shallow breathing (~0.25Hz) — a calm presence, not a strobe.
      var pulse = st.amp * (0.88 + 0.12 * Math.sin(tnow * 1.5));
      var target = Math.max(audio, pulse);
      // Ease slowly toward the target so motion is smooth and unhurried.
      smoothAmp += (target - smoothAmp) * 0.05;
      for (var i = 0; i < 3; i++) smoothCol[i] += (st.col[i] - smoothCol[i]) * 0.04;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, tnow);
      gl.uniform1f(uAmp, smoothAmp);
      gl.uniform3f(uCol, smoothCol[0], smoothCol[1], smoothCol[2]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    return {
      start: function () { if (!animId) frame(); },
      stop: function () { if (animId) { cancelAnimationFrame(animId); animId = null; } },
    };
  }

  // --- J-space word cloud ---
  // Instead of a GPU shader, render the agent's live "mind" as a soft, drifting
  // cloud of the concepts it's attending to (what it just heard / said / knows) —
  // inspired by Anthropic's J-space readouts. Pure 2D canvas: cheap on CPU (two
  // bots can share a host) and reads as an elegant word-illustration, not pixels.
  // The word list is window._kajuWords (most-salient first), pushed from Go.
  function createWordCloud(canvas, opts) {
    var ctx = canvas.getContext("2d");
    var W = canvas.width, H = canvas.height;
    var STATES = {
      idle:      [0.62, 0.70, 0.95],
      listening: [0.45, 0.85, 1.00],
      thinking:  [1.00, 0.78, 0.45],
      speaking:  [0.55, 0.95, 0.70],
    };
    var smoothCol = [0.62, 0.70, 0.95];
    var FS = 20;             // fixed size — legible at 720p
    var LH = FS + 4;         // line height
    ctx.font = FS + "px monospace";
    var CW = ctx.measureText("M").width || FS * 0.6; // monospace char width
    var animId = null, lastDraw = 0, FRAME_MS = 55; // ~18fps, calm
    var t0 = performance.now();

    // A gently morphing metaball outline: an ellipse whose radius drifts with a few
    // slow, small sines → the word-mass breathes like a soft blob (not too liquidy).
    function halfAt(yf, t) {
      var base = Math.sqrt(Math.max(0, 1 - yf * yf));
      var wob = 1
        + 0.07 * Math.sin(yf * 2.6 + t * 0.28)
        + 0.045 * Math.sin(yf * 4.5 - t * 0.20);
      return base * wob;
    }

    function frame() {
      animId = requestAnimationFrame(frame);
      var ts = performance.now();
      if (ts - lastDraw < FRAME_MS) return;
      lastDraw = ts;

      var words = window._kajuWords || [];
      if (!words.length) words = ["listening"];
      // Repeat each concept ~5x so the cloud is dense with multiples of the same
      // word (the J-space look), not a stream of one-of-each.
      var pool = [];
      for (var pw = 0; pw < words.length; pw++) {
        var cw = ("" + words[pw]).toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (!cw) continue;
        for (var rep = 0; rep < 5; rep++) pool.push(cw);
      }
      if (!pool.length) pool = ["LISTENING"];

      var sc = STATES[window._kajuState] || STATES.idle;
      for (var k = 0; k < 3; k++) smoothCol[k] += (sc[k] - smoothCol[k]) * 0.05;
      var amp = opts.getAmplitude ? opts.getAmplitude() : 0;
      var tnow = (ts - t0) / 1000;

      // Near-black field + soft state-tinted central glow.
      ctx.fillStyle = "rgb(6,7,10)";
      ctx.fillRect(0, 0, W, H);
      var cr0 = smoothCol[0] * 255 | 0, cg0 = smoothCol[1] * 255 | 0, cb0 = smoothCol[2] * 255 | 0;
      var g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.min(W, H) * 0.6);
      g.addColorStop(0, "rgba(" + cr0 + "," + cg0 + "," + cb0 + "," + (0.08 + amp * 0.10).toFixed(3) + ")");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);

      ctx.font = FS + "px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      // Strong state tint so the action reads at a glance: idle blue, listening
      // cyan, thinking amber, speaking green.
      var cr = (0.45 + smoothCol[0] * 0.55) * 255 | 0;
      var cg = (0.45 + smoothCol[1] * 0.55) * 255 | 0;
      var cb = (0.45 + smoothCol[2] * 0.55) * 255 | 0;
      var alpha = Math.min(1, 0.9 * (0.85 + amp * 0.4)); // uniform, no scanline flicker
      ctx.fillStyle = "rgba(" + cr + "," + cg + "," + cb + "," + alpha.toFixed(3) + ")";

      // Blob occupies ~40% of the video width, centered, with headroom around it.
      var nRows = Math.floor((H * 0.46) / LH);
      var maxHalf = (W * 0.20) / CW;
      var size = 1 + 0.012 * Math.sin(tnow * 0.35) + amp * 0.03; // slow, subtle breathing
      var y0 = H / 2 - (nRows - 1) / 2 * LH;
      for (var r = 0; r < nRows; r++) {
        var yf = (r - (nRows - 1) / 2) / ((nRows - 1) / 2); // -1..1
        var half = Math.floor(maxHalf * size * halfAt(yf, tnow));
        if (half < 2) continue;
        var target = half * 2;
        // Per-row deterministic word sequence → content stays put as the row grows
        // and shrinks, so only the blob's EDGES breathe (no jittery reflow).
        var off = (r * 3) % pool.length;
        var line = "", i = 0;
        while (line.length < target && i < 80) {
          var w = pool[(off + i) % pool.length];
          i++;
          if (w) line += (line ? " " : "") + w;
        }
        if (line.length > target) line = line.slice(0, target);
        // Very slight horizontal sway so the mass drifts gently, not sloshes.
        var cx = W / 2 + (Math.sin(yf * 1.8 + tnow * 0.22) * 0.012 + Math.sin(tnow * 0.15) * 0.008) * W;
        ctx.fillText(line, cx, y0 + r * LH);
      }
    }
    return {
      start: function () { if (!animId) frame(); },
      stop: function () { if (animId) { cancelAnimationFrame(animId); animId = null; } },
    };
  }

  // --- Entity video avatar ---
  // Start the canvas immediately so the video track is ready BEFORE Meet calls
  // getUserMedia (the hook above injects it).
  window._kajuBlobCanvas = document.createElement("canvas");
  window._kajuBlobCanvas.width = 1280;
  window._kajuBlobCanvas.height = 720;
  window._kajuInputLevel = 0;
  window._kajuWords = window._kajuWords || ["listening"];
  window._kajuEntity = createWordCloud(window._kajuBlobCanvas, {
    getAmplitude: function () {
      // React to BOTH the bot speaking (TTS output) and people talking (input).
      var out = 0;
      if (window._kajuPlayingNow && window._kajuScheduledSources.length > 0) {
        var t = performance.now() / 1000;
        out = 0.5 + Math.sin(t * 8) * 0.3 + Math.sin(t * 13) * 0.15;
      }
      var inp = (window._kajuInputLevel || 0) * 3.5;
      return Math.min(1, Math.max(0, Math.max(out, inp)));
    },
  });
  window._kajuEntity.start();
  var _kajuEntityStream = window._kajuBlobCanvas.captureStream(30);
  window._kajuEntityVideoTrack = _kajuEntityStream.getVideoTracks()[0];
  console.log("[kaju] entity canvas started, video track ready for getUserMedia injection");

  // Replace video track on peer connections. Retries until a video sender is found.
  window._kajuStartBlobVideo = function () {
    if (!window._kajuEntityVideoTrack) return;
    if (window._kajuBlobVideoInterval) return; // already running
    var attempts = 0;
    window._kajuBlobVideoInterval = setInterval(function () {
      attempts++;
      var replaced = false;
      window._kajuPeerConnections.forEach(function (pc) {
        try {
          pc.getSenders().forEach(function (sender) {
            if (sender.track && sender.track.kind === "video" && !replaced) {
              sender.replaceTrack(window._kajuEntityVideoTrack);
              replaced = true;
              console.log("[kaju] replaced video track with entity canvas (attempt " + attempts + ")");
            }
          });
        } catch (e) {}
      });
      if (replaced) {
        clearInterval(window._kajuBlobVideoInterval);
        window._kajuBlobVideoInterval = null;
        // Keep checking — if Meet renegotiates, re-replace.
        window._kajuBlobVideoWatchInterval = setInterval(function () {
          window._kajuPeerConnections.forEach(function (pc) {
            try {
              pc.getSenders().forEach(function (sender) {
                if (sender.track && sender.track.kind === "video" &&
                    sender.track !== window._kajuEntityVideoTrack) {
                  sender.replaceTrack(window._kajuEntityVideoTrack);
                  console.log("[kaju] re-replaced video track with entity canvas");
                }
              });
            } catch (e) {}
          });
        }, 5000);
      }
    }, 1000); // retry every 1s indefinitely until replaced
  };

  window._kajuStopBlobVideo = function () {
    if (window._kajuBlobVideoInterval) {
      clearInterval(window._kajuBlobVideoInterval);
      window._kajuBlobVideoInterval = null;
    }
    if (window._kajuBlobVideoWatchInterval) {
      clearInterval(window._kajuBlobVideoWatchInterval);
      window._kajuBlobVideoWatchInterval = null;
    }
    if (window._kajuEntity) {
      window._kajuEntity.stop();
      window._kajuEntity = null;
    }
    window._kajuBlobCanvas = null;
    window._kajuEntityVideoTrack = null;
    console.log("[kaju] entity video stopped");
  };

  // --- Meet text chat ---
  window._kajuLastChatIndex = 0;
  window._kajuSentTexts = []; // tracks messages we sent, to skip in drain

  // Meet only renders chat messages in the DOM while the chat panel is OPEN, so a
  // headless bot must keep it open to receive messages. Idempotent: only clicks
  // the button when the message input isn't present (panel closed), so it won't
  // toggle an already-open panel shut.
  window._kajuEnsureChatOpen = function () {
    var input = document.querySelector(
      'textarea[aria-label^="Send a message" i], textarea[aria-label*="message" i]',
    );
    if (input) return true;
    var btn = document.querySelector('[aria-label="Chat with everyone"]') ||
      document.querySelector('[aria-label^="Chat" i]') ||
      document.querySelector('[data-tooltip="Chat with everyone"]');
    if (btn) btn.click();
    return false;
  };

  window._kajuDrainChatMessages = function () {
    var msgs = [];
    // Meet uses [data-message-id][jscontroller="RrV5Ic"] for message containers.
    // Message text is in [jsname="dTKtvb"].
    var chatEls = document.querySelectorAll(
      '[data-message-id][jscontroller="RrV5Ic"]',
    );
    console.log(
      "[kaju] chat drain: " + chatEls.length + " messages, index=" +
        window._kajuLastChatIndex,
    );
    for (var i = window._kajuLastChatIndex; i < chatEls.length; i++) {
      var el = chatEls[i];
      var textEl = el.querySelector('[jsname="dTKtvb"]');
      var text = textEl ? textEl.innerText.trim() : "";
      if (!text) {
        // Fallback: first line of innerText (rest is action buttons)
        text = el.innerText.split("\n")[0].trim();
      }
      // Sender name: look in the group container for a name label.
      var sender = "";
      var group = el.closest('[jsname="Ypafjf"]');
      if (group) {
        var nameEl = group.querySelector('[jsname="aUCive"]') ||
          group.querySelector('[jsname="BiasMe"]') ||
          group.querySelector('[jsname="K4b4c"]');
        if (nameEl) sender = nameEl.innerText.trim();
        if (!sender) {
          // Try parent group sibling with name
          var pg = group.parentElement;
          if (pg) {
            var prev = pg.previousElementSibling;
            if (prev) {
              var np = prev.querySelector('[class*="name"]') ||
                prev.querySelector("[jsname]");
              if (np) sender = np.innerText.trim().split("\n")[0];
            }
          }
        }
      }
      if (text) {
        // Skip messages we sent ourselves.
        var sentIdx = window._kajuSentTexts.indexOf(text);
        if (sentIdx !== -1) {
          window._kajuSentTexts.splice(sentIdx, 1);
        } else {
          msgs.push({ sender: sender, text: text });
        }
      }
    }
    window._kajuLastChatIndex =
      document.querySelectorAll('[data-message-id][jscontroller="RrV5Ic"]')
        .length;
    return msgs;
  };

  window._kajuSendChat = function (text) {
    // Track this so _kajuDrainChatMessages skips it.
    window._kajuSentTexts.push(text);
    var chatBtn = document.querySelector('[aria-label="Chat with everyone"]') ||
      document.querySelector('[data-tooltip="Chat with everyone"]') ||
      document.querySelector('[aria-label="Chat"]');
    if (chatBtn) chatBtn.click();

    return new Promise(function (resolve) {
      setTimeout(function () {
        var input = document.querySelector(
          'textarea[aria-label="Send a message to everyone"]',
        ) ||
          document.querySelector(
            'textarea[aria-label="Send a message"]',
          ) ||
          document.querySelector(
            '[contenteditable="true"][data-placeholder]',
          );
        if (!input) {
          console.error("[kaju] chat input not found");
          resolve(false);
          return;
        }

        input.focus();
        if (input.tagName === "TEXTAREA") {
          var nativeSet = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            "value",
          ).set;
          nativeSet.call(input, text);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
          input.innerText = text;
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }

        setTimeout(function () {
          input.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Enter",
              code: "Enter",
              keyCode: 13,
              bubbles: true,
            }),
          );
          console.log("[kaju] chat message sent");
          resolve(true);
        }, 200);
      }, 500);
    });
  };

  // --- Participant list ---
  window._kajuGetParticipants = function () {
    var names = [];
    // data-self-name is the most reliable attribute for participant names.
    document.querySelectorAll("[data-self-name]").forEach(function (el) {
      var n = el.getAttribute("data-self-name");
      if (n && names.indexOf(n) === -1) names.push(n);
    });
    return names;
  };

  // Number of OTHER participants, from live remote audio streams (see the audio
  // track collector above). Robust in headless/audio-only where DOM tiles are
  // absent. Distinct non-live/duplicate streams are filtered out.
  window._kajuGetOtherCount = function () {
    var ids = {};
    var arr = window._kajuAudioTracks || [];
    for (var i = 0; i < arr.length; i++) {
      var e = arr[i];
      if (!e.track || e.track.readyState !== "live") continue;
      var sids = e.streams && e.streams.length ? e.streams : ["_" + e.track.id];
      for (var j = 0; j < sids.length; j++) ids[sids[j]] = true;
    }
    return Object.keys(ids).length;
  };

  // --- Apple-Intelligence style glowing border ---
  // A frameless animated gradient ring hugging the viewport edge, plus a soft
  // pulsing bloom. pointer-events:none so it never blocks the Meet UI. Injected
  // into <html> and re-asserted so Meet's SPA re-renders can't drop it.
  window._kajuAddGlow = function () {
    try {
      if (!document.getElementById("kaju-glow-style")) {
        var st = document.createElement("style");
        st.id = "kaju-glow-style";
        st.textContent =
          "@keyframes kajuGlowPulse{0%,100%{opacity:.5}50%{opacity:.95}}" +
          "#kaju-glow{position:fixed;inset:0;z-index:2147483647;pointer-events:none;overflow:hidden}" +
          "#kaju-glow .kaju-bloom{position:absolute;inset:0;" +
          "box-shadow:inset 0 0 22px 5px rgba(10,132,255,.35)," +
          "inset 0 0 55px 12px rgba(94,92,230,.30)," +
          "inset 0 0 90px 22px rgba(191,90,242,.18);" +
          "animation:kajuGlowPulse 3.4s ease-in-out infinite}";
        (document.head || document.documentElement).appendChild(st);
      }
      if (!document.getElementById("kaju-glow")) {
        var g = document.createElement("div");
        g.id = "kaju-glow";
        var bloom = document.createElement("div");
        bloom.className = "kaju-bloom";
        g.appendChild(bloom);
        document.documentElement.appendChild(g);
      }
    } catch (e) {
      console.log("[kaju] glow failed: " + e);
    }
  };
  window._kajuRemoveGlow = function () {
    var g = document.getElementById("kaju-glow");
    if (g) g.remove();
  };
  // Keep the glow alive, and keep Meet's playback muted to avoid echoing the
  // meeting out the local speakers. Safe now: we tap el.srcObject directly, so
  // muting the element kills speaker output without affecting the captured
  // stream (WebRTC keeps delivering it regardless of element mute state).
  window._kajuAddGlow();
  setInterval(function () {
    if (!document.getElementById("kaju-glow")) window._kajuAddGlow();
  }, 2000);

  console.log(
    "[kaju] Audio hook installed (PCM capture + queue playback + chat)",
  );
})();
