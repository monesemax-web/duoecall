// POST /api/translate-speech
// Body: { audioBase64, mimeType, fromLang, toLang }
// 1) Transcribes the audio clip (speaker's language) via OpenAI Whisper
// 2) Translates the text into the listener's language
// Returns: { original, translated }
//
// Env var required: OPENAI_API_KEY

export const config = {
  api: { bodyParser: { sizeLimit: "10mb" } }, // short speech clips
};

const LANG_NAMES = {
  en: "English", es: "Spanish", fr: "French", pt: "Portuguese",
  de: "German", it: "Italian", zh: "Chinese (Mandarin)", ar: "Arabic",
  hi: "Hindi", sw: "Swahili", tl: "Tagalog", yo: "Yoruba",
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Translation is not configured (missing OPENAI_API_KEY)." });
  }

  try {
    const { audioBase64, mimeType, fromLang, toLang } = req.body || {};
    if (!audioBase64) return res.status(400).json({ error: "No audio provided" });

    // --- 1) Transcribe with Whisper ---
    const buffer = Buffer.from(audioBase64, "base64");
    const type = mimeType || "audio/webm";
    const ext = type.includes("mp4") ? "mp4" : type.includes("ogg") ? "ogg" : "webm";

    const form = new FormData();
    form.append("file", new Blob([buffer], { type }), `clip.${ext}`);
    form.append("model", "whisper-1");
    if (fromLang) form.append("language", fromLang); // hint improves accuracy

    const sttRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    if (!sttRes.ok) {
      const detail = await sttRes.text();
      console.error("STT error:", detail);
      // Surface the real reason so we can diagnose (temporary, for debugging).
      return res.status(502).json({
        error: "Transcription failed",
        stage: "speech-to-text",
        status: sttRes.status,
        detail: detail.slice(0, 500),
      });
    }

    const sttData = await sttRes.json();
    const original = (sttData.text || "").trim();
    if (!original) return res.status(200).json({ original: "", translated: "" });

    // --- 2) Translate with a chat model ---
    const fromName = LANG_NAMES[fromLang] || fromLang || "the source language";
    const toName = LANG_NAMES[toLang] || toLang || "the target language";

    const trRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              `You are a live conversation translator. Translate the user's message from ${fromName} to ${toName}. ` +
              `Output ONLY the translation, no quotes, no explanations, no notes. Keep it natural and spoken, as in real conversation.`,
          },
          { role: "user", content: original },
        ],
      }),
    });

    if (!trRes.ok) {
      const detail = await trRes.text();
      console.error("translate error:", detail);
      // Still return the original so the caption shows something.
      return res.status(200).json({ original, translated: "" });
    }

    const trData = await trRes.json();
    const translated =
      (trData.choices &&
        trData.choices[0] &&
        trData.choices[0].message &&
        trData.choices[0].message.content
          ? trData.choices[0].message.content
          : ""
      ).trim();

    return res.status(200).json({ original, translated });
  } catch (err) {
    console.error("translate-speech error:", err);
    return res.status(500).json({ error: "Translation error", detail: String(err && err.message || err).slice(0, 500) });
  }
}
