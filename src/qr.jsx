import React, { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import jsQR from "jsqr";

// This file is intentionally self-contained (it doesn't import from
// App.jsx) so there's no circular dependency between the two files — it
// keeps its own small copies of the color palette / fonts and the two
// tiny UI primitives (Btn, Modal) it needs, matching App.jsx's values.
const C = {
  ink: "#0B2333",
  card: "#FFFFFF",
  line: "#D7E0D8",
  text: "#0F241E",
  muted: "#5B7268",
  coral: "#E2603A",
  seagrass: "#2E7D58"
};
const BODY = "'IBM Plex Sans', 'Segoe UI', sans-serif";
const MONO = "'IBM Plex Mono', 'SFMono-Regular', Consolas, monospace";
const inputStyle = {
  width: "100%",
  padding: "9px 11px",
  borderRadius: 8,
  border: `1px solid ${C.line}`,
  fontSize: 14,
  fontFamily: BODY,
  color: C.text,
  background: "#FBFCFA",
  boxSizing: "border-box"
};

function Btn({ children, onClick, tone = "ink", size = "md", disabled }) {
  const tones = {
    ink: { bg: C.ink, fg: "#fff" },
    coral: { bg: C.coral, fg: "#fff" },
    seagrass: { bg: C.seagrass, fg: "#fff" },
    ghost: { bg: "transparent", fg: C.ink, border: `1px solid ${C.line}` }
  };
  const t = tones[tone] || tones.ink;
  const pad = size === "sm" ? "6px 12px" : "10px 16px";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        background: t.bg,
        color: t.fg,
        border: t.border || "none",
        padding: pad,
        borderRadius: 8,
        fontSize: size === "sm" ? 12.5 : 14,
        fontWeight: 700,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        fontFamily: BODY,
        whiteSpace: "nowrap"
      }}
    >
      {children}
    </button>
  );
}

function Modal({ title, onClose, children, wide }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(11,35,51,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
        padding: 16
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.card,
          borderRadius: 14,
          padding: 22,
          width: wide ? 480 : 380,
          maxWidth: "94vw",
          maxHeight: "90vh",
          overflowY: "auto",
          boxShadow: "0 20px 60px rgba(11,35,51,0.35)"
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div style={{ fontFamily: BODY, fontWeight: 700, fontSize: 16, color: C.ink }}>{title}</div>
          <button
            onClick={onClose}
            style={{ background: "transparent", border: "none", fontSize: 18, cursor: "pointer", color: C.muted, lineHeight: 1 }}
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// QR codes just encode the plain box number (e.g. "A01"). Keeping it to the
// bare code — instead of a URL — means scanning works the same no matter
// what domain the app ends up deployed at, and stickers never go stale if
// the site moves.
function normalizeCode(v) {
  return String(v || "").trim().toUpperCase();
}

function findBoxByCode(boxes, code) {
  const target = normalizeCode(code);
  if (!target) return null;
  return (boxes || []).find((b) => normalizeCode(b.boxNumber) === target) || null;
}

export function IconQr({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <path d="M14 14h3v3h-3z" />
      <path d="M20 14v3" />
      <path d="M14 20h3" />
      <path d="M20 20v.01" />
    </svg>
  );
}

// ===================== STICKER PRINTING =====================

function boxSexLabel(box) {
  return box.sex === "female" ? "♀ ตัวเมีย" : "♂ ตัวผู้";
}

export function StickerPrintModal({ boxes, onClose, onPrint }) {
  const [query, setQuery] = useState("");
  const [checked, setChecked] = useState(() => new Set((boxes || []).map((b) => b.id)));
  const [busy, setBusy] = useState(false);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return boxes || [];
    return (boxes || []).filter((b) => String(b.boxNumber).toLowerCase().includes(q));
  }, [boxes, query]);

  const toggle = (id) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const selectAll = () => setChecked(new Set((boxes || []).map((b) => b.id)));
  const selectNone = () => setChecked(new Set());

  const selectedCount = checked.size;

  const handlePrint = async () => {
    const selected = (boxes || []).filter((b) => checked.has(b.id));
    if (!selected.length) return;
    setBusy(true);
    try {
      const withQr = await Promise.all(
        selected.map(async (b) => ({
          ...b,
          qrDataUrl: await QRCode.toDataURL(normalizeCode(b.boxNumber), {
            margin: 1,
            width: 300,
            color: { dark: "#0B2333", light: "#FFFFFF" }
          })
        }))
      );
      onPrint(withQr);
    } catch (e) {
      console.error("crabfarm: QR generation failed", e);
      alert("สร้าง QR ไม่สำเร็จ ลองใหม่อีกครั้ง");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`พิมพ์สติกเกอร์ QR (เลือกแล้ว ${selectedCount} กล่อง)`} onClose={onClose} wide>
      <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input
          style={{ ...inputStyle, width: 200 }}
          placeholder="ค้นหาเบอร์กล่อง…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Btn tone="ghost" size="sm" onClick={selectAll}>เลือกทั้งหมด</Btn>
        <Btn tone="ghost" size="sm" onClick={selectNone}>ยกเลิกทั้งหมด</Btn>
      </div>
      <div
        style={{
          border: `1px solid ${C.line}`,
          borderRadius: 10,
          maxHeight: 320,
          overflowY: "auto",
          padding: 6
        }}
      >
        {visible.length === 0 && (
          <div style={{ fontSize: 12.5, color: C.muted, padding: 10 }}>ไม่พบกล่องตามคำค้นหา</div>
        )}
        {visible.map((b) => (
          <label
            key={b.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 10px",
              borderRadius: 8,
              cursor: "pointer",
              fontSize: 13.5
            }}
          >
            <input type="checkbox" checked={checked.has(b.id)} onChange={() => toggle(b.id)} />
            <span style={{ fontFamily: MONO, fontWeight: 700, color: C.ink }}>#{b.boxNumber}</span>
            <span style={{ color: C.muted }}>รุ่นที่ {b.batchNumber} · {boxSexLabel(b)}</span>
          </label>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        <Btn tone="ghost" onClick={onClose}>ยกเลิก</Btn>
        <Btn tone="seagrass" disabled={busy || selectedCount === 0} onClick={handlePrint}>
          {busy ? "กำลังสร้าง QR…" : `พิมพ์ (${selectedCount} กล่อง)`}
        </Btn>
      </div>
    </Modal>
  );
}

// Renders as a sibling of the main app shell (not inside it), so a
// print-only CSS rule can hide the whole app shell and show just this
// during printing without affecting normal on-screen use.
export function PrintStickersArea({ job, onDone }) {
  useEffect(() => {
    if (!job || !job.length) return;
    const handleAfterPrint = () => onDone && onDone();
    window.addEventListener("afterprint", handleAfterPrint);
    // Give the browser a tick to paint the print area before opening the
    // print dialog.
    const t = setTimeout(() => window.print(), 80);
    return () => {
      clearTimeout(t);
      window.removeEventListener("afterprint", handleAfterPrint);
    };
  }, [job, onDone]);

  if (!job || !job.length) return null;

  // Fixed 2in x 2in stickers (QR + box code only), packed edge-to-edge in a
  // grid so both a single sticker and a full batch print with minimal
  // wasted paper. Works the same whether job.length is 1 or many.
  return (
    <div id="crabfarm-print-area">
      <style>{`
        @media screen {
          #crabfarm-print-area { display: none; }
        }
        @media print {
          #crabfarm-app-shell { display: none !important; }
          #crabfarm-print-area { display: block !important; }
          @page { size: A4; margin: 4mm; }
        }
      `}</style>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, 2in)",
          gap: "1mm",
          justifyContent: "start",
          fontFamily: BODY
        }}
      >
        {job.map((b) => (
          <div
            key={b.id}
            style={{
              width: "2in",
              height: "2in",
              boxSizing: "border-box",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              border: "1px dashed #999",
              padding: "0.08in",
              breakInside: "avoid",
              pageBreakInside: "avoid"
            }}
          >
            <img src={b.qrDataUrl} alt={b.boxNumber} style={{ width: "1.5in", height: "1.5in" }} />
            <div
              style={{
                fontFamily: MONO,
                fontWeight: 700,
                fontSize: "15pt",
                color: "#0B2333",
                lineHeight: 1.1,
                marginTop: "0.05in"
              }}
            >
              #{b.boxNumber}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ===================== QR SCANNING =====================

export function QRScanModal({ boxes, onFound, onClose }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const foundRef = useRef(false);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  const [manualCode, setManualCode] = useState("");
  const flashTimerRef = useRef(null);

  const stopCamera = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          setError("อุปกรณ์นี้หรือเบราว์เซอร์นี้ไม่รองรับการเปิดกล้อง — พิมพ์เบอร์กล่องด้านล่างแทนได้");
          return;
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } }
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        const tick = () => {
          if (foundRef.current || !videoRef.current) return;
          if (video.readyState === video.HAVE_ENOUGH_DATA) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const result = jsQR(imageData.data, canvas.width, canvas.height, { inversionAttempts: "dontInvert" });
            if (result && result.data) {
              const box = findBoxByCode(boxes, result.data);
              if (box) {
                foundRef.current = true;
                stopCamera();
                onFound(box);
                return;
              } else if (!flashTimerRef.current) {
                setFlash(`ไม่พบกล่อง "${normalizeCode(result.data)}" ในระบบ`);
                flashTimerRef.current = setTimeout(() => {
                  setFlash("");
                  flashTimerRef.current = null;
                }, 1500);
              }
            }
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch (e) {
        console.error("crabfarm: camera error", e);
        setError("ไม่สามารถเข้าถึงกล้องได้ — กรุณาอนุญาตการใช้กล้อง หรือพิมพ์เบอร์กล่องด้านล่างแทน");
      }
    })();
    return () => {
      cancelled = true;
      stopCamera();
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitManual = () => {
    const box = findBoxByCode(boxes, manualCode);
    if (box) {
      foundRef.current = true;
      stopCamera();
      onFound(box);
    } else {
      setFlash(`ไม่พบกล่อง "${normalizeCode(manualCode)}" ในระบบ`);
    }
  };

  return (
    <Modal title="สแกน QR เพื่อเช็คกล่อง" onClose={onClose}>
      {!error && (
        <div
          style={{
            position: "relative",
            width: "100%",
            aspectRatio: "1 / 1",
            background: "#000",
            borderRadius: 10,
            overflow: "hidden",
            marginBottom: 12
          }}
        >
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video ref={videoRef} playsInline muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          <canvas ref={canvasRef} style={{ display: "none" }} />
        </div>
      )}
      {error && (
        <div style={{ fontSize: 13, color: C.coral, marginBottom: 12, lineHeight: 1.5 }}>{error}</div>
      )}
      {flash && (
        <div style={{ fontSize: 12.5, color: C.coral, marginBottom: 10 }}>{flash}</div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <input
          style={{ ...inputStyle, flex: 1 }}
          placeholder="หรือพิมพ์เบอร์กล่อง เช่น A01"
          value={manualCode}
          onChange={(e) => setManualCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitManual();
          }}
        />
        <Btn tone="seagrass" onClick={submitManual}>ค้นหา</Btn>
      </div>
    </Modal>
  );
}
