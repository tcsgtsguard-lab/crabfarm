// Vercel Serverless Function
// ค้นหาราคาปูตลาด (ราคาส่ง / ราคาปีก) อ้างอิงปัจจุบัน
//
// แบ่งเป็น 2 ส่วนแยกจากกัน:
//  1) Tavily Search API — ค้นเว็บหาข้อมูลราคาปูดิบๆ (ฟรี 1,000 ครั้ง/เดือน ไม่ต้องผูกบัตร)
//     สมัครฟรีที่ https://tavily.com แล้วตั้งค่า Environment Variable ชื่อ TAVILY_API_KEY บน Vercel
//  2) Google Gemini — อ่านผลค้นหาจาก Tavily แล้วสรุป/แปลงเป็นราคาที่มีโครงสร้าง (JSON)
//     ใช้ GEMINI_API_KEY ตัวเดียวกับฟีเจอร์วิเคราะห์น้ำ เป็น "การเรียก AI ทั่วไป" (ไม่ใช่ Search Grounding)
//     จึงอยู่ในโควตาฟรีปกติที่หน้าค่าน้ำใช้อยู่แล้ว ไม่กระทบ/ไม่ต้องแก้ฟีเจอร์วิเคราะห์น้ำแต่อย่างใด

const GEMINI_MODEL = "gemini-3.5-flash-lite";
const TAVILY_URL = "https://api.tavily.com/search";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const { locationName, tavilyApiKeyOverride, geminiApiKeyOverride } = req.body || {};

    const tavilyKey = tavilyApiKeyOverride || process.env.TAVILY_API_KEY;
    if (!tavilyKey) {
      res.status(500).json({
        error: "ยังไม่ได้ตั้งค่า Tavily API Key — สมัครฟรีได้ที่ https://tavily.com (ไม่ต้องผูกบัตร ได้ฟรี 1,000 ครั้ง/เดือน) แล้วใส่ในช่อง Tavily API Key ด้านล่าง หรือตั้ง TAVILY_API_KEY บน Vercel ก็ได้"
      });
      return;
    }
    const geminiKey = geminiApiKeyOverride || process.env.GEMINI_API_KEY;
    if (!geminiKey) {
      res.status(500).json({
        error: "ยังไม่ได้ตั้งค่า GEMINI_API_KEY บน Vercel และยังไม่ได้ใส่ API Key ส่วนตัวในแอป — สมัคร API key ฟรีได้ที่ https://aistudio.google.com/apikey แล้วใส่ในช่อง API Key (ในหน้าค่าน้ำ) หรือตั้ง GEMINI_API_KEY บน Vercel ก็ได้"
      });
      return;
    }

    // ---- ส่วนที่ 1: Tavily ค้นเว็บ ----
    const query = `ราคาปูทะเล ปูดำ ปูไข่ ตลาดวันนี้ ราคาส่ง ราคาปีก ${locationName || "ประเทศไทย"}`;
    const tavilyRes = await fetch(TAVILY_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tavilyKey}`
      },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        max_results: 6,
        include_answer: true,
        topic: "general"
      })
    });
    const tavilyData = await tavilyRes.json();
    if (!tavilyRes.ok) {
      const isQuota = tavilyRes.status === 429 || /quota|limit|credit/i.test(tavilyData?.detail?.error || tavilyData?.error || "");
      if (isQuota) {
        res.status(429).json({
          error: "โควตาการค้นหาฟรีของ Tavily เต็มแล้วสำหรับเดือนนี้ (1,000 ครั้ง/เดือน) — ราคาตลาดยังกรอกเองได้ตามปกติระหว่างรอเดือนถัดไป หรืออัปเกรดแผน Tavily ได้ที่ tavily.com",
          raw: tavilyData
        });
        return;
      }
      res.status(tavilyRes.status).json({ error: tavilyData?.detail?.error || tavilyData?.error || "Tavily API error", raw: tavilyData });
      return;
    }

    const results = Array.isArray(tavilyData.results) ? tavilyData.results : [];
    if (!results.length && !tavilyData.answer) {
      res.status(200).json({ results: [] });
      return;
    }
    const contextParts = [];
    if (tavilyData.answer) contextParts.push(`สรุปจากการค้นหา: ${tavilyData.answer}`);
    results.forEach((r, i) => {
      contextParts.push(`[แหล่งที่ ${i + 1}] ${r.title || ""}\n${(r.content || "").slice(0, 1200)}\n(อ้างอิง: ${r.url || ""})`);
    });
    const searchContext = contextParts.join("\n\n");

    // ---- ส่วนที่ 2: ให้ Gemini อ่านผลค้นหาแล้วแปลงเป็น JSON (เรียก AI แบบทั่วไป ไม่ใช่ Search Grounding) ----
    const prompt = `ต่อไปนี้คือผลการค้นเว็บล่าสุดเกี่ยวกับราคาปูทะเลในตลาดของประเทศไทย (พื้นที่ที่สนใจ: "${locationName || "ประเทศไทย"}")

${searchContext}

จากข้อมูลด้านบน ให้สกัดราคาปูทะเลที่ซื้อขายกันจริงออกมา แยกเป็น:
- ราคาส่ง (wholesalePrice) = ราคาขายส่งจากฟาร์ม/แพปูให้พ่อค้าคนกลางหรือตลาดขายส่ง หน่วยบาทต่อกิโลกรัม
- ราคาปีก (agentPrice) = ราคาที่ตัวแทน/พ่อค้าคนกลางขายต่อให้ร้านอาหารหรือลูกค้าปลีก หน่วยบาทต่อกิโลกรัม
แยกตามประเภท: ตัวผู้ (male), ตัวเมีย (female), ปูไข่ (eggs) และไซส์ถ้ามีข้อมูล (เช่น "3-4 ตัว/กก.")

ตอบกลับเป็น JSON array เท่านั้น ห้ามมีข้อความอื่นนอกเหนือจาก JSON ห้ามใส่ markdown code fence
รูปแบบแต่ละรายการ:
{"category":"male|female|eggs","sizeLabel":"string หรือ null","wholesalePrice":number หรือ null,"agentPrice":number หรือ null,"marketName":"ชื่อตลาดหรือแหล่งอ้างอิง","note":"string สั้นๆ อธิบายแหล่งที่มาหรือวันที่ของราคา"}
ให้เฉพาะรายการที่มีตัวเลขราคาจริงจากข้อมูลด้านบนเท่านั้น ห้ามเดาหรือกุตัวเลขขึ้นเอง ถ้าไม่มีราคาที่ชัดเจนในข้อมูลด้านบนเลย ให้ตอบ [] (array ว่าง) อย่างน้อย 0 และไม่เกิน 6 รายการ`;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": geminiKey
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1 }
        })
      }
    );

    const geminiData = await geminiRes.json();
    if (!geminiRes.ok) {
      const rawMsg = geminiData.error?.message || "";
      const isQuota = geminiRes.status === 429 || /quota|rate limit/i.test(rawMsg);
      if (isQuota) {
        res.status(429).json({
          error: "โควตา Gemini แบบฟรีเต็มแล้ว (จุดนี้เป็นการเรียก AI ทั่วไป ใช้โควตาเดียวกับหน้าค่าน้ำ) — รอสักครู่แล้วลองใหม่ หรือเช็คโควตาได้ที่ https://aistudio.google.com/apikey",
          raw: geminiData
        });
        return;
      }
      res.status(geminiRes.status).json({ error: rawMsg || "Gemini API error", raw: geminiData });
      return;
    }

    const text = geminiData?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    if (!text) {
      res.status(502).json({ error: "ไม่ได้รับข้อความจาก Gemini", raw: geminiData });
      return;
    }

    const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const match = cleaned.match(/\[[\s\S]*\]/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch {
          parsed = null;
        }
      }
    }
    if (!Array.isArray(parsed)) {
      res.status(502).json({ error: "แปลงผลลัพธ์จาก AI เป็นรายการราคาไม่สำเร็จ ลองใหม่อีกครั้ง", raw: text });
      return;
    }

    const validCategories = new Set(["male", "female", "eggs"]);
    const cleanedResults = parsed
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
