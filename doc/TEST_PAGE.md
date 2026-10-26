# 내부 테스트 페이지 및 UI 통합 계약

## 현재 구현

Lyria 동일 음원 즉시 복구 검증 이후의 2·3단계다. 사연과 음악 옵션으로 최종 프롬프트를 준비하는 정적 페이지를 구현했다. 실제 음악 생성은 기존 CLI에서만 실행한다. 이 화면의 완료 상태는 **프롬프트 준비 완료**이며, 생성·파일 저장·결과 링크·이메일 성공을 의미하지 않는다.

```sh
npm run dev
# http://127.0.0.1:4173
npm ci # 전체 테스트용 개발 의존성 설치
npm test
```

Node.js 24.5 이상과 Python 3가 필요하다. 페이지는 런타임 패키지 설치 없이 실행한다. 전체 테스트에는 `npm ci`로 개발 의존성을 설치한다. Cloudflare Pages에 연결할 때는 정적 배포 디렉터리가 `web`이며 별도의 빌드 명령은 필요하지 않다. 아직 호스팅에 배포하지 않았다. 서버는 `web`만 제공하므로 `.env`, Git 데이터, CLI의 원본 응답과 오디오는 공개하지 않는다.

## 파일 역할

- `web/index.html`: 입력 요소, 프롬프트 미리보기, 단계별 상태, 처리 기록. 최종 서비스 UI가 아닌 내부 테스트 화면이다.
- `web/styles.css`: 모바일 대응 스타일. 외부 폰트나 CDN 요청 없음.
- `web/js/prompt-builder.mjs`: DOM·네트워크·저장소에 의존하지 않는 프롬프트 빌더와 상태 전이.
- `web/js/app.mjs`: UI 이벤트와 렌더링. API 키나 사용자 입력을 콘솔·서버·브라우저 저장소에 저장하지 않는다. 요청 미리보기에는 사용자가 입력한 사연이 포함되므로 화면 공유에 주의한다.
- `src/lyria-spike.mjs`: 별도 Node.js 검증 API 계층. 브라우저 코드에서 import하지 않는다.

## 프롬프트 편집 계약

`createDraft()` → `{ story, options, prompt, mode }`.

1. 초기 모드는 `automatic`. `updateInputs(draft, { story, options })`가 프롬프트를 갱신한다.
2. 프롬프트 직접 입력 시 `editPrompt(draft, prompt)`가 `manual`로 전환한다.
3. `manual` 모드에서 사연·옵션을 바꿔도 직접 작성한 프롬프트를 유지한다. 변경 안내를 표시하며, 준비 버튼도 현재 수동 프롬프트를 사용한다.
4. `현재 사연·옵션으로 다시 작성`은 확인 대화상자 이후에만 `applyOptions(draft)`를 호출한다. 취소하면 입력·모드를 유지한다.
5. `preparePreview(draft)`는 입력을 검증하고 `{ model, input, store }`를 반환한다. 외부 API는 호출하지 않는다.
6. 입력이 바뀌면 이전 요청 미리보기와 준비 완료 상태를 폐기한다. 빈 사연, 잘못된 옵션, 빈 프롬프트는 완료 처리하지 않는다.

테스트용 기본값은 한국어, 어쿠스틱 팝, 따뜻함, 보컬 자동, 보통 템포, 약 2분이다. 제품 기본값을 확정한 것이 아니다. 사연은 5,000자, 최종 프롬프트는 12,000자로 제한하며 모델의 토큰 한도를 보장하는 값은 아니다.

## UI 담당자가 유지할 요소

입력 폼 `#draft-form`, 사연 `#story`, 옵션 select의 `name`(`genre`, `mood`, `vocals`, `tempo`, `duration`, `language`), 최종 프롬프트 `#prompt`, 재작성 버튼 `#apply-options`를 사용한다. 선택값은 `OPTION_CHOICES`의 키를 따른다.

상태 요소: `#story-count`, `#edit-mode`, `#pending-changes`, `#status`, `#status-message`, `#stage-prompt span`, `#events`, `#payload-details`, `#payload`. HTML 배치를 바꿔도 이 선택자 또는 UI 어댑터만 맞추면 순수 프롬프트 로직을 유지할 수 있다. 사용자 입력은 `textContent`/`value`로만 삽입한다.

## 다음 단계

Supabase 프로젝트 연결 후 DB·비공개 Storage·Edge Function을 구현하고 서버에서 Secret으로 생성 API를 호출한다. 이번 정적 화면은 네트워크 호출을 CSP `connect-src 'none'`으로 차단한다. API 통합 시 실제 서버 도메인에 맞춰 정책도 갱신해야 한다. 브라우저 키 입력, 실제 생성 버튼, 재시도, 공통 결과 페이지, 다운로드·만료·메일 기능은 아직 연결하지 않았다.

50일째 재발급 링크의 만료 기준, 재신청 횟수, 개인정보 보관기간은 제품 결정 대기 상태다. 이번 단계에서 해당 정책이나 50일 복구 보장을 구현하지 않았다.

## 검증 기록 (2026-10-26)

- `npm test`: 기존 Lyria 모의 테스트 11개 + 프롬프트 상태 전이 테스트 4개, 총 15개 통과.
- 실제 Chromium에서 자동 갱신, 수동 편집 보존, 수동 프롬프트로 요청 준비, 재작성 취소·확인, 이전 미리보기 무효화, 빈 사연 차단, HTML 문자열의 텍스트 처리, 브라우저 저장소 미사용, 새로고침 초기화를 확인했다.
- 데스크톱 1440px 및 모바일 390px 화면 확인. 모바일 가로 넘침 없음. JavaScript 예외 및 외부 요청 없음.
- 웹 서버에서 CLI 원본 응답 경로가 404인 것을 확인했다.
- 로컬 화면 캡처와 브라우저 점검 보고서: `artifacts/ui/desktop.png`, `mobile.png`, `smoke-report.json`. Git에는 포함하지 않는다. 브라우저 점검은 일회성 실행으로, `npm test`에는 포함되지 않는다.
- 추가 음악 생성·메일 발송·외부 배포 없음.
