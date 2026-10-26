import { createDraft, updateInputs, editPrompt, applyOptions, preparePreview } from './prompt-builder.mjs';

let draft = createDraft();
const form = document.querySelector('#draft-form');
const story = document.querySelector('#story');
const prompt = document.querySelector('#prompt');
const reset = document.querySelector('#apply-options');
const selects = [...form.querySelectorAll('select')];
let hasPendingInputs = false;

function log(message) {
  const entry = document.createElement('li');
  entry.textContent = `${new Date().toLocaleTimeString('ko-KR')} · ${message}`;
  const events = document.querySelector('#events');
  events.prepend(entry);
  if (events.children.length > 20) events.lastElementChild.remove();
}

function invalidate() {
  document.querySelector('#status').textContent = '입력 중';
  document.querySelector('#status-message').textContent = '입력이 바뀌었습니다. 준비 버튼으로 최종 내용을 다시 확인해 주세요.';
  document.querySelector('#stage-prompt span').textContent = '대기';
  document.querySelector('#payload').textContent = '';
  document.querySelector('#payload-details').hidden = true;
}

function render() {
  if (prompt.value !== draft.prompt) prompt.value = draft.prompt;
  document.querySelector('#story-count').textContent = `${story.value.length.toLocaleString('ko-KR')} / 5,000`;
  document.querySelector('#edit-mode').textContent = draft.mode === 'manual' ? '직접 편집 중' : '옵션 자동 반영';
  reset.disabled = draft.mode !== 'manual';
  document.querySelector('#pending-changes').hidden = !hasPendingInputs;
}

function showError(message) {
  document.querySelector('#status').textContent = '입력 확인';
  document.querySelector('#status-message').textContent = message;
}

story.value = draft.story;
for (const select of selects) select.value = draft.options[select.name];
form.addEventListener('input', (event) => {
  invalidate();
  if (event.target === prompt) {
    const enteringManual = draft.mode !== 'manual';
    draft = editPrompt(draft, prompt.value);
    if (enteringManual) log('직접 편집 모드로 전환했습니다.');
  } else {
    const options = Object.fromEntries(selects.map(select => [select.name, select.value]));
    try {
      draft = updateInputs(draft, { story: story.value, options });
      hasPendingInputs = draft.mode === 'manual';
    } catch (error) {
      // Empty stories are normal while typing; preserve the draft and block preparation.
      draft = { ...draft, story: story.value, options };
      if (draft.mode === 'automatic') draft.prompt = '';
      showError(error.message);
    }
  }
  render();
});

reset.addEventListener('click', () => {
  if (!window.confirm('직접 편집한 내용을 현재 사연과 옵션으로 바꿀까요?')) return;
  try {
    draft = applyOptions(draft);
    hasPendingInputs = false;
    invalidate();
    render();
    log('현재 사연과 옵션으로 프롬프트를 다시 작성했습니다.');
  } catch (error) { showError(error.message); }
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    const payload = preparePreview(draft);
    document.querySelector('#payload').textContent = JSON.stringify(payload, null, 2);
    document.querySelector('#payload-details').hidden = false;
    document.querySelector('#status').textContent = '프롬프트 준비 완료';
    document.querySelector('#stage-prompt span').textContent = '완료';
    document.querySelector('#status-message').textContent = '최종 프롬프트가 준비되었습니다. 음악 생성·저장·이메일은 아직 실행하지 않았습니다.';
    log('프롬프트 준비 완료. 외부 API 호출 없음.');
  } catch (error) { showError(error.message); }
});

render();
log('예시 사연과 음악 옵션을 불러왔습니다.');
