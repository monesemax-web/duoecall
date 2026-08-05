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
        <button className="ctrl end" onClick={endCall} aria-label="End call" title="End call">
          ✕
        </button>
      </div>
    </div>
  );
}
