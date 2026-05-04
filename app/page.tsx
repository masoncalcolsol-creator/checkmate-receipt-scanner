"use client";

import React, { useMemo, useRef, useState } from "react";
import Tesseract from "tesseract.js";

type Person = { id: string; name: string; phone?: string };

type ReceiptItem = {
  id: string;
  raw: string;
  code?: string;
  description: string;
  amount: number;
  assignedTo: string[];
  confidence?: "high" | "medium" | "low";
};

type PreprocessMode = {
  grayscale: boolean;
  contrast: number;
  threshold: boolean;
  thresholdValue: number;
  upscale: number;
};

type SharePackage = {
  htmlUrl: string;
  textUrl: string;
  summaryText: string;
};

const uid = () => Math.random().toString(36).slice(2, 10);
const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

const defaultPreprocess: PreprocessMode = {
  grayscale: true,
  contrast: 1.8,
  threshold: true,
  thresholdValue: 150,
  upscale: 1.8,
};

function normalizeOcrText(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[€£]/g, "$")
    .replace(/[|]/g, " ")
    .replace(/[^\S\r\n]+/g, " ");
}

function normalizeLine(line: string): string {
  return line
    .replace(/\s+/g, " ")
    .replace(/\$?\s*(\d+)\s*[,.]\s*(\d{2})\b/g, "$$$1.$2")
    .replace(/\bOFFER\b/gi, "Offer")
    .replace(/\bd[il1]sc\b/gi, "disc")
    .replace(/\bTota[1lI]\b/gi, "Total")
    .replace(/\bPay(?:ment|rnent)?\b/gi, "Payment")
    .replace(/\bTerrnine\]?\b/gi, "Terminal")
    .trim();
}

function isReceiptControlLine(line: string): boolean {
  return /\b(total|subtotal|tax|cash|change|balance|debit|credit|visa|mastercard|amex|discover|auth|approval|tender|terminal|rounding|payment|receipt|store|cashier|date|time|thank|saved|rewards)\b/i.test(
    line
  );
}

function isDiscountLine(line: string): boolean {
  const l = line.toLowerCase();
  return (
    /\boffer\b/.test(l) ||
    /\bdisc\b/.test(l) ||
    /\bdiscount\b/.test(l) ||
    /\bcoupon\b/.test(l) ||
    /\bpromo\b/.test(l)
  );
}

function isNonItemLine(line: string): boolean {
  return isReceiptControlLine(line) || isDiscountLine(line);
}

function extractFinalPrice(line: string): { amount: number; index: number } | null {
  const matches = [...line.matchAll(/\$?\(?\d{1,4}[,.]\d{2}\)?/g)];
  if (!matches.length) return null;

  const last = matches[matches.length - 1];
  if (last.index === undefined) return null;

  const raw = last[0].replace(/[^\d.,]/g, "").replace(",", ".");
  let amount = Number(raw);

  if (!Number.isFinite(amount)) return null;

  if (amount >= 30 && amount < 100 && /^[3456789]\d\.\d{2}$/.test(raw)) {
    amount = Number(raw.slice(1));
  }

  if (amount <= 0 || amount > 999) return null;

  return { amount, index: last.index };
}

function extractReceiptTotal(text: string): number | null {
  const lines = normalizeOcrText(text)
    .split(/\r?\n/)
    .map(normalizeLine)
    .filter(Boolean);

  for (const line of lines) {
    if (!/\btotal\b/i.test(line)) continue;
    if (/subtotal|payment|terminal|tender|cash|rounding|balance|change/i.test(line)) continue;

    const price = extractFinalPrice(line);
    if (price) return price.amount;
  }

  return null;
}

function cleanDescription(left: string): { code?: string; description: string } {
  let s = left
    .replace(/^[^a-zA-Z0-9]+/, "")
    .replace(/[_=~`^]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  let code: string | undefined;

  const codeMatch = s.match(/^([A-Z0-9¢©%]{6,24})\s+(.+)$/i);
  if (codeMatch) {
    code = codeMatch[1].replace(/[^A-Z0-9]/gi, "");
    s = codeMatch[2].trim();
  }

  s = s
    .replace(/^[^a-zA-Z]+/, "")
    .replace(/[^a-zA-Z0-9 '&/.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return { code, description: s };
}

function removeExactDuplicateRawLines(items: ReceiptItem[]): ReceiptItem[] {
  const exactRaw = new Set<string>();
  const out: ReceiptItem[] = [];

  for (const item of items) {
    const key = item.raw.toLowerCase().replace(/\s+/g, " ").trim();
    if (exactRaw.has(key)) continue;
    exactRaw.add(key);
    out.push(item);
  }

  return out;
}

function parseReceiptLines(text: string): ReceiptItem[] {
  const lines = normalizeOcrText(text)
    .split(/\r?\n/)
    .map(normalizeLine)
    .filter(Boolean);

  const parsed: ReceiptItem[] = [];

  for (const line of lines) {
    if (isNonItemLine(line)) continue;

    const price = extractFinalPrice(line);
    if (!price) continue;

    const left = line.slice(0, price.index).trim();
    if (left.length < 2) continue;

    const { code, description } = cleanDescription(left);

    if (description.length < 2) continue;
    if (isNonItemLine(description)) continue;

    parsed.push({
      id: uid(),
      raw: line,
      code,
      description,
      amount: price.amount,
      assignedTo: [],
      confidence: price.amount < 100 && description.length > 3 ? "high" : "medium",
    });
  }

  return removeExactDuplicateRawLines(parsed);
}

function duplicateLabel(item: ReceiptItem, allItems: ReceiptItem[]): string {
  const key = `${item.description.toLowerCase().replace(/[^a-z0-9]/g, "")}-${item.amount.toFixed(2)}`;
  const matches = allItems.filter(
    (i) =>
      `${i.description.toLowerCase().replace(/[^a-z0-9]/g, "")}-${i.amount.toFixed(2)}` === key
  );

  if (matches.length <= 1) return "";
  return ` #${matches.findIndex((i) => i.id === item.id) + 1}`;
}

async function imageFileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read image file."));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

async function preprocessImage(dataUrl: string, settings: PreprocessMode): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load image."));
    image.src = dataUrl;
  });

  const maxWidth = 1800;
  const baseScale = Math.min(1, maxWidth / img.width);
  const finalScale = Math.max(1, settings.upscale * baseScale);

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * finalScale);
  canvas.height = Math.round(img.height * finalScale);

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas not supported.");

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  const contrast = settings.contrast;
  const factor = (259 * (contrast * 255 + 255)) / (255 * (259 - contrast * 255));

  for (let i = 0; i < data.length; i += 4) {
    let gray = settings.grayscale
      ? 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
      : (data[i] + data[i + 1] + data[i + 2]) / 3;

    gray = factor * (gray - 128) + 128;
    gray = Math.max(0, Math.min(255, gray));

    if (settings.threshold) gray = gray > settings.thresholdValue ? 255 : 0;

    data[i] = gray;
    data[i + 1] = gray;
    data[i + 2] = gray;
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export default function Page() {
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const uploadRef = useRef<HTMLInputElement | null>(null);

  const [people, setPeople] = useState<Person[]>([
    { id: uid(), name: "You" },
    { id: uid(), name: "Brian" },
  ]);

  const [items, setItems] = useState<ReceiptItem[]>([]);
  const [selectedPersonId, setSelectedPersonId] = useState("");
  const [expandedPersonId, setExpandedPersonId] = useState("");
  const [daddyPersonId, setDaddyPersonId] = useState("");
  const [receiptTotal, setReceiptTotal] = useState<number | null>(null);
  const [showAddPerson, setShowAddPerson] = useState(false);
  const [sharePackage, setSharePackage] = useState<SharePackage | null>(null);

  const [smsSentPersonIds, setSmsSentPersonIds] = useState<string[]>([]);
  const [paidPersonIds, setPaidPersonIds] = useState<string[]>([]);

  const [rawImage, setRawImage] = useState("");
  const [processedImage, setProcessedImage] = useState("");
  const [ocrText, setOcrText] = useState("");
  const [cleanedText, setCleanedText] = useState("");
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrProgress, setOcrProgress] = useState("");

  const [newPerson, setNewPerson] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [manualDesc, setManualDesc] = useState("");
  const [manualAmount, setManualAmount] = useState("");
  const [tax, setTax] = useState("0");
  const [tip, setTip] = useState("0");
  const [preprocess, setPreprocess] = useState<PreprocessMode>(defaultPreprocess);

  const totals = useMemo(() => {
    const itemScanTotal = items.reduce((sum, item) => sum + item.amount, 0);
    const tipNum = Number(tip) || 0;
    const manualTaxNum = Number(tax) || 0;
    const billBase = receiptTotal ?? itemScanTotal + manualTaxNum;
    const splitTotal = billBase + tipNum;
    const unassignedCount = items.filter((i) => i.assignedTo.length === 0).length;
    const needsReview = receiptTotal === null || items.length === 0 || unassignedCount > 0;

    const personTotals = people.map((person) => {
      const isPaid = paidPersonIds.includes(person.id);
      const isSmsSent = smsSentPersonIds.includes(person.id);

      if (daddyPersonId === person.id) {
        return {
          ...person,
          total: splitTotal,
          smsSent: isSmsSent,
          paid: isPaid,
        };
      }

      if (daddyPersonId && daddyPersonId !== person.id) {
        return { ...person, total: 0, smsSent: isSmsSent, paid: isPaid };
      }

      let stickerShare = 0;
      for (const item of items) {
        if (item.assignedTo.includes(person.id)) {
          stickerShare += item.amount / item.assignedTo.length;
        }
      }

      const ratio = itemScanTotal > 0 ? stickerShare / itemScanTotal : 0;
      const total = billBase * ratio + tipNum * ratio;

      return {
        ...person,
        total,
        smsSent: isSmsSent,
        paid: isPaid,
      };
    });

    return {
      itemScanTotal,
      splitTotal,
      needsReview,
      unassignedCount,
      personTotals,
    };
  }, [
    items,
    people,
    tax,
    tip,
    receiptTotal,
    daddyPersonId,
    smsSentPersonIds,
    paidPersonIds,
  ]);

  function setPersonSmsSent(personId: string, sent: boolean) {
    setSmsSentPersonIds((prev) =>
      sent ? Array.from(new Set([...prev, personId])) : prev.filter((id) => id !== personId)
    );
    setSharePackage(null);
  }

  function setPersonPaid(personId: string, paid: boolean) {
    setPaidPersonIds((prev) =>
      paid ? Array.from(new Set([...prev, personId])) : prev.filter((id) => id !== personId)
    );
    setSharePackage(null);
  }

  function updatePersonPhone(personId: string, phone: string) {
    setPeople((prev) => prev.map((p) => (p.id === personId ? { ...p, phone } : p)));
    setSharePackage(null);
  }

  function makeShareText() {
    const lines: string[] = [];
    lines.push("CHECKMATE ITEMIZED SPLIT");
    lines.push("========================");
    lines.push(`Bill Total: ${money(totals.splitTotal)}`);
    lines.push("");
    lines.push("WHO OWES WHAT");
    lines.push("-------------");

    for (const p of totals.personTotals) {
      if (p.total > 0) {
        lines.push(
          `${p.name}: ${money(p.total)} (${p.paid ? "PAID" : p.smsSent ? "SMS SENT / PENDING" : "NOT SENT"})`
        );
      }
    }

    lines.push("");
    lines.push("ITEM BREAKOUT");
    lines.push("-------------");

    for (const item of items) {
      const owners = item.assignedTo
        .map((id) => people.find((p) => p.id === id)?.name)
        .filter(Boolean)
        .join(", ");

      lines.push(
        `${item.description}${duplicateLabel(item, items)} — ${money(item.amount)} — ${
          owners || "UNASSIGNED"
        }`
      );
    }

    lines.push("");
    lines.push("Generated by CHECKMATE MVP.");
    return lines.join("\n");
  }

  function makeShareHtml(summaryText: string) {
    const rows = items
      .map((item) => {
        const owners = item.assignedTo
          .map((id) => people.find((p) => p.id === id)?.name)
          .filter(Boolean)
          .join(", ");

        return `<tr>
          <td>${escapeHtml(item.description + duplicateLabel(item, items))}</td>
          <td>${escapeHtml(money(item.amount))}</td>
          <td>${escapeHtml(owners || "UNASSIGNED")}</td>
        </tr>`;
      })
      .join("");

    const totalsRows = totals.personTotals
      .filter((p) => p.total > 0)
      .map(
        (p) =>
          `<li><strong>${escapeHtml(p.name)}</strong>: ${escapeHtml(money(p.total))} — ${
            p.paid ? "PAID" : p.smsSent ? "SMS SENT / PENDING" : "NOT SENT"
          }</li>`
      )
      .join("");

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>CHECKMATE Receipt Split</title>
<style>
body{font-family:Arial,sans-serif;background:#111;color:#f4f4f5;padding:24px}
.wrap{max-width:900px;margin:auto}
.card{background:#18181b;border:1px solid #3f3f46;border-radius:18px;padding:18px;margin:14px 0}
.total{font-size:34px;font-weight:900;color:#fca5a5}
img{max-width:100%;border-radius:14px;border:1px solid #3f3f46;background:#000}
table{width:100%;border-collapse:collapse}
td,th{border-bottom:1px solid #3f3f46;padding:10px;text-align:left}
pre{white-space:pre-wrap;background:#09090b;padding:14px;border-radius:14px;overflow:auto}
</style>
</head>
<body>
<div class="wrap">
<p style="letter-spacing:.25em;color:#f87171;">NULLWORKS // CHECKMATE</p>
<h1>Receipt Split Report</h1>
<div class="card"><p>Bill Total</p><div class="total">${escapeHtml(money(totals.splitTotal))}</div></div>
<div class="card"><h2>Who Owes What</h2><ul>${totalsRows}</ul></div>
<div class="card"><h2>Itemized Breakout</h2><table><thead><tr><th>Item</th><th>Price</th><th>Assigned To</th></tr></thead><tbody>${rows}</tbody></table></div>
<div class="card"><h2>Receipt Photo</h2>${rawImage ? `<img src="${rawImage}" alt="Receipt photo" />` : "<p>No receipt photo attached.</p>"}</div>
<div class="card"><h2>Plain Text Copy</h2><pre>${escapeHtml(summaryText)}</pre></div>
</div>
</body>
</html>`;
  }

  function generateSharePackage() {
    if (sharePackage) {
      URL.revokeObjectURL(sharePackage.htmlUrl);
      URL.revokeObjectURL(sharePackage.textUrl);
    }

    const summaryText = makeShareText();
    const html = makeShareHtml(summaryText);

    const htmlUrl = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    const textUrl = URL.createObjectURL(
      new Blob([summaryText], { type: "text/plain;charset=utf-8" })
    );

    setSharePackage({ htmlUrl, textUrl, summaryText });
  }

  async function runOcr(file: File) {
    setOcrBusy(true);
    setOcrProgress("Loading image...");
    setOcrText("");
    setCleanedText("");
    setItems([]);
    setReceiptTotal(null);
    setDaddyPersonId("");
    setSharePackage(null);
    setSmsSentPersonIds([]);
    setPaidPersonIds([]);

    try {
      const raw = await imageFileToDataUrl(file);
      setRawImage(raw);

      setOcrProgress("Preprocessing receipt image...");
      const processed = await preprocessImage(raw, preprocess);
      setProcessedImage(processed);

      setOcrProgress("Running OCR on processed image...");
      const result = await Tesseract.recognize(processed, "eng", {
        logger: (m) => {
          if (m.status) {
            const pct =
              typeof m.progress === "number" ? ` ${Math.round(m.progress * 100)}%` : "";
            setOcrProgress(`${m.status}${pct}`);
          }
        },
      });

      const rawText = result.data.text || "";
      const normalized = normalizeOcrText(rawText)
        .split(/\r?\n/)
        .map(normalizeLine)
        .filter(Boolean)
        .join("\n");

      const parsed = parseReceiptLines(rawText);
      const foundTotal = extractReceiptTotal(rawText);

      setOcrText(rawText);
      setCleanedText(normalized);
      setItems(parsed);
      setReceiptTotal(foundTotal);

      setOcrProgress(
        `Done. Parsed ${parsed.length} item(s). Bill total: ${
          foundTotal === null ? "needs manual review" : money(foundTotal)
        }.`
      );
    } catch (err) {
      setOcrProgress(err instanceof Error ? err.message : "OCR failed.");
    } finally {
      setOcrBusy(false);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) runOcr(file);
    e.target.value = "";
  }

  function reparseCleanedText() {
    const source = cleanedText || ocrText;
    const parsed = parseReceiptLines(source);
    const foundTotal = extractReceiptTotal(source);
    setItems(parsed);
    setReceiptTotal(foundTotal);
    setDaddyPersonId("");
    setSharePackage(null);
    setSmsSentPersonIds([]);
    setPaidPersonIds([]);
    setOcrProgress(
      `Re-parsed ${parsed.length} item(s). Bill total: ${
        foundTotal === null ? "needs manual review" : money(foundTotal)
      }.`
    );
  }

  function addPerson() {
    if (!newPerson.trim()) return;
    const newId = uid();
    setPeople((p) => [...p, { id: newId, name: newPerson.trim(), phone: newPhone.trim() }]);
    setNewPerson("");
    setNewPhone("");
    setShowAddPerson(false);
    setExpandedPersonId(newId);
    setSharePackage(null);
  }

  function addManualItem() {
    const amount = Number(manualAmount);
    if (!manualDesc.trim() || !Number.isFinite(amount)) return;

    setItems((prev) => [
      ...prev,
      {
        id: uid(),
        raw: `${manualDesc} ${amount.toFixed(2)}`,
        description: manualDesc.trim(),
        amount,
        assignedTo: selectedPersonId ? [selectedPersonId] : [],
        confidence: "high",
      },
    ]);

    setManualDesc("");
    setManualAmount("");
    setSharePackage(null);
  }

  function updateItem(id: string, patch: Partial<ReceiptItem>) {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
    setSharePackage(null);
  }

  function deleteItem(id: string) {
    setItems((prev) => prev.filter((i) => i.id !== id));
    setSharePackage(null);
  }

  function assignItem(id: string, personId: string) {
    setDaddyPersonId("");
    setSharePackage(null);
    setItems((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;
        const exists = item.assignedTo.includes(personId);
        return {
          ...item,
          assignedTo: exists
            ? item.assignedTo.filter((p) => p !== personId)
            : [...item.assignedTo, personId],
        };
      })
    );
  }

  function splitItem(id: string) {
    setDaddyPersonId("");
    setSharePackage(null);
    setItems((prev) =>
      prev.map((item) =>
        item.id === id ? { ...item, assignedTo: people.map((p) => p.id) } : item
      )
    );
  }

  function splitAllEvenly() {
    setDaddyPersonId("");
    setSharePackage(null);
    setItems((prev) => prev.map((item) => ({ ...item, assignedTo: people.map((p) => p.id) })));
  }

  function daddyMode(personId: string) {
    setDaddyPersonId(personId);
    setSharePackage(null);
    setItems((prev) => prev.map((item) => ({ ...item, assignedTo: [personId] })));
  }

  function smsLink(person: Person, total: number) {
    const reviewLine = sharePackage
      ? `\nReview receipt + itemized split: ${sharePackage.htmlUrl}`
      : "\nGenerate the CHECKMATE share report first for receipt/photo backup.";

    const body = encodeURIComponent(`CHECKMATE: You owe ${money(total)}.${reviewLine}`);
    const cleanedPhone = (person.phone || "").replace(/[^\d+]/g, "");

    return cleanedPhone ? `sms:${cleanedPhone}?&body=${body}` : `sms:?&body=${body}`;
  }

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 p-4 md:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="rounded-3xl border border-red-900/50 bg-zinc-900 p-5 shadow-2xl">
          <p className="text-xs tracking-[0.35em] text-red-400">
            NULLWORKS // CHECKMATE
          </p>
          <h1 className="text-3xl md:text-5xl font-black mt-2">
            Receipt OCR Bubble Splitter
          </h1>
          <p className="text-zinc-400 mt-2">
            Polish 008.1: person-level paid logic. Green only means actually paid.
          </p>
        </header>

        <section className="rounded-3xl bg-zinc-900 border border-zinc-800 p-4 grid md:grid-cols-3 gap-3">
          <div className="rounded-2xl bg-red-950/50 border border-red-800 p-4">
            <p className="text-red-300 text-xs">Bill Total</p>
            <p className="text-3xl font-black">{money(totals.splitTotal)}</p>
          </div>

          <div className="rounded-2xl bg-black/40 p-4">
            <p className="text-zinc-500 text-xs">Parsed Items</p>
            <p className="text-3xl font-black">{items.length}</p>
          </div>

          <div
            className={`rounded-2xl p-4 border ${
              totals.needsReview
                ? "bg-orange-950/40 border-orange-800"
                : "bg-blue-950/40 border-blue-800"
            }`}
          >
            <p className="text-xs">{totals.needsReview ? "Needs Review" : "Ready"}</p>
            <p className="text-lg font-black">
              {totals.needsReview ? `${totals.unassignedCount} unassigned` : "All assigned"}
            </p>
            <p className="text-xs text-zinc-400 mt-1">Scan total: {money(totals.itemScanTotal)}</p>
          </div>
        </section>

        <section className="rounded-3xl bg-zinc-900 border border-zinc-800 p-4 space-y-3">
          <h2 className="text-xl font-bold">Share Report</h2>
          <p className="text-sm text-zinc-400">
            Beta version creates local report links. Permanent links need Supabase Storage next.
          </p>

          <div className="grid md:grid-cols-3 gap-2">
            <button
              onClick={generateSharePackage}
              className="rounded-2xl bg-blue-700 hover:bg-blue-600 p-3 font-bold"
            >
              Generate Share Report
            </button>

            <a
              href={sharePackage?.htmlUrl || "#"}
              target="_blank"
              rel="noreferrer"
              className={`rounded-2xl p-3 font-bold text-center ${
                sharePackage
                  ? "bg-zinc-800 hover:bg-zinc-700"
                  : "bg-zinc-900 text-zinc-600 pointer-events-none"
              }`}
            >
              Open Receipt Report
            </a>

            <a
              href={sharePackage?.textUrl || "#"}
              download="checkmate-split-summary.txt"
              className={`rounded-2xl p-3 font-bold text-center ${
                sharePackage
                  ? "bg-zinc-800 hover:bg-zinc-700"
                  : "bg-zinc-900 text-zinc-600 pointer-events-none"
              }`}
            >
              Download Text Summary
            </a>
          </div>
        </section>

        <section className="grid lg:grid-cols-3 gap-4">
          <div className="rounded-3xl bg-zinc-900 border border-zinc-800 p-4 space-y-4">
            <h2 className="text-xl font-bold">1. Capture Receipt</h2>

            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => cameraRef.current?.click()}
                className="rounded-2xl bg-red-700 hover:bg-red-600 p-4 font-bold"
              >
                Open Camera
              </button>
              <button
                onClick={() => uploadRef.current?.click()}
                className="rounded-2xl bg-zinc-800 hover:bg-zinc-700 p-4 font-bold"
              >
                Upload Photo
              </button>
            </div>

            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={handleFileChange}
            />
            <input
              ref={uploadRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFileChange}
            />

            <div className="rounded-2xl bg-black/40 border border-zinc-800 p-3 text-sm text-zinc-300">
              <p className="font-bold text-zinc-100 mb-2">OCR Status</p>
              <p>{ocrBusy ? ocrProgress : ocrProgress || "Ready."}</p>
            </div>

            <div className="rounded-2xl bg-black/40 border border-zinc-800 p-3 space-y-3">
              <h3 className="font-bold">Receipt Mode Controls</h3>

              <label className="flex items-center justify-between gap-3 text-sm">
                Grayscale
                <input
                  type="checkbox"
                  checked={preprocess.grayscale}
                  onChange={(e) => setPreprocess((p) => ({ ...p, grayscale: e.target.checked }))}
                />
              </label>

              <label className="block text-sm">
                Contrast: {preprocess.contrast.toFixed(2)}x
                <input
                  type="range"
                  min="1"
                  max="2.5"
                  step="0.05"
                  value={preprocess.contrast}
                  onChange={(e) => setPreprocess((p) => ({ ...p, contrast: Number(e.target.value) }))}
                  className="w-full"
                />
              </label>

              <label className="block text-sm">
                Upscale: {preprocess.upscale.toFixed(1)}x
                <input
                  type="range"
                  min="1"
                  max="3"
                  step="0.1"
                  value={preprocess.upscale}
                  onChange={(e) => setPreprocess((p) => ({ ...p, upscale: Number(e.target.value) }))}
                  className="w-full"
                />
              </label>

              <label className="flex items-center justify-between gap-3 text-sm">
                Black/White Threshold
                <input
                  type="checkbox"
                  checked={preprocess.threshold}
                  onChange={(e) => setPreprocess((p) => ({ ...p, threshold: e.target.checked }))}
                />
              </label>

              {preprocess.threshold && (
                <label className="block text-sm">
                  Threshold: {preprocess.thresholdValue}
                  <input
                    type="range"
                    min="80"
                    max="220"
                    step="1"
                    value={preprocess.thresholdValue}
                    onChange={(e) =>
                      setPreprocess((p) => ({ ...p, thresholdValue: Number(e.target.value) }))
                    }
                    className="w-full"
                  />
                </label>
              )}
            </div>
          </div>

          <div className="rounded-3xl bg-zinc-900 border border-zinc-800 p-4 space-y-4 lg:col-span-2">
            <h2 className="text-xl font-bold">2. OCR Test Lab</h2>

            <div className="grid md:grid-cols-2 gap-3">
              <div>
                <p className="text-xs text-zinc-400 mb-1">Raw</p>
                {rawImage ? (
                  <img
                    src={rawImage}
                    alt="Raw receipt"
                    className="rounded-xl border border-zinc-800 max-h-72 w-full object-contain bg-black"
                  />
                ) : (
                  <div className="h-72 rounded-xl border border-zinc-800 bg-black/40 grid place-items-center text-zinc-600">
                    No image
                  </div>
                )}
              </div>

              <div>
                <p className="text-xs text-zinc-400 mb-1">Processed</p>
                {processedImage ? (
                  <img
                    src={processedImage}
                    alt="Processed receipt"
                    className="rounded-xl border border-zinc-800 max-h-72 w-full object-contain bg-black"
                  />
                ) : (
                  <div className="h-72 rounded-xl border border-zinc-800 bg-black/40 grid place-items-center text-zinc-600">
                    No processed image
                  </div>
                )}
              </div>
            </div>

            <div className="grid md:grid-cols-2 gap-3">
              <textarea
                value={ocrText}
                onChange={(e) => setOcrText(e.target.value)}
                className="w-full min-h-52 rounded-2xl bg-black border border-zinc-800 p-3 text-xs font-mono"
                placeholder="Raw OCR"
              />
              <textarea
                value={cleanedText}
                onChange={(e) => setCleanedText(e.target.value)}
                className="w-full min-h-52 rounded-2xl bg-black border border-zinc-800 p-3 text-xs font-mono"
                placeholder="Cleaned OCR"
              />
            </div>

            <button
              onClick={reparseCleanedText}
              className="w-full rounded-2xl bg-zinc-800 hover:bg-zinc-700 p-3 font-bold"
            >
              Re-Parse Cleaned OCR Text
            </button>
          </div>
        </section>

        <section className="rounded-3xl bg-zinc-900 border border-zinc-800 p-4 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-bold">3. People Ledger</h2>
              <p className="text-sm text-zinc-500">Tap a person to expand controls.</p>
            </div>
            <button
              onClick={() => setShowAddPerson((v) => !v)}
              className="rounded-2xl bg-zinc-800 hover:bg-zinc-700 px-4 py-3 font-bold"
            >
              {showAddPerson ? "Hide Add" : "+ Add Person"}
            </button>
          </div>

          {showAddPerson && (
            <div className="grid md:grid-cols-[1fr_1fr_140px] gap-2">
              <input
                value={newPerson}
                onChange={(e) => setNewPerson(e.target.value)}
                placeholder="Name"
                className="rounded-xl bg-black border border-zinc-800 p-3"
              />
              <input
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
                placeholder="Phone optional"
                className="rounded-xl bg-black border border-zinc-800 p-3"
              />
              <button onClick={addPerson} className="rounded-xl bg-red-700 hover:bg-red-600 p-3 font-bold">
                Add
              </button>
            </div>
          )}

          <div className="grid md:grid-cols-2 gap-2">
            <button
              onClick={splitAllEvenly}
              className="rounded-2xl bg-orange-600 hover:bg-orange-500 text-black p-3 font-black"
            >
              Split Entire Receipt Evenly
            </button>
            <button
              onClick={() => setDaddyPersonId("")}
              className="rounded-2xl bg-zinc-800 hover:bg-zinc-700 p-3 font-bold"
            >
              Clear Daddy Mode
            </button>
          </div>

          <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-3">
            {totals.personTotals.map((person) => {
              const expanded = expandedPersonId === person.id;
              const selected = selectedPersonId === person.id;

              return (
                <div
                  key={person.id}
                  className={`rounded-2xl border ${
                    person.paid
                      ? "bg-green-950/70 border-green-600"
                      : daddyPersonId === person.id
                      ? "bg-red-950/70 border-red-600"
                      : selected
                      ? "bg-zinc-800 border-red-700"
                      : "bg-black/40 border-zinc-800"
                  }`}
                >
                  <button
                    onClick={() => {
                      setSelectedPersonId(person.id);
                      setExpandedPersonId(expanded ? "" : person.id);
                    }}
                    className="w-full text-left p-3"
                  >
                    <div className="flex justify-between gap-3">
                      <div>
                        <p className="font-bold">{person.name}</p>
                        <p
                          className={`text-xs ${
                            person.paid
                              ? "text-green-300"
                              : person.smsSent
                              ? "text-orange-300"
                              : person.total > 0
                              ? "text-blue-300"
                              : "text-zinc-500"
                          }`}
                        >
                          {daddyPersonId === person.id
                            ? "Daddy Mode"
                            : person.paid
                            ? "Paid"
                            : person.smsSent
                            ? "SMS Sent / Pending"
                            : person.total > 0
                            ? "Ready"
                            : "No Balance"}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-black">{money(person.total)}</p>
                        <p className="text-xs text-zinc-500">{expanded ? "collapse" : "expand"}</p>
                      </div>
                    </div>
                  </button>

                  {expanded && (
                    <div className="px-3 pb-3 space-y-3">
                      <input
                        value={person.phone || ""}
                        onChange={(e) => updatePersonPhone(person.id, e.target.value)}
                        placeholder="Enter phone number for SMS"
                        inputMode="tel"
                        className="w-full rounded-xl bg-black/60 border border-zinc-700 p-3 text-sm outline-none focus:border-red-600"
                      />

                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <button onClick={() => daddyMode(person.id)} className="rounded-xl bg-red-700 hover:bg-red-600 p-2 font-bold">
                          Daddy
                        </button>
                        <a
                          href={smsLink(person, person.total)}
                          onClick={() => setPersonSmsSent(person.id, true)}
                          className="rounded-xl bg-blue-700 hover:bg-blue-600 p-2 text-center font-bold"
                        >
                          SMS
                        </a>
                        <button
                          onClick={() => setPersonSmsSent(person.id, true)}
                          className="rounded-xl bg-orange-600 hover:bg-orange-500 text-black p-2 font-bold"
                        >
                          Mark Pending
                        </button>
                        <button
                          onClick={() => setPersonPaid(person.id, !person.paid)}
                          className={`rounded-xl p-2 font-bold ${
                            person.paid
                              ? "bg-green-700 hover:bg-green-600 text-white"
                              : "bg-blue-700 hover:bg-blue-600 text-white"
                          }`}
                        >
                          {person.paid ? "Paid ✅" : "Mark Paid"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <section className="rounded-3xl bg-zinc-900 border border-zinc-800 p-4 space-y-4">
          <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
            <div>
              <h2 className="text-2xl font-black">Editable Item Bubbles</h2>
              <p className="text-zinc-400">
                Items only track assignment. Green is reserved for paid people.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <input
                value={tax}
                onChange={(e) => setTax(e.target.value)}
                placeholder="Manual tax only if no OCR total"
                className="rounded-xl bg-black border border-zinc-800 p-3"
              />
              <input
                value={tip}
                onChange={(e) => setTip(e.target.value)}
                placeholder="Tip"
                className="rounded-xl bg-black border border-zinc-800 p-3"
              />
            </div>
          </div>

          <div className="grid md:grid-cols-[1fr_160px_140px] gap-2">
            <input
              value={manualDesc}
              onChange={(e) => setManualDesc(e.target.value)}
              placeholder="Manual item description"
              className="rounded-xl bg-black border border-zinc-800 p-3"
            />
            <input
              value={manualAmount}
              onChange={(e) => setManualAmount(e.target.value)}
              placeholder="Amount"
              className="rounded-xl bg-black border border-zinc-800 p-3"
            />
            <button onClick={addManualItem} className="rounded-xl bg-red-700 hover:bg-red-600 p-3 font-bold">
              Add Item
            </button>
          </div>

          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
            {items.map((item) => (
              <div
                key={item.id}
                className={`rounded-3xl border p-4 space-y-3 ${
                  item.assignedTo.length === 0
                    ? "bg-orange-950/20 border-orange-800"
                    : "bg-black/40 border-blue-900/70"
                }`}
              >
                <div className="flex justify-between gap-3">
                  <input
                    value={`${item.description}${duplicateLabel(item, items)}`}
                    onChange={(e) =>
                      updateItem(item.id, {
                        description: e.target.value.replace(/\s+#\d+$/, ""),
                      })
                    }
                    className="w-full bg-transparent font-bold outline-none"
                  />
                  <input
                    value={item.amount}
                    type="number"
                    step="0.01"
                    onChange={(e) => updateItem(item.id, { amount: Number(e.target.value) })}
                    className="w-24 bg-zinc-950 rounded-xl border border-zinc-800 p-2 text-right"
                  />
                </div>

                <div className="flex items-center justify-between text-xs">
                  <p className="text-zinc-500">{item.code ? `Code: ${item.code}` : "No code"}</p>
                  <span
                    className={`rounded-full px-2 py-1 ${
                      item.assignedTo.length === 0
                        ? "bg-orange-900 text-orange-200"
                        : "bg-blue-900 text-blue-200"
                    }`}
                  >
                    {item.assignedTo.length === 0 ? "unassigned" : "assigned"}
                  </span>
                </div>

                <div className="flex flex-wrap gap-2">
                  {people.map((person) => (
                    <button
                      key={person.id}
                      onClick={() => assignItem(item.id, person.id)}
                      className={`rounded-full px-3 py-1 text-xs border ${
                        item.assignedTo.includes(person.id)
                          ? "bg-blue-700 border-blue-500"
                          : "bg-zinc-800 border-zinc-700"
                      }`}
                    >
                      {person.name}
                    </button>
                  ))}
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <button onClick={() => splitItem(item.id)} className="rounded-xl bg-blue-700 hover:bg-blue-600 p-2 font-bold">
                    Split
                  </button>
                  <button onClick={() => deleteItem(item.id)} className="rounded-xl bg-red-950 hover:bg-red-900 p-2 font-bold">
                    Delete
                  </button>
                </div>

                <p className="text-xs text-zinc-500 font-mono">{item.raw}</p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}