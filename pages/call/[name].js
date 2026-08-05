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
  const [myVoice, setMyVoice] = useState("male"); // this person's voice gender
  const [pickerVoice, setPickerVoice] = useState("male");
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
  // Turn state: 'ready' | 'listening' | 'translating' | 'incoming'
  const [turn, setTurn] = useState("ready");
  // Floor lock: who currently holds the conversation floor: null | 'me' | 'them'
  const [floor, setFloor] = useState(null);
  const floorRef = useRef(null);

  // ---- Refs (live values used inside callbacks/loops) ----
  const callRef = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const joinedRef = useRef(false);
  const myLangRef = useRef("en");
  const myVoiceRef = useRef("male");
  const theirLangRef = useRef(null);
  const translationOnRef = useRef(true);

  // Keep refs in sync with state
  useEffect(() => { if (myLang) myLangRef.current = myLang; }, [myLang]);
  useEffect(() => { myVoiceRef.current = myVoice; }, [myVoice]);
  useEffect(() => { floorRef.current = floor; }, [floor]);
  useEffect(() => { theirLangRef.current = theirLang; }, [theirLang]);
  useEffect(() => { translationOnRef.current = translationOn; }, [translationOn]);

  // If the URL carries a language (starter), adopt it once router is ready
  useEffect(() => {
    if (!router.isReady) return;
    if (speak && !myLang) {
      setMyLang(speak);
      if (router.query.voice) setMyVoice(router.query.voice);
    }
  }, [router.isReady, speak, myLang, router.query.voice]);

  // Backstop: unlock mobile speech on the first tap anywhere in the call,
  // in case the picker's Join tap didn't (e.g. the starter who skips it).
  useEffect(() => {
    if (!myLang) return;
    let done = false;
    const unlock = () => {
      if (done) return;
      done = true;
      try {
        const u = new SpeechSynthesisUtterance(" ");
        u.volume = 0;
        window.speechSynthesis.speak(u);
      } catch (e) {}
      window.removeEventListener("pointerdown", unlock);
    };
    window.addEventListener("pointerdown", unlock);
    return () => window.removeEventListener("pointerdown", unlock);
  }, [myLang]);

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

  // ---- Floor lock: one speaker at a time ----
  function claimFloor() {
    if (floorRef.current) return false; // someone already holds it
    floorRef.current = "me";
    setFloor("me");
    safeSend({ type: "floor", action: "claim" }); // tells them: I'm speaking
    return true;
  }
  function releaseFloor() {
    if (floorRef.current !== "me") return;
    floorRef.current = null;
    setFloor(null);
    safeSend({ type: "floor", action: "release" }); // tells them: floor is open
  }

  // ---- Text to speech ----
  // Mobile browsers block speech until unlocked by a user gesture. We call
  // unlockSpeech() from the Join tap so speaking works on phones afterward.
  function unlockSpeech() {
    try {
      if (!("speechSynthesis" in window)) return;
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0; // silent priming utterance
      window.speechSynthesis.speak(u);
      // Trigger voice list load (some browsers populate lazily).
      window.speechSynthesis.getVoices();
    } catch (e) {}
  }

  // Heuristics to guess a voice's gender from its name (device voices don't
  // expose gender directly, so we match on known name patterns).
  const FEMALE_HINTS = ["female", "woman", "samantha", "victoria", "karen", "moira", "tessa", "monica", "paulina", "google español", "google us english", "zira", "susan", "linda", "heather", "catherine", "amelie", "anna", "ella", "sofia", "lucia", "maria"];
  const MALE_HINTS = ["male", "man", "daniel", "alex", "fred", "diego", "jorge", "google español de estados", "david", "mark", "james", "paul", "george", "thomas", "juan", "carlos", "miguel"];

  function pickVoice(voices, langBase, gender) {
    const inLang = voices.filter(
      (v) => v.lang && v.lang.toLowerCase().startsWith(langBase)
    );
    if (inLang.length === 0) return null;
    const hints = gender === "female" ? FEMALE_HINTS : MALE_HINTS;
    // First: a voice whose name matches the desired gender.
    const byName = inLang.find((v) =>
      hints.some((h) => v.name.toLowerCase().includes(h))
    );
    if (byName) return byName;
    // Otherwise: avoid the opposite gender if we can identify it.
    const otherHints = gender === "female" ? MALE_HINTS : FEMALE_HINTS;
    const notOther = inLang.find(
      (v) => !otherHints.some((h) => v.name.toLowerCase().includes(h))
    );
    return notOther || inLang[0];
  }

  function speak_(text, langCode, gender) {
    try {
      if (!("speechSynthesis" in window)) return;
      const synth = window.speechSynthesis;
      const base = (TTS_LANG[langCode] || "en").slice(0, 2);
      const g = gender || "male";
      const doSpeak = () => {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = TTS_LANG[langCode] || "en-US";
        u.rate = 1.0;
        u.volume = 1.0;
        // Nudge pitch to reinforce the gender difference the device gives us.
        u.pitch = g === "female" ? 1.15 : 0.85;
        const voices = synth.getVoices();
        const v = pickVoice(voices, base, g);
        if (v) u.voice = v;
        synth.cancel();
        synth.speak(u);
      };
      if (synth.getVoices().length === 0) {
        synth.onvoiceschanged = () => {
          synth.onvoiceschanged = null;
          doSpeak();
        };
        setTimeout(doSpeak, 250);
      } else {
        doSpeak();
      }
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
        } else if (d.type === "floor") {
          // The other person grabbed or released the floor.
          if (d.action === "claim") {
            floorRef.current = "them";
            setFloor("them");
          } else if (d.action === "release") {
            if (floorRef.current === "them") {
              floorRef.current = null;
              setFloor(null);
            }
          }
        } else if (d.type === "translation") {
          if (!translationOnRef.current) return;
          const text = (d.text || "").trim();
          if (!text) return;
          setTheirCaption(text);
          setTurn("incoming");
          speak_(text, myLangRef.current, d.voice || "male");
          // Estimate speaking time, then return to ready.
          const secs = Math.min(8, Math.max(2, text.split(/\s+/).length * 0.45));
          setTimeout(() => setTurn("ready"), secs * 1000);
        }
      })
      .on("participant-left", () => {
        setRemoteJoined(false);
        setStatus("The other person left.");
        floorRef.current = null;
        setFloor(null);
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
        const SILENCE_MS = 1400;   // pause that ends a turn — long enough to
                                   // ride through natural mid-sentence pauses
        const MIN_MS = 400;        // must speak this long
        const MIN_LOUD = 6;        // need this many loud frames

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
              // HARD LOCK: only start a turn if the floor is free (or already mine).
              const canSpeak =
                translationOnRef.current &&
                (floorRef.current === null || floorRef.current === "me");
              if (!canSpeak) {
                // Someone else holds the floor — ignore my audio entirely.
                raf = requestAnimationFrame(loop);
                return;
              }
              speaking = true;
              speechStart = now;
              loudFrames = 0;
              chunks = [];
              claimFloor(); // grab the floor
              setTurn("listening");
              if (recorder.state === "inactive") {
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
                // If it was real speech, we're now translating; otherwise ready.
                if (translationOnRef.current) {
                  setTurn(wasReal ? "translating" : "ready");
                }
                // If it wasn't real speech, release the floor immediately.
                if (!wasReal) releaseFloor();
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
      if (translated) {
        safeSend({ type: "translation", text: translated, voice: myVoiceRef.current });
        // Hold the floor until the other side finishes speaking my translation,
        // then release it. Estimate speaking time from word count.
        const words = translated.split(/\s+/).length;
        const secs = Math.min(9, Math.max(2, words * 0.45));
        setTimeout(() => {
          releaseFloor();
          setTurn("ready");
        }, secs * 1000);
      } else {
        // Nothing to say — release immediately.
        releaseFloor();
        setTurn("ready");
      }
    } catch (e) {
      console.error("translate error:", e);
      releaseFloor();
      setTurn("ready");
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
        <div className="tag">You've been invited to a call. Set your language and voice.</div>
        <div className="lang-block">
          <div className="lang-row">
            <label>I speak</label>
            <select value={pickerLang} onChange={(e) => setPickerLang(e.target.value)}>
              {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
          </div>
          <div className="lang-row">
            <label>My voice</label>
            <select value={pickerVoice} onChange={(e) => setPickerVoice(e.target.value)}>
              <option value="male">Male</option>
              <option value="female">Female</option>
            </select>
          </div>
        </div>
        <button
          className="cta"
          onClick={() => {
            unlockSpeech();
            setMyVoice(pickerVoice);
            setMyLang(pickerLang);
          }}
        >
          Join the call
        </button>
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

      {remoteJoined && theirLang && (
        <div className={`turn turn-${floor === "them" ? "locked" : turn}`}>
          {floor === "them" ? (
            <>🔒 The other person is speaking — please wait…</>
          ) : (
            <>
              {turn === "listening" && <>🎙 Listening — keep talking…</>}
              {turn === "translating" && <>⏳ Translating — please wait…</>}
              {turn === "incoming" && <>🔊 They're speaking — please wait…</>}
              {turn === "ready" && <>✅ Your turn — go ahead</>}
            </>
          )}
        </div>
      )}

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
