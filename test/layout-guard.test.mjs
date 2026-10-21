import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// School Chrome extensions add their own element at the top of <body>. Unpinned, it took grid row 1:
// the title bar filled the screen and the plate got 0 px (student laptops, 2026-10-21).
test('the title bar, plate and footer keep their own grid rows', () => {
  const css = readFileSync(new URL('../web/src/style.css', import.meta.url), 'utf8');
  for (const [sel, row] of [['body > .titlebar', 1], ['body > main', 2], ['body > .footer', 3]]) {
    assert.ok(css.includes(`${sel} { grid-row: ${row}; }`), sel);
  }
});
