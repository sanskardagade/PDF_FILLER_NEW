import { useEffect, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { io } from "socket.io-client";
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;
// Bring in styles for text/annotation layers (silences react-pdf warnings)
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { loadDoc, saveDoc, uploadPdfBlob, uploadImageBlob } from "../api/docApi";

const SOCKET_URL = import.meta.env.VITE_API_BASE || "http://localhost:4000";

// small throttle helper so drag updates don't spam
const throttle = (fn, ms=30) => {
  let last = 0, timer;
  return (...args) => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now; fn(...args);
    } else {
      clearTimeout(timer);
      timer = setTimeout(() => { last = Date.now(); fn(...args); }, ms - (now - last));
    }
  };
};

export default function PdfEditor({ fileUrl, docId }) {
  const [numPages, setNumPages] = useState(null);
  const [scale, setScale] = useState(1.2);
  const [tool, setTool] = useState("select");
  const [boxes, setBoxes] = useState({});
  const wrapperRefs = useRef({});
  const socketRef = useRef(null);
  const [pdfBuffer, setPdfBuffer] = useState(null); // Uint8Array for pdf-lib
  const [editedUrl, setEditedUrl] = useState(null); // Updated PDF fileUrl
  const [showTextEdit, setShowTextEdit] = useState(false);
  const [editText, setEditText] = useState("");
  const [pdfTextItems, setPdfTextItems] = useState([]); // PDF text with positions, for the current page
  const [editBlock, setEditBlock] = useState(null); // {item, idx}
  const [boldToggle, setBoldToggle] = useState(false);
  const inlineEditorRef = useRef(null);
  const [pageSize, setPageSize] = useState({ width: 595, height: 842 });
  const [docVersion, setDocVersion] = useState(0);
  const [fontSizeInput, setFontSizeInput] = useState(12);
  const [fontColorHex, setFontColorHex] = useState('#000000');
  const [history, setHistory] = useState([]); // Array<{bytes: Uint8Array, url: string|null}>
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [images, setImages] = useState({}); // {pageNumber: [{id, left, top, width, height, imageUrl, imageBytes}]}
  const [selectedImageFile, setSelectedImageFile] = useState(null);
  const imageInputRef = useRef(null);
  const textBoxRefs = useRef({});

  // Ensure we always have valid PDF bytes for pdf-lib
  async function ensurePdfBytes() {
    if (pdfBuffer && pdfBuffer.length > 6) {
      const hdr = String.fromCharCode(pdfBuffer[0], pdfBuffer[1], pdfBuffer[2], pdfBuffer[3]);
      if (hdr === '%PDF') return pdfBuffer;
    }
    const src = editedUrl || fileUrl;
    if (!src) throw new Error('No PDF source available');
    const ab = await fetch(src).then(r => r.arrayBuffer());
    const bytes = new Uint8Array(ab);
    setPdfBuffer(bytes);
    return bytes;
  }

  // connect socket & join doc room
  useEffect(() => {
    if (!docId) return;
    const socket = io(SOCKET_URL, { transports: ["websocket"] });
    socketRef.current = socket;

    socket.emit("join", { docId });

    socket.on("init_state", ({ boxes, images }) => {
      setBoxes(boxes || {});
      setImages(images || {});
    });
    socket.on("box_added", ({ pageNumber, box }) => {
      setBoxes(prev => ({ ...prev, [pageNumber]: [...(prev[pageNumber]||[]), box] }));
    });
    socket.on("box_updated", ({ pageNumber, boxId, patch }) => {
      setBoxes(prev => {
        const arr = prev[pageNumber] || [];
        const i = arr.findIndex(b => b.id === boxId);
        if (i < 0) return prev;
        const clone = [...arr]; clone[i] = { ...clone[i], ...patch };
        return { ...prev, [pageNumber]: clone };
      });
    });
    socket.on("box_deleted", ({ pageNumber, boxId }) => {
      setBoxes(prev => ({ ...prev, [pageNumber]: (prev[pageNumber]||[]).filter(b => b.id !== boxId) }));
    });

    // optional lock visuals
    socket.on("box_locked", ({ boxId }) => {
      setBoxes(prev => {
        const copy = {};
        for (const [page, arr] of Object.entries(prev)) {
          copy[page] = arr.map(b => b.id===boxId ? { ...b, locked:true } : b);
        }
        return copy;
      });
    });
    socket.on("box_unlocked", ({ boxId }) => {
      setBoxes(prev => {
        const copy = {};
        for (const [page, arr] of Object.entries(prev)) {
          copy[page] = arr.map(b => b.id===boxId ? { ...b, locked:false } : b);
        }
        return copy;
      });
    });

    return () => {
      socket.disconnect();
    };
  }, [docId]);

  // Load persisted boxes/pdf once when docId changes (in addition to socket init)
  useEffect(() => {
    if (!docId) return;
    let cancelled = false;
    loadDoc(docId).then((state) => {
      if (cancelled || !state) return;
      if (state.boxes) setBoxes(state.boxes);
      if (state.images) setImages(state.images);
      if (state.pdfUrl) setEditedUrl(`${SOCKET_URL}${state.pdfUrl}`);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [docId]);

  // Persist boxes and images when window unloads or doc changes
  useEffect(() => {
    if (!docId) return;
    const handler = () => { try { saveDoc(docId, { boxes, images }); } catch {}
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [docId, boxes, images]);

  useEffect(() => {
    setBoxes({});
    setImages({});
    setNumPages(null);
    setEditedUrl(null); // Reset edited file
    setPdfTextItems([]); // Reset when file changes
    setEditBlock(null);
    // Fetch as ArrayBuffer and normalize to Uint8Array for pdf-lib usage
    if (fileUrl) {
      fetch(fileUrl).then(res => res.arrayBuffer()).then(buf => {
        const bytes = new Uint8Array(buf);
        setPdfBuffer(bytes);
        // Clone bytes for history to avoid detached ArrayBuffer issues
        setHistory([{ bytes: new Uint8Array(bytes), url: fileUrl || null }]);
        setHistoryIndex(0);
        extractTextItems(bytes, 1); // For now: just page 1
      });
    }
  }, [fileUrl]);

  // If we load an already-edited PDF from backend (editedUrl), fetch bytes so pdf-lib can edit
  useEffect(() => {
    if (!editedUrl) return;
    if (editedUrl.startsWith('blob:')) return; // already have bytes for blob URL
    fetch(editedUrl).then(res => res.arrayBuffer()).then(buf => {
      const bytes = new Uint8Array(buf);
      setPdfBuffer(bytes);
      extractTextItems(bytes, 1);
    }).catch(() => {});
  }, [editedUrl]);

  // Function to extract text items (pageNum=1) with color information
  async function extractTextItems(pdfArrayBuffer, pageNum=1) {
    // Use the same worker version already set from pdfjs-dist import above
    const pdf = await pdfjsLib.getDocument({ data: pdfArrayBuffer }).promise;
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    setPageSize({ width: viewport.width, height: viewport.height });
    const textContent = await page.getTextContent();
    
    // Get operators to extract color information
    const ops = await page.getOperatorList();
    let currentColor = { r: 0, g: 0, b: 0 }; // Default black
    
    // Parse operators to find color
    // Normalize color values to 0-1 range for consistent storage
    const normalizeColorValue = (val) => {
      const num = typeof val === 'number' ? val : parseFloat(val);
      if (isNaN(num)) return 0;
      // PDF colors are typically in 0-1 range, but ensure they are
      return Math.max(0, Math.min(1, num));
    };
    
    for (let i = 0; i < ops.fnArray.length; i++) {
      const op = ops.fnArray[i];
      if (op === pdfjsLib.OPS.setFillRGBColor && ops.argsArray[i] && ops.argsArray[i].length >= 3) {
        currentColor = {
          r: normalizeColorValue(ops.argsArray[i][0]),
          g: normalizeColorValue(ops.argsArray[i][1]),
          b: normalizeColorValue(ops.argsArray[i][2])
        };
      } else if (op === pdfjsLib.OPS.setFillGrayColor && ops.argsArray[i] && ops.argsArray[i].length >= 1) {
        const gray = normalizeColorValue(ops.argsArray[i][0]);
        currentColor = { r: gray, g: gray, b: gray };
      } else if (op === pdfjsLib.OPS.setFillColorSpace && ops.argsArray[i]) {
        // Reset to default when color space changes
        currentColor = { r: 0, g: 0, b: 0 };
      }
    }
    
    // Map to [{str, x, y, width, height, fontName, fontSize, color}]
    const items = textContent.items.map((item, idx) => {
      const [, , , d, e, f] = item.transform;
      
      // Try to extract color from operators (simplified - uses last color before this text)
      // In practice, we'll need to match operators to text items more precisely
      const fontName = item.fontName || 'Helvetica';
      const isBold = /Bold|Semibold|Medium/gi.test(fontName);
      const isItalic = /Italic|Oblique/gi.test(fontName);
      
      return {
        str: item.str,
        x: e,
        y: f,
        fontSize: Math.abs(d),
        width: item.width,
        height: item.height,
        fontName: fontName,
        isBold,
        isItalic,
        color: currentColor, // Will be improved
      };
    });
    setPdfTextItems(items);
  }
  
  // Helper to convert RGB color to hex
  function rgbToHex(r, g, b) {
    const toHex = (n) => {
      const hex = Math.round(Math.max(0, Math.min(255, n * 255))).toString(16);
      return hex.length === 1 ? '0' + hex : hex;
    };
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  function onDocLoadSuccess({ numPages }) {
    setNumPages(numPages);
  }

  // --- Demo add text at fixed loc ---
  async function handleAddPdfText() {
    const bytes = await ensurePdfBytes();
    const pdfDoc = await PDFDocument.load(bytes);
    const page = pdfDoc.getPages()[0];
    const size = Number(fontSizeInput) || 12;
    const { r, g, b } = hexToRgb01(fontColorHex);
    page.drawText(editText || 'Edited Text!', {
      x: 50, y: 600,
      size,
      color: rgb(r, g, b),
    });
    const newBytes = await pdfDoc.save(); // Uint8Array
    const blob = new Blob([newBytes], { type: 'application/pdf' });
    try {
      const { url } = await uploadPdfBlob(blob);
      const absolute = `${SOCKET_URL}${url}?v=${Date.now()}`;
      setEditedUrl(absolute);
      setPdfBuffer(newBytes);
      pushHistory(newBytes, absolute);
      if (docId) await saveDoc(docId, { boxes, pdfUrl: url });
      setDocVersion(v => v + 1);
    } catch {
      const url = URL.createObjectURL(blob);
      setEditedUrl(url);
      setPdfBuffer(newBytes);
      pushHistory(newBytes, url);
      setDocVersion(v => v + 1);
    }
    setShowTextEdit(false);
    setEditText("");
    await extractTextItems(newBytes, 1);
  }

  // Inline save of edited block (cover old, write new) with original font, size, and color
  async function handleSaveTextEditInline(newStr) {
    if (!editBlock) return;
    const bytes = await ensurePdfBytes();
    const pdfDoc = await PDFDocument.load(bytes);
    const page = pdfDoc.getPages()[0];

    // Use original font properties - don't override with user inputs
    const item = editBlock.item;
    const originalFontSize = item.fontSize;
    const originalIsBold = item.isBold || false;
    const originalIsItalic = item.isItalic || false;
    
    // Determine font based on original properties
    let font;
    if (originalIsBold && originalIsItalic) {
      font = await pdfDoc.embedFont(StandardFonts.HelveticaBoldOblique);
    } else if (originalIsBold) {
      font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    } else if (originalIsItalic) {
      font = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
    } else {
      font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    }

    // Use original font size (not user input)
    const fontSizeToUse = originalFontSize;
    
    // Use original color if available, otherwise default to black
    // Ensure color values are numbers in 0-1 range (pdf-lib requirement)
    const originalColor = item.color || { r: 0, g: 0, b: 0 };
    const normalizeColor = (val) => {
      if (typeof val !== 'number') {
        const num = parseFloat(val);
        if (isNaN(num)) return 0;
        // If value is > 1, assume it's 0-255 range and normalize
        return num > 1 ? num / 255 : num;
      }
      // If value is > 1, assume it's 0-255 range and normalize
      return val > 1 ? val / 255 : val;
    };
    
    const r = Math.max(0, Math.min(1, normalizeColor(originalColor.r)));
    const g = Math.max(0, Math.min(1, normalizeColor(originalColor.g)));
    const b = Math.max(0, Math.min(1, normalizeColor(originalColor.b)));
    
    const textColor = rgb(r, g, b);

    // Calculate precise text dimensions for covering old text
    // We need to cover ONLY the text area, no more, no less
    const oldTextWidth = font.widthOfTextAtSize(item.str, fontSizeToUse);
    const newTextWidth = font.widthOfTextAtSize(newStr, fontSizeToUse);
    
    // Use the maximum width needed (old or new text), add tiny margin for safety
    const textWidth = Math.max(oldTextWidth, newTextWidth) + 2;
    
    // Use the actual measured height from the extracted text item
    // This gives us the real height of the text glyphs
    const actualHeight = item.height || (fontSizeToUse * 0.7);
    
    // In PDF coordinates, y is the baseline (bottom of text)
    // Text typically extends from baseline upward
    // We need to position the rectangle to cover the text properly
    const baselineY = item.y;
    
    // Text extends upward from baseline
    // Adjust Y to start slightly below baseline to cover descenders if any
    // Then height should cover up to cap height
    const coverY = baselineY - (actualHeight * 0.2); // Small padding for descenders
    const coverHeight = actualHeight * 1.1; // Cover actual height plus small margin
    
    // Draw a very precise white rectangle ONLY over the exact text area
    // Make it tight to prevent covering tables/lines while fully covering old text
    page.drawRectangle({
      x: item.x - 1, // Tiny left margin
      y: coverY,
      width: textWidth,
      height: coverHeight,
      color: rgb(1, 1, 1), // White
      opacity: 1.0,
    });

    // Write new text at same baseline position with original properties
    page.drawText(newStr, {
      x: item.x,
      y: item.y,
      size: fontSizeToUse, // Use original font size
      font, // Use original font style
      color: textColor, // Use original color
    });

    const newBytes = await pdfDoc.save(); // Uint8Array
    const blob = new Blob([newBytes], { type: 'application/pdf' });
    try {
      const { url } = await uploadPdfBlob(blob);
      const absolute = `${SOCKET_URL}${url}?v=${Date.now()}`;
      setEditedUrl(absolute);
      setPdfBuffer(newBytes);
      pushHistory(newBytes, absolute);
      if (docId) await saveDoc(docId, { boxes, pdfUrl: url });
      setDocVersion(v => v + 1);
    } catch {
      const url = URL.createObjectURL(blob);
      setEditedUrl(url);
      setPdfBuffer(newBytes);
      pushHistory(newBytes, url);
      setDocVersion(v => v + 1);
    }
    setEditBlock(null);
    // Re-extract to refresh clickable zones
    await extractTextItems(newBytes, 1);
  }

  // Convert #RRGGBB to 0..1 rgb for pdf-lib
  function hexToRgb01(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '#000000');
    if (!m) return { r: 0, g: 0, b: 0 };
    return { r: parseInt(m[1],16)/255, g: parseInt(m[2],16)/255, b: parseInt(m[3],16)/255 };
  }

  function pushHistory(bytes, url) {
    // Clone bytes to avoid detached ArrayBuffer issues
    const clonedBytes = new Uint8Array(bytes);
    setHistory(prev => {
      const trimmed = prev.slice(0, historyIndex + 1);
      const next = [...trimmed, { bytes: clonedBytes, url }];
      setHistoryIndex(next.length - 1);
      return next;
    });
  }

  const canUndo = historyIndex > 0;
  const canRedo = historyIndex >= 0 && historyIndex < history.length - 1;

  function handleUndo() {
    if (!canUndo) return;
    const idx = historyIndex - 1;
    const entry = history[idx];
    setHistoryIndex(idx);
    // Clone bytes to avoid detached ArrayBuffer issues
    const clonedBytes = new Uint8Array(entry.bytes);
    setPdfBuffer(clonedBytes);
    const url = URL.createObjectURL(new Blob([clonedBytes], { type: 'application/pdf' }));
    setEditedUrl(url);
    setDocVersion(v => v + 1);
    extractTextItems(clonedBytes, 1);
  }

  function handleRedo() {
    if (!canRedo) return;
    const idx = historyIndex + 1;
    const entry = history[idx];
    setHistoryIndex(idx);
    // Clone bytes to avoid detached ArrayBuffer issues
    const clonedBytes = new Uint8Array(entry.bytes);
    setPdfBuffer(clonedBytes);
    const url = URL.createObjectURL(new Blob([clonedBytes], { type: 'application/pdf' }));
    setEditedUrl(url);
    setDocVersion(v => v + 1);
    extractTextItems(clonedBytes, 1);
  }

  const addTextBox = async (pageNumber, e, containerEl=null) => {
    if (tool !== "text") return;
    e.stopPropagation();
    const wrap = containerEl || wrapperRefs.current[pageNumber];
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const left = e.clientX - rect.left;
    const top  = e.clientY - rect.top;

    const fontSize = Number(fontSizeInput) || 12;
    const box = {
      id: crypto.randomUUID(),
      left, 
      top, 
      width: 180, 
      height: fontSize + 8, // Height based on font size
      text: "Type...",
      fontSize,
      color: fontColorHex,
      isBold: boldToggle,
    };

    setBoxes(prev => ({ ...prev, [pageNumber]: [...(prev[pageNumber]||[]), box] }));
    socketRef.current?.emit("add_box", { docId, pageNumber, box });
    
    // Auto-focus the new text box
    setTimeout(() => {
      const textBoxEl = textBoxRefs.current[box.id];
      if (textBoxEl) {
        textBoxEl.focus();
        // Select the placeholder text
        const range = document.createRange();
        range.selectNodeContents(textBoxEl);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }, 50);
  };

  const updateBox = throttle((pageNumber, boxId, patch) => {
    setBoxes(prev => {
      const arr = prev[pageNumber] || [];
      const i = arr.findIndex(b => b.id === boxId);
      if (i < 0) return prev;
      const clone = [...arr]; clone[i] = { ...clone[i], ...patch };
      return { ...prev, [pageNumber]: clone };
    });
    socketRef.current?.emit("update_box", { docId, pageNumber, boxId, patch });
  }, 30);

  // Rebuild PDF with all text boxes and images
  async function rebuildPdfWithAllContent(boxesToUse = null, imagesToUse = null) {
    try {
      const boxesToEmbed = boxesToUse || boxes;
      const imagesToEmbed = imagesToUse || images;
      
      // Always start from original PDF
      const src = fileUrl;
      if (!src) {
        const fallbackSrc = editedUrl;
        if (!fallbackSrc) return;
        const ab = await fetch(fallbackSrc).then(r => r.arrayBuffer());
        const bytes = new Uint8Array(ab);
        const pdfDoc = await PDFDocument.load(bytes);
        await embedAllContent(pdfDoc, boxesToEmbed, imagesToEmbed);
        return;
      }
      
      const ab = await fetch(src).then(r => r.arrayBuffer());
      const bytes = new Uint8Array(ab);
      const pdfDoc = await PDFDocument.load(bytes);
      await embedAllContent(pdfDoc, boxesToEmbed, imagesToEmbed);
    } catch (err) {
      console.error('Failed to rebuild PDF with all content:', err);
    }
  }
  
  // Helper function to embed all content (text boxes and images) into PDF
  async function embedAllContent(pdfDoc, boxesToEmbed, imagesToEmbed) {
    try {
      // Embed text boxes first
      const allPages = Object.keys(boxesToEmbed);
      for (const pageNum of allPages) {
        const pageIndex = parseInt(pageNum) - 1;
        if (pageIndex >= 0 && pageIndex < pdfDoc.getPageCount()) {
          const page = pdfDoc.getPages()[pageIndex];
          const pageHeight = page.getHeight();
          const pageBoxes = boxesToEmbed[pageNum] || [];
          
          for (const box of pageBoxes) {
            if (!box.text || box.text.trim() === "" || box.text === "Type...") continue;
            
            // Use box-specific font settings or fallback to global settings
            const boxFontSize = box.fontSize || Number(fontSizeInput) || 12;
            const boxColor = box.color || fontColorHex;
            const boxIsBold = box.isBold !== undefined ? box.isBold : boldToggle;
            
            const { r, g, b } = hexToRgb01(boxColor);
            const textColor = rgb(r, g, b);
            const font = await pdfDoc.embedFont(boxIsBold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica);
            
            // Convert screen coordinates to PDF coordinates
            const pdfX = box.left / scale;
            const pdfY = pageHeight - (box.top / scale) - (box.height / scale);
            
            // Draw text in PDF
            page.drawText(box.text, {
              x: pdfX,
              y: pdfY + boxFontSize, // Adjust for baseline
              size: boxFontSize,
              font,
              color: textColor,
            });
          }
        }
      }
      
      // Embed images
      const allImagePages = Object.keys(imagesToEmbed);
      for (const pageNum of allImagePages) {
        const pageIndex = parseInt(pageNum) - 1;
        if (pageIndex >= 0 && pageIndex < pdfDoc.getPageCount()) {
          const page = pdfDoc.getPages()[pageIndex];
          const pageHeight = page.getHeight();
          const imagesOnPage = imagesToEmbed[pageNum] || [];
          
          for (const img of imagesOnPage) {
            const pdfX = img.left / scale;
            const pdfY = pageHeight - (img.top / scale) - (img.height / scale);
            const pdfWidth = img.width / scale;
            const pdfHeight = img.height / scale;

            let pdfImage;
            try {
              if (img.imageType === 'image/png') {
                pdfImage = await pdfDoc.embedPng(img.imageBytes);
              } else if (img.imageType === 'image/jpeg' || img.imageType === 'image/jpg') {
                pdfImage = await pdfDoc.embedJpg(img.imageBytes);
              } else {
                pdfImage = await pdfDoc.embedPng(img.imageBytes);
              }
            } catch {
              pdfImage = await pdfDoc.embedPng(img.imageBytes);
            }

            page.drawImage(pdfImage, {
              x: Math.max(0, pdfX),
              y: Math.max(0, pdfY),
              width: pdfWidth,
              height: pdfHeight,
            });
          }
        }
      }

      const newBytes = await pdfDoc.save();
      const blob = new Blob([newBytes], { type: 'application/pdf' });
      try {
        const { url } = await uploadPdfBlob(blob);
        const absolute = `${SOCKET_URL}${url}?v=${Date.now()}`;
        setEditedUrl(absolute);
        setPdfBuffer(newBytes);
        pushHistory(newBytes, absolute);
        if (docId) await saveDoc(docId, { boxes: boxesToEmbed, images: imagesToEmbed, pdfUrl: url });
        setDocVersion(v => v + 1);
      } catch {
        const url = URL.createObjectURL(blob);
        setEditedUrl(url);
        setPdfBuffer(newBytes);
        pushHistory(newBytes, url);
        setDocVersion(v => v + 1);
      }
      await extractTextItems(newBytes, 1);
    } catch (err) {
      console.error('Failed to embed all content:', err);
    }
  }

  const deleteBox = async (pageNumber, boxId) => {
    // Remove from state and get updated boxes
    let updatedBoxes;
    setBoxes(prev => {
      const remaining = (prev[pageNumber] || []).filter(b => b.id !== boxId);
      updatedBoxes = { ...prev, [pageNumber]: remaining };
      return updatedBoxes;
    });
    
    socketRef.current?.emit("delete_box", { docId, pageNumber, boxId });
    
    // Rebuild PDF with remaining boxes and images
    await rebuildPdfWithAllContent(updatedBoxes, images);
  };

  const lock = (boxId) => socketRef.current?.emit("lock_box", { docId, boxId });
  const unlock = (boxId) => socketRef.current?.emit("unlock_box", { docId, boxId });

  // Image handling functions - simplified
  function handleImageFileSelect(e) {
    const file = e.target.files?.[0];
    if (!file) {
      setTool("select");
      return;
    }
    if (!file.type.startsWith('image/')) {
      alert('Please select an image file (PNG, JPG, etc.)');
      setTool("select");
      return;
    }
    setSelectedImageFile(file);
    setTool("image");
    // User will now click on PDF to place it
  }

  async function addImage(pageNumber, e) {
    if (tool !== "image" || !selectedImageFile) {
      return;
    }
    
    e.stopPropagation();
    const wrap = wrapperRefs.current[pageNumber];
    if (!wrap) return;
    
    const rect = wrap.getBoundingClientRect();
    const left = e.clientX - rect.left;
    const top = e.clientY - rect.top;

    try {
      // Create image preview URL
      const imageUrl = URL.createObjectURL(selectedImageFile);
      
      // Read image as bytes for embedding
      const imageBytes = await selectedImageFile.arrayBuffer();

      // Get actual image dimensions
      const img = new Image();
      img.src = imageUrl;
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        setTimeout(reject, 5000); // 5 second timeout
      });

      // Calculate size to fit nicely (default 150px max on screen)
      const maxScreenSize = 150;
      let screenWidth = img.width;
      let screenHeight = img.height;
      if (screenWidth > maxScreenSize || screenHeight > maxScreenSize) {
        const ratio = Math.min(maxScreenSize / screenWidth, maxScreenSize / screenHeight);
        screenWidth = screenWidth * ratio;
        screenHeight = screenHeight * ratio;
      }

      const imageObj = {
        id: crypto.randomUUID(),
        left,
        top,
        width: screenWidth,
        height: screenHeight,
        imageUrl,
        imageBytes: new Uint8Array(imageBytes),
        imageType: selectedImageFile.type,
      };

      // Add to state
      const updatedImages = { ...images, [pageNumber]: [...(images[pageNumber]||[]), imageObj] };
      setImages(updatedImages);
      socketRef.current?.emit("add_image", { docId, pageNumber, image: imageObj });
      
      // Embed image in PDF (preserves all text boxes)
      await rebuildPdfWithAllContent(boxes, updatedImages);
      
      // Reset tool and selected file
      setSelectedImageFile(null);
      if (imageInputRef.current) imageInputRef.current.value = '';
      setTool("select");
    } catch (err) {
      console.error('Failed to add image:', err);
      alert('Failed to load image. Please try again.');
      setSelectedImageFile(null);
      setTool("select");
    }
  }

  async function embedImageInPdf(pageNumber, imageObj) {
    try {
      const bytes = await ensurePdfBytes();
      const pdfDoc = await PDFDocument.load(bytes);
      const page = pdfDoc.getPages()[pageNumber - 1];
      const pageHeight = page.getHeight();
      
      // Convert screen coordinates to PDF coordinates
      // Screen: top-left origin, PDF: bottom-left origin
      const pdfX = imageObj.left / scale;
      const pdfY = pageHeight - (imageObj.top / scale) - (imageObj.height / scale);
      const pdfWidth = imageObj.width / scale;
      const pdfHeight = imageObj.height / scale;

      // Embed image based on type
      let pdfImage;
      try {
        if (imageObj.imageType === 'image/png') {
          pdfImage = await pdfDoc.embedPng(imageObj.imageBytes);
        } else if (imageObj.imageType === 'image/jpeg' || imageObj.imageType === 'image/jpg') {
          pdfImage = await pdfDoc.embedJpg(imageObj.imageBytes);
        } else {
          // Default to PNG for other formats
          pdfImage = await pdfDoc.embedPng(imageObj.imageBytes);
        }
      } catch (embedErr) {
        console.error('Image embed error:', embedErr);
        // Try PNG as fallback
        pdfImage = await pdfDoc.embedPng(imageObj.imageBytes);
      }

      // Draw image on PDF
      page.drawImage(pdfImage, {
        x: Math.max(0, pdfX),
        y: Math.max(0, pdfY),
        width: pdfWidth,
        height: pdfHeight,
      });

      const newBytes = await pdfDoc.save();
      const blob = new Blob([newBytes], { type: 'application/pdf' });
      try {
        const { url } = await uploadPdfBlob(blob);
        const absolute = `${SOCKET_URL}${url}?v=${Date.now()}`;
        setEditedUrl(absolute);
        setPdfBuffer(newBytes);
        pushHistory(newBytes, absolute);
        if (docId) {
          const currentImages = { ...images, [pageNumber]: [...(images[pageNumber]||[]), imageObj] };
          await saveDoc(docId, { boxes, images: currentImages, pdfUrl: url });
        }
        setDocVersion(v => v + 1);
      } catch {
        const url = URL.createObjectURL(blob);
        setEditedUrl(url);
        setPdfBuffer(newBytes);
        pushHistory(newBytes, url);
        setDocVersion(v => v + 1);
      }
      await extractTextItems(newBytes, 1);
    } catch (err) {
      console.error('Failed to embed image:', err);
      alert('Failed to embed image in PDF: ' + err.message);
    }
  }

  const updateImage = throttle((pageNumber, imageId, patch) => {
    setImages(prev => {
      const arr = prev[pageNumber] || [];
      const i = arr.findIndex(img => img.id === imageId);
      if (i < 0) return prev;
      const clone = [...arr]; clone[i] = { ...clone[i], ...patch };
      return { ...prev, [pageNumber]: clone };
    });
    socketRef.current?.emit("update_image", { docId, pageNumber, imageId, patch });
  }, 30);

  // Re-embed all images on a page (useful after moving/resizing)
  async function reEmbedAllImagesOnPage(pageNumber, imagesToUse = null) {
    try {
      const imagesToEmbed = imagesToUse || images;
      const pageImages = imagesToEmbed[pageNumber] || [];
      if (pageImages.length === 0) {
        // If no images on this page, we need to rebuild PDF without images
        // Load original PDF and re-embed all images from other pages
        await rebuildPdfWithImages(imagesToEmbed);
        return;
      }
      
      // Start from original PDF or current edited PDF
      const src = fileUrl || editedUrl;
      if (!src) return;
      
      const ab = await fetch(src).then(r => r.arrayBuffer());
      const bytes = new Uint8Array(ab);
      const pdfDoc = await PDFDocument.load(bytes);
      
      // Re-embed all images from all pages
      const allPages = Object.keys(imagesToEmbed);
      for (const pageNum of allPages) {
        const pageIndex = parseInt(pageNum) - 1;
        const page = pdfDoc.getPages()[pageIndex];
        const pageHeight = page.getHeight();
        const imagesOnPage = imagesToEmbed[pageNum] || [];
        
        for (const img of imagesOnPage) {
          const pdfX = img.left / scale;
          const pdfY = pageHeight - (img.top / scale) - (img.height / scale);
          const pdfWidth = img.width / scale;
          const pdfHeight = img.height / scale;

          let pdfImage;
          try {
            if (img.imageType === 'image/png') {
              pdfImage = await pdfDoc.embedPng(img.imageBytes);
            } else if (img.imageType === 'image/jpeg' || img.imageType === 'image/jpg') {
              pdfImage = await pdfDoc.embedJpg(img.imageBytes);
            } else {
              pdfImage = await pdfDoc.embedPng(img.imageBytes);
            }
          } catch {
            pdfImage = await pdfDoc.embedPng(img.imageBytes);
          }

          page.drawImage(pdfImage, {
            x: Math.max(0, pdfX),
            y: Math.max(0, pdfY),
            width: pdfWidth,
            height: pdfHeight,
          });
        }
      }

      const newBytes = await pdfDoc.save();
      const blob = new Blob([newBytes], { type: 'application/pdf' });
      try {
        const { url } = await uploadPdfBlob(blob);
        const absolute = `${SOCKET_URL}${url}?v=${Date.now()}`;
        setEditedUrl(absolute);
        setPdfBuffer(newBytes);
        pushHistory(newBytes, absolute);
        if (docId) await saveDoc(docId, { boxes, images: imagesToEmbed, pdfUrl: url });
        setDocVersion(v => v + 1);
      } catch {
        const url = URL.createObjectURL(blob);
        setEditedUrl(url);
        setPdfBuffer(newBytes);
        pushHistory(newBytes, url);
        setDocVersion(v => v + 1);
      }
      await extractTextItems(newBytes, 1);
    } catch (err) {
      console.error('Failed to re-embed images:', err);
    }
  }

  // Rebuild PDF from original with all current images
  async function rebuildPdfWithImages(imagesToUse = null) {
    try {
      const imagesToEmbed = imagesToUse || images;
      // Always start from original PDF to avoid duplicate images
      const src = fileUrl;
      if (!src) {
        // Fallback to editedUrl if fileUrl not available
        const fallbackSrc = editedUrl;
        if (!fallbackSrc) return;
        const ab = await fetch(fallbackSrc).then(r => r.arrayBuffer());
        const bytes = new Uint8Array(ab);
        const pdfDoc = await PDFDocument.load(bytes);
        
        // Clear page and re-embed (simplified - we'll still have the issue but better than nothing)
        const allPages = Object.keys(imagesToEmbed);
        for (const pageNum of allPages) {
          const pageIndex = parseInt(pageNum) - 1;
          if (pageIndex >= 0 && pageIndex < pdfDoc.getPageCount()) {
            const page = pdfDoc.getPages()[pageIndex];
            const pageHeight = page.getHeight();
            const imagesOnPage = imagesToEmbed[pageNum] || [];
            
            for (const img of imagesOnPage) {
              const pdfX = img.left / scale;
              const pdfY = pageHeight - (img.top / scale) - (img.height / scale);
              const pdfWidth = img.width / scale;
              const pdfHeight = img.height / scale;

              let pdfImage;
              try {
                if (img.imageType === 'image/png') {
                  pdfImage = await pdfDoc.embedPng(img.imageBytes);
                } else if (img.imageType === 'image/jpeg' || img.imageType === 'image/jpg') {
                  pdfImage = await pdfDoc.embedJpg(img.imageBytes);
                } else {
                  pdfImage = await pdfDoc.embedPng(img.imageBytes);
                }
              } catch {
                pdfImage = await pdfDoc.embedPng(img.imageBytes);
              }

              page.drawImage(pdfImage, {
                x: Math.max(0, pdfX),
                y: Math.max(0, pdfY),
                width: pdfWidth,
                height: pdfHeight,
              });
            }
          }
        }
        
        const newBytes = await pdfDoc.save();
        const blob = new Blob([newBytes], { type: 'application/pdf' });
        try {
          const { url } = await uploadPdfBlob(blob);
          const absolute = `${SOCKET_URL}${url}?v=${Date.now()}`;
          setEditedUrl(absolute);
          setPdfBuffer(newBytes);
          pushHistory(newBytes, absolute);
          if (docId) await saveDoc(docId, { boxes, images: imagesToEmbed, pdfUrl: url });
          setDocVersion(v => v + 1);
        } catch {
          const url = URL.createObjectURL(blob);
          setEditedUrl(url);
          setPdfBuffer(newBytes);
          pushHistory(newBytes, url);
          setDocVersion(v => v + 1);
        }
        await extractTextItems(newBytes, 1);
        return;
      }
      
      const ab = await fetch(src).then(r => r.arrayBuffer());
      const bytes = new Uint8Array(ab);
      const pdfDoc = await PDFDocument.load(bytes);
      
      // Re-embed all images from all pages
      const allPages = Object.keys(imagesToEmbed);
      for (const pageNum of allPages) {
        const pageIndex = parseInt(pageNum) - 1;
        const page = pdfDoc.getPages()[pageIndex];
        const pageHeight = page.getHeight();
        const imagesOnPage = imagesToEmbed[pageNum] || [];
        
        for (const img of imagesOnPage) {
          const pdfX = img.left / scale;
          const pdfY = pageHeight - (img.top / scale) - (img.height / scale);
          const pdfWidth = img.width / scale;
          const pdfHeight = img.height / scale;

          let pdfImage;
          try {
            if (img.imageType === 'image/png') {
              pdfImage = await pdfDoc.embedPng(img.imageBytes);
            } else if (img.imageType === 'image/jpeg' || img.imageType === 'image/jpg') {
              pdfImage = await pdfDoc.embedJpg(img.imageBytes);
            } else {
              pdfImage = await pdfDoc.embedPng(img.imageBytes);
            }
          } catch {
            pdfImage = await pdfDoc.embedPng(img.imageBytes);
          }

          page.drawImage(pdfImage, {
            x: Math.max(0, pdfX),
            y: Math.max(0, pdfY),
            width: pdfWidth,
            height: pdfHeight,
          });
        }
      }

      const newBytes = await pdfDoc.save();
      const blob = new Blob([newBytes], { type: 'application/pdf' });
      try {
        const { url } = await uploadPdfBlob(blob);
        const absolute = `${SOCKET_URL}${url}?v=${Date.now()}`;
        setEditedUrl(absolute);
        setPdfBuffer(newBytes);
        pushHistory(newBytes, absolute);
        if (docId) await saveDoc(docId, { boxes, images: imagesToEmbed, pdfUrl: url });
        setDocVersion(v => v + 1);
      } catch {
        const url = URL.createObjectURL(blob);
        setEditedUrl(url);
        setPdfBuffer(newBytes);
        pushHistory(newBytes, url);
        setDocVersion(v => v + 1);
      }
      await extractTextItems(newBytes, 1);
    } catch (err) {
      console.error('Failed to rebuild PDF with images:', err);
    }
  }

  const deleteImage = async (pageNumber, imageId) => {
    // Remove from state and get updated images
    let updatedImages;
    setImages(prev => {
      const remaining = (prev[pageNumber] || []).filter(img => img.id !== imageId);
      updatedImages = { ...prev, [pageNumber]: remaining };
      return updatedImages;
    });
    
    socketRef.current?.emit("delete_image", { docId, pageNumber, imageId });
    
    // Rebuild PDF with remaining images and all text boxes
    await rebuildPdfWithAllContent(boxes, updatedImages);
  };

  // Download the current edited PDF
  async function handleDownload() {
    try {
      let blob;
      if (pdfBuffer && pdfBuffer.length > 0) {
        // Use current in-memory buffer (most up-to-date)
        blob = new Blob([pdfBuffer], { type: 'application/pdf' });
      } else {
        // Fallback: fetch from URL
        const url = editedUrl || fileUrl;
        if (!url) {
          alert('No PDF available to download');
          return;
        }
        const response = await fetch(url);
        blob = await response.blob();
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'edited-document.pdf';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Download failed:', err);
      alert('Failed to download PDF');
    }
  }

  // focus inline editor when set
  useEffect(() => {
    if (inlineEditorRef.current) {
      inlineEditorRef.current.focus();
      const range = document.createRange();
      range.selectNodeContents(inlineEditorRef.current);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }, [editBlock]);

  // Intentionally do not bind to native text layer clicks.
  // We open editors only via our invisible overlay rectangles, which
  // are derived from pdf.js text extraction and thus have stable
  // coordinates for pdf-lib edits.

  return (
    <div className="viewer">
      <div className="toolbar">
        <strong>Tool:</strong>
        <button onClick={() => setTool("select")} disabled={tool==="select"}>Select</button>
        <button onClick={() => setTool("text")} disabled={tool==="text"}>Text</button>
        <button 
          onClick={() => {
            if (tool === "image") {
              setTool("select");
              setSelectedImageFile(null);
            } else {
              imageInputRef.current?.click();
            }
          }} 
          style={{ marginLeft: 4, backgroundColor: tool === "image" ? "#1976d2" : "", color: tool === "image" ? "white" : "" }}
        >
          {tool === "image" ? "Cancel Image" : "Image/Signature"}
        </button>
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={handleImageFileSelect}
        />
        <button onClick={() => setTool("delete")} disabled={tool==="delete"}>Delete</button>
        <button onClick={()=>setBoldToggle(b=>!b)} style={{ marginLeft: 12, fontWeight: boldToggle?700:400 }}>
          B
        </button>
        <input type="number" min={6} max={96} value={fontSizeInput}
               onChange={(e)=>setFontSizeInput(e.target.value)}
               style={{ width: 64, marginLeft: 8 }} title="Font size" />
        <input type="color" value={fontColorHex} onChange={(e)=>setFontColorHex(e.target.value)}
               style={{ marginLeft: 6 }} title="Font color" />
        <button onClick={handleUndo} disabled={!canUndo} style={{ marginLeft: 8 }}>Undo</button>
        <button onClick={handleRedo} disabled={!canRedo} style={{ marginLeft: 4 }}>Redo</button>
        <button onClick={handleDownload} style={{ marginLeft: 12, backgroundColor: '#4CAF50', color: 'white', border: 'none', padding: '4px 12px', borderRadius: '4px', cursor: 'pointer' }}>
          Download PDF
        </button>
        <span style={{flex:1}}/>
        <button onClick={() => setScale(s => Math.max(0.5, s-0.1))}>-</button>
        <div style={{padding:"0 .5rem"}}>{Math.round(scale*100)}%</div>
        <button onClick={() => setScale(s => Math.min(2.0, s+0.1))}>+</button>
      </div>
      {/* removed standalone Add-to-PDF panel to simplify UX for direct inline editing */}

      <Document key={`doc_${docVersion}`} file={editedUrl || fileUrl} onLoadSuccess={onDocLoadSuccess} loading="Loading PDF...">
        {Array.from(new Array(numPages || 0), (_, i) => (
          <div
            key={`page_${i+1}`}
            className="pageWrap"
            ref={(el) => (wrapperRefs.current[i+1] = el)}
            onClick={(e) => {
              if (tool === "text") {
                addTextBox(i + 1, e);
              } else if (tool === "image") {
                addImage(i + 1, e);
              }
            }}
            style={{ position: 'relative', cursor: tool === "image" ? "crosshair" : "default" }}
          >
            <Page
              pageNumber={i + 1}
              scale={scale}
              renderAnnotationLayer={false}
              renderTextLayer={false}
            />

            {/* Inline editor overlay for real text blocks (page 1 demo) */}
            {i === 0 && pdfTextItems.map((item, idx) => {
              const topPx = (pageSize.height - item.y) * scale;
              const leftPx = item.x * scale;
              const heightPx = (item.height || item.fontSize) * scale;
              const widthPx = item.width * scale;
              const isThisEditing = editBlock && editBlock.idx === idx;
              return (
                <div key={idx}>
                  {!isThisEditing && (
                    <div
                      title={item.str}
                      style={{
                        position: 'absolute',
                        left: leftPx,
                        top: topPx,
                        width: widthPx,
                        height: heightPx,
                        opacity: 0,
                        cursor: 'text',
                        pointerEvents: 'auto',
                        zIndex: 30,
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditBlock({item, idx});
                      }}
                    />
                  )}
                  {isThisEditing && (
                    <div
                      ref={inlineEditorRef}
                      contentEditable
                      suppressContentEditableWarning
                      style={{
                        position: 'absolute',
                        left: leftPx,
                        top: topPx - (0.15 * heightPx),
                        minWidth: widthPx,
                        minHeight: heightPx,
                        outline: '2px dashed #1976d2',
                        background: 'rgba(255,255,255,0.8)',
                        fontSize: item.fontSize * scale,
                        lineHeight: 1.1,
                        fontWeight: item.isBold ? 700 : 400,
                        fontStyle: item.isItalic ? 'italic' : 'normal',
                        fontFamily: 'Helvetica, Arial, sans-serif',
                        color: item.color ? rgbToHex(item.color.r, item.color.g, item.color.b) : '#000000',
                        padding: '2px 4px',
                        zIndex: 35,
                      }}
                      onBlur={(e)=>{
                        const val = e.currentTarget.textContent || item.str;
                        handleSaveTextEditInline(val);
                      }}
                      onKeyDown={(e)=>{
                        if(e.key==='Enter') {
                          e.preventDefault();
                          const val = e.currentTarget.textContent || item.str;
                          handleSaveTextEditInline(val);
                        } else if (e.key==='Escape') {
                          setEditBlock(null);
                        }
                      }}
                    >{item.str}</div>
                  )}
                </div>
              );
            })}

            {/* Image overlay layer */}
            {(images[i+1] || []).map((img) => {
              const isSelected = tool === "select";
              return (
                <div
                  key={img.id}
                  style={{
                    position: 'absolute',
                    left: img.left,
                    top: img.top,
                    width: img.width,
                    height: img.height,
                    border: isSelected ? '2px solid #1976d2' : '2px solid transparent',
                    cursor: tool === "delete" ? 'pointer' : 'move',
                    zIndex: 40,
                    pointerEvents: 'auto',
                  }}
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    if (tool === "delete") {
                      e.preventDefault();
                      deleteImage(i+1, img.id);
                      return;
                    }
                    if (tool !== "select") return;
                    
                    const startX = e.clientX;
                    const startY = e.clientY;
                    const startLeft = img.left;
                    const startTop = img.top;
                    let moved = false;
                    
                    const move = (ev) => {
                      const dx = ev.clientX - startX;
                      const dy = ev.clientY - startY;
                      if (!moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
                        moved = true;
                      }
                      if (moved) {
                        const newLeft = startLeft + dx;
                        const newTop = startTop + dy;
                        updateImage(i+1, img.id, { 
                          left: newLeft, 
                          top: newTop 
                        });
                      }
                    };
                    
                    const up = async () => {
                      window.removeEventListener("mousemove", move);
                      window.removeEventListener("mouseup", up);
                      if (moved) {
                        // Re-embed after drag ends
                        setTimeout(async () => {
                          await rebuildPdfWithAllContent(boxes, images);
                        }, 100);
                      }
                    };
                    
                    window.addEventListener("mousemove", move);
                    window.addEventListener("mouseup", up);
                  }}
                >
                  <img
                    src={img.imageUrl}
                    alt="PDF annotation"
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'contain',
                      pointerEvents: 'none',
                    }}
                    draggable={false}
                  />
                  {/* Resize handles when selected */}
                  {isSelected && (
                    <>
                      {/* Bottom-right resize handle */}
                      <div
                        style={{
                          position: 'absolute',
                          right: -5,
                          bottom: -5,
                          width: 10,
                          height: 10,
                          backgroundColor: '#1976d2',
                          border: '2px solid white',
                          borderRadius: '50%',
                          cursor: 'nwse-resize',
                          zIndex: 41,
                        }}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          const startX = e.clientX;
                          const startY = e.clientY;
                          const startWidth = img.width;
                          const startHeight = img.height;
                          const aspectRatio = startWidth / startHeight;
                          
                          const move = (ev) => {
                            const dx = ev.clientX - startX;
                            const dy = ev.clientY - startY;
                            const newWidth = Math.max(50, startWidth + dx);
                            const newHeight = newWidth / aspectRatio;
                            updateImage(i+1, img.id, { 
                              width: newWidth, 
                              height: newHeight 
                            });
                          };
                          
                          const up = async () => {
                            window.removeEventListener("mousemove", move);
                            window.removeEventListener("mouseup", up);
                            setTimeout(async () => {
                              await rebuildPdfWithAllContent(boxes, images);
                            }, 100);
                          };
                          
                          window.addEventListener("mousemove", move);
                          window.addEventListener("mouseup", up);
                        }}
                      />
                    </>
                  )}
                </div>
              );
            })}

            <div
              className="annotation-layer"
              onClick={(e) => {
                if (tool === "text") {
                  addTextBox(i+1, e);
                } else if (tool === "image") {
                  addImage(i+1, e);
                }
              }}
              style={{ cursor: tool === "image" ? "crosshair" : tool === "text" ? "text" : "default" }}
            >
              {(boxes[i+1] || []).map((b) => {
                const boxFontSize = b.fontSize || Number(fontSizeInput) || 12;
                const boxColor = b.color || fontColorHex;
                const boxIsBold = b.isBold !== undefined ? b.isBold : boldToggle;
                
                return (
                <div
                  key={b.id}
                  ref={(el) => { if (el) textBoxRefs.current[b.id] = el; }}
                  className="text-box"
                  style={{
                    position: 'absolute',
                    left:b.left, 
                    top:b.top, 
                    width:b.width, 
                    height:b.height,
                    opacity: b.locked ? 0.6 : 1,
                    border: tool === "select" ? '2px dashed #1976d2' : '1px solid #ccc',
                    padding: '2px 4px',
                    fontSize: boxFontSize * scale,
                    fontWeight: boxIsBold ? 700 : 400,
                    color: boxColor,
                    fontFamily: 'Helvetica, Arial, sans-serif',
                    backgroundColor: 'rgba(255, 255, 255, 0.9)',
                    outline: 'none',
                    cursor: 'text',
                    zIndex: 50,
                  }}
                  contentEditable
                  suppressContentEditableWarning
                  tabIndex={0}
                  onFocus={() => lock(b.id)}
                  onBlur={async () => {
                    unlock(b.id);
                    // Embed text box into PDF when done editing
                    const finalText = textBoxRefs.current[b.id]?.textContent || "";
                    if (finalText.trim() && finalText !== "Type...") {
                      setTimeout(async () => {
                        await rebuildPdfWithAllContent(boxes, images);
                      }, 200);
                    }
                  }}
                  onMouseDown={(e) => {
                    if (tool === "delete") {
                      e.preventDefault();
                      deleteBox(i+1, b.id);
                      return;
                    }
                    if (tool !== "select") return;
                    const startX = e.clientX, startY = e.clientY;
                    let moved = false;
                    const move = (ev) => {
                      const dx = ev.clientX - startX, dy = ev.clientY - startY;
                      if (!moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) moved = true;
                      if (moved) {
                        const pageBoxes = boxes[i + 1] || [];
                        const bi = pageBoxes.findIndex(bx => bx.id === b.id);
                        const start = { ...pageBoxes[bi] };
                        const updated = { ...start, left: start.left + dx, top: start.top + dy };
                        const clone = [...pageBoxes]; clone[bi] = updated;
                        setBoxes(prev => ({ ...prev, [i + 1]: clone }));
                      }
                    };
                    const up = async () => {
                      window.removeEventListener("mousemove", move);
                      window.removeEventListener("mouseup", up);
                      if (moved) {
                        e.preventDefault();
                        // Re-embed after moving
                        setTimeout(async () => {
                          await rebuildPdfWithAllContent(boxes, images);
                        }, 100);
                      }
                    };
                    window.addEventListener("mousemove", move);
                    window.addEventListener("mouseup", up);
                  }}
                  onInput={(e) => {
                    const pageBoxes = boxes[i + 1] || [];
                    const idx = pageBoxes.findIndex(x => x.id === b.id);
                    const clone = [...pageBoxes];
                    clone[idx] = { ...clone[idx], text: e.currentTarget.textContent || "" };
                    setBoxes(prev => ({ ...prev, [i + 1]: clone }));
                  }}
                >
                  {b.text}
                </div>
              );
              })}
            </div>
          </div>
        ))}
      </Document>
    </div>
  );
}
