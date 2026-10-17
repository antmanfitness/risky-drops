/* Plain-JS port of antman-coaching OrbitRing.tsx (same SVG structure + orbit.css classes). */
window.OrbitRing = function ({ pct = 0, size = 74, color, tone, label, center = '', moon = true }) {
  const target = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const r = 44, c = 2 * Math.PI * r;
  const stroke = color || (tone === 'alert' ? 'var(--red)' : 'var(--accent)');
  const el = document.createElement('div');
  el.className = 'orbit-ring' + (tone ? ' ' + tone : '');
  el.style.width = size + 'px'; el.style.height = size + 'px'; el.style.setProperty('--orbit-c', stroke);
  if (label) { el.setAttribute('role', 'img'); el.setAttribute('aria-label', label); }
  el.innerHTML = `<svg viewBox="0 0 100 100" aria-hidden="true">
    <circle class="orbit-track" cx="50" cy="50" r="${r}"/>
    <circle class="orbit-inner" cx="50" cy="50" r="33"/>
    <circle class="orbit-arc" cx="50" cy="50" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${c}" transform="rotate(-90 50 50)"/>
    <g class="orbit-planet" style="transform: rotate(0deg)"><circle class="orbit-halo" cx="50" cy="6" r="7"/><circle class="orbit-dot" cx="50" cy="6" r="4"/></g>
    ${moon ? '<g class="orbit-moon"><circle cx="50" cy="17" r="1.8"/></g>' : ''}
  </svg>${center !== '' ? `<div class="orbit-center">${center}</div>` : ''}`;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    el.querySelector('.orbit-arc').style.strokeDashoffset = c * (1 - target / 100);
    el.querySelector('.orbit-planet').style.transform = `rotate(${target * 3.6}deg)`;
  }));
  return el;
};
