/* Risky Drops: classify a decoded phone-box barcode value. Pure function; also loaded by tests (node). */
(function (root) {
  const luhn = (d) => {
    if (!/^\d{15}$/.test(d)) return false;
    let t = 0;
    for (let i = 0; i < 15; i++) { let n = +d[14 - i]; if (i % 2) { n *= 2; if (n > 9) n -= 9; } t += n; }
    return t % 10 === 0;
  };
  const PART = /^[A-Z0-9]{4,7}[A-Z]{0,3}\/[A-Z]$/;
  // -> { type: 'imei' | 'serial' | 'part' | 'upc' | 'unknown', value, note? }
  function classify(raw) {
    const s = String(raw ?? '').trim().toUpperCase().replace(/\s+/g, '');
    if (!s) return { type: 'unknown', value: '' };
    if (/^\d+$/.test(s)) {
      if (s.length === 15) return luhn(s) ? { type: 'imei', value: s } : { type: 'unknown', value: s, note: '15 digits but failed the IMEI (Luhn) check' };
      if (s.length === 12 || s.length === 13) return { type: 'upc', value: s };
      return { type: 'unknown', value: s };
    }
    // part number like MJW64LL/A; box labels may encode it with a leading "P"
    if (/^P[MNF3][A-Z0-9]{3,6}[A-Z]{0,3}\/[A-Z]$/.test(s) && PART.test(s.slice(1))) return { type: 'part', value: s.slice(1) };
    if (PART.test(s)) return { type: 'part', value: s };
    // serial: 10-12 letters+digits; box labels encode it as "S" + serial
    if (/^[A-Z0-9]+$/.test(s) && /[A-Z]/.test(s) && /\d/.test(s)) {
      if (s[0] === 'S' && s.length >= 11 && s.length <= 13) return { type: 'serial', value: s.slice(1) };
      if (s.length >= 10 && s.length <= 12) return { type: 'serial', value: s };
    }
    return { type: 'unknown', value: s };
  }
  const api = { classify, luhn };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.RDClassify = api;
})(typeof window !== 'undefined' ? window : globalThis);
