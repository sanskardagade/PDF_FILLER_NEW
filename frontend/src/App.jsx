import { useRef, useState } from "react";
import PdfEditor from "./components/PdfEditor.jsx";
import { uploadPdf } from "./services/api.js";
import "./index.css";

export default function App() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [serverUrl, setServerUrl] = useState(null); // absolute URL of uploaded PDF
  const fileInputRef = useRef(null);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.type !== "application/pdf") {
      alert("Please select a PDF file");
      return;
    }

    setBusy(true);
    setError("");

    try {
      const { absoluteUrl } = await uploadPdf(file);
      setServerUrl(absoluteUrl); // go to "next page" (PDF view)
    } catch (err) {
      console.error(err);
      setError(err?.response?.data?.error || "Upload failed");
    } finally {
      setBusy(false);
      // reset so choosing same file again triggers onChange
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  // Download current PDF as "draft"
  async function handleSaveDraft() {
    if (!serverUrl) {
      alert("No PDF loaded to save.");
      return;
    }
    try {
      const res = await fetch(serverUrl);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      a.download = "form-draft.pdf";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Draft download failed", err);
      alert("Failed to download draft.");
    }
  }

  // Share current PDF link (WhatsApp / Email / native share)
  async function handleSubmitShare() {
    if (!serverUrl) {
      alert("No PDF loaded to share.");
      return;
    }

    const shareUrl = serverUrl;

    try {
      if (navigator.share) {
        // Native share sheet (mobile, some desktops)
        await navigator.share({
          title: "Form PDF",
          text: "Please check this PDF form.",
          url: shareUrl,
        });
      } else {
        // Fallback: WhatsApp or Email
        const useWhatsapp = window.confirm(
          "Native share is not available.\n\nOK: Share via WhatsApp\nCancel: Share via Email"
        );

        if (useWhatsapp) {
          const waUrl = `https://wa.me/?text=${encodeURIComponent(
            "Please check this PDF: " + shareUrl
          )}`;
          window.open(waUrl, "_blank");
        } else {
          const mailto = `mailto:?subject=${encodeURIComponent(
            "Shared PDF"
          )}&body=${encodeURIComponent("Please check this PDF: " + shareUrl)}`;
          window.location.href = mailto;
        }
      }
    } catch (err) {
      console.error("Share failed", err);
      alert(
        "Unable to open share options. You can copy this link manually:\n" +
          shareUrl
      );
    }
  }

  // Common hidden file input used by ADD / Change PDF
  const fileInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept="application/pdf"
      style={{ display: "none" }}
      onChange={handleFile}
    />
  );

  const openFilePicker = () => {
    if (!busy) fileInputRef.current?.click();
  };

  return (
    <div
      className="app-root"
      style={{
        width: "100%",
        minHeight: "100vh",
        boxSizing: "border-box",
        padding: "16px 16px",
        backgroundColor: "#f2f4f7",
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      {/* Hidden input at top-level */}
      {fileInput}

      {/* ---------- PAGE 1: FORMS MASTER ---------- */}
      {!serverUrl && (
        <>
          {/* Top bar: title + ADD button */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              width: "100%",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <h2 style={{ margin: 0, fontWeight: 600, fontSize: 20 }}>
              FORMS MASTER
            </h2>
            <div style={{ flex: 1 }} />
            <button
              onClick={openFilePicker}
              disabled={busy}
              style={{
                padding: "8px 24px",
                borderRadius: 20,
                border: "none",
                backgroundColor: "#007bff",
                color: "#fff",
                fontWeight: 600,
                cursor: busy ? "not-allowed" : "pointer",
                boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                fontSize: 14,
                whiteSpace: "nowrap",
              }}
            >
              {busy ? "UPLOADING..." : "ADD"}
            </button>
          </div>

          {/* Main card: Filter + Table */}
          <div
            style={{
              flexShrink: 0,
              width: "100%",
              border: "1px solid #e0e0e0",
              borderRadius: 4,
              padding: "16px 12px",
              backgroundColor: "#fff",
              boxSizing: "border-box",
            }}
          >
            {/* FILTER label */}
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: "#007bff",
                marginBottom: 12,
              }}
            >
              FILTER
            </div>

            {/* Filter form (static for now) */}
            <div style={{ display: "grid", rowGap: 12, marginBottom: 16 }}>
              {/* Row 1 */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                  gap: 12,
                }}
              >
                <FilterSelect
                  label="SELECT COMPANY"
                  placeholder="-SELECT COMPANY-"
                />
                <FilterSelect label="RELATED TO" placeholder="-RELATED TO-" />
                <FilterSelect label="TYPE" placeholder="-TYPE-" />
                <FilterSelect
                  label="DEPARTMENT"
                  placeholder="-DEPARTMENT-"
                />
              </div>

              {/* Row 2 */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                  gap: 12,
                }}
              >
                <FilterSelect
                  label="ACTIVE STATUS"
                  placeholder="-ACTIVE STATUS-"
                />
                <FilterInput label="FORM NO" placeholder="FORM NO" />
                <FilterInput label="REVISION FROM DATE" type="date" />
                <FilterInput label="REVISION TO DATE" type="date" />
              </div>
            </div>

            {/* Search / Clear buttons */}
            <div
              style={{
                marginBottom: 16,
                display: "flex",
                flexWrap: "wrap",
                gap: 8,
              }}
            >
              <button
                disabled
                style={{
                  padding: "8px 24px",
                  borderRadius: 20,
                  border: "none",
                  backgroundColor: "#007bff",
                  color: "#fff",
                  fontWeight: 600,
                  cursor: "not-allowed",
                  flexShrink: 0,
                }}
              >
                SEARCH
              </button>
              <button
                disabled
                style={{
                  padding: "8px 24px",
                  borderRadius: 20,
                  border: "none",
                  backgroundColor: "#007bff",
                  color: "#fff",
                  fontWeight: 600,
                  cursor: "not-allowed",
                  flexShrink: 0,
                }}
              >
                CLEAR
              </button>
            </div>

            {/* Static table (mock data) */}
            <div style={{ overflowX: "auto", width: "100%" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 12,
                  minWidth: 700,
                }}
              >
                <thead>
                  <tr style={{ backgroundColor: "#f5f5f5" }}>
                    <th style={thStyle}>COMPANY</th>
                    <th style={thStyle}>RELATED TO</th>
                    <th style={thStyle}>DEPARTMENT</th>
                    <th style={thStyle}>TYPE</th>
                    <th style={thStyle}>TITLE</th>
                    <th style={thStyle}>REFERENCE NO</th>
                    <th style={thStyle}>EFFECTIVE DATE</th>
                    <th style={thStyle}>REMARK</th>
                    <th style={thStyle}>REJECT REMARK</th>
                    <th style={thStyle}>STATUS</th>
                    <th style={thStyle}>ACTION</th>
                  </tr>
                </thead>
                <tbody>
                  {/* Row 1 */}
                  <tr>
                    <td style={tdStyle}>COMMON FOR ALL</td>
                    <td style={tdStyle}>SHIP</td>
                    <td style={tdStyle}>DECK</td>
                    <td style={tdStyle}>CHECKLIST</td>
                    <td style={tdStyle}>INDEX</td>
                    <td style={tdStyle}>00- INDEX</td>
                    <td style={tdStyle}>01-AUG-2025</td>
                    <td style={tdStyle}>00- INDEX</td>
                    <td style={tdStyle}>NA</td>
                    <td style={tdStyle}>APPROVED</td>
                    <td style={tdStyle}>
                      <button style={editButtonStyle}>EDIT</button>
                    </td>
                  </tr>
                  {/* Row 2 */}
                  <tr>
                    <td style={tdStyle}>COMMON FOR ALL</td>
                    <td style={tdStyle}>SHIP</td>
                    <td style={tdStyle}>ENGINE</td>
                    <td style={tdStyle}>CHECKLIST</td>
                    <td style={tdStyle}>WATCH KEEPING ENGINE</td>
                    <td style={tdStyle}>01-ENG/01/WKE</td>
                    <td style={tdStyle}>01-AUG-2025</td>
                    <td style={tdStyle}>
                      01- ENG 01 - WATCH KEEPING ENGINE
                    </td>
                    <td style={tdStyle}>NA</td>
                    <td style={tdStyle}>APPROVED</td>
                    <td style={tdStyle}>
                      <button style={editButtonStyle}>EDIT</button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            {error && (
              <p style={{ color: "crimson", marginTop: 8, fontSize: 12 }}>
                {error}
              </p>
            )}
          </div>
        </>
      )}

      {/* ---------- PAGE 2: PDF EDITOR (FULL PAGE) ---------- */}
      {serverUrl && (
        <>
          {/* Top bar: back + title + change PDF */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              width: "100%",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <button
              onClick={() => setServerUrl(null)}
              style={{
                padding: "6px 14px",
                borderRadius: 4,
                border: "1px solid #ccc",
                backgroundColor: "#fff",
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              ← Back
            </button>
            <h2 style={{ margin: 0, fontWeight: 600, fontSize: 20 }}>
              PDF EDITOR
            </h2>
            <div style={{ flex: 1 }} />
            <button
              onClick={openFilePicker}
              disabled={busy}
              style={{
                padding: "8px 20px",
                borderRadius: 20,
                border: "none",
                backgroundColor: "#007bff",
                color: "#fff",
                fontWeight: 600,
                cursor: busy ? "not-allowed" : "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {busy ? "UPLOADING..." : "CHANGE PDF"}
            </button>
          </div>

          {/* Save as Draft / Submit buttons row */}
          <div
            style={{
              marginTop: 12,
              marginBottom: 4,
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
            }}
          >
            <button
              onClick={handleSaveDraft}
              style={{
                padding: "10px 28px",
                borderRadius: 20,
                border: "none",
                backgroundColor: "#007bff",
                color: "#fff",
                fontWeight: 600,
                cursor: "pointer",
                boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                letterSpacing: "0.5px",
                flex: 1,
                minWidth: 150,
              }}
            >
              SAVE AS DRAFT
            </button>

            <button
              onClick={handleSubmitShare}
              style={{
                padding: "10px 28px",
                borderRadius: 20,
                border: "none",
                backgroundColor: "#28a745", // green button for submit
                color: "#fff",
                fontWeight: 600,
                cursor: "pointer",
                boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                letterSpacing: "0.5px",
                flex: 1,
                minWidth: 150,
              }}
            >
              SUBMIT
            </button>
          </div>

          {/* Full-width, full-height PDF area */}
          <div
            className="pdf-wrapper-container"
            style={{
              flex: 1,
              width: "100%",
              minHeight: 0,
              marginTop: 4,
              backgroundColor: "#fff",
              borderRadius: 4,
              border: "1px solid #e0e0e0",
              padding: 8,
              boxSizing: "border-box",
              overflow: "auto",
            }}
          >
            <PdfEditor fileUrl={serverUrl} />
          </div>
        </>
      )}
    </div>
  );
}

/* Small helper components for filter fields */
function FilterSelect({ label, placeholder }) {
  return (
    <div>
      <label
        style={{
          display: "block",
          fontSize: 12,
          fontWeight: 600,
          marginBottom: 4,
        }}
      >
        {label}
      </label>
      <select
        disabled
        style={{
          width: "100%",
          padding: "6px 8px",
          borderRadius: 4,
          border: "1px solid #ccc",
          fontSize: 13,
        }}
      >
        <option>{placeholder}</option>
      </select>
    </div>
  );
}

function FilterInput({ label, placeholder, type = "text" }) {
  return (
    <div>
      <label
        style={{
          display: "block",
          fontSize: 12,
          fontWeight: 600,
          marginBottom: 4,
        }}
      >
        {label}
      </label>
      <input
        disabled
        type={type}
        placeholder={placeholder}
        style={{
          width: "100%",
          padding: "6px 8px",
          borderRadius: 4,
          border: "1px solid #ccc",
          fontSize: 13,
        }}
      />
    </div>
  );
}

const thStyle = {
  border: "1px solid #ddd",
  padding: "6px 8px",
  textAlign: "left",
  fontWeight: 600,
};

const tdStyle = {
  border: "1px solid #eee",
  padding: "6px 8px",
  whiteSpace: "nowrap",
};

const editButtonStyle = {
  padding: "4px 12px",
  borderRadius: 2,
  border: "2px solid #007bff",
  backgroundColor: "#fff",
  color: "#007bff",
  fontWeight: 600,
  fontSize: 11,
  cursor: "pointer",
};
