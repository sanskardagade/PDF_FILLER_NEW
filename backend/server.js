import express from "express";
import http from "http";
import cors from "cors";
import path from "path";
import fs from "fs";
import multer from "multer";
import { Server as SocketIOServer } from "socket.io";

// Simple in-memory store: { [docId]: { boxes: { [pageNumber]: Box[] }, pdfUrl?: string } }
// Box shape mirrors frontend: { id, left, top, width, height, text, locked? }
const docs = new Map();

const app = express();

// CORS configuration - allow frontend from environment or all origins
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "*";
app.use(cors({
  origin: CLIENT_ORIGIN === "*" ? true : CLIENT_ORIGIN,
  credentials: true
}));
app.use(express.json());

// Ensure uploads directory exists and serve static files
const uploadsDir = path.resolve(process.cwd(), "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use("/uploads", express.static(uploadsDir));

// Multer storage for PDFs
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ts = Date.now();
    const safe = file.originalname.replace(/[^a-zA-Z0-9_.-]/g, "_");
    cb(null, `${ts}-${safe}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (_req, file, cb) => {
    if ((file.mimetype || "").toLowerCase() === "application/pdf") cb(null, true);
    else cb(new Error("Only PDF files are allowed"));
  },
});

// Health
app.get("/health", (_req, res) => res.json({ ok: true }));

// Load current state for a doc
app.get("/doc/:docId", (req, res) => {
  const { docId } = req.params;
  const state = docs.get(docId) || { boxes: {}, pdfUrl: undefined };
  res.json(state);
});

// Save state (optional; sockets already sync live)
app.post("/doc/:docId", (req, res) => {
  const { docId } = req.params;
  const payload = req.body || {};
  const prev = docs.get(docId) || { boxes: {}, pdfUrl: undefined };
  const next = { boxes: payload.boxes || prev.boxes || {}, pdfUrl: payload.pdfUrl ?? prev.pdfUrl };
  docs.set(docId, next);
  res.json({ ok: true });
});

// Upload endpoint: returns { url }
app.post("/api/files/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  const url = `/uploads/${req.file.filename}`;
  res.json({ url, name: req.file.originalname, size: req.file.size });
});

const server = http.createServer(app);

// Socket.IO CORS - allow frontend from environment or all origins
const SOCKET_ORIGIN = process.env.CLIENT_ORIGIN;
const socketCors = SOCKET_ORIGIN 
  ? { origin: SOCKET_ORIGIN, methods: ["GET", "POST"], credentials: true }
  : { origin: true, methods: ["GET", "POST"], credentials: true };

const io = new SocketIOServer(server, {
  cors: socketCors,
});

io.on("connection", (socket) => {
  socket.on("join", ({ docId }) => {
    if (!docId) return;
    socket.join(docId);
    if (!docs.has(docId)) docs.set(docId, { boxes: {} });
    const { boxes } = docs.get(docId);
    socket.emit("init_state", { boxes });
  });

  socket.on("add_box", ({ docId, pageNumber, box }) => {
    if (!docId || !pageNumber || !box) return;
    const state = docs.get(docId) || { boxes: {} };
    const arr = state.boxes[pageNumber] || [];
    state.boxes[pageNumber] = [...arr, box];
    docs.set(docId, state);
    socket.to(docId).emit("box_added", { pageNumber, box });
  });

  socket.on("update_box", ({ docId, pageNumber, boxId, patch }) => {
    if (!docId || !pageNumber || !boxId) return;
    const state = docs.get(docId) || { boxes: {} };
    const arr = state.boxes[pageNumber] || [];
    const i = arr.findIndex((b) => b.id === boxId);
    if (i < 0) return;
    arr[i] = { ...arr[i], ...patch };
    state.boxes[pageNumber] = arr;
    docs.set(docId, state);
    socket.to(docId).emit("box_updated", { pageNumber, boxId, patch });
  });

  socket.on("delete_box", ({ docId, pageNumber, boxId }) => {
    if (!docId || !pageNumber || !boxId) return;
    const state = docs.get(docId) || { boxes: {} };
    state.boxes[pageNumber] = (state.boxes[pageNumber] || []).filter((b) => b.id !== boxId);
    docs.set(docId, state);
    socket.to(docId).emit("box_deleted", { pageNumber, boxId });
  });

  socket.on("lock_box", ({ docId, boxId }) => {
    if (!docId || !boxId) return;
    socket.to(docId).emit("box_locked", { boxId });
  });

  socket.on("unlock_box", ({ docId, boxId }) => {
    if (!docId || !boxId) return;
    socket.to(docId).emit("box_unlocked", { boxId });
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`PDF Filler backend running on http://localhost:${PORT}`);
});


