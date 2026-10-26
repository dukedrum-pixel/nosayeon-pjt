# 7일 만료 파일 자동 정리

## 실제 활성 상태

Supabase Cron의 `nosayeon-audio-cleanup` 작업과 Edge Function `cleanup-expired-audio`를 배포·활성화했다. 스케줄은 `*/15 * * * *`, 한국 시간 매시 00·15·30·45분이다. 사용자의 PC나 Codex 채팅이 켜져 있을 필요는 없다.

링크는 발급 후 7일이 되는 순간 서버에서 접근을 차단한다. 파일은 이후 정리 실행에서 삭제한다. 정상적으로 대기 건수가 적으면 다음 15분 실행에서 처리하며, 대기열·통신 실패·재시도 간격에 따라 실제 삭제는 늦어질 수 있다. 사용자에게 Storage URL을 제공하지 않고 매 요청의 DB 상태를 검사하므로 삭제 대기 중에도 만료된 링크로 음악을 새로 받을 수 없다.

새 음악 생성·재생성, Google 재조회, 링크 재발급, 이메일 발송은 하지 않는다. 사연·프롬프트·이메일은 저장하거나 로그에 넣지 않는다. 사용자 결과 페이지/API는 아직 공개 배포하지 않았고, 이번 배포는 정리 워커에 한정된다.

## 삭제 대상과 실패 복구

- DB가 저장 완료 음악 중 사용 완료된 링크 또는 `expires_at <= DB 현재 시각`인 링크만 선택한다. 유효한 미사용 링크는 후보 조회와 실제 점유 양쪽에서 거부한다. 호출자가 전송한 곡 ID·URL·본문·수량은 사용하지 않는다.
- 한 번에 최대 20곡을 순서대로 처리하고, 40초 실행 예산이 지나면 남은 곡을 다음 실행으로 미룬다. 진행 중인 한 곡의 정리는 마무리하며 각 API 요청 제한은 5초다. 다른 작업이 처리 중이면 건너뛴다.
- 삭제 점유는 10분간 유지된다. 중단된 작업은 점유 만료 후 다시 처리할 수 있고, 이전 작업은 새 작업의 완료·실패 상태를 덮어쓸 수 없다.
- 미사용 만료 건은 `cleanup_reason=expired`, `expired_at`을 기록하며 다운로드 사용 시각 `consumed_at`을 만들지 않는다. 만료 정리를 점유할 때 이전 다운로드 점유도 제거하므로, 만료 전에 시작했던 요청이 뒤늦게 사용 완료를 확정할 수 없다.
- Storage API로 삭제한 후 POST 목록 조회로 정확한 파일명의 부재를 확인하고 `storage_status=deleted`를 기록한다. CDN 다운로드 응답은 삭제 확인에 쓰지 않는다. 삭제한 음악은 import CLI로 자동 재업로드하지 않는다.
- 실패한 자동 작업은 15분, 30분, 1시간, 2시간, 4시간, 최대 6시간 간격으로 다시 후보에 들어간다. 한 번의 실행 안에서 같은 곡을 반복 재시도하지 않는다. 운영자는 아래 수동 명령으로 이 대기를 건너뛰고 삭제만 재개할 수 있다.

```sh
# 전체 후보 정리. 기존 Supabase Secret 사용, 키 값을 인수에 넣지 않는다.
SUPABASE_URL=https://fuvgpqkyhuyanbfavwcg.supabase.co npm run result:sweep -- --allow-storage-delete

# 특정 만료·사용 완료 건의 삭제만 수동 재개
SUPABASE_URL=https://fuvgpqkyhuyanbfavwcg.supabase.co npm run result:cleanup -- --song-id <UUID> --allow-storage-delete
```

## 인증과 운영

스케줄용 32바이트 난수 토큰은 DB 안에서 생성하고 Vault의 `nosayeon_audio_cleanup_trigger`에 암호화해 보관한다. 공개 스키마의 서버 전용 설정에는 SHA-256만 저장한다. 서비스 역할 키를 Cron 명령에 넣거나, 전용 토큰을 파일·채팅·로그로 가져오지 않는다.

Edge Function의 기본 JWT 검사는 이 전용 토큰 인증으로 대체했다(`verify_jwt=false`). 본문에서 `Authorization: Bearer <전용 토큰>`의 형식·해시·활성화 상태를 확인한 뒤에만 후보 조회와 삭제를 시작한다. 누락·변조 토큰은 HTTP 401, POST 이외의 메서드는 405다. 함수 내부의 Supabase API 호출에는 런타임의 서버 전용 키만 사용한다. CORS 허용이나 임의 오브젝트 삭제 API는 추가하지 않았다.

Cron은 비공개 스키마의 `nosayeon_private.dispatch_audio_cleanup()`을 호출한다. 이 함수는 Vault 값을 DB 안에서 헤더로 사용하고 요청 번호만 반환한다. 일반 사용자와 `service_role`에는 이 스키마·함수 및 네트워크 요청 큐 읽기 권한을 주지 않았다. 스케줄 SQL과 실행 기록에는 원본 토큰이 없다.

적용 이력:

- `20261026203923_expired_audio_cleanup.sql`: 만료 점유·재시도·후보·설정·집계 기록.
- `20261026203948_audio_cleanup_scheduler.sql`: pg_cron·pg_net과 비공개 호출 함수. 이 마이그레이션만으로 스케줄은 활성화되지 않는다.
- `20261026205910_rehome_cleanup_network_extension.sql`: 새 pg_net의 기본 등록 위치를 `extensions`로 정리했다. 비이동식 확장이므로 작업을 일시 정지하고 요청 큐가 비었음을 확인한 뒤 다시 설치했다. 외부 종속 객체를 강제로 삭제하는 CASCADE는 사용하지 않는다.

새 환경에 적용할 때는 코어 마이그레이션·함수를 배포하고 인증 거부를 확인한 뒤, 관리자 SQL 연결에서 [활성화 SQL](../supabase/operations/enable_audio_cleanup.sql)을 실행한다. 현재 프로젝트에는 이미 활성화돼 있다. 스크립트는 기존 전용 토큰의 해시를 내부에서 확인해 재사용하며 값을 출력하지 않는다. 일시 정지는 [정지 SQL](../supabase/operations/pause_audio_cleanup.sql), 재개는 같은 활성화 SQL을 사용한다. 이미 실행 중인 정리까지 되돌리는 명령은 아니다.

`audio_cleanup_runs`는 실행 결과·후보·성공·실패·건너뜀·다음 실행으로 미룬 수·소요시간만 30일간 기록한다. 곡 ID, 토큰, 경로, 사연, 오디오나 원문 오류는 넣지 않는다. RLS를 활성화하고 익명·로그인 사용자의 접근과 RPC 실행을 차단했다. 배포 없이 현재 상태를 확인할 때는 다음과 같이 값이 안전한 열만 조회한다.

```sql
select jobname, schedule, active
from cron.job where jobname = 'nosayeon-audio-cleanup';

select checked_at, result, scanned, deleted, failed, skipped, deferred, duration_ms
from public.audio_cleanup_runs order by checked_at desc limit 10;
```

## 검증 (2026-10-27 KST)

- `npm test`: 77개 통과. 유효 링크 보호, 만료와 다운로드의 경합, 실패 후 재개·후보 지연, 이전 점유 차단, 후보 20개 제한, 잘못된 인증 응답의 차단을 검증했다.
- 실제 복사본에 유효한 링크를 발급했을 때 삭제 점유는 거부됐다. 해당 복사본만 만료 시각을 과거로 바꾼 후 결과 API가 HTTP 410을 반환하는 것을 삭제 전에 확인했다.
- DB → Vault → pg_net → 배포된 Edge Function → 실제 Storage 삭제 경로를 확인했다. 다운로드하지 않은 복사본이 `expired` 사유로 삭제됐고 `consumed_at`은 비어 있었다. Storage 메타데이터 부재와 캐시를 우회한 다운로드의 누락 응답도 확인했다.
- 실제 정기 실행은 한국 시간 05:45에 성공했다. 확장 위치 정리 후 재개한 작업도 06:00에 정상 완료됐다. 수동 호출만으로 스케줄 성공을 대신 판정하지 않았다.
- 검증용 `verification:expiry:` 파일·DB 기록만 정리한 뒤 원래 음악 1개·파일 메타데이터 1개·미사용 결과 링크 1개를 유지했다. 원본은 3,021,074바이트, SHA-256 `bd4905f2f0b26e675b154e11e1a59851c6f13c987dbf0880487f54d442fda102`로 보존됐다. 원래 링크도 실제 만료일이 지나면 이 정책에 따라 정리된다.
- 보고서는 Git 제외 경로 `artifacts/expiry-live/report.json`에 보존한다. 전용 작업 토큰은 이 보고서나 실행 환경으로 가져오지 않았다.
- 보안 점검의 ERROR/WARN은 없고, 서버 전용 테이블에 대한 [RLS 정책 없음 INFO](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)만 남았다.
- 성능 점검도 ERROR/WARN 없이 새 정리 인덱스의 [미사용 INFO](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) 1건만 반환했다. 현재 음악이 1개라 전체 조회가 선택될 수 있으며, 이후 데이터가 늘 때 사용할 부분 인덱스를 유지했다.

동일 음악 재신청, 50일째 재신청 링크의 최종 만료 기준, 재신청 횟수 및 이메일은 이번 작업에서 구현하지 않았다.
