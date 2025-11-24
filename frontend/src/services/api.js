import axios from "axios";
const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:4000";

export async function uploadPdf(file) {
  const form = new FormData();
  form.append("file", file);
  const { data } = await axios.post(`${API_BASE}/api/files/upload`, form, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return { ...data, absoluteUrl: `${API_BASE}${data.url}` };
}
