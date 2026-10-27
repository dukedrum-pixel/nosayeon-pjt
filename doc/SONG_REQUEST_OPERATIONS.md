# 실제 사연 신청 → 음악 → 결과 링크 메일

## 현재 배포

- 신청 주소: https://nosayeon-result-check.cw-lee.chatgpt.site
- 이름: 노사연 · 사연을 노래로
- Site ID: `appgprj_6ae116663f34819191c39fbf636cea68`
- Site 소스: `bc886b861553cdf4b9928ca94c96de5b0b1f3a13`
- 배포: `appgdep_6ae12ee860d881919944ee81c4b299e0`, succeeded, 환경 revision 1
- 버전: `appgprj_6ae116663f34819191c39fbf636cea68~appgver_82a388d0e8c48191a97eba97d378d4a3`
- Supabase Edge Function: `nosayeon-result-api`, version 2, ACTIVE
- 마이그레이션: `20261027224532 / song_request_pipeline`

사용자는 신규 사연을 입력하고 신청하면 실제 음악이 생성되고 dukedrum@gmail.com으로 결과 페이지 링크가 전송되며 음악 재생·다운로드가 되는 수준까지 진행하라고 명시적으로 승인했다. 기존 복구를 신규 생성으로 대체하는 금지는 유지한다. 이번 신규 생성은 기존 곡 복구와 별개다.

## 흐름

1. 소유자 비공개 Site에서 사연·옵션을 입력하고 노래 신청하기를 누른다. 수신처는 dukedrum@gmail.com으로 고정된다.
2. Site 서버가 제출 내용을 검증하고, 새 페이지 토큰을 생성해 AES-256-GCM으로 암호화한다. 브라우저에 원본 토큰이나 서버 키를 요구하지 않는다.
3. 서버 전용 접수 키로 Edge API에 접수한다. Edge API는 서버에서 프롬프트를 구성하고 RLS가 적용된 서비스 전용 DB에 접수한다. 새 접수 키는 Google/Gmail 인증값과 별개이고, DB에는 접수 키 해시만 있다.
4. 클라우드 작업자는 DB에서 한 번만 점유한 신청에 Google 생성 POST를 정확히 한 번 수행한다. Interaction ID를 받은 뒤 먼저 체크포인트를 기록한다. 이후에는 동일 Interaction GET만 가능하며 결과 불명 시 자동 새 생성하지 않는다.
5. 완료 오디오를 크기·해시·MIME와 함께 등록하고 비공개 Storage에 저장·재검증한다. 새 곡의 고정 결과 페이지를 발급한다.
6. 기존 완료 안내 outbox와 차수별 중복 방지를 사용해 결과 링크를 Gmail로 1회 발송한다. 음악 파일을 첨부하지 않는다. Gmail 접수와 받은편지함 수신을 구분한다.
7. 결과 페이지에서 재생과 1회 다운로드를 제공한다. 재생은 다운로드 횟수를 소진하지 않는다. 다운로드 전송 시작 시 소비 확정 후 음원을 삭제하는 기존 정책을 유지한다.

## 개발용 작업자와 Secret

Gemini/Gmail Secret은 원래 클라우드 환경에만 준비돼 있고 Supabase 함수에는 없다. 기존 인증값을 다른 서비스로 복사하거나 출력하지 않고, 현재 클라우드 작업자가 정상 SDK/프록시 경로로 처리하게 했다. Supabase가 제공하는 서비스 역할 키는 Edge Function 내부에서만 사용한다.

Site의 `REQUEST_INGRESS_KEY`, `REQUEST_ENCRYPTION_KEY`는 새로 만든 앱 전용 Secret이다. Sites 네이티브 Secret 저장소에만 설정했다. 클라우드 작업자가 사용할 동일 앱 설정은 Git 제외 `artifacts/request-service/runtime.json`에 0600으로 보관한다. 키·토큰·사연·원문 응답은 로그에 출력하지 않는다. 이 파일이 없는 새 환경에서 키를 임의로 다시 만들면 기존 접수 토큰을 복호화할 수 없으므로, 기존 보관 자료를 먼저 연결한다.

```sh
npm run requests:worker
```

작업자는 시작할 때 Gmail 토큰 갱신·발신 계정 일치를 확인하고 10초마다 heartbeat를 기록한다. heartbeat가 60초 넘게 끊기면 신규 신청 버튼이 비활성화된다. 하루 최대 3건, 동시 활성 신청 1건이다. 이는 현재 계정 소유자만 쓰는 개발 테스트 제한이다.

**상시 운영 서버는 아직 아니다.** 현재 클라우드 환경과 작업자 프로세스가 살아 있을 때 처리한다. 환경 중지·프로세스 종료 뒤에도 DB 접수·상태는 보존하지만 자동 재기동/24시간 가용성을 보장하지 않는다. 장기 운영에는 Google/Gmail 인증이 준비된 상시 작업자 호스팅을 마련해야 한다.

Site의 플랫폼 사용자 ID는 Site별로 다른 pairwise ID이므로 계정 ID와 비교하지 않는다. 소유자 비공개 Site의 플랫폼 접근 제어를 유지하고, 플랫폼이 공급한 로그인 사용자 또는 이중으로 보호된 서비스 호출만 허용한다. 접근 대상을 public으로 변경하기 전에 별도 사용자 인증과 비용 제한을 다시 설계해야 한다. 서비스 자동 검증에는 기존 Sites 서비스 액세스 및 별도 접수 Secret을 사용하며, 사용자 ID를 위조하지 않는다.

## 상태와 재처리

`accepted` → `generating` → `saving` → `notifying` → `completed`.

`unknown`은 생성 POST 응답 손실 등 결과 불명이다. `failed`는 저장·확인 실패 등이며 이미 생성됐을 수 있다. `mail_failed`·`mail_unknown`은 음악은 준비됐지만 메일 처리가 실패/불명인 상태다. 자동으로 다시 생성하거나 다시 발송하지 않는다. claim은 `accepted`만 처리하며 이미 점유된 생성 작업은 재점유하지 않는다. 무작정 상태를 accepted로 바꾸지 않는다.

## 실제 검증

- 자동 테스트 131개 통과. RPC 권한·heartbeat·claim-once·멱등 요청·토큰 암호화 호환·정상 생성/저장/메일·응답 손실을 검사했다.
- 실제 신규 신청 ID: `7c2cbc1b-5a3e-4740-b4f8-4517a02c5d65`
- 실제 새 곡 ID: `72e5698a-188f-472d-a8c2-020091e559cd`
- 원본 크기: 2,959,633바이트.
- Google 신규 생성 1회, Storage 저장·검증, peter@humansyntax.kr → dukedrum@gmail.com 결과 링크 메일 sent 및 접수 완료를 확인했다.
- 동일한 배포 코드의 신청 화면과 Site 서버 코드를 로컬 브라우저에서 실행하고 실제 Edge·Google·Storage·Gmail에 연결했다. 클라우드 네트워크에서 임시 사이트 호스트로 직접 접속할 수 없어, 공개 배포 사이트 자체를 브라우저로 직접 검사한 것과는 구분한다. Sites 배포는 native succeeded로 확인했다.
- 결과 페이지가 실제 음원을 재생했고 브라우저 예외는 0건이었다. 자동 검증은 다운로드를 누르지 않았다. 2026-10-27 22:51:00 UTC(한국 시간 10-28 07:51) 검증 완료 시 다운로드 버튼이 사용 가능했다.
- 이후 DB에는 22:51:54 UTC의 별도 다운로드 소비와 음원 삭제 완료가 기록됐다. 이 요청의 주체나 파일 저장 완료까지 자동 검증으로 주장하지 않는다. 이미 소비된 새 곡을 자동 복구·재생성하지 않았다.
- 기존 곡 `c7ed78ea-453a-41ce-84cd-ad185a031f3b`는 stored, consumed=false로 유지했다.
- 증거는 Git 제외 `artifacts/song-request-live/`, 자동 테스트 로그는 `artifacts/continuation/request-tests.log`에 있다. 링크 토큰이 들어간 private state.json은 출력하거나 Git에 넣지 않는다.

## 신청 버튼 및 진행 단계 수정

실제 Site Worker 로그에서 `/api/request/health`가 503으로 실패하는 원인을 확인했다. Cloudflare Workers는 `fetch(..., {redirect:'error'})`를 지원하지 않아 백엔드 호출 자체가 TypeError로 실패했다. Sites 서버 호출만 `redirect:'manual'`로 변경하고 모든 3xx를 명시적으로 거부해 접수 Secret이 다른 호스트로 전달되지 않게 했다. Node/Deno의 기존 호출 정책은 바꾸지 않았다.

초기 상태 확인이 실패하면 신청 버튼이 계속 비활성으로 남던 문제도 수정했다. 5초마다 읽기 전용 상태 확인을 재시도하고, 페이지가 다시 보일 때도 확인한다. 늦게 도착한 상태 응답이 이미 제출한 신청의 잠금을 풀거나 진행 상태를 덮어쓰지 않는다.

하단 4개 단계는 현재 단계 하나만 1.5초 주기로 깜빡이고 이전 단계는 체크 표시, 완료/실패 후에는 깜빡임을 멈춘다. 현재 단계에 aria-current=step을 적용하고 애니메이션 줄이기 설정에서는 고정 강조로 표시한다.

자동 테스트 135개 통과. 실제 배포 로그에서 수정 직후 `/api/request/health`의 연속 HTTP 200 응답을 확인했고, DB의 enabled/worker_ready 모두 true, 신청 건수는 1건 그대로였다. 이번 수정 검증에서 실제 음악·추가 메일을 생성하지 않았다.
