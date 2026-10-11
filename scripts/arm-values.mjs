// Writes the slicer's copies of shared/ lists (test/arm.test.mjs keeps them equal):
//   container/arm_values.json: every Cura key the ARM tab can send and the values it may take, so
//     the slicer checks the same list as shared/arm.js.
//   container/class_defaults.json: the class default settings exactly as the Worker sends them
//     (toCuraOverrides(CLASS_DEFAULTS)), so the slicer warms up the settings students really use.
import { writeFileSync } from 'node:fs';
import { armValues } from '../shared/arm.js';
import { CLASS_DEFAULTS, toCuraOverrides } from '../shared/settings.js';
writeFileSync(new URL('../container/arm_values.json', import.meta.url), `${JSON.stringify(armValues(), null, 1)}\n`);
writeFileSync(new URL('../container/class_defaults.json', import.meta.url), `${JSON.stringify(toCuraOverrides(CLASS_DEFAULTS), null, 1)}\n`);
