import { useEffect, useMemo, useState } from "react";

const initialRow = {
  coronoles: "",
  parteDelDia: "Mañana",
  observaciones: "",
  documentoTipo: "archivo", // archivo | url
  documentoArchivo: null,
  documentoURL: "",
  parte: "",
  estado: "Pendiente"
};

const STORAGE_KEY = "sv.tabla.rows.v1";

function toCSV(rows) {
  const headers = ["coronoles","partes_del_dia","observaciones","documento","parte","estado"];
  const lines = rows.map(r => {
    const doc = r.documentoTipo === "url" ? r.documentoURL : (r.documentoArchivo?.name || "");
    return [
      r.coronoles, r.parteDelDia, r.observaciones.replace(/\n/g," "),
      doc, r.parte, r.estado
    ].map(x => `"${String(x ?? "").replace(/"/g,'""')}"`).join(",");
  });
  return [headers.join(","), ...lines].join("\n");
}

export default function DataTable() {
  const [rows, setRows] = useState([]);
  const [editingIndex, setEditingIndex] = useState(-1);
  const [draft, setDraft] = useState(initialRow);

  // Persistencia
  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try { setRows(JSON.parse(raw)); } catch {}
    }
  }, []);
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
  }, [rows]);

  const resetDraft = () => setDraft(initialRow);

  const startAdd = () => {
    setEditingIndex(-1);
    resetDraft();
  };

  const startEdit = (i) => {
    setEditingIndex(i);
    const r = rows[i];
    setDraft({
      coronoles: r.coronoles || "",
      parteDelDia: r.parteDelDia || "Mañana",
      observaciones: r.observaciones || "",
      documentoTipo: r.documentoTipo || "archivo",
      documentoArchivo: null, // no podemos rehidratar el File
      documentoURL: r.documentoURL || "",
      parte: r.parte || "",
      estado: r.estado || "Pendiente"
    });
  };

  const removeRow = (i) => {
    if (!confirm("¿Eliminar fila?")) return;
    setRows(prev => prev.filter((_, idx) => idx !== i));
    if (editingIndex === i) {
      setEditingIndex(-1);
      resetDraft();
    }
  };

  const onSubmit = (e) => {
    e.preventDefault();
    const payload = { ...draft };
    // Normalizar documento
    if (payload.documentoTipo === "archivo" && payload.documentoArchivo) {
      payload.documentoURL = ""; // sólo guardamos nombre para referencia
    }
    if (editingIndex >= 0) {
      setRows(prev => prev.map((r,i) => i===editingIndex ? payload : r));
    } else {
      setRows(prev => [payload, ...prev]);
    }
    setEditingIndex(-1);
    resetDraft();
  };

  const exportCSV = () => {
    const csv = toCSV(rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "tabla_firmas.csv";
    a.click();
  };

  const docLabel = (r) => {
    if (r.documentoTipo === "url" && r.documentoURL) return r.documentoURL;
    if (r.documentoTipo === "archivo") return r.documentoArchivo?.name || "(archivo)";
    return "";
  };

  const estados = ["Pendiente","Aprobado","Rechazado"];
  const partesDia = ["Mañana","Tarde","Noche"];

  return (
    <section className="card">
      <h2>Registro — Tabla</h2>

      <form className="form-grid" onSubmit={onSubmit}>
        <label>
          Coronoles
          <input
            value={draft.coronoles}
            onChange={(e)=>setDraft(s=>({...s, coronoles:e.target.value}))}
            placeholder="Nombre / rango"
            required
          />
        </label>

        <label>
          Partes del día
          <select
            value={draft.parteDelDia}
            onChange={(e)=>setDraft(s=>({...s, parteDelDia:e.target.value}))}
          >
            {partesDia.map(p=><option key={p} value={p}>{p}</option>)}
          </select>
        </label>

        <label>
          Parte
          <input
            value={draft.parte}
            onChange={(e)=>setDraft(s=>({...s, parte:e.target.value}))}
            placeholder="ID / número / texto"
          />
        </label>

        <label>
          Estado
          <select
            value={draft.estado}
            onChange={(e)=>setDraft(s=>({...s, estado:e.target.value}))}
          >
            {estados.map(p=><option key={p} value={p}>{p}</option>)}
          </select>
        </label>

        <label className="span-2">
          Observaciones
          <textarea
            rows={3}
            value={draft.observaciones}
            onChange={(e)=>setDraft(s=>({...s, observaciones:e.target.value}))}
            placeholder="Comentarios, notas, incidencias..."
          />
        </label>

        <div className="span-2">
          <div className="row">
            <label className="inline">
              <input
                type="radio"
                name="docTipo"
                checked={draft.documentoTipo==="archivo"}
                onChange={()=>setDraft(s=>({...s, documentoTipo:"archivo"}))}
              /> Archivo
            </label>
            <label className="inline">
              <input
                type="radio"
                name="docTipo"
                checked={draft.documentoTipo==="url"}
                onChange={()=>setDraft(s=>({...s, documentoTipo:"url"}))}
              /> URL
            </label>
          </div>

          {draft.documentoTipo === "archivo" ? (
            <input
              type="file"
              onChange={(e)=>setDraft(s=>({...s, documentoArchivo:e.target.files?.[0] || null}))}
              accept="image/*,.pdf,.doc,.docx"
            />
          ) : (
            <input
              placeholder="https://..."
              value={draft.documentoURL}
              onChange={(e)=>setDraft(s=>({...s, documentoURL:e.target.value}))}
            />
          )}
        </div>

        <div className="row span-2">
          <button type="submit">{editingIndex>=0 ? "Guardar cambios" : "Añadir fila"}</button>
          {editingIndex>=0 && (
            <button type="button" className="ghost" onClick={()=>{setEditingIndex(-1); resetDraft();}}>
              Cancelar edición
            </button>
          )}
          <div className="spacer" />
          <button type="button" className="ghost" onClick={exportCSV}>Exportar CSV</button>
          <button type="button" className="ghost" onClick={startAdd}>Nueva fila</button>
        </div>
      </form>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Coronoles</th>
              <th>Partes del día</th>
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
                <td className="wrap">{docLabel(r)}</td>
                <td>{r.parte}</td>
                <td>
                  <span className={"badge " + (
                    r.estado==="Aprobado" ? "ok" :
                    r.estado==="Rechazado" ? "ko" : ""
                  )}>{r.estado}</span>
                </td>
                <td className="actions">
                  <button className="small" onClick={()=>startEdit(i)}>Editar</button>
                  <button className="small danger" onClick={()=>removeRow(i)}>Eliminar</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="note">
        Nota: los archivos subidos en “Documento” <b>no</b> se almacenan; sólo se conserva el nombre para referencia.<br/>
        Para conservación real, sube a un almacenamiento (Drive/S3) y guarda la URL.
      </p>
    </section>
  );
}
