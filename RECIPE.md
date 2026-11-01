# Herdr Context Bridge

Claude Code·Codex·AGY 잔여량을 하단에서 함께 보고, 원본을 유지한 채 세 제공자 사이의 모든 여섯 방향으로 새 탭에 기록을 인계하는 macOS·네이티브 Windows 도구입니다. Herdr 테마에 맞추며 영어·한국어·일본어·간체 중국어를 지원하고 기본은 매번 승인입니다. 자동 인계는 사용자가 등록한 원본 세션과 대상에만 허용합니다. macOS에서는 첫 번째 선호 언어, Windows에서는 `LC_ALL`·`LC_MESSAGES`·`LANG`·`Intl` 순서로 감지하며 지원하지 않는 언어는 영어로 표시합니다. 자세한 감지 순서는 [한국어 README](README.ko.md#지원-언어)를 참조하세요. 실제 설치와 화면 확인 절차는 아래에 있으며, 이 문서 자체는 설치 완료 기록이 아닙니다.

## What you see — 화면

- 기존 하단 상태바와 같은 높이의 행에 Claude·Codex의 5시간·주간 잔여량과 AGY의 지정된 Gemini4 Argon 주간 bucket 요약을 배치합니다. 제공자와 기간을 구분하고 평균·합산하지 않으며, 불명확한 기간이나 모델 bucket을 추측하지 않습니다.
- 요약을 클릭하면 상세 대화상자를 엽니다. 닫기 또는 Escape로 코딩 화면에 돌아가며 터미널 너비·높이는 바꾸지 않습니다. 상세창에는 `Context Bridge` 제목과 **새로고침**, Claude Code·Codex·AGY 사용량 카드가 있습니다. 각 창의 남은 비율, 막대, 리셋·갱신 시각을 표시합니다.
- 원본 선택, 나머지 두 제공자 중 대상 선택, 잔여량 기준, **매번 승인**과 **선택 세션 자동 인계**, 자동 등록 원본→대상과 해제 버튼이 이어집니다. AGY 원본에는 **인계 대상 권한: 기본 권한/권한 확인 생략**이 표시됩니다. 이는 대상 실행 권한을 직접 선택하는 설정이며 현재 AGY 권한 감지가 아닙니다. 최근 작업 상태는 최대 4개 표시합니다.
- 상세창의 **수동 인계 확인**으로 기존 확인 대화상자를 엽니다. 터미널·세션 후보, 원본→대상, 폴더, 보존 범위, **나중에**·**인계하기**가 있습니다.
- 기본 글자는 12px, 제목 14px, 보조 설명 11px입니다. 배경·테두리·강조색은 Herdr 테마를 사용하며 경고는 `ansi3`, 오류는 `ansi1`, 최신 표시는 `ansi2`입니다. 별도 일러스트나 고정 색상 테마는 없습니다.

## How it behaves — 동작

하단 요약 진입과 이후 60초마다 사용량을 조회합니다. 상세창을 닫아도 요약은 상주하여 갱신, 작업 조회, 알림과 자동 인계 감시를 유지합니다. 준비 중인 인계 작업이 있으면 2초마다 작업 상태를 갱신합니다. 유효한 잔여량이 기준 이하이면 알림과 확인 창을 표시하고, 등록된 자동 인계가 시작된 경우에는 알림만 표시합니다. 같은 사용량 창의 같은 리셋 주기에는 중복 알림을 억제합니다. 요약에서 조회 불가는 `—`, 오래된 값은 별도로 표시하고 유효한 잔여량이 기준 이하이면 경고합니다. 값이 없을 때 100%로 채우지 않습니다.

| 원본 상태 | 인계 동작 |
| --- | --- |
| `working` | 작업 중이므로 수동·자동 인계 모두 보류 |
| `blocked` | 일반 승인 대기는 보류. 확인된 `rate_limit`이면 허용 가능 |
| `idle`, `done` | 연결과 실행 조건을 확인한 후 인계 가능 |
| AGY 원본 | 10분 이내 공식 statusLine에서 `idle`이고 대기 입력·도구 승인·백그라운드 작업·실행 중 subagent가 없어야 함 |
| 연결 없음·불일치 | 원본 재선택 필요, 자동 실행 금지 |

터미널을 누르면 같은 폴더의 후보 세션을 불러오고, 후보를 눌러 연결합니다. AGY는 공식 statusLine에서 ID·작업 폴더·transcript 경로를 관측한 세션만 표시하며 미관측 과거 세션을 검색하지 않습니다. 자동 버튼은 선택 원본을 `autoSessions`, 대상을 `autoTargets`에 저장하고 **매번 승인**은 둘 다 해제합니다. 기존 Claude↔Codex 등록은 대상 생략 시 호환하며 AGY 원본은 대상 지정이 필수입니다. 기준 증감 버튼은 1~50% 범위에서 동작합니다. 자동 인계에는 원본·대상의 모든 사용량 창에 유효한 잔여 비율과 리셋 시각이 필요합니다. AGY bucket이 불확실하면 자동 인계를 보류하지만 원본 상태와 원문 조건을 만족하면 수동 인계는 가능합니다.

버튼 위에 포인터를 올리면 투명도가 바뀝니다. 처리 중이거나 사용할 수 없는 버튼은 흐리게 표시하고 클릭을 받지 않습니다. 대화상자의 Escape와 **나중에**는 창을 닫습니다. **인계하기**는 원본을 중단하지 않고 별도 준비 작업을 시작합니다. 새 탭 생성 후에도 실제 프롬프트 전달과 기록 읽기는 그 탭에서 확인해야 합니다.

## Built from — 구성

- 설치기는 기본 `main` 레이아웃을 복사해 개인 `context-bridge` 레이아웃을 만듭니다. 기존 상태바를 같은 높이의 행으로 감싸 상태바와 요약을 나란히 배치합니다. 상태바가 없으면 하단 한 줄을 추가합니다. 재설치 시 기존 우측 패널을 이 구성으로 교체하며 요약을 중복으로 만들지 않습니다. 내장 mod와 원본 `main` 레이아웃은 수정하지 않습니다.
- `mods/context-bridge/main.js`가 하단 요약과 상세·인계 확인 대화상자를 그립니다. 기본 props의 `node`와 `helper`는 설치 시 절대 경로입니다. 기존 인계 확인에서 원본·대상·폴더·보존 범위를 검토하는 흐름은 유지합니다.
- `ui-logic.js`는 사용량 신선도·주기별 알림·로컬 터미널 후보를 판단합니다. `mod.json`의 `place: "none"`으로 자동 도킹하지 않고 레이아웃 block에서 배치합니다.
- `herdr`의 `panes`, `spaces`, `agents`, `exec`, `props`, `theme`, `shared`, `setShared`, `notify`, `openOverlay`, `closeOverlay`, `nextCommand`를 사용합니다. UI 타이머와 비동기 작업은 View context에서 실행합니다.
- Node 기본 모듈만 사용하는 helper가 `hc ls --json`, `codex app-server`, 읽기용 Git 명령을 호출합니다. 인계는 `herdr-app do tab.new`에 작업 폴더와 Node 실행기의 argv를 전달합니다. 대상 Codex에는 `--no-daemon`, AGY에는 `--prompt-interactive`로 초기 프롬프트를 전달합니다. 확인된 Claude/Codex 원본 우회 모드 또는 AGY 원본의 명시적 `handoffPermissionMode: "bypass"` 선택에 따라 Codex에는 `--yolo`, Claude·AGY에는 `--dangerously-skip-permissions`를 추가하며 그 밖에는 기본 권한입니다. Windows CLI는 `.exe`·`.com`과 표준 npm `.cmd` shim의 실제 대상을 직접 실행하며 임의의 `.cmd`·`.bat` 실행기는 지원하지 않습니다.
- 설치 대상은 개인 mod/helper, 복제 레이아웃, Claude statusLine/hooks, Codex hooks와 AGY statusLine입니다. Herdr 설정은 [공식 `app_dir()`](https://github.com/herdrdev/herdr-app/blob/master/src/mods.rs)의 `HERDR_APP_HOME` → `XDG_CONFIG_HOME/herdr-app` → 사용자 홈의 `.config/herdr-app` 순서를 따릅니다. 상태와 기록은 Windows에서 `USERPROFILE/.local/state/herdr-context-bridge`, macOS에서 `HOME/.local/state/herdr-context-bridge`에 둡니다. POSIX의 0700·0600 mode와 Windows 사용자 프로필의 ACL 권한을 적용받습니다.

## Watch out — 설치와 운영

[한국어 README의 설치·제거 절차](README.ko.md#설치와-제거)를 따릅니다. `npm run install:mod -- --dry-run`으로 경로를 확인하고 설치 후 `herdr-app check`와 `layout.switch`를 별도로 실행합니다. 저장소 업데이트 후에는 `npm run install:mod`를 다시 실행해 복사된 helper를 갱신합니다. 원래 레이아웃으로 복귀한 후 제거할 수 있으며 인계 기록은 남습니다.

Windows에서는 Node.js 22.5 이상과 Git for Windows를 준비하고 앱의 `PATH`에서 `node`와 CLI를 찾을 수 있어야 합니다. PowerShell에서 `npm.cmd run install:mod -- --dry-run`, `npm.cmd run install:mod`, `herdr-app check "$env:USERPROFILE/.config/herdr-app/mods/context-bridge"`, `herdr-app do layout.switch --name context-bridge` 순서로 실행합니다. 제거 전에는 `herdr-app do layout.switch --name main`으로 복귀하고 `npm.cmd run uninstall:mod`를 사용합니다. 사용자 경로를 재정의했다면 check 경로도 맞춥니다. 기존 Claude 상태줄은 Git Bash가 있으면 그 셸로, 없으면 PowerShell로 실행하며 AGY는 기본 Windows 명령 셸을 사용합니다.

Claude 카드가 비어 있으면 설치 후 API 응답과 statusLine sample이 아직 없는지 확인합니다. Codex hooks는 `/hooks`의 정상 신뢰 절차가 필요할 수 있습니다. 이미 실행 중인 CLI는 새 설정을 즉시 반영하지 않을 수 있으므로 후보를 직접 연결합니다. 앱에서 CLI를 찾지 못하면 앱이 상속한 `PATH`를 확인하세요.

자동화의 실행점은 helper `status`입니다. 자동 모드에서 진단용으로 호출해도 조건이 맞으면 인계를 시작할 수 있습니다. 상세창을 닫아도 하단 요약이 감시를 계속하지만 앱이 없는 동안 감시하는 서비스는 없습니다. 자동 인계 실패는 스스로 반복하지 않으며 사용자가 이유를 확인해야 합니다. 대상 생성 중 중단된 경우에는 이미 새 탭이 생겼을 수 있으므로 중복 실행을 피합니다.

원문 archive와 모델이 실제로 읽은 컨텍스트를 구분합니다. raw가 없는 Codex 저장 방식에서는 공식 full history를 사용하고 경고합니다. AGY는 `~/.gemini/antigravity-cli/brain` 또는 이전 `~/.gemini/antigravity/brain`의 실제 경로·세션 ID를 검증하고 전체 `transcript_full.jsonl`을 raw·SHA-256·조각·인덱스로 보존합니다. 압축본만 있거나 전체 원문이 없으면 인계를 중단하며, 외부 첨부와 독립 subagent transcript는 수집하지 않고 원문 참조만 유지합니다. 실행 중 프로세스·모델 내부 상태·원래 시스템 프롬프트는 복제하지 않으며 원본 세션에 입력을 보내거나 종료하지 않습니다. 긴 기록은 인덱스에 따라 모든 조각을 읽고 과거 지시를 현재 요청으로 재실행하지 않습니다.

## Done when — 확인 절차

아래는 완료를 판단할 확인 항목이며, 실제 환경에서 확인한 결과를 뜻하지 않습니다. CI는 `macos-latest`와 `windows-latest`를 대상으로 구성되어 있습니다. 이번 변경은 macOS에서 검증했으며 Windows 실기 Herdr 앱은 아직 검증하지 않았습니다.

1. 프로젝트에서 `npm test`, `npm run check`가 통과합니다.
2. `herdr-app check ~/.config/herdr-app/mods/context-bridge`가 통과하고 네 언어에서 하단 요약·상세창·인계 확인이 잘리지 않습니다. 상세창 닫기·Escape 후 터미널 크기가 유지되고, 기존 상태바와 요약이 함께 보이며, 재설치 후 우측 패널이나 중복 요약이 남지 않습니다.
3. Codex 공식 사용량 조회 결과와 Claude·AGY의 정상 상태줄 sample이 화면에 표시됩니다. 없거나 오래된 값은 그 상태로 표시됩니다.
4. 기본 승인 모드에서 알림·후보 선택만으로 대상 탭을 열지 않고 **인계하기**를 눌러야 실행됩니다.
5. 격리 fixture에서 여섯 인계 방향, 대상·권한 선택, AGY 전체 원문 보존·유휴 조건, 자동 조건·실패 재시도 억제·중복 잠금과 원문 바이트·전체 페이지 보존을 확인합니다. 실제 사용자 세션에 시험 프롬프트를 보내지 않습니다.
6. 사용자가 실제 인계를 선택한 경우 원본 유지, 새 탭 생성, 초기 프롬프트와 기록 읽기를 각각 확인합니다.
7. 제거 dry-run과 임시 설정 fixture에서 기존 설정 복원·나중에 바꾼 사용자 옵션 보존·기록 유지가 확인됩니다.
