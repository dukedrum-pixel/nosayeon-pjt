# 결과 링크 검증과 기존 음원 조회

## 현재 구현

서버가 결과 링크의 토큰 SHA-256을 Supabase의 `song_result_links`와 비교하고, 저장된 기존 음원의 메타데이터와 바이트를 조회한다. 실제 MP3의 원본 해시 일치와 브라우저 디코딩·재생을 확인했다. 현재 서버는 `127.0.0.1`에만 바인딩하는 Node.js 내부 검증 서버다. Supabase Edge Function이나 Cloudflare에는 배포하지 않았다.

1회 다운로드 권한 소진과 사용 후 파일 삭제를 연결했다([다운로드 정책](DOWNLOAD_POLICY.md)). 새 음악 생성·자동 재생성, Google 재조회, 재신청, 이메일 발송은 실행하지 않는다. 스트리밍 음원은 사용자 기기에 전달되므로 네이티브 다운로드 UI를 숨기는 것은 복제 방지를 의미하지 않는다.

## 실행

Node.js 24.5 이상과 기존 Supabase Secret 바인딩이 필요하다. 명령에는 실행 도구의 명시적 네트워크 권한을 사용한다. 키를 명령 인수나 소스에 넣지 않는다.

```sh
# Supabase URL만 일반 환경변수로 지정. 서비스 키는 기존 Secret 사용.
SUPABASE_URL=https://fuvgpqkyhuyanbfavwcg.supabase.co npm run result:serve
# http://127.0.0.1:4174

# 아직 최초 링크가 없는 저장 완료 음악에만 실행한다.
SUPABASE_URL=https://fuvgpqkyhuyanbfavwcg.supabase.co npm run result:issue -- --song-id <UUID> --allow-link-issue
```

`artifacts/result-links/<UUID>.json`의 `url`을 로컬 결과 서버와 같은 환경의 브라우저에서 연다. 이 파일에는 원본 토큰이 있으므로 Git·채팅·로그에 넣지 않는다. CLI는 파일을 권한 `0600`으로 만들고 링크·토큰을 출력하지 않는다. 새 환경으로 이동할 때 원본 검증 폴더와 함께 비공개로 보존한다. 환경 재시작으로 서버가 종료됐으면 다시 시작해야 한다.

발급 RPC 호출 전에 로컬 `pending` 파일을 배타적으로 생성하므로, 통신 실패 후 명령을 반복해도 기존 토큰을 덮어쓰지 않는다. 실패·타임아웃 시 로컬 토큰의 SHA-256과 해당 곡의 DB `token_hash`를 서버에서 비교해 원격 발급 성공 여부부터 확인한다. 원문을 출력하거나 파일·DB 행을 삭제해 재발급하지 않는다. 로컬 토큰 파일을 잃어버렸을 때 복원·재발급하는 절차는 아직 구현하지 않았다.

## 접근과 만료

- 신규 마이그레이션 `20261026154303_result_link_access.sql`을 실제 프로젝트에 적용했다. 기존 저장 마이그레이션은 재실행하지 않았다. `song_result_links`는 RLS 활성화, `anon`/`authenticated` 테이블 접근·RPC 실행 차단, `service_role` 전용이다.
- 곡당 최초 링크 1개만 허용한다. 저장 완료 곡에만 발급하며 발급 시각부터 정확히 7일간 유효하다. 반복 발급은 거부하며 기존 만료 시각을 연장하거나 토큰을 교체하지 않는다. 미확정인 50일째 재신청 경계·횟수 정책은 구현하지 않았다.
- 32바이트 난수 토큰은 링크의 fragment(`#token=...`)에 넣는다. 브라우저는 읽은 직후 주소창의 query·fragment를 제거하고 토큰을 메모리에서만 사용한다. 새로고침·뒤로가기로 토큰을 잃은 경우 원래 비공개 링크를 다시 열어야 한다. 서버에는 `Authorization: Bearer ...`로 전달한다.
- 서버는 `GET /api/result?id=<UUID>`, `GET /api/audio?id=<UUID>&file=<1..8>`, `POST /api/download?id=<UUID>`마다 토큰 해시·곡 ID·취소·사용 완료 여부·기간·저장 상태를 검사한다. 메타데이터에는 Interaction ID·사연·토큰·버킷 경로·키를 반환하지 않는다.
- 오디오는 Storage에서 전체 파일을 읽고 SHA-256·MIME·크기·결정적 경로를 확인한 후 반환한다. 전송 전에 링크를 다시 조회해 취소·만료·저장 상태 변경을 확인한다. 자동 재시도는 없다.
- 네이티브 오디오의 다중 Range 요청 대신 인증된 fetch로 받은 전체 파일을 메모리 Blob으로 재생한다. 이 내부 검증 서버는 오디오 합계 최대 64MiB이며 다중 접속 스트리밍용 최적화는 후속 작업이다. Storage URL·서비스 키를 브라우저에 전달하지 않는다.
- 클라이언트 만료 타이머는 재생과 Blob을 해제하고, 서버는 새 요청을 독립적으로 차단한다. 이미 사용자 기기에 전달된 오디오 바이트를 회수할 수는 없다. 다운로드 사용 후 삭제는 구현했고, 7일 만료에 따른 자동 삭제 작업은 아직 없다.
- 응답은 `Cache-Control: no-store`, `Referrer-Policy: no-referrer`를 사용한다. 정적 파일은 명시적 허용 목록만 제공하며 Secret·소스·원본·로컬 토큰 파일은 공개하지 않는다. 다른 Origin과 허용되지 않은 Host 요청을 거부하고 CORS 허용 헤더를 추가하지 않는다. 요청 URL·헤더·원본 오류를 로그에 남기지 않는다.

## 실제 검증 (2026-10-27 KST)

- `npm test`: 46개 통과. 새 DB 마이그레이션의 권한·중복·기간 제약과 API의 토큰 누락·변조·취소·만료·오디오 해시 불일치·다운로드 중 만료를 검증했다. 별도 브라우저 모의 응답으로 만료 타이머의 플레이어·소스 해제도 확인했다.
- 기존 MP3 1개, 3,021,074바이트. 결과 API에서 반환한 바이트의 SHA-256이 최초 원본의 `bd4905f2f0b26e675b154e11e1a59851c6f13c987dbf0880487f54d442fda102`와 일치했다.
- 정상 토큰의 결과·오디오 API는 HTTP 200, 누락·변조 토큰은 HTTP 401이었다. 토큰 없는 페이지에서 플레이어를 숨기는 것을 확인했다.
- 실제 Chromium에서 디코딩 길이 약 125.623초와 재생 시간 증가를 확인했다. 모바일 390px 가로 넘침, JavaScript 오류, 외부 HTTP 요청은 없었다. 브라우저 저장소는 비어 있고 주소창에서 토큰을 제거했다.
- 보고서·캡처는 Git 제외 경로 `artifacts/result-live/`에 보존했다. 원본 토큰이나 전체 링크는 보고서에 넣지 않았다.
- DB 권한을 실제 프로젝트에서 확인했다. 보안·성능 Advisors에 ERROR/WARN은 없었다. 서버 전용 테이블의 [RLS 정책 없음 안내](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)와 기존 [미사용 인덱스 안내](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index)는 INFO다.

다운로드·삭제의 후속 구현·검증은 [별도 기록](DOWNLOAD_POLICY.md)을 참고한다. 7일 자동 삭제, 재신청, Edge Function 배포·호스팅·메일은 후속 작업이다.
