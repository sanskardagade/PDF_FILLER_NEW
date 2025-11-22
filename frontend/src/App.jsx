import { useState } from "react";
import PdfEditor from "./components/PdfEditor.jsx";
import { uploadPdf } from "./services/api.js";
import "./index.css";

export default function App() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [serverUrl, setServerUrl] = useState(null); // absolute URL

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type !== "application/pdf") {
      alert("Please select a PDF");
      return;
    }
    setBusy(true); setError("");
    try {
      const { absoluteUrl } = await uploadPdf(file);
      setServerUrl(absoluteUrl);
    } catch (err) {
      console.error(err);
      setError(err?.response?.data?.error || "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container">
      <h1>PDF Editor (MVP)</h1>
      {!serverUrl && (
        <div className="dropzone">
          <p><strong>Drop a PDF or select from device</strong></p>
          <input
            type="file"
            accept="application/pdf"
            onChange={handleFile}
            disabled={busy}
          />
          <p style={{marginTop:".5rem", color:"#666"}}>Max 100 MB, PDFs only.</p>
          {busy && <p>Uploading…</p>}
          {error && <p style={{color:"crimson"}}>{error}</p>}
        </div>
      )}

      {serverUrl && (
        <>
          <div style={{margin:"1rem 0"}}>
            <button onClick={() => setServerUrl(null)}>Upload another</button>
          </div>
          <PdfEditor fileUrl={serverUrl} />
        </>
      )}
    </div>
  );
}
