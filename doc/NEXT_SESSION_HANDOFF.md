# 다음 작업 인계 — 2026-10-28 한국 시간

현재 운영·배포 기준은 [SONG_REQUEST_OPERATIONS.md](SONG_REQUEST_OPERATIONS.md)다. 저장소 `dukedrum-pixel/nosayeon-pjt`, 브랜치 `codex/lyria-recovery-spike`를 이어간다.

## 사용자 합의

- 기존 MP3 첨부 테스트는 완료·수신 확인됐다. 다시 발송하지 않는다.
- 신규 사연 신청 → 실제 음악 생성 → dukedrum@gmail.com 결과 링크 안내 → 결과 페이지 재생·다운로드까지 사용자가 승인했고 구현됐다.
- 최신 요청은 **ChatGPT 로그인 없이 지정한 입장 비밀번호로 접속**, **실제로 동작하는 재신청 버튼**이다. 사용자가 공개 접근과 비밀번호 방식을 명시적으로 선택했고 모두 배포·검증했다. 비밀번호 원문은 문서·소스·Git에 기록하지 않는다.
- 기존 음악 재신청을 새 음악 생성으로 대체하거나 실패한 생성/메일을 자동 반복하지 않는다. 키·토큰·원문 응답을 출력하거나 Git에 넣지 않는다.
- 확인이 꼭 필요하면 추천안을 포함한 2~3가지 선택지만 제시한다. 불필요한 승인 질문으로 멈추지 않는다. SQL 변경/검증은 서비스 시작 전까지 별도 승인 없이 진행하도록 합의했다.

## 현재 배포

- 주소: https://nosayeon-result-check.cw-lee.chatgpt.site
- 기존 Site ID `appgprj_6ae116663f34819191c39fbf636cea68`를 재사용한다. 새 Site를 생성하지 않는다.
- Site 소스 `be5e598a70fb4af15ba50c93e46dccf8adaa520f`, 배포 `appgdep_6ae1359b99b4819189e6e66a116b58da`, succeeded, env revision 2.
- access_mode=public. 이후 수정은 일반 save_site_version/deploy_site_version을 사용한다. 소유자 비공개 배포 도구를 사용하지 않는다.
- Edge `nosayeon-result-api` v3 ACTIVE. 모든 고객 API는 Site 서버 전용 키를 추가로 요구한다.
- 마이그레이션 `20261027233531_password_access_and_restore_queue.sql`까지 적용했다. 재적용하지 않는다.
- 원래 Google/Gmail Secret은 클라우드에 유지한다. Site에는 앱 전용 접수·암호화·세션 키와 입장 비밀번호만 Secret으로 설정했다.
- Git 제외 `artifacts/request-service/runtime.json`의 기존 key/ingressToken/sessionKey/origin을 보존한다. 임의 교체하면 기존 자료 복호화/접수/세션에 문제가 생긴다. 파일을 출력하지 않는다.

## 최신 검증

전체 테스트 138개 통과. 실제 복구 검증은 이미 다운로드·삭제된 테스트 곡 `72e5698a-188f-472d-a8c2-020091e559cd`에서 1회 진행했다. 원래 주소·토큰 유지, delivery_version=1, stored, consumed=null, 복구 queue succeeded, 새 차수 완료 안내 sent. 실제 음악 재생 후 다운로드 권한 보존을 확인했다. 이번 검증은 음악을 새로 생성하거나 다운로드를 소비하지 않았다.

브라우저 검증은 배포와 같은 Worker 코드를 로컬 라우팅하고 실제 원격 서비스를 연결했다. 클라우드의 Site 호스트 접속 제한으로 배포 사이트 자체를 브라우저로 검증한 것으로 주장하지 않는다. 네이티브 도구로 실제 배포 succeeded/public을 확인했다. Git 제외 `artifacts/password-restore-live/`에 안전한 보고서와 화면을 보관한다.

현재 작업자는 `node --use-env-proxy scripts/song-request-worker.mjs` 프로세스(실행 세션 70779)다. **상시 운영 서버가 아니다.** heartbeat 60초 경과 시 신청을 비활성화한다. 재시작 전 기존 프로세스와 활성 신청·복구를 확인하고, 두 개를 중복 실행하지 않는다. 하루 총 3건·동시 신규 신청 1건 제한을 유지한다. 다음 독립적인 과제는 상시 작업자 호스팅이다. 사용자 요청 없이 실제 생성·복구·메일 테스트를 반복하지 않는다.

## 구현 주의

입장 세션은 8시간 Secure/HttpOnly 쿠키, 비밀번호 5회 실패 시 5분 차단이다. 결과 링크 `#token`은 입장 후에도 유지한다. 결과 UI의 fetch credentials는 same-origin이어야 입장 쿠키가 포함된다. Edge 직접 호출은 고객 토큰만 있어도 401이다.

복구 버튼은 `/api/restore`를 한 번 접수하고 상태 조회만 반복한다. 클라우드 작업자는 기존 Interaction GET만 수행하고 해시 검증 후 새 다운로드 차수를 준비한다. 자동 새 생성/복구 재시도/메일 재발송을 넣지 않는다. 이미 사용 중이던 구버전 탭은 새로고침해 입장해야 한다.

과거 계획/검증 기록은 다른 handoff 문서에 남아 있지만 현재 승인 대기나 비공개 전용 상태로 해석하지 않는다. 최신 사용자 지시와 이 문서의 현재 상태를 우선한다.
