# 반복 작업자 중단 원인 확인

## 2026-11-23에 직접 확인한 증거

- Supabase는 응답했고 enabled=true였지만 마지막 작업자 신호가 2026-11-22 21:10 UTC에 멈췄다.
- 기존 Docker 컨테이너는 시작 실패 후 재시작을 반복했다. 확인 당시 RestartCount=10이었다.
- 기존 컨테이너의 HTTPS_PROXY 접속 주소와 **현재 Docker가 새 컨테이너에 넣는 주소를 메모리에서 비교**했고, proxyEndpointChanged=true였다. 주소·인증값은 출력/보관하지 않았다.
- 같은 시점에 현재 호스트 설정으로 Gmail 인증 확인은 성공했다.
- 현재 설정으로 컨테이너를 새로 만든 후 같은 이미지/인증 흐름이 정상 시작됐다.
- 다시 비교한 결과 proxyEndpointChanged=false, 컨테이너 running/restarts=0, heartbeat 정상 갱신이었다.

## 원인과 의미

Docker 컨테이너는 생성 시점의 프록시 설정을 보존한다. 관리 개발 환경이 다시 시작되거나 연결 구성이 바뀌면 프록시 주소가 달라질 수 있다. 기존 컨테이너를 restart하는 것만으로는 이 환경 변수가 갱신되지 않아 연결/시작 실패를 반복한다. 이번 조사에서는 이전 주소가 남아 있다는 실제 차이를 확인했다. 과거 모든 중단의 원인이 반드시 같았다고 소급 확정하지는 않는다.

또한 개발 환경 자체가 중지되면 컨테이너도 서비스를 제공할 수 없다. 프로세스 재시작 정책은 개발 환경의 상시 가용성을 만들어 주지 않는다. 새 컨테이너로 복구한 것은 현재 연결 문제의 복구이고, 독립 상시 호스팅 전환을 대신하지 않는다.

## 다음 장애 때 사용할 진단

```sh
node scripts/diagnose-request-worker.mjs
docker logs --tail 20 nosayeon-request-worker
docker inspect --format '{{.State.Status}} restarts={{.RestartCount}}' nosayeon-request-worker
```

진단 명령은 실행 중 작업자를 변경하지 않는다. 현재 Docker 기본값을 확인하는 임시 컨테이너는 실행하지 않고 메타데이터만 비교한 뒤 제거한다. 전체 환경/Docker 설정이나 키를 출력하지 않는다.

proxyEndpointChanged=true이면 현재 인증/CA/프록시 준비 상태와 활성 신청/복구를 먼저 확인하고 안전한 시점에 기존 컨테이너를 제거·재생성한다. 이미 점유된 신청을 accepted로 돌려 새 생성을 유발하지 않는다. 고객 실패 기록은 보존한다.

이번에 시작 단계(runtime_config/database_config/gmail_config/gmail_auth/generation_config/heartbeat)와 오류 종류를 기록하도록 보강했다. DB 연결이 되는 경우 song_worker_events에도 기록하며 관리자 대시보드에서 볼 수 있다. 네트워크가 DB까지 끊긴 경우에는 DB 기록이 남지 않을 수 있어 로컬 로그가 필요하다. 새 이벤트 시스템 이전에는 구체적 실패 단계가 남지 않아 이전 사례의 세부 원인 확정에는 한계가 있다.

## 해결 상태

현재 실행은 복구됐으며 작업자 시작 기록과 stale_proxy_endpoint 진단을 실제 DB에 보관했다. 생성/메일 흐름을 검증용으로 반복하지 않았다. 근본적인 릴리즈 과제는 개발 세션과 독립된 상시 작업자, 안정적인 인증/프록시 환경, 중단 감지·운영 알림이다.
