// Vercel Serverless Function
// ค้นหาราคาปูตลาด (ราคาส่ง / ราคาปีก) อ้างอิงปัจจุบันด้วย Google Gemini + Google Search grounding
// ใช้ GEMINI_API_KEY เดียวกับฟีเจอร์วิเคราะห์น้ำ (ฝั่งเซิร์ฟเวอร์ หรือ apiKeyOverride จากฝั่ง client)
//
// สมัคร API key ฟรีได้ที่ https://aistudio.google.com/apikey (ไม่ต้องผูกบัตรเครดิต)

const GEMINI_MODEL = "gemini-3.5-flash";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const { locationName, apiKeyOverride } = req.body || {};
    const apiKey = apiKeyOverride || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      res.status(500).json({
        error: "ยังไม่ได้ตั้งค่า GEMINI_API_KEY บน Vercel และยังไม่ได้ใส่ API Key ส่วนตัวในแอป — สมัคร API key ฟรีได้ที่ https://aistudio.google.com/apikey แล้วใส่ในช่อง API Key (ในหน้าค่าน้ำ) หรือตั้ง GEMINI_API_KEY บน Vercel ก็ได้"
      });
      return;
    }

    const prompt = `คุณเป็นผู้ช่วยค้นหาราคาปูทะเล (ปูดำ/ปูไข่) ในตลาดปัจจุบันของประเทศไทย โดยเน้นพื้นที่ใกล้เคียง "${locationName || "ประเทศไทย"}" ถ้าหาราคาเฉพาะพื้นที่ไม่ได้ ให้ใช้ราคาตลาดรวมทั่วประเทศแทน
ใช้การค้นหาเว็บล่าสุดเพื่อหาราคาปูทะเลที่ซื้อขายกันจริงในตอนนี้ แยกเป็น:
- ราคาส่ง (wholesalePrice) = ราคาขายส่งจากฟาร์ม/แพปูให้พ่อค้าคนกลางหรือตลาดขายส่ง หน่วยบาทต่อกิโลกรัม
- ราคาปีก (agentPrice) = ราคาที่ตัวแทน/พ่อค้าคนกลางขายต่อให้ร้านอาหารหรือลูกค้าปลีก หน่วยบาทต่อกิโลกรัม
แยกตามประเภท: ตัวผู้ (male), ตัวเมีย (female), ปูไข่ (eggs) และไซส์ถ้ามีข้อมูล (เช่น "3-4 ตัว/กก.")

ตอบกลับเป็น JSON array เท่านั้น ห้ามมีข้อความอื่นนอกเหนือจาก JSON ห้ามใส่ markdown code fence
รูปแบบแต่ละรายการ:
{"category":"male|female|eggs","sizeLabel":"string หรือ null","wholesalePrice":number หรือ null,"agentPrice":number หรือ null,"marketName":"ชื่อตลาดหรือแหล่งอ้างอิง","note":"string สั้นๆ อธิบายแหล่งที่มาหรือวันที่ของราคา"}
ให้ได้อย่างน้อย 1 รายการและไม่เกิน 6 รายการ เรียงตามความเกี่ยวข้อง ถ้าไม่พบราคาที่น่าเชื่อถือจริงๆ ให้ตอบ [] (array ว่าง)`;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }],
          generationConfig: { temperature: 0.2 }
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
      res.status(502).json({ error: "ไม่ได้รับข้อความจาก Gemini", raw: data });
      return;
    }

    // ทำความสะอาดข้อความก่อน parse — บางครั้งโมเดลอาจใส่ ```json ... ``` มาแม้จะสั่งห้ามแล้ว
    const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    let results;
    try {
      results = JSON.parse(cleaned);
    } catch {
      const match = cleaned.match(/\[[\s\S]*\]/);
      if (match) {
        try {
          results = JSON.parse(match[0]);
        } catch {
          results = null;
        }
      }
    }
    if (!Array.isArray(results)) {
      res.status(502).json({ error: "แปลงผลลัพธ์จาก AI เป็นรายการราคาไม่สำเร็จ ลองใหม่อีกครั้ง", raw: text });
      return;
    }

    const validCategories = new Set(["male", "female", "eggs"]);
    const cleanedResults = results
      .filter((r) => r && typeof r === "object")
      .map((r) => ({
        category: validCategories.has(r.category) ? r.category : "male",
        sizeLabel: typeof r.sizeLabel === "string" ? r.sizeLabel : "",
        wholesalePrice: typeof r.wholesalePrice === "number" && isFinite(r.wholesalePrice) ? r.wholesalePrice : null,
        agentPrice: typeof r.agentPrice === "number" && isFinite(r.agentPrice) ? r.agentPrice : null,
        marketName: typeof r.marketName === "string" ? r.marketName : "",
        note: typeof r.note === "string" ? r.note : ""
      }))
      .filter((r) => r.wholesalePrice != null || r.agentPrice != null)
      .slice(0, 6);

    res.status(200).json({ results: cleanedResults });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}
