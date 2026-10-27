# Gmail 가계정 연결 순서 — 로컬 방식 참고용

> 2026-10-27 사용자 선택: PC 설치·로컬 실행 없이 온라인에서만 테스트한다. 현재 진행 순서는 [Gmail 온라인 테스트 안내](GMAIL_ONLINE_SETUP.md)를 따른다. 아래 Desktop 절차는 선택적인 로컬 도구 기록이며 지금 실행할 필요가 없다.

발신 계정: **peter@humansyntax.kr**. 사용자가 지정한 첨부 테스트 수신처: **dukedrum@gmail.com**.

사용자는 Google Cloud 최초 설정을 완료했다고 알렸다. 현재 Cloud 실행환경에는 Gmail 인증값과 필요한 호스트가 아직 등록되지 않았다. 연결 도구와 모의 검증은 준비했지만 Google 계정 로그인·동의와 실제 메일 발송은 아직 하지 않았다. Gemini API 키나 ChatGPT Gmail 연결을 서비스 서버의 인증으로 대신하지 않는다.

## 1. Google Cloud에서 최초 설정

Google 계정 소유자가 직접 로그인해서 진행한다. 클라이언트 Secret·비밀번호·refresh token·callback 주소를 채팅에 붙여 넣지 않는다.

1. [Google Cloud Console](https://console.cloud.google.com/)에서 이 앱용 개발 프로젝트를 선택하거나 만든다.
2. **API 및 서비스 → 라이브러리 → Gmail API → 사용**을 선택한다. [Gmail API 라이브러리 바로가기](https://console.cloud.google.com/apis/library/gmail.googleapis.com).
3. **Google Auth Platform → Branding(브랜딩)**에서 앱 이름(예: `노사연 메일 테스트`), 사용자 지원 이메일, 개발자 연락처를 설정한다.
4. **Audience(대상)**에서 본인 Workspace 조직 내부 앱으로 설정할 수 있으면 Internal을 사용한다. 그 선택이 불가능하면 External / Testing으로 두고 **테스트 사용자에 발신 계정 `peter@humansyntax.kr`만 추가**한다. `dukedrum@gmail.com`은 단순 수신자이므로 OAuth 테스트 사용자에 넣을 필요가 없다.
5. **Data Access(데이터 액세스)**에 아래 권한을 추가한다. 메일 읽기·삭제·Drive 권한은 추가하지 않는다.
6. **Clients(클라이언트) → Create client → Desktop app(데스크톱 앱)**을 선택하고 JSON을 다운로드한다. 현재 도구는 로컬 관리자 운영용 Desktop PKCE 흐름이다. Web application JSON과 서비스 계정 JSON은 받지 않는다. Desktop 흐름에서는 임의의 공개 리디렉션 주소를 만들 필요가 없다.

| 권한 | 용도 |
| --- | --- |
| `https://www.googleapis.com/auth/gmail.send` | 관리자가 지정한 MP3 첨부 발송 |
| `openid` | Google 계정 인증 |
| `email` / `https://www.googleapis.com/auth/userinfo.email` | 로그인한 계정이 설정한 발신 주소와 같은지 확인 |

External / Testing 앱에서 Gmail 권한을 요청한 refresh token은 일반적으로 7일 후 만료된다. 정식 운영 전에는 내부 앱 가능 여부 또는 외부 앱의 게시·검증 요건을 확인하고 다시 인증해야 한다. 이번 작업에서 앱을 공개하거나 Google Cloud의 게시 상태를 자동 변경하지 않는다.

공식 근거: [동의 화면 설정](https://developers.google.com/workspace/guides/configure-oauth-consent), [Desktop PKCE·loopback 방식](https://developers.google.com/identity/protocols/oauth2/native-app), [refresh token 만료](https://developers.google.com/identity/protocols/oauth2#expiration).

## 2. 본인 PC에서 로그인·인증 파일 생성

**이 명령을 실행하는 컴퓨터와 로그인 브라우저는 같은 컴퓨터여야 한다.** 현재 Codex Cloud에서 실행한 뒤 사용자 PC의 `127.0.0.1`을 여는 방식은 연결되지 않는다. 공개 터널이나 callback 코드를 채팅으로 넘기는 방식을 사용하지 않는다. 본인 PC의 체크아웃에 최신 코드와 Node.js 24.5 이상이 있어야 한다. 현재 커밋은 원격으로 푸시하지 않았다.

다운로드한 JSON을 해당 체크아웃의 Git 제외 경로 `artifacts/gmail/client.json`에 옮긴다. macOS/Linux에서는 파일 권한을 본인 전용으로 설정한다. Windows에서는 다른 사용자에게 공유되지 않는 폴더를 사용한다.

```sh
# macOS / Linux에서 적용
chmod 600 artifacts/gmail/client.json

# 저장소 루트에서 실행
npm run gmail:authorize -- --client artifacts/gmail/client.json
```

같은 PC 브라우저에서 `http://127.0.0.1:4175/`를 연 뒤 **Google 계정 연결 시작**을 누르고 `peter@humansyntax.kr`로 로그인한다. 연결 도구는 다음을 수행한다.

- 10분간 유효한 난수 state와 PKCE S256으로 callback을 검증한다. state 불일치·callback 재사용·허용되지 않은 Host/Origin을 차단한다.
- Google의 고정된 토큰·계정 확인 호스트만 사용한다. JSON 안의 임의 서버 주소는 사용하지 않는다.
- 메일 보내기·계정 이메일 외의 권한이 반환되거나 다른 계정으로 로그인하면 저장을 중단한다.
- 발신 계정 확인 후 `artifacts/gmail/credentials.json`에 권한 0600으로 저장한다. 기존 파일은 덮어쓰지 않는다. access token·인증 코드·원문 응답은 저장하거나 출력하지 않는다.
- 메일 발송·Google 음악 조회·음악 생성을 하지 않는다.

기존 인증 파일이 있으면 사용 여부를 확인해 별도로 보관한 뒤 새 인증을 진행한다. 계정 전환 시 새 계정 OAuth 동의와 발신 주소 설정을 함께 바꾼다. Workspace 관리자가 앱 액세스를 막으면 해당 관리자의 허용 설정이 필요하다.

## 3. 메일 없이 연결 검사

같은 PC에서 파일 경로로 연결할 수 있다. 이 방식과 세 OAuth 환경변수 설정은 혼합하지 않는다.

```sh
# macOS / Linux 명령 예시
GMAIL_CREDENTIALS_FILE=artifacts/gmail/credentials.json npm run gmail:check
```

이 명령은 refresh token 갱신과 발신 계정 일치만 확인한다. **Gmail API 활성화·발송 한도·수신함 도착까지 검증하는 것은 아니다.** 인증 파일을 읽어야 할 때 파일 권한·크기·심볼릭 링크를 검사한다. 값을 터미널에 출력하지 않는다.

로컬 결과 서버에도 같은 `GMAIL_CREDENTIALS_FILE`을 설정하면 사용할 수 있다. `.env`를 선택 사용한다면 `node --use-env-proxy --env-file=.env scripts/result-server.mjs`로 실행한다. `.env`는 Git 제외이며 명령줄에 Secret 값을 직접 넣지 않는다.

## 4. Codex Cloud 서버 연결

본인 PC의 `credentials.json`을 콘솔에 출력하거나 채팅에 올리지 않는다. 서버 환경의 Secret 관리 화면에 직접 등록한다. 파일 경로 방식은 현재 파일이 실제로 존재하는 호스트에서만 동작한다.

| 항목 | 설정 |
| --- | --- |
| `GMAIL_CLIENT_ID` | 생성한 클라이언트 ID |
| `GMAIL_CLIENT_SECRET` | 클라이언트 Secret. 허용 도메인 `oauth2.googleapis.com` |
| `GMAIL_REFRESH_TOKEN` | 발신 계정 refresh token. 허용 도메인 `oauth2.googleapis.com` |
| `GMAIL_SENDER` | `peter@humansyntax.kr` |
| 네트워크 허용 | `oauth2.googleapis.com`, `openidconnect.googleapis.com`, `gmail.googleapis.com` |

기존 Supabase·Google 음악 API 허용 설정은 유지한다. 설정 게시 후 연결 검사로 실제 계정 일치까지 확인한다. `openidconnect.googleapis.com`에는 단기 access token만 보낸다. 발신 주소를 확인할 수 없으면 발송하지 않는다. 이전의 `gmail.send` 단독 인증은 이메일 확인 권한을 포함해 다시 동의해야 한다.

현재 로컬 관리자 도구를 외부 웹 서비스로 배포할 때는 HTTPS Web OAuth 흐름과 관리자 개인별 로그인·권한을 별도로 설계해야 한다. 이번 Desktop 도구를 고객용 공개 로그인으로 사용하지 않는다.

## 5. 기존 MP3로 첨부 발송 확인

인증 연결이 끝나면 관리자 페이지에서 기존 곡의 백업 MP3를 선택하고 수신처 **dukedrum@gmail.com**을 입력해 **MP3 첨부 메일 발송**을 실행한다. 테스트 수신처는 이 문서에 기록했으며 모든 운영 메일의 기본 수신자로 하드코딩하지 않았다.

원본 해시 검증과 발신 계정 확인을 통과해야 Gmail에 보낸다. 기존 고객 다운로드 권한은 소진하지 않는다. Gmail 접수 기록과 실제 수신 첨부파일의 SHA-256을 따로 확인한다. 응답이 끊기면 이력과 보낸편지함을 확인하고, 자동 재발송하거나 새 음악을 생성하지 않는다.

## 이번 준비 단계 검증

- 전체 자동 테스트 109개 통과. OAuth HTTP 교환은 모의 응답을 사용했으며 실제 Google 계정 동의가 아니다.
- PKCE 교환, state 일치, 단일 callback, 10분 만료, Host·Origin 검사, 계정 불일치, 추가 권한, refresh token 누락·거절, 인증 파일 권한·심볼릭 링크, 메일 없는 검사, 발송 전 계정 확인을 검증했다.
- 현재 환경의 연결 검사에서 Gmail 인증 미설정을 확인했다. 환경에 준비된 Secret은 기존 Gemini·Supabase뿐이고, Gmail용 세 호스트는 아직 허용되지 않았다. 새 OAuth Secret 생성·Google Cloud 설정·실제 메일 발송·DB 변경·음악 생성은 하지 않았다.
