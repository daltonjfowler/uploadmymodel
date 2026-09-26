// The class gate for slicing (like uploadmycode's and uploadmylaser's class phrase). The teacher
// opens slicing for a while with a phrase on the board; students type it once when they first
// press Slice. Everything else on the site works without it. It is what keeps the slicer (and
// its bill) asleep outside class: no open window, no slice.

// How long the teacher can open slicing for, in minutes.
export const SLICING_DURATIONS = [15, 50, 90, 240, 480];

export const MIN_PHRASE = 4;
export const MAX_PHRASE = 40;

/** "Blue Robot  Pancake" -> "blue-robot-pancake". Case, spaces and dashes do not matter. */
export function normalizePhrase(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s_-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-|-$/g, '');
}

const WORDS = [
  ['blue', 'green', 'orange', 'purple', 'silver', 'golden', 'tiny', 'giant', 'happy', 'sleepy', 'rapid', 'quiet'],
  ['robot', 'rocket', 'turtle', 'dragon', 'pickle', 'comet', 'cactus', 'walrus', 'panda', 'wizard', 'banana', 'falcon'],
  ['pancake', 'volcano', 'galaxy', 'taco', 'castle', 'noodle', 'meteor', 'bridge', 'muffin', 'island', 'tornado', 'lantern'],
];

/** Three easy words for the board, e.g. "orange-walrus-taco". */
export function generatePhrase(random = Math.random) {
  return WORDS.map((list) => list[Math.floor(random() * list.length)]).join('-');
}

/** Check the teacher's "open slicing" request. */
export function validateOpenRequest(input) {
  if (input === null || typeof input !== 'object') return { ok: false, error: 'must be an object' };
  if (!SLICING_DURATIONS.includes(input.minutes)) return { ok: false, error: 'minutes: not one of the choices' };
  const phrase = normalizePhrase(input.phrase ?? '');
  if (phrase.length < MIN_PHRASE || phrase.length > MAX_PHRASE) {
    return { ok: false, error: `phrase: ${MIN_PHRASE} to ${MAX_PHRASE} letters, numbers or dashes` };
  }
  return { ok: true, phrase, minutes: input.minutes };
}
