const API_BASE = import.meta.env.VITE_API_BASE || "https://pdf-filler-new.onrender.com";

export async function loadDoc(docId) {
  const res = await fetch(`${API_BASE}/doc/${encodeURIComponent(docId)}`);
  if (!res.ok) throw new Error("Failed to load doc");
  return await res.json();
}

export async function saveDoc(docId, state) {
  const res = await fetch(`${API_BASE}/doc/${encodeURIComponent(docId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state || {}),
  });
  if (!res.ok) throw new Error("Failed to save doc");
  return await res.json();
}

export async function uploadPdfBlob(file) {
  const form = new FormData();
  form.append('file', file, 'edited.pdf');
  const res = await fetch(`${API_BASE}/api/files/upload`, { method: 'POST', body: form });
  if (!res.ok) throw new Error('Upload failed');
  return await res.json(); // { url }
}

export async function uploadImageBlob(file) {
  const form = new FormData();
  form.append('file', file, file.name || 'image.jpg');
  const res = await fetch(`${API_BASE}/api/files/upload`, { method: 'POST', body: form });
  if (!res.ok) throw new Error('Image upload failed');
  return await res.json(); // { url }
}


