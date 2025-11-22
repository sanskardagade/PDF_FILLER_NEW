import { Router } from "express";
import fs from "fs";
import path from "path";

const router = Router();

// directory to store annotations (JSON per document)
const dataDir = path.join(process.cwd(), "uploads", "_anno");

// ensure the folder exists
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

/**
 * GET /api/annotations/:id
 * Fetch saved annotations for a given document ID.
 */
router.get("/:id", (req, res) => {
  try {
    const filePath = path.join(dataDir, `${req.params.id}.json`);
    if (!fs.existsSync(filePath)) {
      return res.json({ boxes: {} }); // empty if no annotations yet
    }

    const json = JSON.parse(fs.readFileSync(filePath, "utf8"));
    res.json(json);
  } catch (err) {
    console.error("Error reading annotation file:", err);
    res.status(500).json({ error: "Failed to read annotation file" });
  }
});

/**
 * POST /api/annotations/:id
 * Save annotations (boxes) for a given document ID.
 */
router.post("/:id", (req, res) => {
  try {
    const filePath = path.join(dataDir, `${req.params.id}.json`);
    const payload = { boxes: req.body?.boxes || {} };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
    res.json({ ok: true });
  } catch (err) {
    console.error("Error writing annotation file:", err);
    res.status(500).json({ error: "Failed to save annotation file" });
  }
});

export default router;
