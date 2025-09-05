// src/components/PdfAnalyzer.jsx
import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import axios from "axios";

pdfjsLib.GlobalWorkerOptions.workerSrc = window.PDFJS_WORKER;

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000";
const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_TTA = 0;

export default function PdfAnalyzer({ onRealDetected }) {
  const [pdfFile, setPdfFile] = useState(null);
  const [pageIndex, setPageIndex] = useState(-1); // -1 = última
  const [busy, setBusy] = useState(false);
  const [cropUrl, setCropUrl] = useState("");
  const [result, setResult] = useState(null);
  const inputRef = useRef(null);

  const pickPDF = () => inputRef.current?.click();

  // Renderiza página a canvas
  async function renderPageToCanvas(pdfData, pageNumber, scale = 2.5) {
    const loadingTask = pdfjsLib.getDocument({ data: pdfData });
    const pdf = await loadingTask.promise;
    const targetPage = pageNumber >= 0 ? pageNumber + 1 : pdf.numPages; // pdf.js es 1-index
    const page = await pdf.getPage(targetPage);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: ctx, viewport }).promise;

    // Extraer texto para ancla
    const textContent = await page.getTextContent();
    const anchorRect = findAnchorRect(textContent, viewport) || bottomRect(viewport, 0.35);

    // Recortar ROI
    const roiCanvas = cropCanvas(canvas, anchorRect);
    return { pdf, page, canvas, roiCanvas, viewport, anchorRect };
  }

  // Encuentra un rect debajo de "firma"/"firmado"/"signature"
  function findAnchorRect(textContent, viewport) {
    const keywords = /firma|firmado|signature|firmante|firma:|firmado por/i;
    // textContent.items: { str, transform, width, height, ... }
    let best = null;
    for (const it of textContent.items) {
      if (!it.str || !keywords.test(it.str)) continue;
      // Transformar a coords de viewport
      // transform = [a, b, c, d, e, f]
      const [a,b,c,d,e,f] = it.transform;
      // Transformar mediante viewport (pdf.js 3.x)
      const m = viewport.transform;
      const x = a*m[0] + b*m[2] + e*m[4];
      const y = c*m[1] + d*m[3] + f*m[5];
      const fontH = Math.hypot(c*m[1], d*m[3]); // aproximación altura
      const width = (it.width || it.str.length * (fontH*0.6)) * (viewport.scale || 1);

      const rect = {
        x0: x,
        y0: y - fontH,
        x1: x + width,
        y1: y
      };
      if (!best || rect.y1 > best.y1) best = rect; // la más baja en la página
    }
    if (!best) return null;
    // ROI: franja completa bajo el ancla (ajustable)
    const H = viewport.height, W = viewport.width;
    const y0 = Math.max(0, best.y1 - 0.05 * H);
    const y1 = Math.min(H, best.y1 + 0.35 * H);
    return { x0: 0, y0, x1: W, y1 };
  }

  function bottomRect(viewport, frac=0.35) {
    const H = viewport.height, W = viewport.width;
    const y0 = Math.max(0, H * (1 - frac));
    return { x0: 0, y0, x1: W, y1: H * 0.98 };
  }

  function cropCanvas(srcCanvas, rect) {
    const w = Math.max(1, Math.round(rect.x1 - rect.x0));
    const h = Math.max(1, Math.round(rect.y1 - rect.y0));
    const dest = document.createElement("canvas");
    dest.width = w; dest.height = h;
    const dctx = dest.getContext("2d");
    dctx.drawImage(
      srcCanvas,
      rect.x0, rect.y0, w, h,   // src
      0, 0, w, h                 // dst
    );
    return dest;
  }

  // Usa OpenCV.js para aislar la firma dentro del ROI (similar al backend)
  function isolateSignatureCanvas(roiCanvas) {
    const cv = window.cv;
    if (!cv || !cv.Mat) throw new Error("OpenCV.js no se cargó aún.");

    const src = cv.imread(roiCanvas);
    const gray = new cv.Mat();
    const blur = new cv.Mat();
    const bw = new cv.Mat();
    const lines = new cv.Mat();
    const bw2 = new cv.Mat();

    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
    cv.GaussianBlur(gray, blur, new cv.Size(3,3), 0, 0, cv.BORDER_DEFAULT);
    cv.threshold(blur, bw, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);

    // invertir si fondo queda negro
    const mean = cv.mean(bw)[0];
    if (mean > 127) {
      cv.bitwise_not(bw, bw);
    }

    // quitar líneas horizontales
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(25,1));
    cv.morphologyEx(bw, lines, cv.MORPH_OPEN, kernel);
    cv.subtract(bw, lines, bw2);

    // contornos
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(bw2, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let bbox = null;
    const areaMin = 0.002 * (bw2.rows * bw2.cols);
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const area = cv.contourArea(c);
      if (area < areaMin) continue;
      const r = cv.boundingRect(c);
      if (!bbox) bbox = { x0:r.x, y0:r.y, x1:r.x+r.width, y1:r.y+r.height };
      else {
        bbox.x0 = Math.min(bbox.x0, r.x);
        bbox.y0 = Math.min(bbox.y0, r.y);
        bbox.x1 = Math.max(bbox.x1, r.x+r.width);
        bbox.y1 = Math.max(bbox.y1, r.y+r.height);
      }
      c.delete();
    }

    // si no encontró contornos, devolvemos el ROI tal cual
    let outCanvas = roiCanvas;
    if (bbox) {
      const pad = Math.round(0.04 * Math.max(roiCanvas.width, roiCanvas.height));
      const x0 = Math.max(0, bbox.x0 - pad);
      const y0 = Math.max(0, bbox.y0 - pad);
      const x1 = Math.min(roiCanvas.width,  bbox.x1 + pad);
      const y1 = Math.min(roiCanvas.height, bbox.y1 + pad);
      outCanvas = cropCanvas(roiCanvas, { x0, y0, x1, y1 });
    }

    // limpiar
    src.delete(); gray.delete(); blur.delete(); bw.delete(); lines.delete(); bw2.delete();
    contours.delete(); hierarchy.delete();

    return outCanvas;
  }

  async function handlePDF(file) {
    setBusy(true); setCropUrl(""); setResult(null);
    try {
      // Esperar OpenCV.js
      await waitForCV();

      const arr = await file.arrayBuffer();
      const { roiCanvas } = await renderPageToCanvas(arr, pageIndex, 2.8);

      // Aislar firma con OpenCV
      const cropCanvasEl = isolateSignatureCanvas(roiCanvas);
      const dataUrl = cropCanvasEl.toDataURL("image/png");
      setCropUrl(dataUrl);

      // Enviar a /predict
      const blob = await (await fetch(dataUrl)).blob();
      const form = new FormData();
      form.append("file", new File([blob], "signature.png", { type: "image/png" }));
      const { data } = await axios.post(
        `${API_BASE.replace(/\/+$/,"")}/predict`,
        form,
        { params: { threshold: DEFAULT_THRESHOLD, tta: DEFAULT_TTA } }
      );
      setResult(data);

      // Si REAL ⇒ avisar al padre para marcar “Corroborado” la fila más reciente
      if (String(data.label || "").toUpperCase() === "REAL") {
        onRealDetected?.();
      }
    } catch (e) {
      setResult({ error: String(e) });
    } finally {
      setBusy(false);
    }
  }

  function waitForCV(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const t0 = performance.now();
      (function check(){
        if (window.cv && window.cv.Mat) return resolve();
        if (performance.now() - t0 > timeoutMs) return reject(new Error("OpenCV.js no cargó a tiempo"));
        requestAnimationFrame(check);
      })();
    });
  }

  const badgeClass =
    result?.error ? "badge error"
    : result?.label?.toUpperCase() === "REAL" ? "badge ok"
    : result?.label ? "badge ko" : "badge";

  return (
    <section className="card">
      <h2>Analizar PDF (extraer firma en el navegador)</h2>

      <div className="grid grid-3">
        <label>
          Página (0 = primera, -1 = última)
          <input type="number" value={pageIndex}
                 onChange={e=>setPageIndex(parseInt(e.target.value || -1,10))}
                 placeholder="-1" />
        </label>
      </div>

      <div className="analyze">
        <div className="uploader" onClick={pickPDF}>
          {cropUrl
            ? <img src={cropUrl} alt="firma extraída" />
            : <p>Haz clic para elegir PDF</p>}
          <input
            ref={inputRef} hidden type="file" accept="application/pdf"
            onChange={(e)=>{ const f=e.target.files?.[0]; setPdfFile(f||null); if (f) handlePDF(f); }}
          />
        </div>

        <div className="controls">
          <button className="btn" onClick={()=>pdfFile && handlePDF(pdfFile)} disabled={busy || !pdfFile}>
            {busy ? "Procesando..." : "Reprocesar"}
          </button>
          {busy && <div className="spinner" />}
        </div>
      </div>

      {result && (
        <div className="result">
          <div className={badgeClass}>
            {result?.error ? "ERROR" : (result?.label || "-").toUpperCase()}
          </div>
          {!result.error && (
            <div className="result__meta">
              <div><b>p(real):</b> {(result.p_real ?? 0).toFixed(3)}</div>
              <div><b>p(forge):</b> {(result.p_forge ?? 0).toFixed(3)}</div>
              <div><b>thr:</b> {result.threshold_used}</div>
              <div><b>TTA:</b> {result.tta}</div>
              <div><b>lat:</b> {result.latency_ms}ms</div>
            </div>
          )}
          {cropUrl && (
            <div className="result__preview" style={{marginTop:10}}>
              <img src={cropUrl} alt="firma recortada" />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
