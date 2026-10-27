> 현재 상태: 사용자가 ChatGPT 로그인 없이 비밀번호로 접속하도록 명시적으로 요청해 public + 서버 비밀번호 방식으로 전환했다. 실제 신청·결과·재신청이 연결되어 있다. 아래 최초 비공개 미리보기 기록은 과거 상태이며, 최신 배포는 [SONG_REQUEST_OPERATIONS.md](SONG_REQUEST_OPERATIONS.md)를 따른다.

# 무료 임시 검증 사이트

사용자가 2~3개 선택지 중 **무료 임시 주소로 먼저 검증**을 선택해 Sites에 비공개 화면 검증 사이트를 만들었다. 고객용 실서비스와 구분한다.

- Site ID: `appgprj_6ae116663f34819191c39fbf636cea68`
- 주소: https://nosayeon-result-check.cw-lee.chatgpt.site
- 배포 상태: Sites 도구의 `succeeded` 응답으로 확인 완료. 소유자 비공개 접근 유지.
- 소스 커밋: `07ceb70c5ec4e40b79c4e4f6b3273bb6ad9db43b`
- 저장 버전: `appgprj_6ae116663f34819191c39fbf636cea68~appgver_90c6c93ac8ac81918ed0766e4e16996a`
- 배포 ID: `appgdep_6ae116b24d748191939dc81b9adead1e`
- 현재 작업 공간: `/workspace/sites/nosayeon-result-check`

새 환경에서 수정할 때 이 Site ID를 재사용한다. 동일 사이트를 다시 생성하지 않는다. Sites의 소스 저장소가 원본이며 짧은 수명의 쓰기 자격증명은 도구로 새로 받는다. 자격증명은 파일이나 로그에 저장하지 않는다. 주 프로젝트 GitHub 저장소와 Site 소스 저장소는 별개다.

## 검증 범위

기존 `web/result-preview.html`과 결과 화면 자원만 복사한 정적 사이트다. 첫 화면에서 음악 준비 완료 상태를 보이고, 선택 메뉴에서 완료·만료·준비 중·실패 등 8가지 화면을 확인한다. 320/390/1440px 가로 넘침과 브라우저 예외 없음, 실제 재생·다운로드 버튼 비활성을 확인했다.

실제 음원·고객 토큰·Supabase/Gmail Secret·관리자 화면은 포함하지 않는다. 외부 API를 호출하지 않는다. 기존 음악 생성·재신청·1회 다운로드·추가 메일 발송도 실행하지 않았다.

실제 MP3 전달을 위해서는 고객 API 호스팅과 서버 Secret, 기존 비공개 링크 보관 자료를 별도로 연결해야 한다. 이 정적 미리보기 주소를 `RESULT_PUBLIC_ORIGIN`으로 설정하거나 실제 고객에게 완료 메일을 보내지 않는다. 현재 사이트는 소유자 검증용 비공개 접근을 유지한다.

## 배포 환경 메모

이 클라우드 환경에는 Sites 스킬에 설명된 source helper 실행 파일이 없어, 동일한 소스 저장소 자격증명을 메모리/숨긴 stdin으로만 전달해 Git push 후 정적 산출물을 묶었다. Git 자격증명을 인자·환경 파일·Git 설정에 영구 저장하지 않았다. 아카이브에는 `.openai/hosting.json`과 선언된 `dist/`만 포함한다.

## 현재 상태 변경

사용자가 실제 신청 전체 흐름을 승인해 기존 Site를 Worker 앱으로 전환했다. 루트는 사연 신청 페이지이며 /result.html은 실제 Edge API에 연결한다. 이전 정적 화면 미리보기 전용 설명은 과거 상태다. 이름은 **노사연 · 사연을 노래로**, 주소는 기존 메일 링크 보존을 위해 유지했다. 최신 배포·검증·클라우드 작업자 제약은 [SONG_REQUEST_OPERATIONS.md](SONG_REQUEST_OPERATIONS.md)를 따른다.
