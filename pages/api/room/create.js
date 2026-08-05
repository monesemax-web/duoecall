// POST /api/room/create
// Creates a short-lived Daily room and returns its URL + name.
// The two callers both join the same room URL to be on the call together.
//
// Env var required: DAILY_API_KEY

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.DAILY_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Calling is not configured (missing DAILY_API_KEY)." });
  }

  try {
    // Room auto-expires 2 hours from now so we don't pile up dead rooms.
    const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 2;

    const r = await fetch("https://api.daily.co/v1/rooms", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        properties: {
          exp,
          enable_chat: false,
          start_video_off: false,
          start_audio_off: false,
          max_participants: 2,
        },
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      console.error("daily create room error:", data);
      return res.status(502).json({ error: data.error || "Failed to create room" });
    }

    return res.status(200).json({ url: data.url, name: data.name });
  } catch (err) {
    console.error("room create error:", err);
    return res.status(500).json({ error: "Failed to create room" });
  }
}
