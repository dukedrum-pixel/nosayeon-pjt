# 노사연 · Nosayeon

사연을 바탕으로 음악을 만들고, 동일한 음악을 복구하는 서비스의 개발 저장소입니다.

- [프로젝트 인계](doc/PROJECT_HANDOFF.md)
- [Lyria 동일 음원 복구 검증 및 실제 결과](doc/LYRIA_SPIKE.md)
- [내부 테스트 페이지 실행·UI 통합 계약](doc/TEST_PAGE.md)
- [Supabase 프로젝트 준비·DB·기존 음악 저장](doc/SUPABASE_SETUP.md)

```sh
npm ci       # 전체 테스트를 위한 개발 의존성 설치
npm run dev  # 내부 테스트 페이지: http://127.0.0.1:4173
npm test     # 외부 API 호출 없는 테스트
```

Node.js 24.5 이상, 페이지 실행에는 Python 3가 필요합니다. 프롬프트 준비 화면은 음악을 생성하지 않습니다. 실제 테스트 음악 1곡은 이미 생성·재조회해 파일 해시 일치를 확인했습니다. 추가 생성 대신 저장된 실행 폴더에 `--resume`을 사용하세요.

Supabase 실제 프로젝트에 DB 마이그레이션과 비공개 버킷 구성을 적용했습니다. 기존 음악의 실제 업로드는 서버 키 설정 대기 중입니다. `npm run storage:import -- --run <기존 실행 폴더>`는 외부 호출 없이 원본 파일을 검사합니다. 장기 보관·이메일·다운로드 정책은 아직 구현 전입니다.
