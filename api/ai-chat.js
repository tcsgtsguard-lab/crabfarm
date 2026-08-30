// Vercel Serverless Function
// รับข้อความ (ไม่มีรูป) แล้วยิงไปที่ Google Gemini API เพื่อสรุปรายงาน/ตอบคำถามผู้ช่วยฟาร์ม
// ใช้ GEMINI_API_KEY (หรือ apiKeyOverride ที่ client ส่งมา) เหมือนกับ api/analyze-water.js

const GEMINI_MODEL = "gemini-3.6-flash";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const { message, apiKeyOverride } = req.body || {};
    const apiKey = apiKeyOverride || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      res.status(500).json({
        error: "\u0E22\u0E31\u0E07\u0E44\u0E21\u0E48\u0E44\u0E14\u0E49\u0E15\u0E31\u0E49\u0E07\u0E04\u0E48\u0E32 GEMINI_API_KEY \u0E1A\u0E19 Vercel \u0E41\u0E25\u0E30\u0E22\u0E31\u0E07\u0E44\u0E21\u0E48\u0E44\u0E14\u0E49\u0E43\u0E2A\u0E48 API Key \u0E2A\u0E48\u0E27\u0E19\u0E15\u0E31\u0E27\u0E43\u0E19\u0E41\u0E2D\u0E1B \u2014 \u0E2A\u0E21\u0E31\u0E04\u0E23 API key \u0E1F\u0E23\u0E35\u0E44\u0E14\u0E49\u0E17\u0E35\u0E48 https://aistudio.google.com/apikey"
      });
      return;
    }
    if (!message) {
      res.status(400).json({ error: "\u0E44\u0E21\u0E48\u0E21\u0E35\u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21" });
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
          contents: [{ parts: [{ text: message }] }]
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
