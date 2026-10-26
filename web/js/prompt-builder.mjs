export const DEFAULT_STORY = '힘든 한 해를 보내는 동안 묵묵히 곁을 지켜준 친구에게 고맙다는 마음을 전하고 싶어요. 함께 걷던 저녁 산책길과 별것 아닌 이야기로 웃었던 순간을 담아주세요.';

// Internal test defaults, not final product policy. Labels belong to the UI.
export const OPTION_CHOICES = Object.freeze({
  genre: { acoustic: 'warm acoustic pop', ballad: 'emotional ballad', pop: 'melodic pop', rock: 'uplifting soft rock', trot: 'Korean trot' },
  mood: { warm: 'warm and sincere', hopeful: 'hopeful and uplifting', calm: 'calm and reflective', sad: 'sad and tender' },
  vocals: { any: 'Choose a vocal timbre that suits the story', female: 'Female lead vocals', male: 'Male lead vocals' },
  tempo: { slow: 'Slow tempo, around 65–80 BPM', medium: 'Moderate tempo, around 85–105 BPM', upbeat: 'Upbeat tempo, around 110–130 BPM' },
  duration: { short: 'Aim for about one minute', standard: 'Aim for about two minutes', long: 'Aim for about three minutes' },
  language: { ko: 'Korean', en: 'English' },
});

export const DEFAULT_OPTIONS = Object.freeze({ genre: 'acoustic', mood: 'warm', vocals: 'any', tempo: 'medium', duration: 'standard', language: 'ko' });

export function buildPrompt(story, options = DEFAULT_OPTIONS) {
  if (typeof story !== 'string' || !story.trim()) throw new Error('노래에 담을 사연을 입력해 주세요.');
  if (story.length > 5000) throw new Error('사연은 5,000자 이내로 입력해 주세요.');
  const selected = {};
  for (const [name, choices] of Object.entries(OPTION_CHOICES)) {
    const value = options[name] ?? DEFAULT_OPTIONS[name];
    if (!Object.hasOwn(choices, value)) throw new Error('음악 옵션을 다시 선택해 주세요.');
    selected[name] = choices[value];
  }
  return [
    'Create one original song inspired by the following personal story. Respect its emotional meaning.',
    '', 'Story:', story.trim(), '', 'Musical direction:',
    `Genre: ${selected.genre}.`, `Mood: ${selected.mood}.`, `${selected.vocals}.`,
    `${selected.tempo}.`, `${selected.duration}; the exact duration may vary.`,
    `Write and sing original lyrics in ${selected.language}.`,
    'Use instruments that complement the story and genre. Give the song a clear verse and memorable chorus.',
    'Do not imitate an existing artist, voice, melody, or song. Do not include personal contact details in the lyrics.',
  ].join('\n');
}

export function createDraft(story = DEFAULT_STORY, options = DEFAULT_OPTIONS) {
  return { story, options: { ...options }, prompt: buildPrompt(story, options), mode: 'automatic' };
}

// Pure state transitions allow the final UI to reuse the same editing contract.
export function updateInputs(draft, { story = draft.story, options = {} } = {}) {
  const next = { ...draft, story, options: { ...draft.options, ...options } };
  return next.mode === 'manual' ? next : { ...next, prompt: buildPrompt(next.story, next.options) };
}

export function editPrompt(draft, prompt) {
  return { ...draft, prompt, mode: 'manual' };
}

export function applyOptions(draft) {
  return { ...draft, prompt: buildPrompt(draft.story, draft.options), mode: 'automatic' };
}

export function preparePreview(draft) {
  // Validate inputs even when manual editing prevents automatic rebuilding.
  buildPrompt(draft.story, draft.options);
  if (!draft.prompt.trim()) throw new Error('최종 프롬프트를 입력해 주세요.');
  if (draft.prompt.length > 12000) throw new Error('최종 프롬프트는 12,000자 이내로 입력해 주세요.');
  return Object.freeze({ model: 'lyria-3.5', input: draft.prompt.trim(), store: true });
}
