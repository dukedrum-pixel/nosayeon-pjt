# Supabase DB·비공개 음악 저장 기반

## 현재 상태

DB 마이그레이션, 서버 전용 Storage REST 어댑터, 기존 Lyria 검증 결과의 저장 CLI를 구현했다. **실제 Supabase 프로젝트는 아직 생성·연결되지 않았고 원격 마이그레이션과 업로드도 미실행**이다. 정적 테스트 페이지에는 서비스 키나 저장 API를 연결하지 않았다.

이번 단계는 이미 생성된 음악을 최초 저장하는 단계다. 새 음악 생성, Google 재조회, 링크 발급, 파일 만료·삭제, 다운로드 권한 소진, 이메일, 공개 Edge Function은 실행하지 않는다. 제품 정책 미확정 항목은 변경하지 않았다.

## 소유자의 프로젝트 준비

1. [Supabase Dashboard](https://supabase.com/dashboard)에서 무료 조직의 **New project**를 선택한다.
2. 이름은 `nosayeon-pjt`, 지역은 가능하면 Seoul을 선택한다. DB 비밀번호를 생성해 비밀번호 관리자에 보관한다. 채팅이나 Git에 넣지 않는다.
3. 프로젝트가 준비되면 Supabase 플러그인을 설치하고 해당 계정을 연결한다. 소유자가 사용할 프로젝트를 지정한 뒤 그 프로젝트에만 마이그레이션을 적용한다.
4. `supabase/migrations/20261026150000_private_audio_storage.sql`을 하나의 마이그레이션으로 적용한다. 파일은 트랜잭션으로 묶여 있다. 새 전용 프로젝트용이며 기존 `songs` 테이블 등이 있으면 중단하므로 검토 없이 삭제하거나 덮어쓰지 않는다.

DB 적용 후 실제 파일 저장 CLI를 실행하려면 아래 런타임 설정도 필요하다. 키 값을 채팅으로 전달하지 않는다.

| 설정 | 넣을 값 | 위치 |
| --- | --- | --- |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` | 서버/CLI 환경변수 |
| `SUPABASE_SERVICE_ROLE_KEY` | 해당 프로젝트의 서버 전용 `service_role` 키 | Cloud Network secret |
| Network secret 허용 도메인 | `<project-ref>.supabase.co`만 | Secret 바인딩 설정 |
| 네트워크 허용 호스트 | `<project-ref>.supabase.co` | Cloud 네트워크 설정 |

`service_role`은 Supabase 프로젝트 설정의 API Keys에서 legacy 키로 제공될 수 있다. 공개용 `anon`/publishable 키와 구분한다. 값은 소스·브라우저·채팅에 넣지 않는다. 이 CLI 어댑터는 표준 Supabase 프로젝트 도메인만 허용하며 로컬·커스텀 도메인 및 새 형식의 키는 이번 단계에서 실연동 검증하지 않았다.

설정 게시 후 현재 작업에서 Secret `ready`, 네트워크 `enforced` 및 실제 연결을 확인한다. Secret 바인딩과 네트워크 허용은 별도다. 실행 도구의 명시적 네트워크 접근 권한도 사용해야 한다. 프로젝트 URL과 키가 서로 같은 프로젝트를 가리켜야 한다.

## DB 구조와 접근 제어

| 테이블 | 저장하는 내용 |
| --- | --- |
| `songs` | 고유 Interaction ID, 모델·생성시각, 생성·저장 단계 상태, 저장 점유권·만료시각, 고정 오류 코드 |
| `song_files` | 오디오별 SHA-256·크기·MIME, 비공개 버킷·결정적 파일 경로 |
| `song_events` | 저장 단계별 등록·시작·완료·실패, 고정 오류 코드·HTTP 상태·시각 |

세 테이블 모두 RLS를 활성화하고 `anon`/`authenticated` 접근과 함수 실행을 차단한다. 서버 `service_role`만 사용한다. 사연·최종 프롬프트·이메일·결과 페이지 토큰은 이번 스키마에 저장하지 않는다.

버킷 `nosayeon-audio`는 비공개, 파일당 최대 64MiB, MP3/WAV만 허용한다. 익명 다운로드나 Storage 쓰기 정책을 추가하지 않는다. 같은 이름의 버킷이 공개 또는 다른 설정으로 이미 존재하면 트랜잭션 전체를 중단한다. 파일 추가·조회는 SQL로 Storage 테이블을 수정하는 대신 Storage API를 사용한다.

## 기존 실제 음악으로 실행

기존 검증 폴더 `artifacts/lyria/run-QhkKWf`에는 생성 완료 응답, 원본 MP3, `baseline.json`, `report.json`이 있다. Git에서 제외되어 있으므로 새 환경으로 이동하면 폴더를 별도 보존해야 한다. 원본 응답에는 사연·오디오가 포함될 수 있으므로 공개 저장소에 올리지 않는다.

```sh
# 전체 테스트를 위한 개발 의존성 설치
npm ci

# 외부 호출 없이 원본 파일·ID·기존 비교 보고서 검사
npm run storage:import -- --run artifacts/lyria/run-QhkKWf

# DB 마이그레이션 및 런타임 준비 후 기존 음악만 실제 저장
npm run storage:import -- --run artifacts/lyria/run-QhkKWf --allow-storage-write

# 실패 시 동일한 명령·동일한 run 폴더로 저장만 수동 재개
# npm run spike -- --allow-paid-call 은 실행하지 않는다.
```

로컬 `.env`를 사용하는 경우에만 `node --use-env-proxy --env-file=.env scripts/import-spike.mjs --run ... --allow-storage-write`로 실행한다. npm 스크립트는 `.env`를 자동으로 읽지 않는다.

CLI는 먼저 모든 원본 해시와 ID·MIME·크기를 검증한다. 원본 오디오 합계 64MiB, 최대 8개로 제한한다. 최초 `created.json`이 `in_progress`였어도 같은 ID의 `first-completed.json`과 성공 비교 보고서가 있으면 저장할 수 있다. 원본이 손상됐거나 비교 결과가 `different`이면 원격 쓰기 전에 중단한다.

## 중복·실패 처리

1. `register_generated_song`: Interaction ID를 unique 키로 행과 오디오 메타데이터를 한 트랜잭션에 등록한다. 같은 ID·같은 원본은 같은 행을 반환한다. 해시·MIME·크기·생성시각이 바뀌면 거부한다.
2. `claim_song_storage`: 원자적으로 저장 점유권을 10분간 확보한다. 다른 작업이 저장 중이면 `busy`를 반환한다. 중단돼도 만료 후 같은 저장 건을 재개할 수 있다.
3. `{song_id}/original/{index}-{sha256}.mp3` 또는 `.wav` 경로를 사용한다. 기존 파일은 덮어쓰지 않는다. 이미 있으면 바이트를 검증하고, 없으면 업로드 후 다시 읽어 SHA-256을 검증한다.
4. 모든 오디오가 일치할 때만 현재 점유권으로 `finish_song_storage`를 호출한다. 실패하면 `fail_song_storage`로 저장 단계만 실패 처리한다. 오래된 작업은 새 작업의 상태를 바꿀 수 없다.
5. 네트워크 요청에 자동 재시도는 없다. 업로드 응답을 받지 못해도 같은 원본으로 저장만 재개하면 먼저 기존 오브젝트를 검사한다. 원격 해시가 다르면 덮어쓰지 않고 중단한다.

결과는 실행 폴더의 `storage-report.json`에 저장한다. 상태값은 `stored`, `already_stored`, `busy`, `failed`다. `already_stored`는 기존 DB의 완료 기록을 사용하며 매번 원격 파일을 재검증하지 않는다. 나중에 만료·삭제한 파일을 복구하는 기능은 별도 구현해야 한다.

DB와 오브젝트 저장은 하나의 트랜잭션이 아니므로, 실패 시 검증된 일부 파일이 버킷에 남을 수 있다. 같은 경로·원본으로 재개해 처리한다. 10분 점유권이 끝났거나 작업 완료 기록만 실패해도 음악을 재생성하지 않는다. 요청·응답 본문, 키, 원본 토큰, 서명 URL, 오디오 데이터는 로그에 출력하지 않는다.

## 검증 결과와 실제 연결 후 확인할 것

- `npm test`: 29개 통과. PGlite PostgreSQL WASM 엔진에서 실제 마이그레이션, 트랜잭션 롤백, RLS·함수 권한, 중복 등록, 점유권 교체, 부분 저장 재개, 원격 해시 불일치를 검증했다. 테스트용 Storage 카탈로그와 메모리 오브젝트를 사용하며 실제 Supabase API는 아니다.
- REST 어댑터는 모의 HTTP로 인증 헤더·호스트 제한·덮어쓰기 금지·예외 정제·재시도 없음을 확인했다.
- 실제 MP3 1개(3,021,074바이트)의 로컬 저장 준비 검사 통과. DB·Storage·음악 생성 API 호출 없음.
- 실제 연결 후에는 원격 마이그레이션, RLS/버킷 설정, 원본 업로드 후 읽기 해시 일치, 동일 폴더 재실행 시 중복 없음, 익명 Storage 접근 차단을 추가로 확인해야 한다.
- Edge Function 배포, 결과 링크, 만료·다운로드·복구·메일 및 50일 보관 검증은 후속 단계다. 웹 테스트 페이지의 CSP와 네트워크 미연결 상태를 유지했다.
