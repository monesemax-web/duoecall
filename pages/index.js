import { useState } from "react";
import { useRouter } from "next/router";

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

export default function Home() {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [joinUrl, setJoinUrl] = useState("");
  const [error, setError] = useState("");
  const [speak, setSpeak] = useState("en");

  async function startCall() {
    setError("");
    setCreating(true);
    try {
      const r = await fetch("/api/room/create", { method: "POST" });
      const j = await r.json();
      if (!r.ok) {
        setError(j.error || "Couldn't start the call.");
        setCreating(false);
        return;
      }
      // Room name is the last path segment of the Daily URL.
      const name = j.name || (j.url || "").split("/").pop();
      router.push(`/call/${encodeURIComponent(name)}?speak=${speak}`);
    } catch (e) {
      setError("Network error starting the call.");
      setCreating(false);
    }
  }

  function joinCall() {
    setError("");
    const val = joinUrl.trim();
    if (!val) return;
    // Accept either a full Daily URL or just a room name.
    const name = val.includes("/") ? val.split("/").pop().split("?")[0] : val;
    router.push(`/call/${encodeURIComponent(name)}?speak=${speak}`);
  }

  return (
    <div className="home">
      <img
        src="/logo-mark.svg"
        alt="DuoEcall"
        style={{ width: 104, height: "auto", marginBottom: 14 }}
      />
      <div className="logo">
        Duo<span>Ecall</span>
      </div>
      <div className="subtag">AI real-time translation</div>
      <div className="tag">
        A live video call where each person speaks their own language. Start a
        call, share the link, and talk.
      </div>

      <div className="lang-block">
        <div className="lang-row">
          <label>I speak</label>
          <select value={speak} onChange={(e) => setSpeak(e.target.value)}>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
        <div className="lang-note">
          The other person picks their own language. Everyone hears the other in
          their language automatically.
        </div>
      </div>

      <button className="cta" onClick={startCall} disabled={creating}>
        {creating ? "Starting…" : "Start a call"}
      </button>

      <div className="join-row">
        <input
          value={joinUrl}
          onChange={(e) => setJoinUrl(e.target.value)}
          placeholder="Paste a call link to join"
          onKeyDown={(e) => {
            if (e.key === "Enter") joinCall();
          }}
        />
        <button onClick={joinCall}>Join</button>
      </div>

      {error && (
        <div style={{ color: "#ffb4b4", fontSize: 13, marginTop: 14 }}>{error}</div>
      )}

      <div className="hint">
        Stage 1: this is the plain video call. Translation comes next. Test it by
        opening the call link on a second phone.
      </div>
    </div>
  );
}
