# makemusic 프로젝트 히스토리 (2026-10-25)

새 채팅에서 이어서 작업하기 위한 인수인계 문서예요. 이 파일 하나만 읽으면 지금까지의 결정, 조사 결과, 파일 구성, 남은 일을 알 수 있게 정리했어요.

- 작업 폴더: `C:\Users\dukedrum\Documents\ClaudePRJ\nosa` (git 저장소 아님)
- 환경: Windows 11, Python 3.13, Node.js 설치됨, 브라우저는 Chrome/Edge 사용
- 사용자와는 한국어로 대화

---

## 1. 한눈에 보기

| 항목 | 상태 |
|---|---|
| `index.html` — 임베드 플레이어 녹음 페이지 | 완성. 테스트 소리로 검증함. 실제 탭 오디오 녹음은 사용자 미검증 |
| `start.bat` — 로컬 서버 실행기 | 수정 완료 (ASCII + CRLF). 동작 확인함 |
| `makemusic.html` — Gemini API(Lyria)로 곡 생성 페이지 | 완성. 가짜 응답으로 검증함. **실제 생성은 결제 미연결로 아직 실패** |
| 현재 막힌 곳 | API 키의 Google 프로젝트가 무료 등급 → Lyria 한도 0 → 결제 연결 필요 |
| 사연 노래 서비스 모델 약관 검토 | 완료(8장). Suno: 다운로드 없는 플레이어 공유는 위반. Flow Music: 유료 티어 + 다운로드 제공은 가능, AI 생성 고지·사연 동의 필요 |

진행 흐름: 녹음 페이지 제작 → Suno 녹음본 상업 이용 가능 여부 조사(불가) → Suno 대체 플랫폼 비교 → Google Flow Music 선택 → Flow Music과 Gemini API(Lyria) 비교 → API로 곡을 만드는 `makemusic.html` 제작 → 첫 실행에서 무료 등급 한도 오류 → 사연 노래 서비스 모델(결제 후 생성·공유)의 약관 검토: Suno는 다운로드 없는 플레이어 공유 불가, Flow Music은 다운로드 후 제공 가능.

---

## 2. 파일 구성

```
nosa/
├─ index.html                 임베드 레코더 (탭 오디오 녹음)
├─ makemusic.html             메이크뮤직 (Gemini API Lyria로 곡 생성)
├─ start.bat                  로컬 서버 실행 (python -m http.server 8765)
├─ makemusic_history_261025.md  이 문서
└─ .claude/launch.json        미리보기 서버 설정 (recorder: 8765, preview: 8770)
```

- 처음 만든 start.bat이 깨져 있을 때 생긴 빈 파일 `{const`는 삭제함.
- `.claude/launch.json`: Claude 앱의 미리보기 서버용. `recorder`는 8765 포트(start.bat과 같은 포트라 사용자가 start.bat을 켜 두면 충돌), `preview`는 8770 포트.

---

## 3. index.html — 임베드 레코더

음악 사이트의 플레이어 임베드 코드를 붙여넣으면, 그 플레이어에서 나오는 소리를 곡 단위로 자동 녹음해서 저장하는 페이지.

### 사용 흐름
1. `start.bat` 실행 → `http://localhost:8765/` 열림 (Chrome/Edge)
2. 임베드 코드 또는 URL 붙여넣기 → 플레이어가 뜨고 화면 공유 창이 자동으로 열림
3. 공유 창에서 "이 탭" + "탭 오디오도 공유" 켜고 [공유] (브라우저 보안상 이 클릭은 생략 불가)
4. (YouTube·SoundCloud는) 플레이어가 처음부터 자동 재생 → 소리 감지 시 녹음 시작 → 무음 3초면 곡 끝으로 보고 저장 → 연속 녹음 모드면 다음 곡 대기

### 구현 요점
- 다른 사이트의 iframe 안 오디오는 직접 접근 불가 → `getDisplayMedia({ preferCurrentTab: true, audio: {...} })`로 현재 탭 소리를 캡처
- 붙여넣은 HTML은 실행하지 않음. `DOMParser`로 iframe/audio/video의 src만 뽑아 직접 요소를 만듦 (스크립트 임베드, `javascript:` 주소 거부)
- URL 자동 변환: YouTube(watch, youtu.be, music, shorts, playlist) → embed, Spotify → embed, SoundCloud → w.soundcloud.com 플레이어
- 자동 재생 파라미터: YouTube `autoplay=1`, SoundCloud `auto_play=true`
- AudioContext 48kHz 고정 → AudioWorklet(Blob URL)에서 2048프레임 단위로 PCM + RMS 전달
- 상태: idle → starting → armed(대기) → recording
- 프리롤 1.5초, 앞뒤 디지털 무음(약 -80dBFS) 샘플 단위로 잘라냄
- 저장 형식: MP3 320/192kbps(lamejs 1.2.1, cdnjs → jsdelivr 순서로 Worker에서 importScripts), WAV
- 저장 위치: 기본 다운로드 폴더, 또는 File System Access API로 폴더 지정
- 설정·마지막 임베드는 localStorage(`embedrec.opts`, `embedrec.embed`)에 저장
- 녹음 대기 중 목록 미리듣기 재생 차단 (탭 소리가 같이 녹음되므로)
- 기본 설정: 무음 기준 -60dBFS, 곡 끝 판단 3초, 최소 길이 5초, 최대 길이 20분

### 검증
- 가짜 getDisplayMedia(사인파 톤 → 무음 → 톤)로 자동 시작, 무음 분할, MP3/WAV 저장, 디코딩까지 확인
- 실제 공유 창을 거친 탭 오디오 녹음은 사용자가 아직 확인 안 함
- 제약: PC용 Chrome/Edge만 탭 오디오 공유 가능. 다른 사이트 플레이어의 곡 제목은 읽을 수 없어 파일명은 `이름_날짜_시간.mp3`

### start.bat 문제와 수정
- 처음 버전은 한글 + LF 줄바꿈 + UTF-8이라 cmd가 줄을 엉뚱하게 끊어 실행 실패 (`'rt'은(는) 내부 또는 외부 명령...` 오류)
- 영어 ASCII + CRLF로 다시 저장. `py` → `python` 순서로 찾고 `python -m http.server 8765 --bind 127.0.0.1` 실행, 1초 뒤 브라우저 열기. `NOBROWSER` 환경 변수가 있으면 브라우저를 안 엶(테스트용)

---

## 4. Suno 녹음본의 상업 이용 (결론: 불가)

Suno 약관(2026-08-10 개정, 2026-09-03 시행) 확인 결과:
- Suno가 제공하는 다운로드 경로 외의 방법으로 사본을 얻는 것을 명시적으로 금지하고, 녹음과 스트림 리핑을 예로 듦. 콘텐츠 보호 장치 우회, 워터마크·핑거프린트 제거도 금지
- 상업적 이용은 유료(Pro/Premier) 사용자가 공식 다운로드로, 등급별 다운로드 한도 안에서 받은 파일에만 허용
- 무료: 개인·비상업만, 평생 7회 체험 다운로드(상업 권리 없음)
- 위반 시: 콘텐츠 삭제, 계정 정지·해지, 법적 조치 가능. 사용자가 Suno를 대신해 손해를 배상하는 면책 조항 있음
- Suno는 생성물에 저작권이 생긴다고 보장하지 않음
- 결론: index.html 레코더는 Suno에 쓰지 않기로 함

---

## 5. Suno 대체 플랫폼 비교 (2026년 10월 확인)

"곡당 비용"은 생성 단가와 상업용 단가(상업적으로 쓸 수 있게 다운로드하는 1곡당)로 나눔.

### 보컬 곡 생성

| 플랫폼 | 요금 (월 결제) | 생성량 | 곡당 비용 | 다운로드 | 상업적 이용 |
|---|---|---|---|---|---|
| Suno | Pro $10 / Premier $30 (연간 $8 / $24) | 약 500 / 2,000곡 | 생성 약 $0.02, 상업용 $0.50 | 월 20 / 60곡 (추가 구매 가능) | 유료 + 공식 다운로드만 |
| Google Flow Music | Starter $8 / Plus $24 / Member $64 (연간 $6 / $18 / $48) | 3,000 / 10,000 / 30,000 크레딧 (약 600 / 2,000 / 6,000곡) | 약 $0.013 | 모든 플랜 mp3·wav·m4a·스템, 홈페이지에 "다운로드 무제한" | 유료 플랜 공식 허용, 무료는 불명확 |
| Mureka | 입문 약 $8~10 / 상위 약 $24~30 (로그인 필요해 미확인) | 약 400~500 / 1,600~2,000곡 | 약 $0.02 | 상위 플랜 WAV·스템 | 약관(2026-05-13): 유료·크레딧 구매 시 사용자 소유, 무료는 Mureka 소유·비상업·출처 표기 |
| ElevenLabs Music | Starter $6 / Creator $22 / Pro $99 | 월 17 / 62 / 304분 | 3분 곡 약 $1.2 / $1.1 / $1.0 | 무료 불가, 고음질 WAV는 Pro부터 | Starter는 스트리밍 배포 금지, Creator부터 가능. 영화·TV·라디오 불가 (Music Terms 2026-10-09) |
| Udio | Standard $10 / Pro $30 | 2,400 / 6,000 크레딧 | — | 전면 금지 (2025-10 UMG 합의 이후) | 불가. 개인·비상업 감상만, 유튜브 업로드도 금지 |

### 연주곡·배경음악 위주

| 플랫폼 | 요금 | 곡당 비용 | 상업적 이용 |
|---|---|---|---|
| Stable Audio | 무료(월 약 12곡) / Solo $12 / Session $30 / Producer $90 / Studio $199 | 약 $0.07 | 전 플랜 상업 라이선스, 연 매출 $1M 초과 기업은 별도 |
| AIVA | Free / Standard €11 / Pro €33 (연간 결제 월 환산) | €0.73 / €0.11 | Standard는 AIVA 소유·유튜브 등만, Pro는 사용자 소유·제한 없음 |
| Soundraw | Creator ₩8,250 / Artist ₩16,583~34,916 | Artist Starter 약 ₩1,660 | Creator는 영상 배경음, 스트리밍 배포는 Artist |

선택 결과: **Google Flow Music** (가장 저렴, 다운로드 무제한, 유료 플랜 상업 이용 공식 허용). 사용자가 Flow에서 곡이 잘 만들어지는 것과 상업 이용을 직접 확인함.

---

## 6. Google Flow Music 정리

- 옛 Riffusion → Producer.ai. Google이 2026년 2월 인수, 2026년 4월 Google Flow Music으로 이름 변경 (`flowmusic.app`)
- 모델: Lyria 3.5 (2026-07-29 Flow Music에 먼저 도입, 홈페이지에 "최신 프런티어 음악 모델 Lyria 3.5")
- Google AI 구독과 연동: Google AI Plus → Starter, AI Pro → Plus, AI Ultra → Member 혜택 (Google 공식 도움말에 Starter 혜택으로 3,000크레딧, 약 600곡, "Commercial use rights" 명시)
- Flow Music 크레딧은 Google AI 크레딧과 별개
- Google은 생성물 소유권을 주장하지 않음. 모든 음원에 SynthID 워터마크
- 주의: 남의 음원 업로드·특정 가수 흉내는 허용 범위 밖, 유통사·플랫폼 AI 표기 규정 따로 확인, 대량 업로드는 스팸 분류 위험
- 공식 API 없음. useapi.net 비공식 래퍼는 약관 위반·계정 위험이라 사용하지 않기로 함

### 저작권·인접권 메모
- 사용자 인식: "AI 생성물은 저작권이 어렵고 인접권만 가질 수 있다" → 정정함
- 실연자 권리: 사람의 실연이 없으면 해당 없음
- 음반제작자 권리: 한국 법상 창작성 요건이 없어 가능하다는 견해가 있지만 판례·정부 지침 없음 → "불확실"
- 미국 등은 음반도 저작물이라 인간 저작자 요건 적용
- 음저협: 2025-03부터 AI 사용 곡 등록 보류. 2026-08-03 파트별 인간 기여 기준을 시행했다가 22일 만에 철회(문체부 공론화 요구), 다시 보류 상태. AI 사용을 숨기고 저작권료 163억 원을 받은 4명을 음저협이 고발했으나 증거 부족으로 불송치(2026-07)
- 현실적 수익: 유통사 계약을 통한 음원 유통 수익은 가능. 음저협 저작권료는 사실상 막힘

### Flow Music vs Gemini API
- 기반 모델은 같음(Lyria 3.5). 차이는 감싸는 도구: 앱은 AI 프로듀서 대화, 확장·커버·교체·스템, 개인화. API는 한 번 요청에 한 곡
- 같은 프롬프트라도 매번 다른 곡이 나옴(비결정적) → 비교는 "평균 품질"로 해야 함
- 앱이 프롬프트 재작성·숨은 설정·후처리를 하는지는 비공개 → 동일하다고 장담 불가
- 비교 방법 제안: 같은 프롬프트로 양쪽 5곡 이상 생성 → 블라인드 청취 → LUFS·샘플레이트·비트레이트 비교
- 비용: 앱 약 $0.013/곡, API $0.08/곡(약 6배). 수작업은 앱, 자동 대량 생성은 API

---

## 7. makemusic.html — 메이크뮤직

API 키와 프롬프트를 넣으면 Gemini API의 Lyria로 곡을 생성하고, 페이지에서 바로 재생 + 자동 다운로드하는 단일 HTML 파일.

### 화면
- API 키: password 입력, 보기/숨기기, "이 브라우저에 키 저장"(기본 꺼짐, localStorage `makemusic.key`), AI Studio 키 발급 링크
- 모델: 완성곡 `lyria-3.5` ($0.08) / 30초 클립 `lyria-3-clip-preview` ($0.04, 프롬프트 시험용)
- 프롬프트 + 예시 버튼 5개(시티팝, 발라드, 로파이, EDM, 어쿠스틱)
- 가사(선택): [Verse]/[Chorus] 태그. 가사에 한글이 있으면 "아래 가사를 그대로 사용해 줘."를, 아니면 "Use the following lyrics exactly."를 붙여서 프롬프트 뒤에 이어 보냄
- 파일 형식 MP3/WAV(WAV는 3.5만), 개수 1~5, 자동 다운로드(기본 켜짐), 예상 비용 표시
- 결과 카드: 플레이어, 다운로드, 형식·크기·길이, 가사(복사), 곡 구조 JSON, 원본 응답(긴 base64는 생략 표시), 세션 누적 비용
- 입력값은 localStorage `makemusic.draft`에 저장
- Ctrl+Enter로 생성, 취소 버튼(AbortController), 생성 중 페이지 이탈 경고

### API 사용 방식 (공식 문서 기준)
- 엔드포인트: `POST https://generativelanguage.googleapis.com/v1beta/interactions`
- 헤더: `x-goog-api-key: <키>`, `Content-Type: application/json`
- 본문: `{ "model": "lyria-3.5", "input": "<프롬프트>" }`
- WAV 요청: `"response_format": { "type": "audio", "mime_type": "audio/wav" }` (기본은 MP3)
- 응답: `steps[]` 중 `type: "model_output"`의 `content[]`에 `{type:"text", text}`(가사 또는 구조 JSON)와 `{type:"audio", data(base64), mime_type}`
- 오디오 블록에 `uri`가 올 수도 있음(스키마상 `delivery: "uri"` 옵션 존재). 페이지는 uri가 오면 주소 표시 + 키로 받아오기 시도
- `status`가 `in_progress`로 오면 `GET /v1beta/interactions/{id}`로 4초 간격 최대 150회 조회
- 오류 응답이 `[{ "error": {...} }]`처럼 배열로 오기도 함 → 1개짜리 배열은 풀어서 처리
- 브라우저에서 직접 호출 가능(CORS 허용 확인, Origin이 null인 file://도 응답 읽힘) → 서버 불필요
- 동시 요청 2개 제한(429 방지)
- 임베드 플레이어 주소는 API가 제공하지 않음 → 페이지 안 플레이어 + 파일 저장으로 대체

### Lyria 모델 정보 (Gemini API 가격표, 2026-10)
| 모델 ID | 내용 | 가격 |
|---|---|---|
| `lyria-3.5` | 보컬·가사 포함 몇 분 길이 완성곡, MP3 기본/WAV 선택, 44.1kHz 스테레오, 이미지 최대 10장 입력 가능 | $0.08/곡 |
| `lyria-3-clip-preview` | 30초 클립, MP3 | $0.04/곡 |
| `lyria-3-pro-preview` | 이전 세대 완성곡 (레거시) | $0.08/곡 |

- 무료 등급 사용량 없음
- 차단: 특정 가수 목소리 요청, 저작권 있는 가사 생성 요청, Google 생성형 AI 금지 정책 위반
- 프롬프트·가사 글자 수 제한은 공식 문서에 없음
- 한 번 요청에 한 곡(이어서 수정 불가), 결과는 매번 다름
- 프롬프트 팁: 악기·BPM·키·분위기·구조·길이를 구체적으로, 가사와 프롬프트 언어 일치, 타임스탬프 `[0:00 - 0:10] Intro: ...`로 구조 지정 가능
- Gemini API 약관: Google은 생성물 소유권을 주장하지 않음, 사용 책임은 사용자, 만 18세 이상, 업무용 개발자 서비스

### 검증
- 일부러 틀린 키로 실제 API 호출 → "API 키가 올바르지 않아요" 정상 표시
- 가짜 응답(in_progress → 폴링 → 완료, 가사 + 구조 JSON + WAV)으로 요청 형식, 폴링, 가사 분리, 입력 프롬프트 에코 제외, 자동 다운로드, 비용 계산 확인
- 모바일(375px) 가로 넘침 없음

### 현재 막힌 곳: 무료 등급 한도 오류
사용자의 첫 실제 요청 결과:
```
429 too_many_requests
Rate limit exceeded for model lyria-3-pro (limit: 0 input tokens per minute on Free Tier).
Please upgrade your tier at https://ai.dev/rate-limit.
```
- 원인: API 키의 프로젝트가 무료 등급. Lyria는 무료 등급 한도 0. 프롬프트·가사·로그인 문제 아님
- 오류 속 모델명 `lyria-3-pro`는 Lyria 3.5가 같은 한도 버킷을 쓰기 때문으로 보임(요청은 `lyria-3.5`)
- **Flow Music 유료 구독과 Gemini API 결제는 별개**
- 페이지 수정 완료: 이 오류면 "이 키의 프로젝트가 무료 등급이에요…" 안내 + "AI Studio에서 결제 설정하기" 버튼, 402(선불 잔액 없음) 안내 추가, 키 입력란에 "Flow Music 구독과는 별개" 문구

해결 절차 (Gemini API 결제 문서 기준):
1. https://aistudio.google.com/apikey 열기
2. 키가 속한 프로젝트의 Billing Tier 칸에서 **Set up billing**
3. 국가·연락처·결제수단 입력
4. 결제 방식 선택: 선불(Prepay, 최소 $5) 또는 후불(Postpay)
5. 보통 즉시, 늦어도 약 10분 안에 Tier 1 적용

결제 등급:
| 등급 | 조건 | 10분당 지출 한도 |
|---|---|---|
| Free | 활성 프로젝트 | — |
| Tier 1 | 결제 계정 연결 | $10 |
| Tier 2 | 누적 $100 결제 + 첫 결제 후 3일 | $50 |
| Tier 3 | 누적 $1,000 결제 + 30일 | $200 |

선불 주의: 잔액 $0이면 키가 멈추고 402 오류, 크레딧은 12개월 뒤 만료, 대체로 환불 불가.

---

## 8. 사연 노래 서비스 모델의 약관 검토 (Suno vs Google Flow Music)

검토한 사업 모델: 고객에게 사연을 받으면서 결제를 받음 → 사연으로 곡 생성 → 고객에게 공유. 두 가지를 확인했음.
1. Suno: 다운로드 없이 Suno 스트리밍 플레이어(링크·임베드)만 공유하면 약관 위반인가?
2. Google Flow Music: 곡을 항상 다운로드해서 제공하면 문제없는가?

두 분석 모두 약관 문언 분석이며 법률 자문 아님. 각 사 지원팀 확인은 받지 않았음.

### 8-1. Suno: 다운로드 없이 플레이어 공유 → 약관 위반 (결론)

확인 대상: Suno 약관(2026-08-10 개정, 2026-09-03 시행) 원문, 공식 블로그(2026-08-10), 헬프센터 FAQ.

핵심 조항 원문:
- Commercial Use Restriction: "Except as permitted in the next section, you agree not to display, distribute, license, perform, publish, reproduce, duplicate, copy, create derivative works from, modify, sell, resell, **grant access to**, transfer, or otherwise use or exploit **any portion of the Service, and any Output** or Voice Model, **for any commercial purposes**."
- Permitted Commercial Use: "You may commercially exploit Output solely to the extent it adheres to Suno's Conditions of Access and Use ... **provided you have obtained a permitted download of that Output** ... **You may not commercially exploit Output that has not been downloaded by you through an approved channel** ... you will not use or exploit any Output for commercial purposes **on or outside the Service**."

해석:
- 결제를 받고 곡을 제공하면 전달 형태와 무관하게 상업적 이용. 헬프센터는 commercial use를 "만든 음악으로 돈을 벌 수 있는 능력"으로 정의
- 원칙은 전면 금지, 유일한 예외가 "해당 Output의 허용된 다운로드 확보". 다운로드 안 한 곡은 "on or outside the Service", 즉 Suno 안에서 스트리밍하는 것까지 상업적 이용 불가
- 유료 요금제여도 동일. Pro/Premier 권리 양도 조항에 "subject to ... commercial use restrictions" 단서. 헬프센터 문구도 2026-09-03에 "Songs made while subscribed" → "Songs **downloaded** while subscribed are granted commercial use rights"로 변경
- 공식 FAQ의 "Streaming and sharing on Suno remain unlimited on every plan"은 개인적 공유가 무제한이라는 뜻. 헬프센터는 비상업 이용을 "친구에게 들려주는 personal use"로 설명
- 임베드 플레이어(`suno.com/embed/{곡ID}`)는 존재하지만 전용 규정 없음. 헬프센터는 Copy Link만 안내 → 링크 공유와 같이 "Service의 일부에 접근 권한 부여"로 취급하는 것이 안전

추가로 걸리는 조항:
- "If you are an enterprise user, you must contact sales" — enterprise 정의 없음. 다수 고객에게 반복 판매하는 서비스는 사전 서면 확인 권장(support@suno.com)
- 고객 사연 = Submission. Suno는 Submission+Output(Content)에 대해 worldwide, sublicensable, perpetual, irrevocable 라이선스(AI 개선·홍보 포함) 보유 → 고객 동의 문구 필요
- "Output may not be unique across users" → "당신만의 곡" 표현 주의
- 다운로드 한도 = 월 판매 상한. Pro 20곡, Premier 60곡, Premier+Studio는 Studio 내 무제한, 추가 구매 가능. Free는 평생 7회 체험(상업 불가)

사례 조사:
- 같은 모델(스트리밍 공유 방식 유료 서비스)이 제재받은 공개 사례 없음
- 인접 사례: Digital Music News(2025-12-22) — 워너 합의 직후 헬프센터 "you own the songs" → "generally are not considered the owner" 변경. 2026-09-03 "made" → "downloaded" 변경. 일본 분석글(2026-08-11)도 "다운로드 안 한 작품의 상업 이용은 저작권 문제와 별개로 계약 위반" 해석
- gcui-art/suno-api 깃허브 이슈(2024-11): Suno가 외부 API를 모두 차단했다는 보고. 제3자 서비스에 대한 유일한 관찰된 조치
- 집행 수단: 약관상 sole discretion으로 사전 통지 없이 계정 정지·삭제. 커뮤니티 가이드라인(2026-10-01) 경고 → 일시정지 → 기능제한 → 영구정지. 약관은 Output에 tier와 Download 여부를 나타내는 fingerprint/watermark/metadata를 심을 수 있다고 명시
- 유사 서비스(Songcove, SongStory, Songive)는 존재하나 엔진 비공개. Songcove는 비공개 공유 페이지 + 선택적 MP3 다운로드 구조

Suno를 쓸 경우 운영 기준선:
- 판매 곡마다 1회 다운로드 → 자체 플레이어·스토리지로 제공. 다운로드 후 상업 권리는 영속
- 다운로드한 곡의 Suno 링크를 덤으로 주는 것은 회색지대(Service 접근 권한 부여 금지가 남음). 핵심 전달 수단으로 쓰지 않기
- 사연 업로드 동의 문구, 고유성 미보증 고지, enterprise 해당 여부 서면 질의

### 8-2. Google Flow Music: 유료 티어 + 다운로드 제공 → 약관상 직접 장애 없음 (결론)

적용 약관:
- `flowmusic.app/terms` → 일반 Google 서비스 약관(policies.google.com/terms, 2026-07-30 시행, 한국 버전)으로 리디렉션. `/privacy` → 일반 Google 개인정보처리방침
- Google 서비스별 추가 약관 목록에 Flow/Flow Music 항목 없음. Labs.google 항목은 Google 약관 + Generative AI 금지 사용 정책(2024-12-17)만 적용
- 음악 전용 상업 조항 없음. Suno의 다운로드 관문 같은 문장 없음

소유권·상업 이용:
- Google 약관: "Some of our services allow you to generate original content. Google won't claim ownership over that content."
- Flow 공식 헬프 FAQ "Can I use outputs of these tools for commercial purposes?" → 약관을 따르라 + 위 문장 인용
- 입력물 라이선스는 "operating and improving the services"라는 limited purpose로 한정(Suno보다 좁음)
- 저작권 성립 보증 없음. 소비자용 면책 없음(Google 생성형 AI 면책은 Cloud/Workspace 상품만)

걸리는 조항 3가지:
1. "Commercial use rights"는 유료 티어에만 표기. Google One 헬프(AI Plus/Pro/Ultra 혜택)는 Flow Music Starter/Plus/Member 혜택에 "Commercial use rights" 명시. flowmusic.app 요금 페이지의 Free 플랜과 비교표에는 상업 이용 언급 없음 → 무료 티어 판매는 분쟁 여지. Starter 이상 사용으로 해소
2. Google 약관 "Don't abuse our services": "misleading others into thinking that generative AI content was created by a human", "providing services that appear to originate from you (or someone else) when they actually originate from us". 금지 사용 정책 4-e "Misrepresenting AI-generated content as created solely by a human in order to deceive" → 서비스 안내에 "Google Lyria 기반 AI 생성" 표기로 해소
3. 한국 AI 기본법(2026-01-22 시행): 생성형 AI 결과물 표시 의무, 미이행 과태료 1회 500만 원부터. 음악 세부 기준 미확인. 2번 고지로 함께 충족하는 방향

고객 사연 업로드:
- Flow(영상) 개인정보 고지(2026-05-19): "human reviewers read, annotate, and process a sample of your data", "Please don't submit confidential information", 18개월 보관, "Help improve Flow" 토글. Flow Music 포함 여부는 명시 안 됨. 앱에 "Memories"(producer 학습) 토글 존재
- 금지 사용 정책 1-f: "using personal data ... without legally required consent" 금지 → 고객 동의 문구 필요

다운로드·요금(요금 페이지 비교표에서 확인):

| 플랜 | 연간 결제 시 월 요금 | 월 크레딧 | 곡 수(Google 추산) | 다운로드 |
|---|---|---|---|---|
| Free | $0 | 일일 보충만 | 미표기 | mp3/wav/m4a·스템 ✓ |
| Starter (= AI Plus) | $6 | 3,000 | 약 600곡 | ✓ |
| Plus (= AI Pro) | $18 | 10,000 | 약 2,000곡 | ✓ |
| Member (= AI Ultra) | $48 | 30,000 | 약 6,000곡 | ✓ |

- Downloads(mp3, wav, m4a), Stem downloads, Publishing 모두 4개 플랜 체크. 홈페이지 "Unlimited downloads". 다운로드에 크레딧 소모 없음. 추가 크레딧 구매는 유료 플랜만
- 헬프 "Create & manage songs": Compose에서 Lyrics/Sound/Details 수정, Publish/Share 링크, "Allow community remix" 토글(타인의 리믹스·다운로드 차단), 단일/다중(zip) 다운로드, 파일 형식 선택

사례 조사:
- Flow Music 사용자가 상업 이용으로 제재받은 공개 사례 없음
- Kogon v. Google, No. 1:26-cv-02582 (N.D. Ill., 2026-03-06 제소): 독립 아티스트 집단소송. Lyria 3가 YouTube 약 4,400만 클립으로 무단 학습됐다고 주장. Google은 2026-06 YouTube 약관 라이선스를 근거로 각하 신청. 진행 중 (사용자 책임을 묻는 소송은 아니지만 엔진 자체의 법적 불확실성)
- UMG v. DistroKid (2026): AI 생성곡 유통 문제로 DistroKid가 일부 곡을 사전 통지 없이 삭제 → 고객이 받은 곡을 유튜브 등에 올릴 때 Content ID 분쟁 가능성 안내 필요
- TuneCore에 Flow Music 연동 안내 문서 존재(접근 차단으로 내용 미확인)

Flow Music 운영 기준선:
- Starter 이상 유료 티어로 생성
- 매 곡 다운로드 → 자체 스토리지·플레이어로 제공
- "Google Lyria 기반 AI 생성" 표기
- 고객 사연의 Google 업로드에 대한 동의
- "Commercial use rights"의 범위(재판매, 고객 대행 제작 포함 여부)를 Google이 문서로 정의하지 않음 → 규모 확대 전 Google One 지원팀 서면 확인 권장

### 8-3. 비교 요약

| 항목 | Suno | Google Flow Music |
|---|---|---|
| 적용 약관 | Suno 전용 약관, 음악 상업 조항 상세 | 일반 Google 약관 + 생성형 AI 금지 사용 정책 |
| 상업적 이용 조건 | 유료 플랜 + 곡당 다운로드 필수 | 약관상 조건 없음, 유료 티어에 "Commercial use rights" 표기 |
| 다운로드 한도 | Pro 20곡/월, Premier 60곡/월 | 무제한, 전 플랜 |
| 입력물(사연) 라이선스 | 영구·취소불가·재라이선스 가능, 홍보·학습 포함 | 서비스 운영·개선 목적으로 한정 |
| 특유 리스크 | Service 접근 권한 부여 금지, enterprise 조항 | AI 생성 비고지 금지, 무료 티어 상업권 불명확 |
| 면책 | 없음 | 없음(소비자용) |
| 공개 제재 사례 | 없음 | 없음 |

---

## 9. 남은 일 / 다음 단계

1. **사용자**: AI Studio에서 결제 연결 → `makemusic.html`에서 30초 클립($0.04)으로 첫 실제 생성 테스트
2. 실제 응답이 문서와 다르면(필드 이름, uri 전달, 오류 형식 등) `extractOutputs()`·`explainError()` 조정
3. (선택) Flow Music vs API 블라인드 비교: 같은 프롬프트로 각 5곡, 파일 사양(LUFS·샘플레이트·비트레이트) 분석 스크립트
4. (선택) 생성 기록을 IndexedDB에 저장해 새로고침 후에도 목록 유지
5. `index.html`의 실제 탭 오디오 녹음은 사용자 환경에서 아직 미검증
6. (서비스 준비) 고객 사연의 외부 AI 업로드 동의 문구, "Google Lyria 기반 AI 생성" 고지 문구 작성 (8장 운영 기준선)
7. (서비스 준비) Google One 지원팀에 Flow Music "Commercial use rights"의 범위(재판매·고객 대행 제작 포함 여부) 서면 질의. Suno를 쓸 경우 support@suno.com에 enterprise 해당 여부 질의
8. (서비스 준비) 전달 방식은 자체 스토리지·플레이어로 고정. 외부 플랫폼 플레이어 링크·임베드는 핵심 전달 수단으로 쓰지 않기

### 실행 방법 요약
- `start.bat` 더블클릭 → `http://localhost:8765/` (레코더), `http://localhost:8765/makemusic.html` (메이크뮤직)
- `makemusic.html`은 파일을 더블클릭해서 바로 열어도 동작하도록 만듦
- 키를 저장한 상태로 파일을 공유하거나 웹에 올리지 않기

---

## 10. 참고 자료

Suno
- https://suno.com/terms
- https://suno.com/pricing
- https://help.suno.com/en/articles/13614785
- https://about.suno.com/blog/suno-updates-tos
- https://suno.com/community-guidelines (2026-10-01 개정, 제재 단계)
- https://help.suno.com/en/articles/9601665 (유료 구독 권리, "downloaded while subscribed")
- https://help.suno.com/en/articles/9601601 (무료 플랜 권리, Suno 링크 공유)
- https://help.suno.com/en/articles/9601985 · https://help.suno.com/en/articles/9602241 (commercial / non-commercial use 정의)
- https://help.suno.com/en/articles/13876865 (다운로드 동작) · https://help.suno.com/en/articles/2565761 (공유 방법)
- https://help.suno.com/en/articles/2416769 (소유권)
- https://jackrighteous.com/blogs/guides-using-suno-ai-music-creation/how-to-embed-suno-songs (임베드 플레이어 /embed/ 주소)
- https://www.digitalmusicnews.com/2025/12/22/suno-warner-music-deal-changes/ (소유권 문구 변경 보도)
- https://note.com/shugo/n/n94b8f644e086 (2026-09 개정 해석, 일본어)
- https://github.com/gcui-art/suno-api/issues/195 (외부 API 차단 보고)

Google Flow Music / Lyria / Gemini API
- https://www.flowmusic.app/ · https://www.flowmusic.app/pricing
- https://support.google.com/googleone/answer/16882689?hl=en
- https://ai.google.dev/gemini-api/docs/music-generation
- https://ai.google.dev/gemini-api/docs/lyria-prompt-guide
- https://ai.google.dev/gemini-api/docs/pricing
- https://ai.google.dev/gemini-api/docs/rate-limits
- https://ai.google.dev/gemini-api/docs/billing
- https://ai.google.dev/gemini-api/terms
- https://ai.google.dev/api/interactions-api
- https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/lyria/lyria-3
- https://jackrighteous.com/blogs/music-creation-process-guide/google-flow-music-rights-commercial-use-2026
- https://policies.google.com/terms (Google 서비스 약관, 2026-07-30 시행. flowmusic.app/terms가 여기로 리디렉션)
- https://policies.google.com/terms/generative-ai/use-policy (생성형 AI 금지 사용 정책, 2024-12-17)
- https://policies.google.com/terms/generative-ai (Generative AI 추가 약관, 2024-05-22 이후 적용 종료 안내)
- https://policies.google.com/terms/service-specific (서비스별 추가 약관 목록, Flow/Flow Music 항목 없음)
- https://one.google.com/terms-of-service (Google One 약관, 2026-10-01 수정)
- https://support.google.com/flow/answer/16353333?hl=en (Flow 시작 가이드, 상업적 이용 FAQ)
- https://support.google.com/flow/answer/17083868?hl=en (Flow Music 시작 가이드)
- https://support.google.com/flow/answer/17083870?hl=en (Flow Music 크레딧·구독 플랜)
- https://support.google.com/flow/answer/17084348?hl=en (Flow Music 곡 생성·편집·공유·다운로드)
- https://support.google.com/googleone/answer/14534406?hl=en (AI Pro 혜택) · https://support.google.com/googleone/answer/16286513?hl=en (AI Ultra 혜택)
- https://labs.google/flow/privacy (Flow 개인정보 고지, 2026-05-19)
- https://cloud.google.com/archive/terms/generative-ai-indemnified-services-20260120 (Google 생성형 AI 면책 대상 목록)
- https://www.vitallaw.com/news/copyright-news-independent-artists-take-on-google-over-ai-music-generation/ipm01c1a1f4deddf247ef9517ed0d9c55ff8c (Kogon v. Google 제소 보도)
- https://www.musicbusinessworldwide.com/google-moves-to-dismiss-indie-artists-lawsuit-over-lyria-3-ai-training-arguing-they-licensed-their-music-to-youtube/ (Google 각하 신청)
- https://www.rollingstone.com/music/music-news/distrokid-removed-music-response-umg-lawsuit-1235641464/ (UMG v. DistroKid 삭제 조치)
- https://support.tunecore.com/hc/en-gb/articles/48255987089428 (TuneCore + Flow Music, 내용 미확인)

한국 AI 기본법
- https://www.skax.co.kr/insight/trend/3666
- https://kbthink.com/life/daily/ai-basic-act.html

기타 플랫폼
- Udio: https://www.udio.com/pricing · https://www.udio.com/terms-of-service
- ElevenLabs: https://elevenlabs.io/music-terms · https://elevenlabs.io/pricing
- Mureka 약관: https://static-cos.mureka.ai/cos-prod/mureka/static/terms-20260513.pdf
- Stable Audio: https://www.stableaudio.com/pricing
- AIVA: https://www.aiva.ai/pricing
- Soundraw: https://soundraw.io/pricing

국내 저작권 동향
- https://weekly.khan.co.kr/article/202610130600011
- https://news.mtn.co.kr/news-detail/2026081115501577406
- https://news.mtn.co.kr/news-detail/2026092215554461216
- https://sports.khan.co.kr/article/202608050109003
