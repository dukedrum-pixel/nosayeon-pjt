# 관리자 페이지와 백업 MP3 직접 전달

## 현재 구현

`npm run result:serve`의 로컬 서버에서 `http://127.0.0.1:4174/admin.html`을 연다. 외부 배포는 하지 않았으며 서버는 loopback에만 바인딩한다. 서비스 역할 키와 별개인 관리자 토큰으로 모든 관리자 API를 인증한다.

- 음악 요청·완료·보관·복구·재신청·안내 대기 건수, DB 크기, 프로젝트 전체 및 음악 파일 Storage 사용량.
- 곡 ID 검색, 20건 페이지, 원본 파일 정보, 직접 전달 준비·발송 이력.
- 관리자 PC에서 고른 기존 백업 MP3를 DB의 원본 크기와 SHA-256에 대조한다. Google 조회·새 생성·자동 재생성 없이 동작한다.
- 검증된 MP3를 관리자가 내려받아 직접 첨부하거나, Gmail API가 연결되면 화면에서 수신처를 입력해 MP3 첨부 메일을 발송한다. 여러 원본이 있으면 파일별로 선택한다. WAV 발송은 현재 지원하지 않는다.
- 카카오 비즈메시지, 결제·환불, Google Drive 자동 백업은 추후 작업으로 표시한다. Drive 데스크톱 동기화 구상은 별도 백업 작업으로 남겼으며 이번에는 구현하지 않았다.

현재 `songs`에는 생성 완료 후 등록된 음악만 있어 전체 접수·생성 실패 건수는 알 수 없다. 카드에 이 범위를 명시했다. 요청 접수 시스템이 연결되기 전까지 미확인 수치를 0건으로 꾸미지 않는다.

DB 크기는 `pg_database_size(current_database())`이며 WAL·시스템 파일·다른 DB는 포함하지 않는다. Storage 사용량은 `storage.objects`의 크기 메타데이터 합계이고 조직 전체의 청구 사용량과 다르다. 알 수 없는 파일 크기가 있으면 잔여량 산정을 중단한다. 요금제 용량은 자동 조회하지 않는다. 실제 기준값을 `ADMIN_DATABASE_CAPACITY_BYTES`, `ADMIN_STORAGE_CAPACITY_BYTES`에 넣으면 그 기준에 대한 잔여량을 계산하고, 미설정이면 미설정으로 표시한다. 디스크의 물리적 여유 공간을 나타내는 수치는 아니다.

## 관리자 인증

`ADMIN_ACCESS_TOKEN`에 최소 32바이트 난수의 base64url 값(43~128자)을 서버 Secret으로 지정할 수 있다. Supabase 키나 고객 페이지 토큰을 재사용하지 않는다.

설정이 없으면 서버 시작마다 32바이트 난수로 로컬 전용 토큰을 생성하고 `artifacts/admin/access.json`에 권한 0600으로 저장한다. 값은 로그에 출력하지 않는다. 로그인 화면에서 이 파일을 선택하면 된다. 토큰은 브라우저 메모리에만 있고 localStorage·sessionStorage·쿠키·URL에 저장하지 않는다. 로그아웃·페이지 이탈 시 메모리 인증과 준비 파일의 blob URL을 해제한다. 파일과 `artifacts/`는 Git 제외다. 토큰 파일은 서버 호스트에서만 접근하고 외부 공유하지 않는다. 서버 재시작 시 기존 자동 발급 토큰은 무효가 된다.

현재는 내부 로컬 운영 도구다. 외부 관리자 배포에는 HTTPS와 개인별 관리자 로그인·권한 및 세션 관리가 필요하다. 현재 토큰을 공개 웹사이트에 배포하지 않는다.

## 직접 전달과 기존 고객 권한

백업 파일은 서버 메모리에서만 처리하며 Supabase Storage나 디스크에 재저장하지 않는다. 해시 불일치·잘못된 곡·50일 경과는 준비 및 발송 전에 차단한다. 동시 업로드는 서버당 1개이고 파일은 원본 크기 이하, 최대 64 MiB다. Gmail 첨부는 MIME 인코딩 크기를 고려해 18 MiB 이하로 제한한다.

직접 전달은 고객 결과 페이지 재신청과 별개다. 기존 다운로드 차수·7일·1회 권한, 페이지 토큰, 저장 파일을 변경하거나 삭제하지 않는다. 직접 전달 가능 기간은 최초 생성부터 50일 미만으로 적용했다. 고객이 받은 이메일 첨부파일은 고객 다운로드 링크의 1회·만료 제한을 적용할 수 없다.

`admin_delivery_exports`는 다음 상태를 구분한다. 원문 응답·오디오·관리자 토큰·고객 페이지 토큰은 기록하지 않는다. 수신처와 발신 주소는 발송 중복 확인을 위해 서버 전용 DB에 저장하며 브라우저의 이력 API에는 노출하지 않는다.

| 상태 | 의미 |
| --- | --- |
| `prepared` | 원본 검증 후 파일 응답을 준비함. 파일 저장·메일 발송 성공을 뜻하지 않음 |
| `sending` | DB에 발송 시작 기록을 확정함. 서버 중단 시 결과 확인 필요 |
| `sent` | Gmail이 메시지 ID를 반환하고 DB에 기록함. 수신함 도착 보장은 아님 |
| `failed` | 발송 전 인증 실패 또는 Gmail의 명시적인 거절 |
| `unknown` | 발송 POST 도중 연결 끊김·5xx·응답 이상 등 결과 불명 |

발송 요청마다 멱등 키를 사용한다. 같은 키의 재요청은 다시 보내지 않는다. 발송 후 DB 확정 응답을 잃으면 `sending` 또는 이미 확정된 상태를 유지하며 자동 재발송하지 않는다. `sending`·`unknown`은 Gmail 보낸편지함과 이력을 확인하고 운영자가 처리해야 한다. 브라우저 재로그인·다른 탭·새 요청 키는 다른 요청이므로, 재전송 전에 기존 이력을 반드시 확인한다. HTTP 응답·DB·메일 서버를 하나의 트랜잭션으로 묶을 수 없으므로 전달의 정확히 한 번을 보장하지 않는다.

## Gmail 가계정 연결

초기 발신 주소는 사용자가 지정한 `peter@humansyntax.kr`이다. 현재 환경에는 Gmail 앱 전용 인증이 없어 실제 발송은 비활성이다. ChatGPT의 Gmail 연결은 이 서비스 서버의 OAuth 인증을 대신하지 않는다. 실제 계정 로그인이 없으므로 발신 주소에 대한 소유·송신 권한도 아직 실검증하지 않았다.

1. Google Cloud 프로젝트에서 Gmail API를 활성화하고 OAuth 클라이언트와 동의 화면을 준비한다.
2. 해당 가계정으로 OAuth 동의를 완료한다. `https://www.googleapis.com/auth/gmail.send`와 계정 이메일 확인용 `openid email`, offline access를 사용해 refresh token을 받는다. 메일 읽기·삭제·Drive 권한은 요청하지 않는다. 내부 Workspace 앱 설정 가능 여부와 관리자의 앱 허용 정책을 확인한다. 외부 Testing 앱은 refresh token 만료 제한이 있으므로 서비스 운영 전에 게시 상태·검증 요구를 확인한다.
3. 서버 Secret에 아래 값을 설정한다. 채팅·Git에 붙여 넣지 않는다. `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`의 허용 도메인은 `oauth2.googleapis.com`으로 제한하고, 네트워크에는 `oauth2.googleapis.com`, `openidconnect.googleapis.com`, `gmail.googleapis.com`을 허용한다. 발급된 단기 access token만 Gmail 호스트에 보낸다.
4. [Gmail 최초 연결 순서](GMAIL_SETUP.md)의 로컬 PKCE 연결 도구와 `gmail:check`로 토큰 갱신·발신 계정 일치를 먼저 확인한다. 서버 재시작 후 인증 설정 여부가 표시된다. 실제 연결과 발송은 지정한 테스트 수신처에 직접 발송해 별도로 확인한다. 키가 존재하는 것만으로 발송 성공을 표시하지 않는다.

| 설정 | 내용 |
| --- | --- |
| `GMAIL_CLIENT_ID` | OAuth 클라이언트 ID |
| `GMAIL_CLIENT_SECRET` | 해당 OAuth 클라이언트 Secret |
| `GMAIL_REFRESH_TOKEN` | 발신 계정이 동의한 offline refresh token |
| `GMAIL_SENDER` | 초기 `peter@humansyntax.kr`; 본계정 전환 시 교체 |

로컬에서는 `GMAIL_CREDENTIALS_FILE`로 본인 전용 인증 파일을 지정할 수도 있다. OAuth 환경변수 세 항목과는 혼합하지 않는다. 파일의 발신 주소와 다른 `GMAIL_SENDER`는 거부한다. 메일 발송 직전에 Google 계정 이메일을 확인하고 일치하지 않으면 발송을 차단한다.

본계정 전환은 새 계정의 OAuth 동의를 받고 인증값·발신 주소를 함께 교체한다. 다른 계정 토큰을 유지한 채 발신 문자열만 바꾸지 않는다. 비밀번호나 Gemini API 키로 Gmail 발송을 인증하지 않는다. 세 OAuth 설정 중 일부만 있으면 잘못된 설정으로 서버 시작을 중단한다.

공식 근거: [Gmail 첨부 메일 생성·발송](https://developers.google.com/workspace/gmail/api/guides/sending), [Gmail 권한](https://developers.google.com/workspace/gmail/api/auth/scopes), [OAuth offline access](https://developers.google.com/identity/protocols/oauth2/web-server#offline).

## 적용 및 검증

실제 Supabase에 `20261026230353 / admin_dashboard`를 적용했다. 기존 마이그레이션은 재실행하지 않았다. 새 감사 테이블은 RLS를 활성화하고 `anon`·`authenticated`의 테이블 및 RPC 권한을 차단했다. RPC는 SECURITY INVOKER이고 서버 `service_role`만 실행한다. Storage 객체는 SQL로 수정하지 않는다.

- 자동 테스트 103개 통과. 관리자 인증, 잘못된 해시, 50일 경계, SQL 권한, 멱등 키, Gmail MIME 첨부, 실패·결과 불명, 실제 HTTP 전달을 검사했다. Gmail 발송 검증은 모의 HTTP이며 실제 계정 발송이 아니다.
- 실제 DB·로컬 브라우저에서 원본 3,021,074바이트 MP3로 검사했다. SHA-256 `bd4905f2f0b26e675b154e11e1a59851c6f13c987dbf0880487f54d442fda102` 일치. 별도 검증용 곡은 `deleted` 상태이고 Storage 음원 없이 백업 MP3의 직접 전달 준비·재다운로드에 성공했다. 잘못된 파일 차단, 모바일 가로 넘침 없음, 브라우저 예외 없음, 로그아웃, 브라우저 지속 저장소 미사용을 확인했다.
- 원래 곡의 Storage 상태와 파일 경로는 유지했다. Google 요청·음악 생성·실제 메일 발송은 하지 않았다. 검증 자료는 Git 제외 `artifacts/admin-live/`에 보관한다.
- 실제 Advisors의 ERROR/WARN 없음. RLS 정책 없음 INFO는 서버 전용 설계이며, 미사용 인덱스 INFO는 아직 사용량이 적기 때문이다. [RLS 안내](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy), [인덱스 안내](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index).
- 검증 후 정확한 fixture ID와 `verification:admin:` 접두·삭제 상태를 확인해 검증용 음악 및 준비 기록을 정리했다. 최종 DB는 원래 음악·파일 각 1건, 직접 전달 기록·검증용 음악 각 0건이다. 원래 다운로드는 미소진 상태다.
