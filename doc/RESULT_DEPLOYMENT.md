# 고객 결과 서비스 배포 준비

현재는 배포 전이다. 코드·컨테이너·내부 검증을 준비하며 외부 사이트를 만들거나 공개 서비스를 시작하지 않는다.

## 실행 경로

- `npm run result:serve`: 기존 loopback 내부 서버. 관리자 UI/API 포함. 외부 공개 금지.
- `npm run result:public`: 고객 전용 서버. `RESULT_PUBLIC_ORIGIN`을 필수로 검사하고 `PORT`(기본 8080)에서 수신. HTTPS 종료 프록시 뒤에서 실행한다.

공개 서버는 `/result.html`, `/result.css`, `/styles.css`, 결과 페이지 JS 3개, 고객 결과·음원·다운로드·재신청 API, `/healthz`만 허용한다. 관리자·디자인 미리보기·개발 파일·artifacts·환경 파일은 404다. 요청 Host는 설정한 공개 원점과 정확히 일치해야 하며, 브라우저 Origin도 그 원점으로 제한한다. 전달된 `X-Forwarded-Host`로 허용 범위를 바꾸지 않는다.

TLS·프록시가 제공할 항목:

- 공개 HTTPS 인증서와 확정된 원점. 업스트림 `Host`는 동일한 공개 호스트로 전달한다.
- Node 포트는 프록시만 접근하도록 비공개 네트워크에 둔다. 인터넷에 HTTP로 직접 노출하지 않는다.
- 다운로드·원본 복구 응답을 위한 충분한 요청 제한 시간(최대 10분). POST를 자동 재시도하지 않는다.
- API 응답·오디오·결과 HTML은 캐시하지 않는다. 요청 본문·Authorization·완성된 고객 링크를 로그에 남기지 않는다.
- 헬스 체크는 `GET /healthz`에 확정한 Host 헤더를 사용한다. `ok`는 프로세스 응답이며 DB/Gmail 준비 완료를 뜻하지 않는다.

페이지 토큰은 URL fragment에 유지되며 HTTP 요청·Referer에 전송되지 않는다. 각 API는 Authorization과 DB 권한을 별도로 확인한다. 공개 모드에는 HSTS, no-referrer, nosniff, CSP, Permissions-Policy가 적용된다. 고객 페이지와 내부 관리자 인증을 같은 공개 호스트에 배포하지 않는다.

## 컨테이너

`Dockerfile`은 런타임 소스·정적 파일·공개 진입점만 복사하며 node 사용자로 실행한다. 런타임 외부 npm 의존성이 없어 설치 단계가 없다. `.dockerignore`로 Git·Secret 파일·artifacts·테스트·로컬 node_modules를 제외한다. Secret은 이미지에 복사하거나 빌드 인자로 전달하지 않고 런타임 Secret으로 주입한다.

```sh
docker build -t nosayeon-result:review .
```

Node 24 베이스 이미지는 실제 빌드에서 확인한 digest로 고정했다. 출시 시 보안 업데이트 여부를 다시 확인한다. 관리형 클라우드에서 빌드·실행 시 플랫폼의 프록시·CA 설정을 유지한다. HTTPS 요청이 필요한 컨테이너에는 CA를 읽기 전용으로 마운트하고 `NODE_EXTRA_CA_CERTS`를 지정한다. TLS 검증을 끄지 않는다.

`RESULT_EMAIL_ENABLED=false`를 유지한 상태에서 우선 고객 페이지·인증·정적 자원·오류 상태를 확인한다. 실제 음악으로 다운로드 버튼을 누르면 1회 권한을 소진하고 파일 삭제가 시작되므로, 운영 곡을 일반 헬스 체크로 사용하지 않는다. 재신청도 기존 파일을 교체하므로 자동 스모크 테스트로 실행하지 않는다.

## 출시 전 남은 결정

1. 사용자에게 보여 줄 공개 주소·호스팅을 확정한다.
2. 필요한 서버 Secret과 비공개 링크 보관 자료를 연결한다. [메일 설정](RESULT_EMAIL_OPERATIONS.md)을 따른다.
3. 프록시·Secret·정리 작업·종료 시 진행 중 요청의 대기 시간을 검증한다. 프로세스 강제 종료 도중 발송 결과가 불명이면 자동 재발송하지 않는다.
4. 검토한 주소에 배포하고 지정 수신처의 결과 페이지 메일 테스트를 별도 확인 후 진행한다.

고객 신청·결제, 카카오 비즈메시지, 개인별 관리자 로그인과 OAuth 웹 callback은 이번 결과 전달 흐름에 포함하지 않는다. 별도 요구·계정 설정을 정리한 뒤 개발한다.
