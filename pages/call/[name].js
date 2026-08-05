import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import DailyIframe from "@daily-co/daily-js";

export default function CallPage() {
  const router = useRouter();
  const { name, speak, hear } = router.query;

  const LANG_LABELS = {
    en: "English", es: "Spanish", fr: "French", pt: "Portuguese",
    de: "German", it: "Italian", zh: "Chinese", ar: "Arabic",
    hi: "Hindi", sw: "Swahili", tl: "Tagalog", yo: "Yoruba",
  };

  const callRef = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);

  const [status, setStatus] = useState("Connecting…");
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [remoteJoined, setRemoteJoined] = useState(false);
  const [shareUrl, setShareUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [swapped, setSwapped] = useState(false); // false = them big, you small

  // Translation state
  const [myCaption, setMyCaption] = useState("");       // what I said (original)
  const [theirCaption, setTheirCaption] = useState(""); // what they said, translated for me
  const [translating, setTranslating] = useState(false);
  const [translationOn, setTranslationOn] = useState(true);

  // Refs for the speech-capture machinery
  const recorderRef = useRef(null);
  const audioCtxRef = useRef(null);
  const speakingRef = useRef(false);
  const silenceStartRef = useRef(null);
  const chunksRef = useRef([]);
  const langRef = useRef({ speak: "en", hear: "es" });
  const translationOnRef = useRef(true);

  const domain = process.env.NEXT_PUBLIC_DAILY_DOMAIN;

  useEffect(() => {
    if (!name || !domain) return;

    const roomUrl = `https://${domain}/${name}`;
    setShareUrl(typeof window !== "undefined" ? window.location.href : "");

    // Create a call object (we render our own video UI, not Daily's prebuilt one).
    const call = DailyIframe.createCallObject({
      subscribeToTracksAutomatically: true,
      dailyConfig: {
        userMediaVideoConstraints: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        },
      },
    });
    callRef.current = call;

    function attachTrack(ref, participant, kind) {
      if (!ref.current) return;
      const track =
        participant.tracks &&
        participant.tracks[kind] &&
        participant.tracks[kind].persistentTrack;
      if (track) {
        // Only reset srcObject if the track actually changed — re-setting the
        // same stream on mobile can cause the video to drop/blank.
        const current = ref.current.srcObject;
        const alreadyShowing =
          current &&
          current.getVideoTracks &&
          current.getVideoTracks()[0] &&
          current.getVideoTracks()[0].id === track.id;
        if (!alreadyShowing) {
          ref.current.srcObject = new MediaStream([track]);
        }
        ref.current.play && ref.current.play().catch(() => {});
      }
    }

    function updateLocal() {
      const p = call.participants().local;
      if (p) attachTrack(localVideoRef, p, "video");
    }

    function updateRemote() {
      const parts = call.participants();
      const remote = Object.values(parts).find((p) => !p.local);
      if (remote) {
        setRemoteJoined(true);
        attachTrack(remoteVideoRef, remote, "video");
        // Attach remote audio to a hidden element so we can hear them.
        const aTrack =
          remote.tracks &&
          remote.tracks.audio &&
          remote.tracks.audio.persistentTrack;
        if (aTrack) {
          let a = document.getElementById("remote-audio");
          if (!a) {
            a = document.createElement("audio");
            a.id = "remote-audio";
            a.autoplay = true;
            document.body.appendChild(a);
          }
          a.srcObject = new MediaStream([aTrack]);
          a.play && a.play().catch(() => {});
        }
      } else {
        setRemoteJoined(false);
      }
    }

    call
      .on("joined-meeting", () => {
        setStatus("Waiting for the other person…");
        updateLocal();
      })
      .on("participant-joined", () => {
        setStatus("Connected");
        updateRemote();
      })
      .on("participant-updated", () => {
        updateLocal();
        updateRemote();
      })
      .on("track-started", () => {
        updateLocal();
        updateRemote();
      })
      .on("app-message", (ev) => {
        // The other side sends us their translated text; we caption + speak it.
        const data = ev && ev.data;
        if (!data || data.type !== "translation") return;
        if (!translationOnRef.current) return;
        const text = (data.text || "").trim();
        if (!text) return;
        setTheirCaption(text);
        speakText(text, langRef.current.hear);
      })
      .on("participant-left", () => {
        setRemoteJoined(false);
        setStatus("The other person left the call.");
      })
      .on("error", (e) => {
        console.error("daily error:", e);
        setStatus("Connection problem. Try rejoining.");
      });

    call.join({ url: roomUrl }).catch((e) => {
      console.error("join failed:", e);
      setStatus("Couldn't join the call.");
    });

    // Safety net: some mobile browsers miss the exact attach moment, so
    // re-check the local + remote video every 1.5s for the first while.
    const attachInterval = setInterval(() => {
      updateLocal();
      updateRemote();
    }, 1500);

    return () => {
      clearInterval(attachInterval);
      try {
        call.leave();
        call.destroy();
      } catch (e) {}
      const a = document.getElementById("remote-audio");
      if (a) a.remove();
    };
  }, [name, domain]);

  // Keep language + toggle refs in sync with query params / state.
  useEffect(() => {
    langRef.current = { speak: speak || "en", hear: hear || "es" };
  }, [speak, hear]);
  useEffect(() => {
    translationOnRef.current = translationOn;
  }, [translationOn]);

  // --- Speech capture engine: listen to my mic, detect end-of-speech on
  // silence, send the clip to be transcribed + translated, then ship the
  // translation to the other person over Daily's data channel. ---
  useEffect(() => {
    if (!domain || !name) return;
    let stream;
    let cancelled = false;

    async function startListening() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) return;

        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        const audioCtx = new AudioCtx();
        audioCtxRef.current = audioCtx;
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);

        // MediaRecorder captures the actual audio; analyser just detects speech.
        const mime = MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "audio/mp4";
        const recorder = new MediaRecorder(stream, { mimeType: mime });
        recorderRef.current = recorder;
        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.onstop = () => {
          const blob = new Blob(chunksRef.current, { type: mime });
          chunksRef.current = [];
          if (blob.size > 3000) handleSpeechClip(blob, mime); // ignore tiny blips
        };

        const SILENCE = 18;      // volume threshold (0-255-ish average)
        const SILENCE_MS = 900;  // how long a pause ends a turn
        const MIN_SPEECH_MS = 400;
        let speechStart = 0;

        function loop() {
          if (cancelled) return;
          analyser.getByteFrequencyData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) sum += data[i];
          const avg = sum / data.length;

          const now = Date.now();
          if (avg > SILENCE) {
            // Speaking
            if (!speakingRef.current) {
              speakingRef.current = true;
              speechStart = now;
              silenceStartRef.current = null;
              if (translationOnRef.current && recorder.state === "inactive") {
                chunksRef.current = [];
                try { recorder.start(); } catch (e) {}
              }
            }
            silenceStartRef.current = null;
          } else {
            // Silence
            if (speakingRef.current) {
              if (!silenceStartRef.current) silenceStartRef.current = now;
              const silentFor = now - silenceStartRef.current;
              const spokeFor = now - speechStart;
              if (silentFor > SILENCE_MS && spokeFor > MIN_SPEECH_MS) {
                speakingRef.current = false;
                silenceStartRef.current = null;
                if (recorder.state === "recording") {
                  try { recorder.stop(); } catch (e) {}
                }
              }
            }
          }
          requestAnimationFrame(loop);
        }
        loop();
      } catch (e) {
        console.error("mic listen error:", e);
      }
    }

    startListening();

    return () => {
      cancelled = true;
      try {
        if (recorderRef.current && recorderRef.current.state === "recording") {
          recorderRef.current.stop();
        }
      } catch (e) {}
      try { audioCtxRef.current && audioCtxRef.current.close(); } catch (e) {}
      try { stream && stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    };
  }, [name, domain]);

  // Send one captured speech clip to be transcribed + translated, then
  // deliver the translation to the other participant.
  async function handleSpeechClip(blob, mime) {
    if (!translationOnRef.current) return;
    setTranslating(true);
    try {
      const b64 = await blobToBase64(blob);
      const r = await fetch("/api/translate-speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioBase64: b64,
          mimeType: mime,
          fromLang: langRef.current.speak,
          toLang: langRef.current.hear,
        }),
      });
      const j = await r.json();
      if (j.original) setMyCaption(j.original);
      const translated = (j.translated || "").trim();
      if (translated && callRef.current) {
        // Send the translation to the other person to caption + speak.
        callRef.current.sendAppMessage({ type: "translation", text: translated }, "*");
      }
    } catch (e) {
      console.error("translate clip error:", e);
    } finally {
      setTranslating(false);
    }
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // Speak translated text aloud in the listener's language.
  function speakText(text, langCode) {
    try {
      if (!("speechSynthesis" in window)) return;
      const u = new SpeechSynthesisUtterance(text);
      const map = {
        en: "en-US", es: "es-ES", fr: "fr-FR", pt: "pt-BR", de: "de-DE",
        it: "it-IT", zh: "zh-CN", ar: "ar-SA", hi: "hi-IN", sw: "sw-KE",
        tl: "fil-PH", yo: "en-US",
      };
      u.lang = map[langCode] || "en-US";
      u.rate = 1.0;
      // Pick a matching voice if available.
      const voices = window.speechSynthesis.getVoices();
      const match = voices.find((v) => v.lang && v.lang.startsWith((map[langCode] || "en").slice(0, 2)));
      if (match) u.voice = match;
      window.speechSynthesis.cancel(); // stop any prior utterance
      window.speechSynthesis.speak(u);
    } catch (e) {
      console.error("tts error:", e);
    }
  }

  function toggleMic() {
    const call = callRef.current;
    if (!call) return;
    const next = !micOn;
    call.setLocalAudio(next);
    setMicOn(next);
  }

  function toggleCam() {
    const call = callRef.current;
    if (!call) return;
    const next = !camOn;
    call.setLocalVideo(next);
    setCamOn(next);
  }

  function endCall() {
    const call = callRef.current;
    try {
      call && call.leave();
    } catch (e) {}
    router.push("/");
  }

  function copyLink() {
    if (!shareUrl) return;
    try {
      navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {}
  }

  if (!domain) {
    return (
      <div className="center-msg">
        Calling isn't configured yet. Set NEXT_PUBLIC_DAILY_DOMAIN and try again.
      </div>
    );
  }

  return (
    <div className="call">
      <div className="callbar">
        <div className="who">
          <img
            src="/logo-mark.svg"
            alt=""
            style={{ height: 26, width: "auto", verticalAlign: "middle", marginRight: 8 }}
          />
          <div>
            <div>
              Duo<span>Ecall</span>
            </div>
            {speak && hear && (
              <div className="langs">
                <b>{LANG_LABELS[speak] || speak}</b> → <b>{LANG_LABELS[hear] || hear}</b>
              </div>
            )}
          </div>
        </div>
        <div className="status">{status}</div>
      </div>

      <div className="stage">
        {/* Remote video element (fixed ref). Sizing swaps via class. */}
        <div
          className={swapped ? "pip" : "main-video"}
          onClick={swapped ? () => setSwapped(false) : undefined}
          role={swapped ? "button" : undefined}
        >
          <video ref={remoteVideoRef} autoPlay playsInline />
          {!remoteJoined && !swapped && (
            <div className="placeholder">
              Waiting for the other person to join…
              <br />
              Share the link below.
            </div>
          )}
          {swapped ? (
            <span className="pip-label">Them</span>
          ) : (
            remoteJoined && <div className="main-label">Them</div>
          )}
        </div>

        {/* Local (self) video element (fixed ref). Sizing swaps via class. */}
        <div
          className={swapped ? "main-video" : "pip"}
          onClick={!swapped ? () => setSwapped(true) : undefined}
          role={!swapped ? "button" : undefined}
        >
          <video ref={localVideoRef} autoPlay playsInline muted />
          {swapped ? (
            <div className="main-label">You</div>
          ) : (
            <span className="pip-label">You</span>
          )}
        </div>
      </div>

      {/* Live caption bar: what THEY said (translated for me) on top,
          what I said (my own words) below, so I can see it's working. */}
      {(theirCaption || myCaption || translating) && (
        <div className="captions">
          {theirCaption && (
            <div className="cap-them">{theirCaption}</div>
          )}
          {(myCaption || translating) && (
            <div className="cap-me">
              {translating && !myCaption ? "…" : myCaption}
            </div>
          )}
        </div>
      )}

      {!remoteJoined && (
        <div className="share">
          <input readOnly value={shareUrl} />
          <button onClick={copyLink}>{copied ? "Copied!" : "Copy link"}</button>
        </div>
      )}

      <div className="controls">
        <button
          className={`ctrl ${micOn ? "" : "off"}`}
          onClick={toggleMic}
          aria-label={micOn ? "Mute" : "Unmute"}
          title={micOn ? "Mute" : "Unmute"}
        >
          {micOn ? "🎙" : "🔇"}
        </button>
        <button
          className={`ctrl ${camOn ? "" : "off"}`}
          onClick={toggleCam}
          aria-label={camOn ? "Turn camera off" : "Turn camera on"}
          title={camOn ? "Camera off" : "Camera on"}
        >
          {camOn ? "📷" : "🚫"}
        </button>
        <button
          className={`ctrl ${translationOn ? "on-accent" : "off"}`}
          onClick={() => setTranslationOn((v) => !v)}
          aria-label={translationOn ? "Turn translation off" : "Turn translation on"}
          title={translationOn ? "Translation on" : "Translation off"}
        >
          🌐
        </button>
        <button className="ctrl end" onClick={endCall} aria-label="End call" title="End call">
          ✕
        </button>
      </div>
    </div>
  );
}
