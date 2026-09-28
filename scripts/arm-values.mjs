// Writes container/arm_values.json: every Cura key the ARM tab can send and the values it may take,
// so the slicer checks the same list as shared/arm.js (test/arm.test.mjs keeps them equal).
import { writeFileSync } from 'node:fs';
import { armValues } from '../shared/arm.js';
writeFileSync(new URL('../container/arm_values.json', import.meta.url), `${JSON.stringify(armValues(), null, 1)}\n`);
