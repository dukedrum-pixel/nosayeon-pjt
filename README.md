# 노사연 · Nosayeon

사연을 바탕으로 음악을 만들고, 동일한 음악을 복구하는 서비스의 개발 저장소입니다.

- [프로젝트 인계](doc/PROJECT_HANDOFF.md)
- [Lyria 동일 음원 복구 검증 및 실제 결과](doc/LYRIA_SPIKE.md)
- [내부 테스트 페이지 실행·UI 통합 계약](doc/TEST_PAGE.md)
- [Supabase 프로젝트 준비·DB·기존 음악 저장](doc/SUPABASE_SETUP.md)
- [결과 링크 토큰 검증·실제 음원 조회](doc/RESULT_ACCESS.md)
- [1회 다운로드·파일 삭제·실패 복구](doc/DOWNLOAD_POLICY.md)
- [7일 만료 자동 정리·스케줄 운영](doc/EXPIRY_CLEANUP.md)
- [동일 음악 재신청 준비·조회 전용 복구 검증](doc/RESTORE_PREPARATION.md)
- [확정 제품 정책](doc/PRODUCT_POLICY.md) · [고정 결과 페이지·재신청 구현](doc/REISSUE.md)

```sh
npm ci       # 전체 테스트를 위한 개발 의존성 설치
npm run dev  # 내부 테스트 페이지: http://127.0.0.1:4173
npm test     # 외부 API 호출 없는 테스트
```

Node.js 24.5 이상, 페이지 실행에는 Python 3가 필요합니다. 프롬프트 준비 화면은 음악을 생성하지 않습니다. 실제 테스트 음악 1곡은 이미 생성·재조회해 파일 해시 일치를 확인했습니다. 추가 생성 대신 저장된 실행 폴더에 `--resume`을 사용하세요.

Supabase 실제 프로젝트에 DB 마이그레이션과 비공개 버킷 구성을 적용하고, 기존 MP3의 업로드·재다운로드 SHA-256 일치를 확인했습니다. `npm run storage:import -- --run <기존 실행 폴더>`는 외부 호출 없이 원본 파일을 검사합니다. 장기 보관의 실증과 메일·카톡 전송은 아직 구현 전입니다.

`npm run dev` 실행 후 `/result-preview.html`에서 예시 데이터 기반 상태별 화면을 확인할 수 있습니다. 실제 `/result.html`은 `npm run result:serve`에서 같은 주소로 듣기·1회 다운로드·50일 이내 무제한 재신청을 제공합니다. 재신청하면 이전 파일을 먼저 삭제하고 같은 음악을 복구해 새 7일 보관 기간을 시작합니다. 15분 간격 자동 정리도 운영 중입니다. 메일·카톡 전송과 공개 결과 서비스 호스팅은 아직 연동 전입니다.
