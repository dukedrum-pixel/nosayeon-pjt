# 동일 음악 재신청 준비

## 완료한 작업

재신청의 선행 조건인 기존 Google Interaction 조회와 원본 검증을 별도 모듈로 구현했다. `src/lyria-restore.mjs`의 클라이언트는 `retrieve(baseline)`만 제공하며 모든 HTTP 요청은 GET이다. 음악 생성 모듈을 import하거나 생성 POST·자동 재시도·폴링으로 대체하지 않는다.

`baseline`에는 서버에 저장한 Interaction ID, 모델, 생성 시각 및 오디오별 순서·MIME·크기·최초 SHA-256이 필요하다. 모두 검증한 뒤에만 Google을 조회한다. 응답의 ID·모델·완료 상태·생성 시각을 확인하고, `model_output`에 속한 모든 오디오의 수·MIME·크기·해시를 최초 기준과 비교한다. 사용자 입력에 포함된 오디오는 복구 결과에서 제외한다.

합계 64MiB·최대 8개를 허용한다. inline Base64와 HTTPS Google API/Google Storage URI를 지원하며 리다이렉트·외부 호스트·URL 자격 증명을 거부한다. Google Storage에는 Google API 키를 전달하지 않는다. HTTP·응답·네트워크 오류는 고정 코드와 HTTP 상태로 정리하고 키·원문·URI·사연을 로그에 넣지 않는다.

## 검증 명령

```sh
# 도움말만 출력. 외부 요청 없음.
npm run restore:verify

# 기존 서버 Secret을 사용해 DB 메타데이터 조회 → Google GET → 로컬 해시 검증.
SUPABASE_URL=https://fuvgpqkyhuyanbfavwcg.supabase.co npm run restore:verify -- --song-id <UUID> --allow-google-read
```

Node.js 24.5 이상에서 기존 `GEMINI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY` Secret과 허용 도메인을 사용한다. 키 값을 인수·파일·채팅에 넣지 않는다. 네트워크 명령에는 실행 도구의 명시적 네트워크 권한을 사용한다.

이 도구는 DB·Storage에 쓰지 않고 새 링크도 발급하지 않는다. 복구 음원과 해시 비교 보고서는 Git 제외 경로 `artifacts/restore-verification/run-*/`에 권한 `0600`으로 저장한다. Google 응답 본문과 원본 Interaction ID는 보고서에 넣지 않는다. 로컬 복구 파일은 원본과 같은 개인정보 보호 수준으로 취급한다.

이 명령은 기술 검증 도구이며 제품의 재신청 자격 판정이 아니다. Google의 현재 조회 결과가 없거나 기준과 다르면 중단한다. 현재 성공이 50일 후의 복구 가능성, Google 보관 설정 또는 재신청 10분 처리 시간을 보장하지 않는다.

## 실제 검증 (2026-10-27 KST)

- `npm test`: 84개 통과. 조회만 제공하는 API, ID·모델·시각 검증, 오디오 변조·누락, URI 호스트 제한, 키 전달 범위, 자동 재시도 없음, 실제 MP3와 같은 3,021,074바이트 inline 응답을 검증했다.
- 실제 DB의 최초 메타데이터를 기준으로 같은 Google Interaction을 조회했다. 기존 MP3 1개·3,021,074바이트의 SHA-256이 `bd4905f2f0b26e675b154e11e1a59851c6f13c987dbf0880487f54d442fda102`로 일치했다. 저장된 로컬 복구 파일도 최초 MP3와 별도로 비교했다.
- 보고서는 `artifacts/restore-verification/run-CyNI3G/report.json`에 보존했다. 음악 생성 요청, 원격 저장 쓰기, 링크 재발급은 0회다. 운영 중인 만료 자동 정리 작업은 변경하지 않았다.

## 재신청 API 연결 전에 필요한 선택

[원본 기획](PROJECT_HANDOFF.md)의 미확정 정책에 대해 소유자 선택을 요청한 상태다. 설정의 기본값으로 임의 적용하거나 실제 링크의 권한·만료 시각을 변경하지 않았다.

| 항목 | 선택지 |
| --- | --- |
| 50일 이내 재신청 링크의 최종 만료 | 재발급 후 7일 유지(최대 생성 후 약 57일) / 생성 후 50일에 종료 |
| 재신청 횟수 | 50일 이내 횟수 제한 없음·동시 요청 차단 / 음악당 최대 3회 |
| 완료 안내 | 결과 페이지에 즉시 표시·이메일은 연동 후 추가 / 이메일로만 안내·Gmail 연동 선행 |

권장안은 각각 첫 번째다. 선택 후 재신청 자격·동시 점유·저장 복구·새 토큰 발급·이전 삭제 작업과의 경합을 묶어 구현해야 한다. 원본 토큰을 단순 재사용하거나 만료 상태를 무조건 초기화하는 방식으로 대체하지 않는다. 사용자용 재신청 API와 버튼은 아직 연결하지 않았다.
