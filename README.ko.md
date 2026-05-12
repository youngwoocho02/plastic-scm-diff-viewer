# Plastic SCM Diff Viewer

[English](./README.md)

Plastic SCM (Unity Version Control) 의 pending 변경 사항을 Git 스타일 diff로 보여주는 VS Code 확장 — 개별 파일 클릭과 **Multi Diff Editor**(변경된 모든 파일을 한 뷰에서 스크롤)를 지원한다.

## 기능

- **Multi Diff Editor** — 모든 pending 변경을 한 스크롤 뷰에서 (Git의 "Open All Changes"와 동일)
- **단일 파일 diff** — SCM 사이드바에서 파일 클릭 시 표준 diff 창
- **Git 스타일 Added / Deleted 표시** — 추가된 파일은 "빈 상태 → 새 내용", 삭제된 파일은 "원본 → 빈 상태"
- **지연 base 로딩** — diff로 연 파일의 historical content만 가져옴
- **in-memory 콘텐츠 캐시** — 열었던 historical revision은 세션 내내 재사용
- **Changeset diff** — 임의의 두 changeset 번호 간 비교
- **자동 새로 고침** — 변경 목록이 워크스페이스 상태와 동기화 유지

## 요구사항

- VS Code 1.86+
- [Plastic SCM / Unity Version Control](https://www.plasticscm.com/) CLI (`cm`) 이 설치되어 있고 `PATH`에 등록되어 있어야 함

## 설치

### Linux / macOS

```bash
curl -fsSL https://raw.githubusercontent.com/youngwoocho02/plastic-scm-diff-viewer/master/install.sh | sh
```

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/youngwoocho02/plastic-scm-diff-viewer/master/install.ps1 | iex
```

### 기타 방법

[Releases 페이지](https://github.com/youngwoocho02/plastic-scm-diff-viewer/releases)에서 `plastic-scm-diff-viewer.vsix` 를 직접 내려받아:

```bash
code --install-extension plastic-scm-diff-viewer.vsix
```

또는 소스에서 직접 빌드 — [빌드](#빌드) 참고.

## 사용법

1. Plastic SCM 워크스페이스가 있는 폴더를 연다. 상위 폴더여도 됨 — 하위 디렉터리의 `.plastic/` 마커를 자동 탐지한다.
2. VS Code의 Source Control 사이드바에 **Plastic SCM** 그룹이 나타나며 모든 pending 변경이 나열된다.
3. SCM 제목 표시줄의 **diff-multiple** (🗂) 아이콘을 눌러 Multi Diff Editor를 열거나, 개별 파일을 클릭하면 단일 diff 창.

### 명령어

| 명령어 | 설명 |
|---|---|
| `Plastic SCM: View All Changes (Multi Diff)` | 모든 pending 변경을 Multi Diff Editor에서 표시 |
| `Plastic SCM: View Changeset Diff` | 두 changeset 번호를 입력해 비교 |
| `Plastic SCM: Refresh` | 변경 목록 수동 새로 고침 |
| `Plastic SCM: Clear Content Cache` | in-memory 캐시 삭제 (문제 진단용) |

## 설정

| 설정 | 기본값 | 설명 |
|---|---|---|
| `plasticDiff.cmPath` | `cm` | `cm` CLI 실행 파일 경로 |
| `plasticDiff.autoRefreshInterval` | `10000` | 자동 새로 고침 주기(ms). 새로 고침은 변경 목록만 갱신하고, 파일 내용은 diff를 열 때 가져온다. `0`이면 자동 새로 고침 비활성화. |

## 동작 원리

Plastic SCM은 **중앙집중형 VCS**다 — 히스토리는 워크스페이스가 아니라 repository 서버에 있다. "이 파일의 cs:N 내용을 보여줘" 요청은 전부 `cm cat`으로 서버 왕복을 거친다. 한 번 호출에 보통 2~4초씩 든다. 이 확장은 왕복 횟수를 최소화하는 얇은 어댑터다.

### 데이터 흐름 (cold refresh)

1. **`cm wi`** — 워크스페이스 루트 탐지
2. **`cm status --header` + `cm gwp`** — 로드된 changeset 번호와 브랜치 읽기
3. **`cm status --noheader --all --machinereadable --iscochanged`** — 모든 pending 변경 목록 (Added / Changed / Deleted / Moved)
4. Source Control 뷰를 status 결과만으로 갱신한다. 새로 고침 중에는 historical file content를 가져오지 않는다.

### Diff 렌더링

- **Changed** → `plastic://path?ref=cs:N` (base) vs `file://path` (워크스페이스)
- **Added** → 빈 가상 문서 vs `file://path`
- **Deleted** → `plastic://path?ref=cs:N` vs 빈 가상 문서
- **Moved** → `plastic://oldPath?ref=cs:N` vs `file://newPath`

`plastic://` URI 스킴은 `TextDocumentContentProvider`가 처리하며, query에서 `ref`를 추출해 열린 파일 하나에 대해서만 `cm cat` (캐시)을 호출한다.

### 동시성

`cm`은 워크스페이스 레벨 락을 잡기 때문에, 확장은 모든 CLI 호출을 4-slot 세마포어로 관문을 걸어 직렬화한다. 이 값은 실측으로 결정 — `limit=4` 는 실전에서 100% 안정, `limit=6` 은 단독 벤치에선 되지만 `cm status` 와 동시 부하가 걸리면 flake.

동일한 `path#ref` 키에 대한 동시 호출은 단일 in-flight Promise로 합쳐져서, 반복 diff 오픈이 중복 작업을 하지 않는다.

## 알려진 한계

- **파일 diff 첫 오픈이 느릴 수 있음** — 원격 repository 기준 `cm cat`이 historical content를 가져오기 때문
- **Phantom Changed 항목** — refresh 중 모든 파일을 base와 바이트 비교하지 않으므로 일부 checkout 흔적이 표시될 수 있음
- **바이너리 파일** — UTF-8 문자열로 디코드되어 나타남. 비-텍스트 파일은 깨져 보일 수 있음
- **멀티 루트 워크스페이스** — 탐지된 첫 Plastic 루트만 모니터링

## 빌드

```bash
npm install
npm run build
```

`.vsix`로 패키징:

```bash
npx @vscode/vsce package --allow-missing-repository
```

## 라이선스

MIT
