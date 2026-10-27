# 최신 게시 환경에서 Gmail 첨부 테스트 이어가기

## 현재 상태

사용자는 Gmail OAuth Playground에서 발신 계정 `peter@humansyntax.kr`와 `email_verified=true`를 확인했고, Gmail Secret 3개와 허용 도메인 3개를 환경 편집에 추가해 게시했다고 알렸다.

그 후 기존 작업 채팅의 `environment_status`를 확인했으나, 이 채팅에 연결된 인스턴스는 여전히 spec_revision=observed_spec_revision=11이며 Secret은 Gemini·Supabase 2개뿐이었다. 로컬 프로세스에도 Gmail 환경변수 세 개가 없고, 정책 파일에도 Gmail 호스트 세 개가 없다. 사용자가 게시하지 않았다고 단정하거나 값을 다시 입력하게 하지 않는다. 현재 인스턴스와 최신 게시 설정을 구분해야 한다. 이 채팅의 도구에는 인스턴스 재연결·재시작 기능이 없었다.

실제 Gmail 인증 요청·테스트 메일 발송은 아직 하지 않았다. 구름 아이콘은 환경 이름 `nosayeon-pjt`만 표시했고 재적용 메뉴가 확인되지 않았다. 새로 게시한 환경으로 새 클라우드 실행을 시작한 뒤 준비 상태를 다시 확인한다.

## 이어갈 작업

저장소 `dukedrum-pixel/nosayeon-pjt`, 브랜치 `codex/lyria-recovery-spike`를 사용한다. AGENTS.md를 먼저 읽는다. SQL 관련 검증은 서비스 시작 전까지 사용자에게 별도 승인 요청하지 않도록 합의했다.

1. Cloud Environment 상태 및 정책을 확인한다. 세 Secret `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`이 `ready`이며 관측이 최신인지 확인한다. 네트워크 `enforced`와 `oauth2.googleapis.com`, `openidconnect.googleapis.com`, `gmail.googleapis.com`을 확인한다. 기존 Supabase 키·호스트도 유지한다. 키·토큰·원문 응답을 출력하지 않는다.
2. 필요한 실행 도구의 네트워크 권한과 기존 프록시·CA를 사용한다. `npm run gmail:check`로 메일 없는 토큰 갱신과 발신 계정 일치를 확인한다. Secret 이름이 보이는 것만으로 API 인증 성공을 주장하지 않는다.
3. 기존 MP3는 실제 Supabase에 저장되어 있으며, 고객 다운로드 API가 아닌 서버 전용 Storage 읽기로 검증할 수 있다. 곡 ID `c7ed78ea-453a-41ce-84cd-ad185a031f3b`, 원본 크기 3,021,074바이트, SHA-256 `bd4905f2f0b26e675b154e11e1a59851c6f13c987dbf0880487f54d442fda102`이다. 사용자는 새 음악 생성·자동 재생성을 금지했다.
4. 지정 수신처 `dukedrum@gmail.com`으로 기존 MP3 첨부 테스트 1회를 이미 명시적으로 요청했다. 정상 인증·원본 확인 후 다음 명령을 실행할 수 있다. 추가 발송 승인을 반복 요청하지 않는다.

```sh
node --use-env-proxy scripts/test-gmail-delivery.mjs --send-authorized-test
```

5. 명령은 기존 관리자 API 핸들러와 실제 DB 발송 감사 기록·멱등 키를 사용한다. 고객 다운로드 권한·페이지 토큰·음원을 변경하거나 삭제하지 않는다. 실제 Google 음악 API를 호출하지 않는다. 결과는 Git 제외 `artifacts/gmail-live/send-report.json`에 남는다. `send-state.json`은 발송 핸들러 호출 전에 독점 생성되어 같은 작업 공간의 자동 재실행을 차단한다. 새 환경에서 실행할 때도 먼저 DB `admin_delivery_exports`의 이력을 확인해 이전 실행에서 이미 메일을 보냈는지 확인한다.
6. 오류·타임아웃·결과 불명이면 상태 파일을 삭제하고 재시도하지 않는다. DB의 operation_id·Gmail 보낸편지함을 확인한다. 인증 검사만 성공한 것을 발송 성공으로 표시하지 않는다.
7. Gmail 접수 성공과 사용자의 실제 수신을 구분한다. 사용자가 받은 MP3를 다시 첨부하면 해시를 대조할 수 있다. 키·토큰·원문 응답은 채팅에 보내라고 하지 않는다.

프로젝트 SQL은 이미 실제 Supabase에 적용되어 있다. 기존 마이그레이션을 재적용하지 않는다. 관리자 기능과 Gmail 준비 단계의 전체 테스트 109개가 통과했다. 세부 온라인 인증 절차는 GMAIL_ONLINE_SETUP.md를 참고한다. 공개 관리자 UI와 Web OAuth callback은 아직 배포하지 않았다.
