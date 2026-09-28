// The class gate for slicing (like uploadmycode's and uploadmylaser's class phrase). The teacher
// opens slicing for a while with a phrase on the board; students type it once when they first
// press Slice. Everything else on the site works without it. It is what keeps the slicer (and
// its bill) asleep outside class: no open window, no slice.
//
// While the window is open the phrase is the only lock, so it must be too many to guess: the
// Worker allows 60 tries a minute from one address (a school shares one), and a suggested phrase
// is one of PHRASE_COUNT (about 450 million, over 2^28): trying them all from one address takes
// about 14 years, and a 50-minute window gives a guesser about a 1 in 150,000 chance. A teacher's
// own phrase can be anything (Dalton's call, 2026-09-28): a short one is the teacher's choice to
// make, and the per-address limit still slows guessing.

// How long the teacher can open slicing for, in minutes.
export const SLICING_DURATIONS = [15, 50, 90, 240, 480];

export const MIN_PHRASE = 1;
export const MAX_PHRASE = 40;

/** "Blue Robot  Pancake 42" -> "blue-robot-pancake-42". Case, spaces and dashes do not matter. */
export function normalizePhrase(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s_-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-|-$/g, '');
}

// Plain words a class can read off a whiteboard and type: a describing word, an animal, a thing.
// Left out on purpose: names (Amber, Rusty, Raven...), body words, words with a second meaning kids
// would giggle at, size words that make a pair rude, and spellings kids trip on (desert / dessert,
// arctic, leopard, grey / gray). One word each, so nobody has to guess "blue jay" or "bluejay".
// Add words freely; remove one only while PHRASE_COUNT stays at 2^28 or more (test/settings.test.mjs).
export const PHRASE_WORDS = [
  [
    'red', 'blue', 'green', 'yellow', 'orange', 'purple', 'pink', 'silver', 'golden', 'bronze',
    'copper', 'indigo', 'teal', 'navy', 'lime', 'crimson', 'maroon', 'brown', 'tiny', 'mini',
    'round', 'square', 'curly', 'spiky', 'fluffy', 'fuzzy', 'bumpy', 'shiny', 'sparkly', 'glowing',
    'frosty', 'snowy', 'rainy', 'windy', 'cloudy', 'foggy', 'icy', 'chilly', 'warm', 'crispy',
    'crunchy', 'smooth', 'silky', 'velvet', 'striped', 'spotted', 'dotted', 'plaid', 'happy',
    'sleepy', 'jolly', 'brave', 'calm', 'quiet', 'clever', 'gentle', 'kind', 'proud', 'lucky',
    'merry', 'friendly', 'cheerful', 'curious', 'eager', 'bold', 'noble', 'wise', 'polite',
    'patient', 'busy', 'silly', 'zany', 'bouncy', 'jumpy', 'grumpy', 'sneaky', 'speedy', 'rapid',
    'swift', 'quick', 'nimble', 'sturdy', 'steady', 'wooden', 'paper', 'plastic', 'metal', 'steel',
    'iron', 'glass', 'stone', 'marble', 'cotton', 'denim', 'modern', 'royal', 'secret', 'magic',
    'cosmic', 'atomic', 'ocean', 'polar', 'tropical', 'lunar', 'solar', 'electric', 'turbo',
    'super', 'mega', 'ultra', 'laser', 'pixel', 'digital', 'robotic', 'sour', 'tangy', 'minty',
    'cheesy', 'toasty', 'buttery', 'loud', 'humming', 'famous', 'fancy', 'fearless', 'hidden',
    'honest', 'humble', 'neat', 'nifty', 'plain', 'rare', 'snappy', 'tidy', 'tricky', 'trusty',
    'twisty', 'zippy', 'breezy', 'bright', 'crisp', 'epic', 'frozen', 'glossy', 'grand', 'handy',
    'lively', 'mellow', 'peppy', 'plucky', 'puffy', 'quirky', 'radiant', 'sleek', 'stellar',
    'upbeat', 'vivid', 'wacky',
  ],
  [
    'ant', 'bear', 'beetle', 'bison', 'buffalo', 'camel', 'canary', 'caribou', 'cheetah',
    'chipmunk', 'cobra', 'condor', 'coyote', 'crab', 'crane', 'cricket', 'crow', 'deer', 'dingo',
    'dolphin', 'dove', 'dragonfly', 'duck', 'eagle', 'eel', 'elk', 'emu', 'falcon', 'ferret',
    'finch', 'flamingo', 'fox', 'frog', 'gazelle', 'gecko', 'gerbil', 'gibbon', 'giraffe', 'goat',
    'goldfish', 'goose', 'gopher', 'gorilla', 'hamster', 'hare', 'hawk', 'hedgehog', 'heron',
    'hippo', 'hornet', 'horse', 'hyena', 'ibis', 'iguana', 'impala', 'jackal', 'jaguar',
    'jellyfish', 'kangaroo', 'kiwi', 'koala', 'lemur', 'lion', 'lizard', 'llama', 'lobster', 'lynx',
    'macaw', 'magpie', 'manatee', 'marmot', 'meerkat', 'mongoose', 'moose', 'moth', 'mouse',
    'narwhal', 'newt', 'ocelot', 'octopus', 'orca', 'ostrich', 'otter', 'owl', 'panda', 'panther',
    'parrot', 'pelican', 'penguin', 'pigeon', 'pony', 'poodle', 'porcupine', 'puffin', 'puma',
    'python', 'quail', 'rabbit', 'reindeer', 'rhino', 'salmon', 'seal', 'shark', 'sheep', 'sloth',
    'snail', 'sparrow', 'spider', 'squid', 'stingray', 'stork', 'swan', 'tapir', 'tiger', 'toad',
    'toucan', 'trout', 'tuna', 'turtle', 'viper', 'vulture', 'walrus', 'wasp', 'whale', 'wolf',
    'wombat', 'yak', 'zebra', 'alpaca', 'badger', 'beagle', 'bulldog', 'collie', 'terrier', 'corgi',
    'starfish', 'lamb', 'bunny', 'kitten', 'puppy', 'duckling', 'cub', 'fawn', 'foal', 'ladybug',
    'bumblebee', 'firefly', 'grasshopper', 'caterpillar', 'termite', 'scorpion', 'tarantula',
    'armadillo', 'anteater', 'hummingbird', 'kingfisher', 'osprey', 'albatross', 'cardinal',
    'parakeet', 'platypus', 'wallaby', 'salamander', 'crocodile', 'alligator', 'marlin',
    'swordfish', 'pufferfish', 'clownfish', 'sardine', 'oyster', 'clam', 'beluga', 'unicorn',
    'dragon', 'yeti', 'hen', 'mammoth',
  ],
  [
    'comet', 'planet', 'meteor', 'galaxy', 'rocket', 'star', 'orbit', 'nebula', 'asteroid',
    'satellite', 'crater', 'rainbow', 'thunder', 'cloud', 'breeze', 'blizzard', 'tornado',
    'volcano', 'glacier', 'canyon', 'island', 'meadow', 'forest', 'river', 'lagoon', 'valley',
    'mountain', 'pebble', 'boulder', 'waterfall', 'puddle', 'iceberg', 'acorn', 'pinecone', 'maple',
    'cactus', 'fern', 'tulip', 'clover', 'sunflower', 'seashell', 'pancake', 'waffle', 'pretzel',
    'bagel', 'noodle', 'pizza', 'cookie', 'cupcake', 'popcorn', 'pumpkin', 'apple', 'lemon',
    'mango', 'grape', 'pear', 'potato', 'tomato', 'pasta', 'burrito', 'sandwich', 'toast',
    'cereal', 'oatmeal', 'jelly', 'cheese', 'butter', 'smoothie', 'lemonade', 'cocoa', 'gumdrop',
    'lollipop', 'jellybean', 'pudding', 'dumpling', 'lantern', 'castle', 'bridge', 'tower',
    'anchor', 'arrow', 'backpack', 'balloon', 'basket', 'bell', 'bicycle', 'blanket', 'bucket',
    'button', 'camera', 'candle', 'compass', 'crayon', 'drum', 'feather', 'flag', 'flute', 'guitar',
    'hammock', 'helmet', 'kettle', 'kite', 'ladder', 'magnet', 'mitten', 'mirror', 'notebook',
    'paddle', 'parachute', 'pencil', 'piano', 'pillow', 'puzzle', 'radio', 'ribbon', 'sailboat',
    'scooter', 'shovel', 'skateboard', 'sled', 'spoon', 'teapot', 'telescope', 'tent', 'ticket',
    'trumpet', 'tractor', 'trophy', 'umbrella', 'violin', 'wagon', 'whistle', 'windmill', 'zipper',
    'domino', 'trampoline', 'igloo', 'lighthouse', 'submarine', 'train', 'canoe', 'kayak',
    'jetpack', 'glider', 'blimp', 'tugboat', 'airship', 'eraser', 'marker', 'sticker', 'envelope',
    'postcard', 'clock', 'gadget', 'gizmo', 'widget', 'lamp', 'bench', 'toolbox', 'wrench', 'gear',
    'pulley', 'lever', 'battery', 'keyboard', 'printer', 'antenna', 'sensor', 'beacon', 'banner',
    'crown', 'treasure', 'coin', 'medal', 'map', 'globe', 'atlas', 'robot',
  ],
];
// Then a number from 10 to 99 (no leading zero to get wrong).
const NUMBERS = 90;

export const PHRASE_COUNT = PHRASE_WORDS.reduce((n, list) => n * list.length, NUMBERS);

// crypto, not Math.random: one phrase must say nothing about the next.
function cryptoRandom() {
  return crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
}

/** Three easy words and a number for the board, e.g. "golden-walrus-lantern-42". */
export function generatePhrase(random = cryptoRandom) {
  const words = PHRASE_WORDS.map((list) => list[Math.floor(random() * list.length)]);
  return [...words, 10 + Math.floor(random() * NUMBERS)].join('-');
}

/** Check a class phrase the teacher typed. */
export function validatePhrase(text) {
  const phrase = normalizePhrase(text ?? '');
  if (phrase.length < MIN_PHRASE || phrase.length > MAX_PHRASE) {
    return { ok: false, error: `phrase: ${MIN_PHRASE} to ${MAX_PHRASE} letters, numbers or dashes` };
  }
  return { ok: true, phrase };
}

/**
 * Check the teacher's slicing request: { phrase, minutes } opens (or reopens) the window;
 * { phrase, keep: true } only changes the phrase and keeps the window's end time.
 */
export function validateOpenRequest(input) {
  if (input === null || typeof input !== 'object') return { ok: false, error: 'must be an object' };
  const p = validatePhrase(input.phrase);
  if (input.keep === true) return p.ok ? { ok: true, phrase: p.phrase, keep: true } : p;
  if (!SLICING_DURATIONS.includes(input.minutes)) return { ok: false, error: 'minutes: not one of the choices' };
  return p.ok ? { ok: true, phrase: p.phrase, minutes: input.minutes } : p;
}
