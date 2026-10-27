# Gmail 온라인 테스트 — PC 설치·명령어 불필요

발신 `peter@humansyntax.kr`, 사용자가 지정한 첨부 테스트 수신처 `dukedrum@gmail.com`.

브라우저에서 Google 공식 OAuth Playground로 인증을 받고, 서버 Secret 관리 화면에 직접 등록한다. 이후 Codex Cloud 실행환경에서 기존 MP3로 실제 발송을 검증한다. 공개 관리자 페이지는 아직 배포하지 않았지만 이번 메일 테스트에는 공개 사이트나 별도 도메인이 필요하지 않다. Node.js 설치·ZIP·로컬 callback은 사용하지 않는다. 정식 관리자 페이지의 Gmail 연결 버튼과 HTTPS callback은 별도 웹 배포 단계에서 구현해야 한다.

## 1. 기존 Google Cloud 프로젝트에 Web 클라이언트 추가

Gmail API 활성화·Branding·Audience 등 이미 완료한 설정은 유지한다. 이전 Desktop 클라이언트는 지울 필요 없다.

1. [Google Cloud Console](https://console.cloud.google.com/)에서 기존 프로젝트를 선택한다.
2. Google Auth Platform → Clients → Create client.
3. Application type은 **Web application**을 선택한다. 이름은 `노사연 온라인 메일 테스트` 등으로 정한다.
4. **Authorized redirect URIs(승인된 리디렉션 URI)**에 아래 주소를 정확히 넣는다. JavaScript origins 칸이 아니다. 끝에 `/`를 추가하지 않는다.

```text
https://developers.google.com/oauthplayground
```

5. 생성 후 Client ID와 Client Secret을 본인만 접근 가능한 비밀 관리 위치에 보관한다. Secret은 생성 시점에만 확인 가능할 수 있으므로 창을 닫기 전 보관한다. 채팅·Git에는 넣지 않는다.

## 2. Playground를 본인 클라이언트로 설정

1. [Google 공식 OAuth Playground](https://developers.google.com/oauthplayground/)를 연다.
2. 우측 상단 톱니바퀴(OAuth 2.0 configuration)를 연다.
3. OAuth flow는 **Server-side**, OAuth endpoints는 **Google**, Access type은 **Offline**, Force prompt는 **Consent Screen**으로 둔다. Custom endpoint를 설정하지 않는다.
4. **Use your own OAuth credentials**를 체크한다.
5. 1번에서 만든 Web 클라이언트의 ID와 Secret을 해당 칸에 직접 입력하고 설정을 닫는다.

이 방식은 Google 공식 Playground 서버를 통해 인증 요청을 전달하므로 Client Secret을 Google Playground에 제공한다. 다른 온라인 토큰 생성 사이트를 사용하지 않는다. Playground 기본 클라이언트를 쓰면 refresh token이 24시간 후 자동 취소되므로 본인 클라이언트를 사용한다. 본인 클라이언트라도 External / Testing 앱의 refresh token은 Gmail 권한을 포함할 때 일반적으로 7일 제한이 있다.

## 3. 필요한 권한만 요청

왼쪽 **Step 1 → Input your own scopes**에 다음 한 줄을 넣는다.

```text
https://www.googleapis.com/auth/gmail.send openid email
```

**Authorize APIs**를 누르고 발신 계정 **peter@humansyntax.kr**로 로그인한다. 선택한 계정·앱 이름·권한을 확인한 뒤 동의한다. 메일 읽기·삭제·Drive 권한은 필요하지 않다. Workspace 관리 정책에 막히면 해당 관리자의 허용이 필요하다.

External / Testing이면 Audience의 테스트 사용자에 발신 계정을 추가한다. 수신자 dukedrum@gmail.com은 OAuth 동의를 하는 계정이 아니므로 추가할 필요 없다.

## 4. 토큰 발급 및 계정 확인

1. Playground로 돌아오면 **Step 2 → Exchange authorization code for tokens**를 누른다.
2. **Refresh token** 값이 생겼는지 확인한다. Access token과 혼동하지 않는다. 토큰을 채팅이나 공유 링크로 보내지 않는다.
3. 발신 계정 확인을 위해 **Step 3**에서 Method를 **GET**, Request URI를 아래로 설정한다.

```text
https://openidconnect.googleapis.com/v1/userinfo
```

4. **Send the request**를 누른다. 이는 계정 정보 확인이며 메일 발송이 아니다.
5. HTTP 200, 응답의 `email`이 `peter@humansyntax.kr`, `email_verified`가 `true`인지 확인한다. 값이나 응답 전체를 채팅에 붙이지 말고 성공 여부만 알린다.

Playground의 Create Link에서 OAuth credentials/tokens 포함 옵션을 켜거나 인증 화면 전체를 공유하지 않는다. Playground의 파일 첨부 업로드 한도는 1 MB이므로 약 3 MB인 기존 MP3를 이 도구에 직접 올리는 경로는 사용하지 않는다.

## 5. 서버 Secret·네트워크 등록

이 작업의 Codex Cloud 환경 편집 화면에서 기존 Gemini·Supabase 설정을 유지하고 아래 값을 직접 등록한다. 키와 토큰은 채팅에 보내지 않는다.

| 설정 이름 | 넣을 값 | Secret 허용 도메인 |
| --- | --- | --- |
| `GMAIL_CLIENT_ID` | 1번 Web 클라이언트 ID | `oauth2.googleapis.com` |
| `GMAIL_CLIENT_SECRET` | 1번 Web 클라이언트 Secret | `oauth2.googleapis.com` |
| `GMAIL_REFRESH_TOKEN` | 4번 Refresh token | `oauth2.googleapis.com` |

일반 환경변수 `GMAIL_SENDER`는 `peter@humansyntax.kr`로 설정하거나 기존 코드의 기본값을 사용한다. 네트워크 허용 호스트에는 아래 3개를 추가하고 환경 설정을 게시한다. Secret별 허용 도메인 설정과 네트워크 허용은 별도다.

```text
oauth2.googleapis.com
openidconnect.googleapis.com
gmail.googleapis.com
```

`GMAIL_CREDENTIALS_FILE`은 이 경로에서 설정하지 않는다. 로컬 인증 파일과 OAuth 환경변수 방식을 혼합하지 않는다. Client ID·Secret·refresh token은 같은 Web 클라이언트 조합이어야 한다.

## 6. 클라우드에서 실제 첨부 테스트

사용자가 환경 설정을 게시했다고 알려주면 Codex는 다음을 수행한다. 현재까지 실제 인증·발송을 실행한 상태는 아니다.

1. Secret·네트워크 준비 상태를 값 없이 확인하고 메일 없는 토큰 갱신·발신 계정 검사를 실행한다.
2. 기존 MP3를 DB 원본 크기·SHA-256에 대조한다. 새 음악은 생성하지 않는다.
3. 지정된 dukedrum@gmail.com으로 MP3 첨부 테스트를 1회 진행하고 Gmail 접수·감사 기록을 확인한다. 기존 고객 다운로드는 소진하지 않는다.
4. 실제 수신 여부는 사용자가 확인한다. 수신한 첨부파일 해시는 별도로 확인해야 하며, Gmail 접수만으로 수신·원본 일치를 주장하지 않는다.
5. 결과가 불분명하면 자동 재발송하지 않는다.

사용자는 설치나 로컬 명령을 실행할 필요 없다. 클라우드 실행환경의 서버 검증은 공개 관리자 UI 배포를 의미하지 않는다. 서비스 운영에 사용자 PC의 상시 실행은 필요하지 않다.

공식 근거: [Playground의 자체 클라이언트·Offline·토큰 교환·24시간 취소·업로드 제한 안내](https://developers.google.com/oauthplayground/), [Web OAuth 클라이언트 및 리디렉션 일치](https://developers.google.com/identity/protocols/oauth2/web-server), [refresh token 만료](https://developers.google.com/identity/protocols/oauth2#expiration).
