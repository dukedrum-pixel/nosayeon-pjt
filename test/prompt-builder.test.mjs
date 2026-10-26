import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraft, updateInputs, editPrompt, applyOptions, preparePreview, buildPrompt } from '../web/js/prompt-builder.mjs';

test('사연과 선택 옵션으로 음악 방향을 구성한다', () => {
  const draft = updateInputs(createDraft(), { story: '졸업하는 동생을 응원해요.', options: { genre: 'rock', vocals: 'female', language: 'en' } });
  assert.match(draft.prompt, /졸업하는 동생/);
  assert.match(draft.prompt, /soft rock/);
  assert.match(draft.prompt, /Female lead vocals/);
  assert.match(draft.prompt, /lyrics in English/);
  assert.doesNotMatch(draft.prompt, /acoustic pop/);
});

test('직접 편집한 내용은 사연·옵션 변경으로 덮어쓰지 않는다', () => {
  const manual = editPrompt(createDraft(), '내가 직접 작성한 프롬프트');
  const changed = updateInputs(manual, { story: '새로운 사연', options: { mood: 'sad' } });
  assert.equal(changed.mode, 'manual');
  assert.equal(changed.prompt, manual.prompt);
  assert.equal(preparePreview(changed).input, manual.prompt);
  assert.equal(manual.options.mood, 'warm');
  const applied = applyOptions(changed);
  assert.equal(applied.mode, 'automatic');
  assert.match(applied.prompt, /새로운 사연/);
  assert.match(applied.prompt, /sad and tender/);
});

test('잘못된 사연·옵션과 빈 수동 프롬프트는 준비할 수 없다', () => {
  assert.throws(() => buildPrompt('  '), /사연/);
  assert.throws(() => buildPrompt('a'.repeat(5001)), /5,000/);
  assert.throws(() => buildPrompt('사연', { genre: 'toString' }), /옵션/);
  assert.throws(() => preparePreview(editPrompt(createDraft(), '  ')), /최종 프롬프트/);
  assert.throws(() => preparePreview(editPrompt(createDraft(), 'a'.repeat(12001))), /12,000/);
  const invalidManual = updateInputs(editPrompt(createDraft(), '유효한 프롬프트'), { story: '' });
  assert.throws(() => preparePreview(invalidManual), /사연/);
});

test('요청 미리보기는 직접 편집 결과를 사용하고 draft를 변경하지 않는다', () => {
  const draft = editPrompt(createDraft(), '  Keep my custom lyrics.  ');
  assert.deepEqual(preparePreview(draft), { model: 'lyria-3.5', input: 'Keep my custom lyrics.', store: true });
  assert.equal(draft.prompt, '  Keep my custom lyrics.  ');
});
