// Tiny DOM helpers. No framework: the page must stay light for slow Chromebooks.

/** Make an element. Attributes set to null or undefined are skipped. */
export function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    node.setAttribute(k, String(v));
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape text for innerHTML. Anything a student typed or a file name must go through this. */
export function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

export function $(selector) {
  return document.querySelector(selector);
}

/** 12345 → "12,345". */
export function fmt(n, digits = 0) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}
