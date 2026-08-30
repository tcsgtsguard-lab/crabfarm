// Vercel Serverless Function
// รับรูปภาพ (base64) + prompt จากฝั่ง client แล้วยิงต่อไปที่ Google Gemini API
// โดยใช้ GEMINI_API_KEY ที่เก็บไว้ฝั่งเซิร์ฟเวอร์เท่านั้น (ไม่หลุดไปที่ browser)
//
// สมัคร API key ฟรีได้ที่ https://aistudio.google.com/apikey (ไม่ต้องผูกบัตรเครดิต)
// แล้วตั้งค่า Environment Variable ชื่อ GEMINI_API_KEY ใน Vercel Project Settings
// (Settings > Environment Variables) ก่อน ไม่งั้นฟังก์ชันนี้จะตอบ error กลับไป

const GEMINI_MODEL = "gemini-2.5-flash";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const { imageBase64, mediaType, prompt, apiKeyOverride } = req.body || {};
    const apiKey = apiKeyOverride || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      res.status(500).json({
        error: "\u0E22\u0E31\u0E07\u0E44\u0E21\u0E48\u0E44\u0E14\u0E49\u0E15\u0E31\u0E49\u0E07\u0E04\u0E48\u0E32 GEMINI_API_KEY \u0E1A\u0E19 Vercel \u0E41\u0E25\u0E30\u0E22\u0E31\u0E07\u0E44\u0E21\u0E48\u0E44\u0E14\u0E49\u0E43\u0E2A\u0E48 API Key \u0E2A\u0E48\u0E27\u0E19\u0E15\u0E31\u0E27\u0E43\u0E19\u0E41\u0E2D\u0E1B \u2014 \u0E2A\u0E21\u0E31\u0E04\u0E23 API key \u0E1F\u0E23\u0E35\u0E44\u0E14\u0E49\u0E17\u0E35\u0E48 https://aistudio.google.com/apikey \u0E41\u0E25\u0E49\u0E27\u0E43\u0E2A\u0E48\u0E43\u0E19\u0E0A\u0E48\u0E2D\u0E07 \u0E22\u0E31\u0E07\u0E44\u0E21\u0E48\u0E21\u0E35 API Key? \u0E43\u0E19\u0E41\u0E2D\u0E1B \u0E2B\u0E23\u0E37\u0E2D\u0E15\u0E31\u0E49\u0E07 GEMINI_API_KEY \u0E1A\u0E19 Vercel \u0E01\u0E47\u0E44\u0E14\u0E49"
      });
      return;
    }
    if (!imageBase64 || !prompt) {
      res.status(400).json({ error: "\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E44\u0E21\u0E48\u0E04\u0E23\u0E1A (\u0E15\u0E49\u0E2D\u0E07\u0E21\u0E35 imageBase64 \u0E41\u0E25\u0E30 prompt)" });
      return;
    }

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
                { inline_data: { mime_type: mediaType || "image/jpeg", data: imageBase64 } }
              ]
            }
          ]
        })
      }
    );

    const data = await geminiRes.json();
    if (!geminiRes.ok) {
      res.status(geminiRes.status).json({ error: data.error?.message || "Gemini API error", raw: data });
      return;
    }

    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    if (!text) {
      res.status(502).json({ error: "\u0E44\u0E21\u0E48\u0E44\u0E14\u0E49\u0E23\u0E31\u0E1A\u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E08\u0E32\u0E01 Gemini", raw: data });
      return;
    }

    res.status(200).json({ text });
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) });
  }
}
