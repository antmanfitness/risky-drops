/* Risky Drops box scanner: plain-JS port of antman-coaching LiveBarcodeScanner.tsx (copied, not edited).
 * Native BarcodeDetector when present, else ZXing (vendored js/zxing.min.js, lazy-loaded). Box formats: CODE_128, EAN_13, UPC_A,
 * DATA_MATRIX, QR (+ TRY_HARDER). Decodes a thin wide centre crop at full sensor resolution about every 120 ms; a bad frame never
 * closes the scanner. Photo decode slices the still image into overlapping bands so stacked label barcodes each resolve. */
(function () {
  const NATIVE_FORMATS = ['code_128', 'ean_13', 'upc_a', 'data_matrix', 'qr_code'];
  let zxingP = null;
  function loadZXing() {
    if (window.RDZXing) return Promise.resolve(window.RDZXing);
    if (!zxingP) zxingP = new Promise((res, rej) => { const s = document.createElement('script'); s.src = (document.querySelector('script[src*="scanner.js"]')?.src || '').replace('scanner.js', 'zxing.min.js');
      s.onload = () => res(window.RDZXing); s.onerror = () => { zxingP = null; rej(new Error('Could not load the barcode reader')); }; document.head.appendChild(s); });
    return zxingP;
  }
  async function createZxing() {
    const Z = await loadZXing(), F = Z.BarcodeFormat;
    const hints = new Map([[Z.DecodeHintType.POSSIBLE_FORMATS, [F.CODE_128, F.EAN_13, F.UPC_A, F.DATA_MATRIX, F.QR_CODE]], [Z.DecodeHintType.TRY_HARDER, true]]);
    return new Z.BrowserMultiFormatReader(hints);
  }
  function nativeDetector() {
    const D = window.BarcodeDetector; if (!D) return null;
    try { return new D({ formats: NATIVE_FORMATS }); } catch { return null; }
  }
  function cameraErrorMessage(error) {
    const name = error?.name || '';
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'Camera permission is off. On iPhone: Settings → Safari → Camera → Allow (or remove and re-add Risky Drops to your Home Screen). You can still scan from a photo or type it in.';
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No usable camera was found. Scan from a photo or type it in instead.';
    if (name === 'NotReadableError') return 'The camera is busy in another app. Close it and try again, or scan from a photo.';
    return 'The live camera could not start here. Scan from a photo or type it in instead.';
  }

  // Live scanner. onCode(rawValue) is called for every distinct value; the caller decides what to keep.
  function startLive({ video, onCode, onStatus, onTorch }) {
    let cancelled = false, stream = null, timer = null, track = null;
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
    const seen = new Map();
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('no api'), { name: 'NotSupportedError' });
        try { stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } }); }
        catch (e) { if (e?.name !== 'OverconstrainedError') throw e; stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'environment' } }); }
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        track = stream.getVideoTracks()[0] || null;
        const caps = track?.getCapabilities?.() || {};
        if (caps.torch) onTorch?.(async (on) => { try { await track.applyConstraints({ advanced: [{ torch: on }] }); return true; } catch { return false; } });
        if (caps.focusMode?.includes?.('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
        video.setAttribute('playsinline', 'true'); video.muted = true; video.srcObject = stream;
        await video.play().catch(() => {});
        onStatus('scanning');
        let native = nativeDetector(); const zx = await createZxing().catch(() => null); let frame = 0;
        const tick = async () => {
          if (cancelled) return;
          if (video.readyState >= 2 && video.videoWidth && ctx) {
            // thin wide aiming box: labels stack barcodes close together, so only the one under the line is read
            const sw = Math.round(video.videoWidth * 0.92), sh = Math.round(video.videoHeight * 0.22);
            canvas.width = sw; canvas.height = sh;
            ctx.drawImage(video, Math.round((video.videoWidth - sw) / 2), Math.round((video.videoHeight - sh) / 2), sw, sh, 0, 0, sw, sh);
            const codes = [];
            try { if (native) for (const d of await native.detect(canvas)) if (d.rawValue) codes.push(d.rawValue); } catch { native = null; }
            if (!codes.length && zx && (!native || frame % 3 === 0)) { try { codes.push(zx.decodeFromCanvas(canvas).getText()); } catch { /* nothing in this frame; keep scanning */ } }
            frame++;
            for (const c of codes) { const now = Date.now(); if (!seen.has(c) || now - seen.get(c) > 4000) { seen.set(c, now); onCode(c); } }
          }
          if (!cancelled) timer = setTimeout(tick, 120);
        };
        tick();
      } catch (e) { if (!cancelled) onStatus('error', cameraErrorMessage(e)); }
    })();
    return () => { cancelled = true; clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); track = null; video.srcObject = null; };
  }

  // Decode a still photo; returns every distinct value found (stacked label barcodes -> several).
  async function decodeImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Could not open that photo')); i.src = url; });
      const scale = Math.min(1, 2600 / Math.max(img.naturalWidth, img.naturalHeight));
      const W = Math.round(img.naturalWidth * scale), H = Math.round(img.naturalHeight * scale);
      const full = document.createElement('canvas'); full.width = W; full.height = H; full.getContext('2d').drawImage(img, 0, 0, W, H);
      // value -> vertical position (so codes come back top-to-bottom, e.g. IMEI above IMEI 2 as printed)
      const found = new Map(), native = nativeDetector(), add = (v, y) => { if (v && !found.has(v)) found.set(v, y); };
      if (native) { try { for (const d of await native.detect(full)) add(d.rawValue, d.boundingBox ? d.boundingBox.y : 0); } catch { /* ignore */ } }
      const zx = await createZxing();
      const tryCanvas = (c, y0) => { try { const r = zx.decodeFromCanvas(c), pts = r.getResultPoints() || []; add(r.getText(), y0 + (pts.length ? pts.reduce((a, p) => a + p.getY(), 0) / pts.length : c.height / 2)); } catch { /* none */ } };
      const band = (src, y, h) => { const c = document.createElement('canvas'); c.width = src.width; c.height = h; c.getContext('2d').drawImage(src, 0, y, src.width, h, 0, 0, src.width, h); return c; };
      const sweep = (src) => { for (const frac of [0.12, 0.2, 0.34]) { const h = Math.max(40, Math.round(src.height * frac)); for (let y = 0; y + h <= src.height + 1; y += Math.max(10, Math.round(h / 2))) { const yy = Math.min(y, src.height - h); tryCanvas(band(src, yy, h), yy); } } tryCanvas(src, 0); };
      sweep(full);
      if (!found.size) { const r = document.createElement('canvas'); r.width = H; r.height = W; const g = r.getContext('2d'); g.translate(H, 0); g.rotate(Math.PI / 2); g.drawImage(full, 0, 0); sweep(r); }
      return [...found.entries()].sort((a, b) => a[1] - b[1]).map((e) => e[0]);
    } finally { URL.revokeObjectURL(url); }
  }

  // Compress a photo to a JPEG data URL (for box photos and the AI read).
  async function compress(file, maxSide = 1280, quality = 0.72) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Could not open that photo')); i.src = url; });
      const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight)); const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      let q = quality, out = c.toDataURL('image/jpeg', q); while (out.length > 650000 && q > 0.35) { q -= 0.1; out = c.toDataURL('image/jpeg', q); }
      return out;
    } finally { URL.revokeObjectURL(url); }
  }
  window.RDScanner = { startLive, decodeImage, compress, loadZXing };
})();
