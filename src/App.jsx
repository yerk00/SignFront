import { useEffect, useRef, useState } from "react";
import { predictSignature, getBaseURL } from "./api";
import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.js?worker";
import "./index.css";

pdfjsLib.GlobalWorkerOptions.workerPort = new pdfjsWorker();

const API_BASE = getBaseURL();
const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_TTA = 0;

const STORAGE_ROWS = "sv.rows.v2";

const emptyDraft = {
  coronoles: "",
  parteDelDia: "Mañana",
  observaciones: "",
  documentoURL: "",
  parte: ""
};

export default function App() {
  // Formulario de registro
  const [draft, setDraft] = useState(emptyDraft);

  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [aiResult, setAiResult] = useState(null);

  const [pdfFile, setPdfFile] = useState(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfCropUrl, setPdfCropUrl] = useState("");
  const [pdfResult, setPdfResult] = useState(null);
  const [pageIndex, setPageIndex] = useState(-1); 

  const [rows, setRows] = useState([]);

  // Persistencia
  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_ROWS);
    if (raw) {
      try { setRows(JSON.parse(raw)); } catch {}
    }
  }, []);
  useEffect(() => {
    localStorage.setItem(STORAGE_ROWS, JSON.stringify(rows));
  }, [rows]);

  // Preview IMAGEN
  useEffect(() => {
    if (!file) { setPreview(""); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const addRow = (e) => {
    e.preventDefault();
    const row = {
      ...draft,
      documento: draft.documentoURL?.trim() || "",
      estado: "Pendiente"
    };
    setRows(prev => [row, ...prev]); 
    setDraft(emptyDraft);
  };

  // ---------- Analizar IA ----------
  const inputRef = useRef(null);
  const analyze = async () => {
    if (!file) return alert("Selecciona una imagen.");
    setBusy(true); setAiResult(null);
    try {
      const data = await predictSignature(file, {
        threshold: DEFAULT_THRESHOLD,
        tta: DEFAULT_TTA,
        baseURL: API_BASE
      });
      setAiResult(data);

      const isReal = String(data?.label || "").toUpperCase() === "REAL";
      if (isReal && rows.length > 0) {
        setRows(prev => {
          if (prev.length === 0) return prev;
          const updated = [...prev];
          updated[0] = { ...updated[0], estado: "Corroborado" };
          return updated;
        });
      }

    } catch (e) {
      setAiResult({ error: String(e) });
    } finally {
      setBusy(false);
    }
  };

  // ---------- Utilidades PDF (frontend) ----------
  function waitForCV(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const cv = window.cv;
      if (cv && cv.Mat) return resolve();
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          reject(new Error("OpenCV.js no cargó a tiempo"));
        }
      }, timeoutMs);

      const ready = () => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve();
        }
      };

      if (cv) {
        cv["onRuntimeInitialized"] = ready;
      } else {
        const tick = () => {
          const c = window.cv;
          if (c && c.Mat) ready();
          else requestAnimationFrame(tick);
        };
        tick();
      }
    });
  }

  function cropCanvas(srcCanvas, rect) {
    const w = Math.max(1, Math.round(rect.x1 - rect.x0));
    const h = Math.max(1, Math.round(rect.y1 - rect.y0));
    const dest = document.createElement("canvas");
    dest.width = w; dest.height = h;
    const dctx = dest.getContext("2d");
    dctx.drawImage(srcCanvas, rect.x0, rect.y0, w, h, 0, 0, w, h);
    return dest;
  }

  function bottomRect(viewport, frac=0.35) {
    const H = viewport.height, W = viewport.width;
    const y0 = Math.max(0, H * (1 - frac));
    return { x0: 0, y0, x1: W, y1: H * 0.98 };
  }

  function findAnchorRect(textContent, viewport) {
    const keywords = /firma|firmado|signature|firmante|firma:|firmado por/i;
    let bestY = -Infinity;
    for (const it of (textContent.items || [])) {
      const s = it?.str || "";
      if (!keywords.test(s)) continue;
      const m = pdfjsLib.Util.transform(viewport.transform, it.transform);
      const y = m[5];
      if (Number.isFinite(y) && y > bestY) bestY = y;
    }
    if (bestY === -Infinity) return null;
    const H = viewport.height, W = viewport.width;
    const y0 = Math.max(0, bestY - 0.05 * H);
    const y1 = Math.min(H, bestY + 0.35 * H);
    return { x0: 0, y0, x1: W, y1 };
  }

  async function renderPageToCanvas(pdfArrayBuffer, pageNumber, scale = 2.8) {
    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(pdfArrayBuffer) });
    const pdf = await loadingTask.promise;
    const targetIndex = pageNumber >= 0 ? Math.min(pageNumber, pdf.numPages - 1) : (pdf.numPages - 1);
    const page = await pdf.getPage(targetIndex + 1); 
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: ctx, viewport }).promise;

    let anchorRect = null;
    try {
      const textContent = await page.getTextContent();
      anchorRect = findAnchorRect(textContent, viewport);
    } catch (_) {

    }
    if (!anchorRect) anchorRect = bottomRect(viewport, 0.35);

    const roiCanvas = cropCanvas(canvas, anchorRect);
    return { roiCanvas };
  }

  function isolateSignatureCanvas(roiCanvas) {
  const cv = window.cv;
  if (!cv || !cv.Mat) throw new Error("OpenCV.js no está listo.");

  // ====== Parámetros afinables ======
  const EXCLUDE_RIGHT_FRAC = 0.20; 
  const MIN_AREA_FRACTION = 0.0008;
  const MAX_FILL_FOR_SIG  = 0.42;
  const MIN_ASPECT_FOR_SIG = 3.0;
  const HLINE_FRAC = 0.25;

  // --- 1) Prepro: B/W invertido con Otsu
  const src  = cv.imread(roiCanvas);
  const gray = new cv.Mat();
  const blur = new cv.Mat();
  const bw   = new cv.Mat();

  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
  cv.GaussianBlur(gray, blur, new cv.Size(3,3), 0, 0, cv.BORDER_DEFAULT);
  cv.threshold(blur, bw, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  const mean = cv.mean(bw)[0];
  if (mean > 127) cv.bitwise_not(bw, bw);

  const W = roiCanvas.width, H = roiCanvas.height;

  const kHorizW = Math.max(25, Math.round(W * HLINE_FRAC));
  const kernelH = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(kHorizW, 1));
  const linesH  = new cv.Mat();
  let   noLines = new cv.Mat(); 
  cv.morphologyEx(bw, linesH, cv.MORPH_OPEN, kernelH);
  cv.subtract(bw, linesH, noLines);

  if (EXCLUDE_RIGHT_FRAC > 0) {
    const xCut = Math.round(W * (1 - EXCLUDE_RIGHT_FRAC));
    const mask = new cv.Mat.zeros(noLines.rows, noLines.cols, cv.CV_8UC1);
    const srcRoi = noLines.roi(new cv.Rect(0, 0, xCut, H));
    const dstRoi = mask.roi(new cv.Rect(0, 0, xCut, H));
    srcRoi.copyTo(dstRoi);
    srcRoi.delete(); dstRoi.delete();
    noLines.delete();      
    noLines = mask;         
  }

  // --- 4) Contornos y selección por rasgos “de firma”
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(noLines, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  const A = W * H;
  const candidates = [];

  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const area = cv.contourArea(c);
    if (area < MIN_AREA_FRACTION * A) { c.delete(); continue; }

    const r = cv.boundingRect(c);
    const w = r.width, h = r.height;
    const ar = w / (h + 1e-3);
    const bboxArea = w * h;
    const fill = area / (bboxArea + 1e-3);
    const peri = cv.arcLength(c, true);
    const thinFactor = area / (peri * peri + 1e-3);

    const squareLike = (ar > 0.8 && ar < 1.25) && (fill > 0.35);
    const denseRect  = (fill > 0.55) && (ar > 0.5 && ar < 2.0);

    const likely =
      (ar > MIN_ASPECT_FOR_SIG || w > 0.25 * W) &&
      (fill < MAX_FILL_FOR_SIG) &&
      !squareLike && !denseRect;

    if (likely) {
      const score = w * (1 - fill) * (1 / (thinFactor + 1e-4));
      candidates.push({ rect: r, score });
    }
    c.delete();
  }

  let outCanvas = roiCanvas;

  if (candidates.length) {
    // unir candidatos (firmas con trazos separados)
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const { rect } of candidates) {
      x0 = Math.min(x0, rect.x);
      y0 = Math.min(y0, rect.y);
      x1 = Math.max(x1, rect.x + rect.width);
      y1 = Math.max(y1, rect.y + rect.height);
    }
    const pad = Math.round(0.06 * Math.max(W, H));
    x0 = Math.max(0, x0 - pad);
    y0 = Math.max(0, y0 - pad);
    x1 = Math.min(W, x1 + pad);
    y1 = Math.min(H, y1 + pad);
    outCanvas = cropCanvas(roiCanvas, { x0, y0, x1, y1 });
  } else {
    // Fallback: contorno con mayor "ancho - 2*alto"
    const contours2 = new cv.MatVector(), hier2 = new cv.Mat();
    cv.findContours(noLines, contours2, hier2, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    let best = null, bestScore = -1;
    for (let i = 0; i < contours2.size(); i++) {
      const c = contours2.get(i);
      const r = cv.boundingRect(c);
      const score = r.width - 2 * r.height;
      if (score > bestScore) { bestScore = score; best = r; }
      c.delete();
    }
    if (best) {
      const pad = Math.round(0.05 * Math.max(W, H));
      const x0 = Math.max(0, best.x - pad);
      const y0 = Math.max(0, best.y - pad);
      const x1 = Math.min(W, best.x + best.width + pad);
      const y1 = Math.min(H, best.y + best.height + pad);
      outCanvas = cropCanvas(roiCanvas, { x0, y0, x1, y1 });
    }
    contours2.delete(); hier2.delete();
  }

  // --- limpiar
  src.delete(); gray.delete(); blur.delete(); bw.delete();
  linesH.delete(); noLines.delete();
  contours.delete(); hierarchy.delete();

  return outCanvas;
}


  const pdfInputRef = useRef(null);
  const analyzePDF = async (pickedFile) => {
    if (!pickedFile) return;
    setPdfBusy(true); setPdfResult(null); setPdfCropUrl("");
    try {
      await waitForCV();
      const arr = await pickedFile.arrayBuffer();
      const { roiCanvas } = await renderPageToCanvas(arr, pageIndex, 2.8);
      const cropCanvasEl = isolateSignatureCanvas(roiCanvas);
      const dataUrl = cropCanvasEl.toDataURL("image/png");
      setPdfCropUrl(dataUrl);

      // Enviar recorte a /predict
      const blob = await (await fetch(dataUrl)).blob();
      const fileForAPI = new File([blob], "signature.png", { type: "image/png" });
      const data = await predictSignature(fileForAPI, {
        threshold: DEFAULT_THRESHOLD,
        tta: DEFAULT_TTA,
        baseURL: API_BASE
      });
      setPdfResult(data);

      // Si REAL → marcar última fila como Corroborado
      if (String(data?.label || "").toUpperCase() === "REAL" && rows.length > 0) {
        setRows(prev => {
          if (!prev.length) return prev;
          const copy = [...prev];
          copy[0] = { ...copy[0], estado: "Corroborado" };
          return copy;
        });
      }
    } catch (e) {
      setPdfResult({ error: String(e) });
    } finally {
      setPdfBusy(false);
    }
  };

  const removeRow = (idx) => {
    if (!confirm("¿Eliminar fila?")) return;
    setRows(prev => prev.filter((_,i)=>i!==idx));
  };

  const labelClassImg =
    aiResult?.error ? "badge error"
    : aiResult?.label?.toUpperCase() === "REAL" ? "badge ok"
    : aiResult?.label ? "badge ko"
    : "badge";

  const labelClassPdf =
    pdfResult?.error ? "badge error"
    : pdfResult?.label?.toUpperCase() === "REAL" ? "badge ok"
    : pdfResult?.label ? "badge ko"
    : "badge";

  return (
    <div className="shell">
      <header className="hero">
        <div className="hero__text">
          <h1>Panel de Firmas</h1>
          <p>Registra entradas, analiza una firma (imagen o PDF) y refleja el resultado en la tabla.</p>
        </div>
      </header>

      {/* 1) Registrar (arriba) */}
      <section className="card">
        <h2>Registrar</h2>
        <form className="form" onSubmit={addRow}>
          <div className="grid grid-3">
            <label>
              Nombre
              <input required value={draft.coronoles} onChange={e=>setDraft(s=>({...s, coronoles:e.target.value}))} placeholder="Nombre / rango" />
            </label>
            <label>
              Fecha parte
              <select value={draft.parteDelDia} onChange={e=>setDraft(s=>({...s, parteDelDia:e.target.value}))}>
                {["Mañana","Tarde","Noche"].map(p=><option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <label>
              Parte
              <input value={draft.parte} onChange={e=>setDraft(s=>({...s, parte:e.target.value}))} placeholder="ID / número" />
            </label>
          </div>
          <label>
            Documento (URL)
            <input value={draft.documentoURL} onChange={e=>setDraft(s=>({...s, documentoURL:e.target.value}))} placeholder="Adjuntar documento" />
          </label>
          <label>
            Observaciones
            <textarea rows={3} value={draft.observaciones} onChange={e=>setDraft(s=>({...s, observaciones:e.target.value}))} placeholder="Notas..." />
          </label>

          <div className="hint">
            <strong>Estado:</strong> al analizar con IA, si el resultado es <b>REAL</b>, la fila más reciente pasará a <b>Corroborado</b>.
          </div>

          <div className="right">
            <button className="btn">Añadir a la tabla</button>
          </div>
        </form>
      </section>

      {/* 2) Analizar IA (IMAGEN) */}
      <section className="card">
        <h2>Analizar IA (Imagen)</h2>
        <div className="analyze">
          <div className="uploader" onClick={()=>inputRef.current?.click()}>
            {preview
              ? <img src={preview} alt="preview" />
              : <p>Haz clic para elegir imagen</p>}
            <input ref={inputRef} hidden type="file" accept="image/*" onChange={(e)=>setFile(e.target.files?.[0]||null)} />
          </div>

          <div className="controls">
            <button className="btn" onClick={analyze} disabled={busy || !file}>Analizar</button>
            {busy && <div className="spinner" />}
          </div>
        </div>

        {aiResult && (
          <div className="result">
            <div className={labelClassImg}>
              {aiResult?.error ? "ERROR" : (aiResult?.label || "-").toUpperCase()}
            </div>
            {preview && (
              <div className="result__preview">
                <img src={preview} alt="analizada" />
                <div className="result__meta">
                  {!aiResult.error ? (
                    <>
                      <div><b>p(real):</b> {(aiResult.p_real ?? 0).toFixed(3)}</div>
                      <div><b>p(forge):</b> {(aiResult.p_forge ?? 0).toFixed(3)}</div>
                      <div><b>thr:</b> {aiResult.threshold_used}</div>
                      <div><b>TTA:</b> {aiResult.tta}</div>
                      <div><b>lat:</b> {aiResult.latency_ms}ms</div>
                    </>
                  ) : (
                    <div className="error">{String(aiResult.error)}</div>
                  )}
                </div>
              </div>
            )}
            <div className="hint">
              Si la IA fue <b>REAL</b>, la fila más reciente se marca automáticamente como <b>Corroborado</b>.
            </div>
          </div>
        )}
      </section>

      {/* 2b) Analizar PDF (extraer firma en el navegador) */}
      <section className="card">
        <h2>Analizar PDF (extraer firma en el navegador)</h2>
        <div className="grid grid-3" style={{marginBottom:8}}>
          <label>
            Página (0 = primera, -1 = última)
            <input type="number" value={pageIndex}
                   onChange={e=>setPageIndex(parseInt(e.target.value || -1,10))}
                   placeholder="-1" />
          </label>
        </div>

        <div className="analyze">
          <div className="uploader" onClick={()=>pdfInputRef.current?.click()}>
            {pdfCropUrl
              ? <img src={pdfCropUrl} alt="firma extraída" />
              : <p>Haz clic para elegir PDF</p>}
            <input
              ref={pdfInputRef} hidden type="file" accept="application/pdf"
              onChange={(e)=>{ const f=e.target.files?.[0]; setPdfFile(f||null); if (f) analyzePDF(f); }}
            />
          </div>

          <div className="controls">
            <button className="btn" onClick={()=>pdfFile && analyzePDF(pdfFile)} disabled={pdfBusy || !pdfFile}>
              {pdfBusy ? "Procesando..." : "Reprocesar"}
            </button>
            {pdfBusy && <div className="spinner" />}
          </div>
        </div>

        {pdfResult && (
          <div className="result">
            <div className={labelClassPdf}>
              {pdfResult?.error ? "ERROR" : (pdfResult?.label || "-").toUpperCase()}
            </div>
            {!pdfResult.error && (
              <div className="result__meta">
                <div><b>p(real):</b> {(pdfResult.p_real ?? 0).toFixed(3)}</div>
                <div><b>p(forge):</b> {(pdfResult.p_forge ?? 0).toFixed(3)}</div>
                <div><b>thr:</b> {pdfResult.threshold_used}</div>
                <div><b>TTA:</b> {pdfResult.tta}</div>
                <div><b>lat:</b> {pdfResult.latency_ms}ms</div>
              </div>
            )}
            {pdfCropUrl && (
              <div className="result__preview" style={{marginTop:10}}>
                <img src={pdfCropUrl} alt="firma recortada" />
              </div>
            )}
            <div className="hint">
              Si la IA fue <b>REAL</b>, la fila más reciente se marca automáticamente como <b>Corroborado</b>.
            </div>
          </div>
        )}
      </section>

      {/* 3) Tabla (abajo) */}
      <section className="card">
        <h2>Tabla</h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Fecha Parte</th>
                <th>Observaciones</th>
                <th>Documento</th>
                <th>Parte</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.length===0 ? (
                <tr><td colSpan={7} className="muted">Sin registros</td></tr>
              ) : rows.map((r,i)=>(
                <tr key={i}>
                  <td>{r.coronoles}</td>
                  <td>{r.parteDelDia}</td>
                  <td className="wrap">{r.observaciones}</td>
                  <td className="wrap">{r.documento || "(sin documento)"}</td>
                  <td>{r.parte || "-"}</td>
                  <td>
                    <span className={
                      "chip " + (r.estado==="Corroborado" ? "chip-ok" :
                                 r.estado==="Rechazado" ? "chip-ko" : "chip-muted")
                    }>
                      {r.estado}
                    </span>
                  </td>
                  <td className="actions">
                    <button className="btn ghost danger" onClick={()=>removeRow(i)}>Eliminar</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <footer className="foot">UI claro (celeste/verde) · Estado “Corroborado” al detectar REAL</footer>
    </div>
  );
}
