import { useEffect, useRef, useState } from "react";
import { predictSignature } from "../api";

export default function ImageAnalyzer() {
  const [backend, setBackend] = useState("");
  const [threshold, setThreshold] = useState(0.7);
  const [tta, setTta] = useState(0);
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    const b = localStorage.getItem("sv.backend") || import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000";
    const t = localStorage.getItem("sv.threshold") || "0.7";
    const k = localStorage.getItem("sv.tta") || "0";
    setBackend(b); setThreshold(parseFloat(t)); setTta(parseInt(k,10));
  }, []);

  useEffect(() => {
    if (!file) { setPreview(""); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const savePrefs = () => {
    localStorage.setItem("sv.backend", backend.trim());
    localStorage.setItem("sv.threshold", String(threshold));
    localStorage.setItem("sv.tta", String(tta));
    alert("Preferencias guardadas ✅");
  };

  const submit = async () => {
    if (!file) return alert("Selecciona una imagen.");
    setBusy(true); setResult(null);
    try {
      const data = await predictSignature(file, {
        threshold: Number(threshold), tta: Number(tta), baseURL: backend
      });
      setResult(data);
    } catch (e) {
      setResult({ error: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const labelClass =
    result?.error ? "badge error"
    : result?.label?.toUpperCase() === "REAL" ? "badge ok"
    : result?.label ? "badge ko" : "badge";

  return (
    <section className="card">
      <h2>Analizar Firma</h2>

      <div className="grid">
        <label>
          Backend URL
          <input value={backend} onChange={(e)=>setBackend(e.target.value)} placeholder="http://127.0.0.1:8000" />
        </label>
        <label>
          threshold (p(real))
          <input type="number" min="0" max="1" step="0.01"
                 value={threshold} onChange={(e)=>setThreshold(e.target.value)} />
        </label>
        <label>
          TTA
          <input type="number" min="0" max="32" step="1"
                 value={tta} onChange={(e)=>setTta(e.target.value)} />
        </label>
      </div>

      <div className="row">
        <button onClick={savePrefs}>Guardar preferencias</button>
        <a className="link" href={`${backend.replace(/\/+$/,"")}/docs`} target="_blank" rel="noreferrer">Swagger (/docs)</a>
      </div>

      <div className="uploader">
        <div className="drop" onClick={()=>inputRef.current?.click()}>
          {preview ? <img src={preview} alt="preview" /> : <p>Haz clic para elegir imagen</p>}
          <input ref={inputRef} hidden type="file" accept="image/*" onChange={(e)=>setFile(e.target.files?.[0]||null)}/>
        </div>
        <div className="row">
          <button onClick={submit} disabled={busy}>Enviar a /predict</button>
          {busy && <div className="spinner" />}
        </div>
      </div>

      {result && (
        <div className="result">
          <div className={labelClass}>{result?.error ? "ERROR" : (result?.label || "-").toUpperCase()}</div>
          <pre className="json">{JSON.stringify(result, null, 2)}</pre>
        </div>
      )}
    </section>
  );
}
