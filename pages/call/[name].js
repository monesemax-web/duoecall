import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import DailyIframe from "@daily-co/daily-js";

const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "pt", label: "Portuguese" },
  { code: "de", label: "German" },
  { code: "it", label: "Italian" },
  { code: "zh", label: "Chinese (Mandarin)" },
  { code: "ar", label: "Arabic" },
  { code: "hi", label: "Hindi" },
  { code: "sw", label: "Swahili" },
  { code: "tl", label: "Tagalog" },
  { code: "yo", label: "Yoruba" },
];
const LANG_LABELS = Object.fromEntries(LANGUAGES.map((l) => [l.code, l.label]));
const TTS_LANG = {
  en: "en-US", es: "es-ES", fr: "fr-FR", pt: "pt-BR", de: "de-DE",
  it: "it-IT", zh: "zh-CN", ar: "ar-SA", hi: "hi-IN", sw: "sw-KE",
  tl: "fil-PH", yo: "en-US",
};

export default function CallPage() {
  const router = useRouter();
  const { name, speak } = router.query;
  const domain = process.env.NEXT_PUBLIC_DAILY_DOMAIN;

  // ---- UI state ----
  const [myLang, setMyLang] = useState(null);     // language THIS person speaks
  const [pickerLang, setPickerLang] = useState("en");
  const [theirLang, setTheirLang] = useState(null);
  const [status, setStatus] = useState("Connecting…");
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [remoteJoined, setRemoteJoined] = useState(false);
  const [swapped, setSwapped] = useState(false);
  const [shareUrl, setShareUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [translationOn, setTranslationOn] = useState(true);
  const [myCaption, setMyCaption] = useState("");
  const [theirCaption, setTheirCaption] = useState("");
  const [busy, setBusy] = useState(false);

  // ---- Refs (live values used inside callbacks/loops) ----
  const callRef = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const joinedRef = useRef(false);
  const myLangRef = useRef("en");
  const theirLangRef = useRef(null);
  const translationOnRef = useRef(true);

  // Keep refs in sync with state
  useEffect(() => { if (myLang) myLangRef.current = myLang; }, [myLang]);
  useEffect(() => { theirLangRef.current = theirLang; }, [theirLang]);
  useEffect(() => { translationOnRef.current = translationOn; }, [translationOn]);

  // If the URL carries a language (starter), adopt it once router is ready
  useEffect(() => {
    if (!router.isReady) return;
    if (speak && !myLang) setMyLang(speak);
  }, [router.isReady, speak, myLang]);

  // ---- Send helpers (safe: only after join) ----
  function safeSend(obj) {
    if (!joinedRef.current) return;
    const call = callRef.current;
    if (!call || !call.sendAppMessage) return;
    try { call.sendAppMessage(obj, "*"); } catch (e) {}
  }
  function announceLang() {
    safeSend({ type: "lang", lang: myLangRef.current });
  }

  // ---- Text to speech ----
  function speak_(text, langCode) {
    try {
      if (!("speechSynthesis" in window)) return;
      const u = new SpeechSynthesisUtterance(text);
      u.lang = TTS_LANG[langCode] || "en-US";
      u.rate = 1.0;
      const voices = window.speechSynthesis.getVoices();
      const base = (TTS_LANG[langCode] || "en").slice(0, 2);
      const match = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith(base));
      if (match) u.voice = match;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch (e) {}
  }

  // =====================================================================
  //  CALL CONNECTION  (runs once we know name + domain + myLang)
  // =====================================================================
  useEffect(() => {
    if (!name || !domain || !myLang) return;

    const roomUrl = `https://${domain}/${name}`;
    if (typeof window !== "undefined") {
      setShareUrl(window.location.origin + window.location.pathname); // clean link, no lang
    }

    const call = DailyIframe.createCallObject({
      subscribeToTracksAutomatically: true,
      dailyConfig: {
        userMediaVideoConstraints: {
          width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 },
        },
      },
    });
    callRef.current = call;

    function attach(ref, participant, kind) {
      if (!ref.current || !participant) return;
      const t = participant.tracks?.[kind]?.persistentTrack;
      if (!t) return;
      const cur = ref.current.srcObject;
      const same = cur?.getVideoTracks?.()[0]?.id === t.id;
      if (!same) ref.current.srcObject = new MediaStream([t]);
      ref.current.play?.().catch(() => {});
    }
    function refreshVideo() {
      const parts = call.participants();
      if (parts.local) attach(localVideoRef, parts.local, "video");
      const remote = Object.values(parts).find((p) => !p.local);
      if (remote) {
        setRemoteJoined(true);
        attach(remoteVideoRef, remote, "video");
        const a = remote.tracks?.audio?.persistentTrack;
        if (a) {
          let el = document.getElementById("remote-audio");
          if (!el) {
            el = document.createElement("audio");
            el.id = "remote-audio";
            el.autoplay = true;
            document.body.appendChild(el);
          }
          if (el.srcObject?.getAudioTracks?.()[0]?.id !== a.id) {
            el.srcObject = new MediaStream([a]);
          }
          el.play?.().catch(() => {});
        }
      } else {
        setRemoteJoined(false);
      }
    }

    call
      .on("joined-meeting", () => {
        joinedRef.current = true;
        setStatus("Waiting for the other person…");
        refreshVideo();
        announceLang();
      })
      .on("participant-joined", () => {
        setStatus("Connected");
        refreshVideo();
        announceLang(); // greet the newcomer
      })
      .on("participant-updated", refreshVideo)
      .on("track-started", refreshVideo)
      .on("app-message", (ev) => {
        const d = ev?.data;
        if (!d) return;
        if (d.type === "lang" && d.lang) {
          if (theirLangRef.current !== d.lang) {
            theirLangRef.current = d.lang;
            setTheirLang(d.lang);
          }
          announceLang(); // reply so they learn mine too
        } else if (d.type === "translation") {
          if (!translationOnRef.current) return;
          const text = (d.text || "").trim();
          if (!text) return;
          setTheirCaption(text);
          speak_(text, myLangRef.current);
        }
      })
      .on("participant-left", () => {
        setRemoteJoined(false);
        setStatus("The other person left.");
      })
      .on("error", (e) => {
        console.error("daily error:", e);
        setStatus("Connection problem. Try rejoining.");
      });

    call.join({ url: roomUrl }).catch((e) => {
      console.error("join failed:", e);
      setStatus("Couldn't join the call.");
    });

    const videoPoll = setInterval(refreshVideo, 1500);
    const langBeat = setInterval(announceLang, 3000); // steady, safe (gated on join)

    return () => {
      clearInterval(videoPoll);
      clearInterval(langBeat);
      joinedRef.current = false;
      theirLangRef.current = null;
      try { call.leave(); call.destroy(); } catch (e) {}
      const a = document.getElementById("remote-audio");
      if (a) a.remove();
    };
  }, [name, domain, myLang]);

  // =====================================================================
  //  SPEECH CAPTURE  (listen to my mic, detect end-of-turn, translate)
  // =====================================================================
  useEffect(() => {
    if (!name || !domain || !myLang) return;
    let stream, audioCtx, raf, recorder;
    let cancelled = false;
    let speaking = false;
    let speechStart = 0;
    let silenceStart = 0;
    let loudFrames = 0;
    let chunks = [];

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) return;
        const AC = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AC();
        const src = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);

        const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4";
        recorder = new MediaRecorder(stream, { mimeType: mime });
        recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
        recorder.onstop = () => {
          const blob = new Blob(chunks, { type: mime });
          chunks = [];
          const real = recorder._real;
          recorder._real = false;
          if (real && blob.size > 8000) translateClip(blob, mime);
        };

        const SPEAK_THRESH = 30;   // avg volume to count as sound
        const LOUD_THRESH = 44;    // clearly speech
        const SILENCE_MS = 850;    // pause that ends a turn
        const MIN_MS = 500;        // must speak this long
        const MIN_LOUD = 7;        // need this many loud frames

        function loop() {
          if (cancelled) return;
          analyser.getByteFrequencyData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) sum += data[i];
          const avg = sum / data.length;
          const now = Date.now();

          if (avg > SPEAK_THRESH) {
            if (avg > LOUD_THRESH) loudFrames++;
            if (!speaking) {
              speaking = true;
              speechStart = now;
              loudFrames = 0;
              chunks = [];
              if (translationOnRef.current && recorder.state === "inactive") {
                try { recorder.start(); } catch (e) {}
              }
            }
            silenceStart = 0;
          } else {
            if (speaking) {
              if (!silenceStart) silenceStart = now;
              if (now - silenceStart > SILENCE_MS && now - speechStart > MIN_MS) {
                speaking = false;
                const wasReal = loudFrames >= MIN_LOUD;
                silenceStart = 0;
                if (recorder.state === "recording") {
                  recorder._real = wasReal;
                  try { recorder.stop(); } catch (e) {}
                }
              }
            }
          }
          raf = requestAnimationFrame(loop);
        }
        loop();
      } catch (e) {
        console.error("mic error:", e);
      }
    }
    start();

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      try { if (recorder && recorder.state === "recording") recorder.stop(); } catch (e) {}
      try { audioCtx && audioCtx.close(); } catch (e) {}
      try { stream && stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    };
  }, [name, domain, myLang]);

  // Translate one captured clip into the OTHER person's language, then send it.
  async function translateClip(blob, mime) {
    if (!translationOnRef.current) return;
    const toLang = theirLangRef.current;
    if (!toLang) return; // don't know target yet
    setBusy(true);
    try {
      const b64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onloadend = () => res(String(r.result).split(",")[1]);
        r.onerror = rej;
        r.readAsDataURL(blob);
      });
      const resp = await fetch("/api/translate-speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioBase64: b64, mimeType: mime,
          fromLang: myLangRef.current, toLang,
        }),
      });
      const j = await resp.json();
      if (j.original) setMyCaption(j.original);
      const translated = (j.translated || "").trim();
      if (translated) safeSend({ type: "translation", text: translated });
    } catch (e) {
      console.error("translate error:", e);
    } finally {
      setBusy(false);
    }
  }

  // ---- Controls ----
  function toggleMic() {
    const c = callRef.current; if (!c) return;
    const n = !micOn; c.setLocalAudio(n); setMicOn(n);
  }
  function toggleCam() {
    const c = callRef.current; if (!c) return;
    const n = !camOn; c.setLocalVideo(n); setCamOn(n);
  }
  function endCall() {
    try { callRef.current && callRef.current.leave(); } catch (e) {}
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

  // ---- Render guards ----
  if (!domain) {
    return <div className="center-msg">Calling isn't configured. Set NEXT_PUBLIC_DAILY_DOMAIN.</div>;
  }
  if (!router.isReady) {
    return <div className="center-msg">Loading…</div>;
  }
  if (!myLang) {
    return (
      <div className="home">
        <img src="/logo-mark.svg" alt="DuoEcall" style={{ width: 88, marginBottom: 12 }} />
        <div className="logo">Duo<span>Ecall</span></div>
        <div className="subtag">AI real-time translation</div>
        <div className="tag">You've been invited to a call. Which language do you speak?</div>
        <div className="lang-block">
          <div className="lang-row">
            <label>I speak</label>
            <select value={pickerLang} onChange={(e) => setPickerLang(e.target.value)}>
              {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
          </div>
        </div>
        <button className="cta" onClick={() => setMyLang(pickerLang)}>Join the call</button>
      </div>
    );
  }

  return (
    <div className="call">
      <div className="callbar">
        <div className="who">
          <img src="/logo-mark.svg" alt="" style={{ height: 26, marginRight: 8, verticalAlign: "middle" }} />
          <div>
            <div>Duo<span>Ecall</span></div>
            <div className="langs">
              <b>{LANG_LABELS[myLang] || myLang}</b>
              {theirLang
                ? <> ↔ <b>{LANG_LABELS[theirLang] || theirLang}</b></>
                : <span style={{ opacity: 0.6 }}> · waiting…</span>}
            </div>
          </div>
        </div>
        <div className="status">{status}</div>
      </div>

      <div className="stage">
        <div className={swapped ? "pip" : "main-video"} onClick={swapped ? () => setSwapped(false) : undefined} role={swapped ? "button" : undefined}>
          <video ref={remoteVideoRef} autoPlay playsInline />
          {!remoteJoined && !swapped && (
            <div className="placeholder">Waiting for the other person…<br />Share the link below.</div>
          )}
          {swapped ? <span className="pip-label">Them</span> : (remoteJoined && <div className="main-label">Them</div>)}
        </div>
        <div className={swapped ? "main-video" : "pip"} onClick={!swapped ? () => setSwapped(true) : undefined} role={!swapped ? "button" : undefined}>
          <video ref={localVideoRef} autoPlay playsInline muted />
          {swapped ? <div className="main-label">You</div> : <span className="pip-label">You</span>}
        </div>
      </div>

      {(theirCaption || myCaption || busy) && (
        <div className="captions">
          {theirCaption && <div className="cap-them">{theirCaption}</div>}
          {(myCaption || busy) && <div className="cap-me">{busy && !myCaption ? "…" : myCaption}</div>}
        </div>
      )}

      {!remoteJoined && (
        <div className="share">
          <input readOnly value={shareUrl} />
          <button onClick={copyLink}>{copied ? "Copied!" : "Copy link"}</button>
        </div>
      )}

      <div className="controls">
        <button className={`ctrl ${micOn ? "" : "off"}`} onClick={toggleMic} title={micOn ? "Mute" : "Unmute"}>
          {micOn ? "🎙" : "🔇"}
        </button>
        <button className={`ctrl ${camOn ? "" : "off"}`} onClick={toggleCam} title={camOn ? "Camera off" : "Camera on"}>
          {camOn ? "📷" : "🚫"}
        </button>
        <button className={`ctrl ${translationOn ? "on-accent" : "off"}`} onClick={() => setTranslationOn((v) => !v)} title="Translation">
          🌐
        </button>
        <button className="ctrl end" onClick={endCall} title="End call">✕</button>
      </div>
    </div>
  );
}
