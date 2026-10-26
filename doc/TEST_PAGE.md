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

### 공통 결과 페이지 상태 미리보기 (2026-10-27)

`npm run dev` 후 `http://127.0.0.1:4173/result-preview.html`에서 사용 가능, 다운로드 사용 완료, 7일 만료, 보관기간 종료, 준비 중, 유효하지 않은 링크, 조회 오류 화면을 전환할 수 있다. 프롬프트 화면 하단에도 진입 링크가 있다. 실제 결과를 조회하는 페이지가 아닌 예시 데이터 기반 검증 화면이며, 재생 소스와 다운로드·재신청 동작은 연결하지 않았다. 초기 상태는 유효하지 않은 링크다. URL의 ID·토큰·상태값은 읽지 않으며 브라우저 저장소도 사용하지 않는다. 실제 서버 연결 페이지는 이후 `/result.html`로 분리했다.

- `web/js/result-state.mjs`: DOM·네트워크에 의존하지 않는 `buildResultView(snapshot, now)` 함수. 서버 응답 계약은 `{ status, expiresAt?, canRestore? }`다. `expiresAt`은 시간대가 명시된 ISO 시각이며 사용 가능 상태에서는 필수다. 만료 경계에 도달하면 재생·다운로드를 숨긴다. 잘못된 응답은 오류 화면으로 처리한다.
- `canRestore === true`인 만료·사용 완료 상태에만 재신청 버튼을 표시한다. 50일 경계와 재신청 횟수를 클라이언트에서 임의로 정하지 않는다. 재신청이 불가능해도 서버가 허용한 기존 링크의 사용 가능 상태를 임의로 보관 종료로 바꾸지 않는다.
- `web/js/result-preview.mjs`: 예시 상태 구성과 DOM 표시 담당. 상태를 바꿀 때 오디오 재생·소스를 초기화한다. 모든 버튼은 비활성화돼 있고 CSP는 `connect-src 'none'; media-src 'none'`을 유지한다.
- UI 계약: `#result-heading`, `#result-message`, `#result-expiry`, `#result-playback`, `#result-audio`, `#result-download`, `#result-restore`. 예시 전용 컨트롤은 `#result-scenario`, `#restore-eligible`이다. 서버 연결 시 예시 컨트롤과 어댑터를 교체하고 표시 계약은 유지할 수 있다.
- 화면 모델은 접근 제어가 아니다. 후속 서버는 원본 토큰의 해시 검증, 매 요청의 유효기간·권한 확인, 다운로드 권한의 원자적 소진, 파일 전송·삭제 처리를 구현해야 한다. 현재 화면에서는 링크를 발급하거나 기존 음악의 권한·파일을 변경하지 않는다.

검증: `npm test` 총 34개 통과(결과 상태 테스트 5개 추가). 실제 Chromium에서 7가지 상태, 재신청 허용 전환, URL 입력 무시, 버튼 비활성화, 음원 소스 없음, 브라우저 저장소 미사용을 확인했다. 데스크톱 1440px·모바일 390px에서 화면을 확인했고 모바일 가로 넘침, JavaScript 오류, 외부 요청은 없었다. 원본 MP3의 웹 경로는 HTTP 404였다. 화면 캡처와 점검 보고서는 Git 제외 경로 `artifacts/result-ui/`에 보존한다.

### 실제 API 연결

DB·비공개 Storage 기반과 기존 음악 저장·검증을 완료했다. 결과 조회용 로컬 서버와 실제 `/result.html`의 연결·재생, 1회 다운로드·사용 후 삭제를 연결했다([결과 조회 안내](RESULT_ACCESS.md), [다운로드 정책](DOWNLOAD_POLICY.md)). [만료 자동 정리](EXPIRY_CLEANUP.md)는 Supabase Cron과 전용 Edge Function으로 실행한다. 프롬프트 화면과 상태 미리보기의 CSP `connect-src 'none'`은 유지한다. 실제 결과 화면은 같은 출처 API와 메모리 Blob 재생만 허용한다. 사용자 결과 API·Cloudflare 공개 배포, 실제 생성 버튼, 메일·카톡은 아직 연결하지 않았다. 고정 페이지·재신청은 [후속 기록](REISSUE.md)을 참고한다.

재신청 만료 기준과 횟수는 이후 [제품 정책](PRODUCT_POLICY.md)으로 확정했다. 50일은 재신청 자격 기간이며, Google의 실제 50일 보관을 검증 없이 보장하지 않는다. 개인정보 보관 정책은 별도다.

## 검증 기록 (2026-10-26)

- `npm test`: 기존 Lyria 모의 테스트 11개 + 프롬프트 상태 전이 테스트 4개, 총 15개 통과.
- 실제 Chromium에서 자동 갱신, 수동 편집 보존, 수동 프롬프트로 요청 준비, 재작성 취소·확인, 이전 미리보기 무효화, 빈 사연 차단, HTML 문자열의 텍스트 처리, 브라우저 저장소 미사용, 새로고침 초기화를 확인했다.
- 데스크톱 1440px 및 모바일 390px 화면 확인. 모바일 가로 넘침 없음. JavaScript 예외 및 외부 요청 없음.
- 웹 서버에서 CLI 원본 응답 경로가 404인 것을 확인했다.
- 로컬 화면 캡처와 브라우저 점검 보고서: `artifacts/ui/desktop.png`, `mobile.png`, `smoke-report.json`. Git에는 포함하지 않는다. 브라우저 점검은 일회성 실행으로, `npm test`에는 포함되지 않는다.
- 추가 음악 생성·메일 발송·외부 배포 없음.
