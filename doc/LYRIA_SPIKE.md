# Lyria 동일 음원 복구 검증

작성일: 2026-10-26 (Asia/Seoul)

## 현재 상태

- 1단계 기술 검증용 CLI 구현. Node.js 24.5 이상, 추가 패키지 설치 불필요.
- 실제 Google API 호출: **테스트 음악 1곡 생성 및 동일 Interaction 재조회 성공**.
- 즉시 재조회 오디오의 SHA-256 일치 확인. **50일 후 복구 가능 여부는 검증 전**.
- 새 Cloud 작업에서 Secret `ready`, 네트워크 정책 `enforced` 확인. 네트워크 명령에는 실행 도구의 명시적 네트워크 접근 권한이 필요했다.
- 기존 `PROJECT_HANDOFF.md`는 원본 인계 기록으로 보존한다.

## 실제 검증 결과 (2026-10-26 23:06 KST)

- 기준 코드: `codex/lyria-recovery-spike`, `8d34a2f`.
- `npm test`: 모의 테스트 11개 통과. 실제 API 결과와 구분한다.
- `npm run spike -- --allow-paid-call`: 생성 POST 1회, 같은 Interaction GET 1회. 자동 재생성 없음.
- 모델: `lyria-3.5`. 생성 응답 소요시간 25,089ms, 재조회·비교 696ms.
- 결과: `identical`. 원본과 재조회 모두 inline `audio/mpeg`, 각 3,021,074바이트.
- `ffprobe` 확인: 약 2분 6초(125.623초), MP3, 44.1kHz 스테레오, 약 192kbps. `sha256sum`으로 두 파일의 해시도 별도 재확인했다.
- 양쪽 SHA-256: `bd4905f2f0b26e675b154e11e1a59851c6f13c987dbf0880487f54d442fda102`.
- 로컬 실행 폴더: `artifacts/lyria/run-QhkKWf`. Interaction ID, 최초 응답, 원본/복구 MP3, `baseline.json`, `report.json`, `timing.json` 보존. 원본 응답과 음악은 Git에 포함하지 않는다.
- 이후 검증은 `npm run spike -- --resume artifacts/lyria/run-QhkKWf`로 같은 Interaction만 조회한다. 위 생성 명령을 반복하지 않는다.
- 즉시 복구의 바이트 동일성만 입증했다. Google AI Studio의 55일 보관 설정, 실제 청구액, 50일 뒤 복구는 별도 확인이 필요하다.

## 새 Cloud 작업에서 이어가기

사용자가 게시한 API 키와 허용 도메인이 새 작업에 적용됐고 실제 검증도 완료했다. 아래는 최초 실행 절차이며, 이번 음악에 대한 후속 작업은 저장된 실행 폴더의 `--resume`을 사용한다. 새 작업에서도 실제 준비 상태를 확인한다.

1. 개발 브랜치 `codex/lyria-recovery-spike`의 최신 코드를 사용한다. `main`에는 검증 도구가 없을 수 있다.
2. Cloud 환경 상태에서 `GEMINI_API_KEY` 바인딩의 준비 상태와 Google 도메인 허용을 확인한다. 키 값은 출력하지 않는다.
3. `npm test` 실행 후 기존 실행 폴더를 확인한다. 승인된 테스트 1곡은 이미 생성했으므로 새 생성 명령을 반복하지 않는다.
4. 실패 시 자동 재생성하지 않는다. `artifacts/lyria/run-*`의 저장 상태를 확인하고 가능한 경우 `--resume`으로 동일 Interaction 조회만 재개한다.
5. 실제 결과와 모의 테스트 결과를 구분해서 보고한다. 이번 즉시 재조회는 성공했으며 장기 보관은 아직 검증하지 않았다.

## 확인한 공식 계약

- [음악 생성 문서](https://ai.google.dev/gemini-api/docs/music-generation): `lyria-3.5`와 Interactions API를 통한 전체 곡 생성 및 MP3 출력.
- [REST API](https://ai.google.dev/api/interactions-api): POST `/v1beta/interactions`, GET `/v1beta/interactions/{id}`, `steps` 중 `model_output.content`의 audio 블록. 오디오는 `data` 또는 `uri`로 전달될 수 있다.
- [보관정책](https://ai.google.dev/gemini-api/docs/interactions-overview#data-storage-and-retention): 유료 기본 55일, 무료 1일. 유료 프로젝트에서 보관기간 설정 가능.

문서상 Interaction 조회 지원과 실제 동일 오디오 복구 성공은 별개다. 즉시 조회 성공도 50일 뒤 성공을 보장하지 않는다. 실제 가격과 청구액은 별도로 확인해야 한다.

## 실행 준비

1. Google AI 프로젝트에서 결제와 Lyria 모델 접근 권한 확인.
2. 보관기간 55일 확인.
3. Codex Cloud 환경 Secrets에 `GEMINI_API_KEY` 등록. 키를 채팅이나 저장소에 넣지 않는다.
4. 환경 네트워크 설정에 `generativelanguage.googleapis.com` 허용. 실제 응답이 Storage URI인 경우 `storage.googleapis.com`도 허용.
5. 환경 설정 반영 후 Secret 준비 상태 확인.

로컬 실행 시에만 `.env.example`을 참고해 Git에서 제외된 `.env`에 키를 넣고 `node --use-env-proxy --env-file=.env scripts/lyria-spike.mjs ...`로 실행할 수 있다. `npm run spike`는 `.env`를 자동으로 읽지 않고 환경변수를 사용한다.

## 실행

```sh
# 기본 실행은 안내만 출력하며 API 호출 없음
npm run spike

# 유료 곡 생성 POST 1회 후 동일 Interaction GET 및 SHA-256 비교
npm run spike -- --allow-paid-call

# 출력된 실제 run 경로 사용. 새 곡 생성 없이 재조회만 실행
npm run spike -- --resume artifacts/lyria/run-XXXXXX

# 외부 API 호출 없는 모의 응답 테스트
npm test
```

생성 요청이 타임아웃됐더라도 서버에서 생성됐을 수 있다. 새 생성 명령을 바로 반복하지 말고 출력된 실행 폴더와 Google AI Studio 로그를 확인한다. 생성 응답이 없는 경우 `resume`은 자동 생성을 거부한다.

## 결과 파일과 판정

`artifacts/lyria/run-*` 아래에 생성 응답, 완료 응답, 최초/재조회 오디오, 생성 응답 소요시간, `baseline.json`, `report.json`을 기록한다. 이 폴더 전체는 Git에서 제외하며 원본 응답은 로컬 진단용 민감 자료로 취급한다. 공유하기 전에 사연, 오디오, URI 등을 검토해야 한다. 콘솔에는 키, 응답 본문, Base64, 서명 URI를 출력하지 않는다.

- `identical`: 생성된 모든 오디오 블록의 수·MIME·SHA-256이 일치. 프로세스 종료 코드 0.
- `different`: 오디오 블록 또는 해시 불일치. 종료 코드 1. 보관정책 구현을 보류하고 원인 조사.
- 오류: 인증, 접근 권한, 조회, 오디오 추출 등에 실패. 종료 코드 1. 자동 재생성 없음.

`resume`은 저장된 최초 파일 해시를 계속 비교 기준으로 사용한다. 다음 날이나 보관기간 경계에서도 같은 실행 폴더로 재검증할 수 있다. 모의 테스트 데이터는 실제 재생 가능한 MP3가 아니므로 테스트 통과는 Google 연동 성공을 뜻하지 않는다.

## 검증 범위와 남은 과제

- 동기 생성 응답을 우선 사용한다. `in_progress` 응답은 동일 ID의 GET으로 최대 120회 대기한다. background 생성 지원과 Supabase 실행 제한은 후속 검증이다.
- 오디오는 MP3/WAV만 처리한다. 허용 URI는 HTTPS Google API 및 Google Storage 호스트로 제한하며 리다이렉트는 차단한다. 다른 URI가 나오면 검토 후 대응한다.
- 최초 응답 시간이 기록되지만 정확한 곡 길이·비트레이트·실제 청구액은 자동 측정하지 않는다. 실제 호출 후 파일 및 결제 사용량에서 확인한다.
- API 키는 Google API 호스트에만 헤더로 전달하고 Storage URI에는 전달하지 않는다.
- API 요청에는 자동 재시도가 없다. 재조회 실패는 `resume`으로 수동 재시도한다.
- 검증 결과가 나온 후 7일 파일 삭제 + 50일 재신청 정책의 가능 여부를 결정한다.
- 제품 결정 대기: 50일째 재발급 링크의 만료 기준, 재신청 횟수, 개인정보 보관기간.
