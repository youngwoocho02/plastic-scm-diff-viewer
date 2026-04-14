# plastic-scm-diff-viewer — CLAUDE 작업 가이드

## 프로젝트 한 줄 요약

**VSCode 확장.** Plastic SCM (Unity Version Control) 의 pending 변경 사항을 **Git 스타일 diff**로 렌더한다. `cm` CLI를 호출해 workspace 상태를 읽고, `plastic://` URI 스킴으로 과거 버전을 공급해서 VSCode의 diff / Multi Diff Editor에 붙인다.

Plastic은 중앙집중형이라 historical content가 로컬에 없음 → 모든 비교가 네트워크 왕복. 확장은 왕복을 최소화하는 **얇은 어댑터 + 캐시 레이어**다.

## Stack

- **TypeScript** (strict), **esbuild** 번들
- **VSCode Extension API** `^1.86.0`
- 배포: `@vscode/vsce` → `.vsix` → GitHub Release
- 의존성: runtime 0개 (VSCode API만)

## 디렉토리 구조

```
plastic-scm-diff-viewer/
├── src/
│   ├── extension.ts         — activate/deactivate, 워크스페이스 탐지 (cm wi)
│   ├── plasticScm.ts        — SCM provider, 3단계 refresh, viewAllChanges 커맨드
│   ├── plasticCli.ts        — cm CLI wrapper, 캐시, 세마포어, phantom filter, in-flight coalesce
│   ├── contentProvider.ts   — plastic:// URI 스킴 → cm cat 결과 공급
│   └── types.ts             — ChangeStatus, PlasticChange, URI encode/decode
├── docs/
│   └── DEVELOPMENT.md       — 개발 기록: Git vs Plastic 구조, 성능 분석, 시행착오
├── dist/                    — esbuild 번들 (gitignored)
├── README.md                — 영문 기본
├── README.ko.md             — 한국어
├── package.json             — 커맨드/설정/metadata, publisher "fedtop"
├── tsconfig.json
├── .vscodeignore            — .vsix에 포함 안 할 파일
├── .gitignore
└── LICENSE                  — MIT
```

## 4 레이어 아키텍처

```
extension.ts
  └─ PlasticScmProvider 생성, channel 주입

plasticScm.ts (SCM provider + 커맨드)
  └─ doRefresh — 3단계 (raw status → phantom filter + prefetch 병렬)
  └─ viewAllChanges — phantomInflight 대기 후 Multi Diff 오픈
  └─ diffUris — Added/Deleted/Changed/Moved 별 URI 매핑

plasticCli.ts (cm 프로세스 + 캐시)
  └─ enqueueCm — 4-slot 세마포어 (workspace lock 회피)
  └─ catCached — 3단 lookup (cache → in-flight → new cm cat)
  └─ _contentCache Map<ref\0path, Buffer> — immutable, 무효화 없음
  └─ filterPhantomChanges — Changed 중 byte-identical 제거
  └─ prefetchBaseContent — non-Added 항목 base 선-warming

contentProvider.ts (VSCode 인터페이스)
  └─ plastic:// URI → parsePlasticUri → getFileContent → cache/cm cat
```

## 주요 개념

- **Phantom CH**: Plastic이 `CH`로 보고하지만 base와 byte-identical인 파일. Unity `.asset` checkout 흔적으로 흔함. `filterPhantomChanges`가 cm cat + Buffer 비교로 걸러냄.
- **Immutable 캐시**: historical revision은 Plastic에서 rewrite 안 되므로 `(ref, path)` 키는 세션 내내 유효. refresh·커밋·브랜치 스위치와 무관하게 재사용.
- **In-flight coalescing**: 동일 `ref\0path` 동시 호출은 단일 Promise 공유 → phantom filter와 prefetch가 같은 파일 중복 fetch 안 함.
- **3단계 refresh**: stage 1 (status 파싱, raw snapshot commit) → stage 2+3 병렬 (phantom filter + prefetch). `viewAllChanges`는 `phantomInflight`를 기다려서 snapshot에 phantom이 섞이지 않도록 보장.
- **세마포어 4**: `cm`은 workspace lock을 잡음. 실측 결과 동시 cat 6+ 부터 flake. 4가 안전 ceiling.

## 작업 방법

### 빌드

```bash
npm install
npm run build          # esbuild → dist/extension.js
npm run watch          # watch 모드
```

### 타입 체크

```bash
npx tsc --noEmit
```

### 패키징 (`.vsix` 생성)

```bash
npx @vscode/vsce package --allow-missing-repository
# → plastic-scm-diff-viewer-<version>.vsix
```

### 로컬 설치 (개발 중 바로 사용해보기)

```bash
# 빌드 후
code --install-extension plastic-scm-diff-viewer-0.1.0.vsix --force
# VSCode reload (Ctrl+R) 해야 새 버전 적용
```

### 구현검증 필수 절차

`npx tsc --noEmit` 타입 체크만으로는 검증 완료가 아님. VSCode 확장은 실제 설치·동작까지 확인해야 한다.

```bash
npm run build
npx @vscode/vsce package --allow-missing-repository
code --install-extension plastic-scm-diff-viewer-0.1.0.vsix --force
# VSCode에서 Ctrl+Shift+P → "Developer: Reload Window"
```

이후 SCM 사이드바에서 실제 변경 사항이 의도한 대로 표시되는지 확인.

### 개발 중 디버그 실행 (VSCode 재설치 없이)

`.vscode/launch.json`이 있으면 `F5`로 Extension Development Host 새 창이 뜸. 현재는 launch.json 없음 — 필요하면 추가.

### 로그 확인

extension은 `Plastic SCM Diff` OutputChannel에 **timestamp prefix + 카테고리 prefix** (`[cm]`, `[cache]`, `[phantom]`, `[prefetch]`, `[refresh]`, `[scm]`, `[provider]`, `[activate]`) 로 모든 단계를 기록한다.

VSCode에서 `View → Output → Plastic SCM Diff` 드롭다운 선택.

## 릴리즈 절차

1. `package.json`의 `version` 업데이트
2. `npm run build && npx vsce package`
3. vsix를 `plastic-scm-diff-viewer.vsix` (버전 없는 이름) 으로 복사
   ```bash
   cp plastic-scm-diff-viewer-X.Y.Z.vsix /tmp/plastic-scm-diff-viewer.vsix
   ```
4. GitHub Release 생성
   ```bash
   git tag vX.Y.Z && git push origin vX.Y.Z
   gh release create vX.Y.Z /tmp/plastic-scm-diff-viewer.vsix \
     --title "vX.Y.Z" --notes "..."
   ```
5. `/releases/latest/download/plastic-scm-diff-viewer.vsix` URL은 항상 최신 릴리즈를 가리킴 — README 수정 필요 없음.

## 건드릴 때 주의

### `plasticCli.ts`

- **세마포어 limit 6 이상 올리지 말 것** — workspace lock 실패. 로컬 벤치(단독 cm cat)는 6까지 safe지만 실전에선 `cm status`와 겹쳐서 flake. 실측 증거 있음.
- **catCached는 반드시 사용**. 직접 `execBuffer(['cat', ...])` 호출은 캐시·in-flight coalesce를 우회하므로 중복 요청 발생.
- **phantom filter는 필수**. 제거하면 Unity `.asset` phantom이 그대로 리스트에 노출.

### `plasticScm.ts`

- **stage 1 commit 후 `phantomFiltered: false`** 로 해야 viewAllChanges가 phantom filter를 기다림. 이 플래그 제거 시 Multi Diff에 phantom 섞임.
- **`refreshInflight` 직접 await 금지**. 전체 refresh 기다리면 warm case에서 6초 허비. phantomInflight만 기다리는 게 맞음.

### `contentProvider.ts`

- **`uri.fsPath` 대신 `uri.path` 사용**. fsPath는 non-file 스킴에서 플랫폼별 path 변환으로 꼬일 수 있음 (실제 버그 있었음).
- **EMPTY_REF 체크 먼저**. EMPTY_REF면 즉시 `''` 반환 — cm cat 호출 안 함.

### `types.ts:toPlasticUri` / `parsePlasticUri`

- **base64/JSON 쓰지 말 것**. base64 `=` padding이 VSCode URI 왕복에서 깨지는 케이스 있었음. 현재는 단순 `?ref=<encoded>` query param 방식 유지.

## 성능 기준 (현재 실측)

| 시나리오 | 시간 |
|---|---|
| Cold refresh (첫 refresh) | ~20초 |
| Warm refresh (이후) | ~6초 (`cm status` 호출만, cat은 전부 hit) |
| Warm Multi Diff 클릭 | ~0.5초 (cache hit, VSCode 내부 렌더만) |
| Single file click (warm) | ~0초 |
| `cm cat` 1회 | 2~4초 (네트워크 왕복, Unity DevOps Cloud) |

**네트워크가 본질적 병목**. 줄이려면:
- **D. 디스크 영구 캐시** — `context.globalStorageUri` 에 `(ref, path) → bytes` 저장. 세션 간 warm 유지.
- **cm shell 인터랙티브 모드** — 프로세스/연결 재사용. 복잡도 큼.

## 릴리즈 상태

- GitHub: https://github.com/youngwoocho02/plastic-scm-diff-viewer (public)
- 최신 릴리즈: `v0.1.0`
- 커밋 히스토리: squash된 단일 commit (개발 시행착오는 `docs/DEVELOPMENT.md`에 정리)

## 관련 문서

- **README.md** / **README.ko.md** — 사용자용
- **docs/DEVELOPMENT.md** — 개발 기록, Git vs Plastic 구조 차이, 성능 분석, 시행착오 타임라인
- 이 파일 (**CLAUDE.md**) — 작업 시 맥락
