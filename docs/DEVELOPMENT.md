# Plastic SCM Diff Viewer — 개발 기록

VSCode에서 Plastic SCM(Unity Version Control) 의 pending changes를 Git처럼 보려고 만든 확장의 설계·구현 과정과 성능 분석 문서.

---

## 1. 왜 만들었나

Unity 프로젝트를 Plastic SCM으로 관리 중인데, Plastic GUI나 `cm` CLI로는 변경사항을 보기 불편했다. 목표:

- VSCode의 SCM 뷰에 pending changes 표시
- 파일 클릭 시 Git처럼 좌우 비교 diff
- 전체 변경을 스크롤 가능한 Multi Diff Editor로 한 번에 훑기

Git 확장처럼 자연스럽게 동작하면 된다. 하지만 **Plastic의 내부 구조가 Git과 달라서**, 중간에 여러 구조적 문제가 나왔다.

---

## 2. Git과 Plastic SCM의 구조적 차이

성능과 설계에 결정적인 차이 4가지.

### 2.1 저장소 위치

**Git — 분산형**
```
my-project/
├── .git/
│   └── objects/       ← 모든 파일의 모든 버전이 로컬에
└── src/
```
`git show HEAD:file.c` → `.git/objects/`에서 즉시 읽음. 네트워크 안 탄다. 히스토리 전체가 디스크에 있다.

**Plastic — 중앙집중형(기본)**
```
my-project/
├── .plastic/          ← 워크스페이스 메타데이터만 (checkout 상태, cs 번호)
└── src/               ← 현재 파일들만

[원격 서버]
  repository/
    cs:3264, cs:3265, ...  ← 실제 히스토리는 여기
```
`cm cat file#cs:3264` → **서버에 요청** → 네트워크 왕복. 워크스페이스엔 현재 파일과 상태 메타데이터만 있고, 과거 버전 내용은 서버에만 존재.

Plastic에도 "로컬 저장소" 모드와 `cm replicate`를 통한 분산 기능이 있지만, **기본 사용 형태는 중앙집중**이다. Unity DevOps Cloud 같은 SaaS는 완전히 원격이라 매번 인터넷 왕복.

### 2.2 "변경" 추적 방식

**Git**: 워킹 트리 파일을 index와 비교. 파일 건드리면 자동으로 "modified" 표시. 명시적 선언 필요 없음.

**Plastic**: 파일 수정 전에 `cm checkout`으로 **명시적 잠금**을 해야 함 (Unity DevOps 기본값은 자동 checkout). Checkout만 하고 내용 안 바꿔도 "Changed"로 표시됨. 이 차이가 뒤에서 **phantom CH** 문제를 만든다.

### 2.3 상태 코드 복잡도

Git은 단순함: `M/A/D/R/U` (modified/added/deleted/renamed/unmerged).

Plastic `cm status --machinereadable` 는:
- `AD` Added
- `CH` Changed
- `CO` Checked-out (내용 변경 없음)
- `CO+CH` Checked-out + 내용 변경
- `CP` Copied
- `RP` Replaced
- `DE` Deleted (via `cm remove`)
- `LD` Locally Deleted (fs에서 삭제)
- `MV` Moved (via `cm move`)
- `LM` Locally Moved (fs 이동)
- `PR` Private (untracked)
- `IG` Ignored

이 복잡한 상태들을 Git-style `Added/Changed/Deleted/Moved` 4개로 정규화해야 한다.

### 2.4 Historical diff 명령

Git: `git diff HEAD -- file.c` 즉시 로컬에서.

Plastic:
- `cm diff cs:X cs:Y` — changeset 간 역사적 diff ✅
- `cm diff cs:N` (단일 인자) — parent→cs:N 역사적 diff (기대와 다름)
- **"workspace vs base"** 같은 pending diff 명령은 **없다**

Pending 변경은 오직 `cm status`로만 목록을 얻을 수 있고, 각 파일 내용 비교는 `cm cat path#cs:N`으로 base를 받아와서 수동으로 해야 한다.

---

## 3. 시행착오 타임라인

### 3.1 v1: 기초 구현 (cm status + 파싱)

`cm status --all --machinereadable`로 목록 받고 파싱. VSCode SCM API에 resource로 등록. 단순한 구조:

```
extension.ts       ← 활성화 + 워크스페이스 탐지
plasticScm.ts      ← SCM provider, 커맨드
contentProvider.ts ← plastic:// URI → 내용 공급
plasticCli.ts      ← cm 호출 + 파싱
types.ts           ← ChangeStatus, toPlasticUri
```

Changed 파일 클릭 → `vscode.diff(plastic://base, file://workspace)` → 동작 확인.

### 3.2 Added/Deleted 파일 클릭이 아무것도 안 열림

**증상**: Changed는 diff 뜨는데 Added/Deleted는 클릭해도 조용함.

**원인**: `toResourceState`에서 command arguments 만들 때

```ts
arguments: originalUri && modifiedUri
  ? [originalUri, modifiedUri, title]
  : undefined
```

Added는 originalUri가 없음(`undefined`), Deleted는 modifiedUri가 없음. 둘 중 하나라도 없으면 `arguments: undefined` → `vscode.diff`에 인자 없이 호출 → no-op. **Git은 "없는 쪽"을 빈 문서로 표시**한다.

**해결**: `EMPTY_REF` 센티널 도입.
- Added → 좌측 `plastic://?ref=__empty__` (provider가 `''` 반환), 우측 `file://`
- Deleted → 좌측 `plastic://?ref=cs:N`, 우측 `plastic://?ref=__empty__`
- Multi Diff 리소스도 동일 규칙

이제 Git처럼 "없던 거 → 생김" / "있던 거 → 없어짐" diff가 뜬다.

### 3.3 Phantom CH 발견

**증상**: `PC_Renderer.asset`, `ShaderGraphSettings.asset` 같은 파일이 Changed 목록에 있는데, 열어보면 diff가 없음. `md5sum`으로 워크스페이스 파일과 base를 비교하면 **100% 동일**.

**원인**: Unity가 asset을 저장할 때 Plastic은 checkout을 자동으로 걸고, 이후 내용이 안 바뀌어도 Plastic은 그걸 `CH`(또는 `CO+CH`)로 보고. Plastic GUI도 동일한 목록을 보여주지만, 더블클릭하면 "no differences"가 뜨는 유명한 현상.

**해결**: Content 비교 필터.

```ts
async function filterPhantomChanges(cwd, baseCs, changes) {
  return Promise.all(changes.map(async c => {
    if (c.status !== Changed) return true;
    const [base, current] = await Promise.all([
      cm_cat(c.path, `cs:${baseCs}`),
      fs.readFile(c.path),
    ]);
    return !base.equals(current);  // 같으면 drop
  })).then(keep => changes.filter((_, i) => keep[i]));
}
```

각 Changed 파일에 대해 base 내용과 workspace 내용을 Buffer로 비교, 완전히 같으면 제거. 이후 phantom 증상 해결.

### 3.4 `cm diff cs:N` 삽질

잠깐 "`cm diff cs:N` 을 쓰면 실제 diff가 있는 파일만 준다"고 오해했다. 실제로는:

- `cm diff cs:X cs:Y` — X와 Y 두 changeset 간 역사적 diff
- `cm diff cs:N` (단일) — **parent→cs:N 역사적 diff**, pending workspace diff 아님

테스트해보니 `cm diff cs:3264` 출력에 `.claude/*` 같은 파일이 있었는데, 이건 **내 workspace 현재 상태**가 아니라 cs:3264 커밋에 들어간 내용이었다. 착각.

**되돌림**: `cm status` 기반으로 복귀. Pending 상태는 Plastic에서 `cm status`만이 권위 있는 소스.

### 3.5 동시성 경합 — workspace lock 경합

**증상**: manifest.json ↔ ProjectSettings.asset 등이 refresh할 때마다 **무작위로** 한 개씩 "통으로 새 파일"처럼 표시. 어떤 파일이 깨지는지는 매번 다름.

처음엔 URI 인코딩 버그로 의심하고 `base64` → query param 바꾸는 등 여러 번 엉뚱한 곳을 수정했다. 실제 원인 파악까지 시간 걸림.

**진짜 원인**: Plastic `cm` CLI가 **workspace-level 락**을 잡는다. `Promise.all`로 13개 `cm cat`을 동시 실행하면 일부가 `"The workspace is locked"` 에러로 실패. `getFileContent`의 `try/catch`가 에러를 삼키고 `''` 반환 → diff 좌측이 빈 상태 → "새 파일"처럼 보임.

**로컬 재현** (`vscode-uri` + Node bench):
```
limit=1:  100% ok, 38s   ← 직렬, 안전하지만 느림
limit=4:  100% ok, 9s    ← 여기가 sweet spot
limit=6:  100% ok, 7s
limit=8:  ~80% ok, 5s    ← flaky
limit=13: ~85% ok, 4s    ← 기존 Promise.all
```

**해결**: 세마포어로 cm 프로세스 동시 실행 **4개로 제한**. 모든 `exec`/`execBuffer`가 세마포어 통과.

```ts
const CM_CONCURRENCY = 4;
async function enqueueCm<T>(task: () => Promise<T>): Promise<T> {
  await acquireCmSlot();
  try { return await task(); }
  finally { releaseCmSlot(); }
}
```

이후 경합 0. 이 경험에서 **로컬 재현 가능한 테스트 없이는 추측하지 말 것**이라는 교훈을 얻음. 이 버그가 드러나기까지 내가 URI 인코딩만 세 번 바꿨다.

### 3.6 캐시 넣었다 뺐다

한 번은 in-memory content cache를 넣었다가 사용자가 "단순하게 해줘"라고 해서 뺐다. 그 결과 Multi Diff 오픈이 느려져서 다시 넣음. **그 과정에서 깨달은 것**:

초기 캐시 설계는 "refresh마다 clear"였다. 이건 틀렸다. 왜냐면 **historical revision은 immutable**이기 때문이다. `file#cs:3264`의 내용은 영원히 같다 — 커밋, 브랜치 스위치, 업데이트가 일어나도 **그 특정 cs:N의 내용은 절대 안 바뀜**.

Plastic이 history를 rewrite하지 않으니 `(path, cs:N)` → Buffer 매핑은 **평생 유효**. 무효화 타이밍 자체가 없다.

**최종 설계**:
```ts
const _contentCache = new Map<string, Buffer>();  // key: "cs:N\0absPath"
                                                    // clear: 안 함
```

디스크 영속은 과투자(YAGNI). 복잡도 vs 이득 고려해서 in-memory만.

### 3.7 Multi Diff가 20초 걸림

사용자 불만: "멀티 디프 뜨는데 20초는 걸린다."

캐시 넣었으니 0초일 거라 말했는데 실제 20초. **내 분석이 Changed 파일만 고려한 결과였다**. 실제로는:

- **Changed** (13개): phantom filter가 side effect로 cache warming → 클릭 시 cache hit → 즉시
- **Added** (3개): EMPTY_REF → 즉시
- **Deleted** (11개): **아무도 warming 안 했음** → Multi Diff 열 때 매 파일마다 `cm cat` 실행 → 11 × 3s / 병렬 4 ≈ **9초**
- Cold start면 초기 refresh(11초)까지 얹혀서 총 20초

**해결 2가지:**

1. **`prefetchBaseContent`**: `doRefresh`에서 phantom filter 후 **모든 non-Added 항목의 base를 warming**. Changed는 이미 cache hit(0초), Deleted/Moved는 실제 fetch. 한 번 끝나면 Multi Diff 열 때 cm 호출 0회.

2. **`STALE_MS` → `autoRefreshInterval`**: 하드코딩 2초 stale window가 5초 auto-refresh보다 짧아서 대부분의 click이 stale 판정으로 refresh 한 번 더 돌림. auto-refresh 간격에 맞추면 "SCM 리스트가 보여주는 같은 스냅샷"을 Multi Diff도 쓰게 됨.

결과: 첫 refresh는 ~16초(전체 warming)이지만 **세션당 1회**. 이후 Multi Diff 클릭은 cm 호출 0회 → 창 뜨는 시간만 (<1초).

---

## 4. 왜 느린가 — 본질적 제약

### 4.1 `cm cat` 1회 실측

| 명령 | 시간 |
|---|---|
| `cm` (no args) | **0.24s** — 프로세스 spawn |
| `cm cat file#cs:N` | **2.9~3.8s** |
| `cm status --header` | **1.5~3s** |
| `cm status --all` | **~1s** |

프로세스 spawn은 빠르다(0.24s). 느린 건 실제 명령 실행 2.5초+. 이건:
- repository 서버에 연결
- 인증
- 요청 전송
- 응답 수신
- 연결 종료

**프로토콜 왕복** 비용. 파일 크기(5KB)에 비해 극도로 많은 오버헤드.

### 4.2 왜 이렇게 많이 드냐

Plastic의 `cm` CLI는 **매번 새로 서버에 연결**한다. 연결, 인증, 세션 수립을 매 명령마다 반복. 네트워크 왕복 여러 번 + 인증 연산. 이게 2.5초의 정체.

비교:
- **Git**: 네트워크 없음. 로컬 파일시스템 읽기 → 마이크로초 단위.
- **Plastic GUI**: 내부에 `plasticd` 또는 WCF 서비스가 떠있고, **한 번 연결하면 그걸 재사용**. 몇 ms 내로 응답.
- **Plastic `cm` CLI**: 매 호출이 새 연결 → 2~3초씩.

Plastic GUI가 빠른 건 연결을 amortize하기 때문이다. CLI 기반 확장은 이걸 못 함. 구조적 한계.

### 4.3 시간 분해

실제 워크스페이스(Changed 13, Deleted 6, 서버 = Unity DevOps Cloud):

```
첫 refresh (cold):
  cm status --header       ~2s
  cm status --all           ~1s
  phantom filter 13 × cm cat / parallel 4 ≈ 10s
  prefetch 6 × cm cat / parallel 4         ≈ 5s
  ─────────
  총 약                     ~16s

이후 refresh (warm):
  cm status --header       ~2s
  cm status --all           ~1s
  phantom filter (cache hit) ≈ 0s
  prefetch (cache hit)       ≈ 0s
  ─────────
  총 약                     ~3s

Multi Diff 클릭 (warm):
  cm 호출 0회 (전부 cache)   ≈ 0s
  VSCode 창 렌더            ≈ 0.5s
  ─────────
  총 약                     <1s
```

**병목은 처음 1번의 네트워크 fetch.** 이후는 immutable cache로 전부 해결.

### 4.4 우리가 줄일 수 있는 것과 없는 것

**줄일 수 있는 것:**
- 중복 호출 제거 (캐시) ← 이게 해결책의 전부
- 동시성 경합 방지 (세마포어)
- 불필요한 refresh 스킵 (stale check)

**줄일 수 없는 것:**
- `cm cat` 1회당 본질 비용 (네트워크 왕복)
- 첫 refresh의 cold start
- Plastic 서버 응답 시간

전자는 우리 코드가 제어 가능, 후자는 Plastic/네트워크 인프라 제약.

---

## 5. 현재 아키텍처

### 5.1 레이어

```
extension.ts
  ├─ 워크스페이스 탐지 (cm wi)
  ├─ OutputChannel 생성 → plasticCli.configure()
  └─ PlasticScmProvider 인스턴스 생성

plasticScm.ts  (SCM provider + 커맨드 핸들러)
  ├─ SCM UI 통합 (vscode.scm.createSourceControl)
  ├─ refresh() — single-flight, 5s auto
  │    └─ getWorkspaceInfo → getPendingChanges → prefetchBaseContent
  ├─ diffUris(change, originalRef, modifiedRef) — URI 생성 공통
  ├─ viewAllChanges() — Multi Diff 커맨드
  ├─ viewChangesetDiff() — 두 cs 간 diff
  └─ lastChanges/lastBaseCs/lastBranch/lastRefreshTime 캐시

contentProvider.ts  (TextDocumentContentProvider)
  └─ plastic:// URI → parsePlasticUri → getFileContent → 문자열 반환

plasticCli.ts
  ├─ _contentCache: Map<"cs:N\0path", Buffer>
  ├─ enqueueCm semaphore (CM_CONCURRENCY = 4)
  ├─ catCached() — 캐시 통과하는 cm cat
  ├─ getPendingChanges() — cm status 파싱 + phantom filter
  ├─ prefetchBaseContent() — 모든 non-Added 항목 base warming
  ├─ getWorkspaceInfo() — 브랜치/레포/cs/root
  └─ getChangesetDiff() — cm diff cs:X cs:Y 파싱

types.ts
  ├─ ChangeStatus (A/C/D/M)
  ├─ EMPTY_REF 센티널
  ├─ toPlasticUri() — file Uri에 scheme + ?ref= 붙임
  └─ parsePlasticUri() — uri.path + query에서 ref 추출
```

### 5.2 데이터 흐름 (refresh → Multi Diff)

```
auto-refresh 또는 수동 트리거
  ↓
doRefresh()
  ↓
getWorkspaceInfo() → cs 3264, branch main
  ↓
getPendingChanges(cs:3264)
  ├─ cm status --all --machinereadable --iscochanged
  ├─ 상태 코드 정규화 (AD→Added, CO+CH→Changed, LD→Deleted, ...)
  ├─ directory 제외
  └─ filterPhantomChanges (Changed 파일만)
      └─ catCached(path, "cs:3264") ← cache populate
  ↓
prefetchBaseContent (non-Added)
  └─ catCached(path, "cs:3264") ← cache populate (Deleted/Moved)
  ↓
lastChanges, lastBranch, lastBaseCs, lastRefreshTime 저장
  ↓
SCM 리소스 리스트 갱신


사용자가 Multi Diff 클릭
  ↓
viewAllChanges()
  ↓
await refreshInflight if any
  ↓
stale check (lastRefreshTime vs autoRefreshInterval)
  ↓ 보통 fresh → 스킵
resources = lastChanges.map(diffUris(c, "cs:3264", null))
  ↓
_workbench.openMultiDiffEditor({title, resources})
  ↓
VSCode가 파일별 좌측 content 요청 → contentProvider → catCached → 캐시 히트
```

### 5.3 상태 정규화 매핑

```
cm status 코드          →  ChangeStatus
─────────────────────────────────────
AD, CP                 →  Added
CH, RP                 →  Changed
CO+CH                  →  Changed  (checked out + 내용 변경)
CO (단독)              →  (제외, 순수 checkout)
MV, LM                 →  Moved
DE, LD                 →  Deleted
PR, IG                 →  (제외, 노이즈)
directory (ISDIR=True) →  (제외)
```

### 5.4 URI 인코딩

```
plastic:// 스킴
  path:  /home/user/workspace/file.cs  (file 스킴과 같은 실제 경로)
  query: ref=cs%3A3264                 (encodeURIComponent)

toPlasticUri(path, ref):
  vscode.Uri.file(path).with({scheme: 'plastic', query: `ref=${encodeURIComponent(ref)}`})

parsePlasticUri(uri):
  path: uri.path                        ← fsPath 아님 (non-file scheme 호환)
  ref:  uri.query 에서 정규식으로 추출
```

base64/JSON 같은 복잡한 인코딩은 VSCode Uri 클래스와 왕복에서 문제 일으킨다. 단순 query param이 가장 안전.

---

## 6. 한계와 trade-off

### 6.1 첫 refresh 지연 (세션당 1회 16초)

**원인**: Cold cache, 모든 Changed + Deleted base를 원격 서버에서 fetch.

**현재 대응**: 없음. 사용자가 VSCode 처음 열고 첫 Multi Diff까지는 대기.

**개선 옵션** (미구현):
- **디스크 영속 캐시**: `context.globalStorageUri`에 저장. 재시작 후에도 유효. 복잡도 중간(파일 해싱, I/O, 용량 관리).
- **`cm shell` interactive 모드**: cm을 persistent subprocess로 띄우고 stdin으로 명령. 서버 연결 재사용 가능성. 복잡도 큼.

### 6.2 Moved 파일 oldPath 없음

`cm status --machinereadable`는 MV/LM 항목의 원본 경로를 제공 안 함. 그래서 현재:
- `diffUris`에서 Moved는 `oldPath || currentPath`로 fallback
- 양쪽이 현재 경로로 같음 → 자동으로 self-diff (의미 있는 diff 안 나옴)

**개선 필요** (미구현): `cm find` 또는 `cm history`로 원본 경로 조회. 당분간 워크스페이스에 MV가 없어서 보류.

### 6.3 Binary 파일 지원

`getFileContent`는 Buffer를 `.toString('utf8')`로 변환해서 VSCode provider에 반환. 바이너리 파일(이미지, fbx 등)은 UTF-8 decode 과정에서 손상. VSCode Multi Diff도 바이너리를 잘 다루지 못해서 실용적 영향은 적지만, 근본적으로는 `arrayBuffer` 기반 provider가 필요.

### 6.4 네트워크 품질 의존

사용자가 remote 서버(Unity DevOps Cloud)를 쓰는 한, 모든 성능 수치는 네트워크 RTT에 비례. 로컬 repository(`cm replicate`)로 바꾸면 1회당 수백 ms로 떨어질 것이지만, 워크플로우 전환이 큰 결정.

---

## 7. 얻은 교훈

### 7.1 "로컬 재현 불가능하면 추측하지 말 것"

동시성 경합 버그를 찾기까지 URI 인코딩을 세 번 수정했다. 매번 사용자가 VSCode에서 테스트해줘야 해서 사이클이 길었다. 결국 `vscode-uri` 패키지로 **VSCode 없이 로컬에서 Uri 왕복 테스트**를 만들고 나서야 진짜 원인(`cm` lock)을 찾았다.

**원칙**: 추측이 2회 연속 틀리면 그때부터는 재현 환경을 먼저 만든다.

### 7.2 "같은 증상이 여러 원인에서 나온다"

"Multi Diff에서 파일이 통으로 새 파일처럼 나옴"은:
1. URI 인코딩 깨짐 (base64 `=` padding)
2. `fsPath` vs `path` 차이
3. workspace lock 경합으로 cm cat 실패

세 가지 다른 원인이 똑같은 증상을 냈다. 한 원인을 고치면 다른 원인이 드러나서 "고치니까 또 다른 게 깨진다"처럼 보였다. 실제로는 **연속된 독립 버그**였다.

### 7.3 "캐시 무효화는 데이터가 immutable이면 사라진다"

처음엔 "refresh 시점에 cache clear"로 넣었다. 이건 overthinking. SCM의 historical revision은 immutable이고, cache key에 revision 번호를 포함하면 **새 revision = 새 key = 자동 리프레시**. 옛 key는 그대로 남아도 틀리지 않음.

**원칙**: 무효화 타이밍이 복잡하게 느껴지면, 키 설계를 다시 보라. Immutable 키면 무효화가 사라진다.

### 7.4 "성능 분석은 분해해야 한다"

"Multi Diff가 20초 걸린다"를 들었을 때, 처음엔 추측으로 "캐시 히트니까 빠를 텐데"라고 답했다. 틀렸다. 실제로 시간을 분해하니:
- refresh (phantom filter): 10s
- Deleted provider 호출 (캐시 미스): 9s
- 합계 19s

**파일 타입별로 경로가 달랐다**는 걸 처음엔 못 봤다. Changed만 보고 일반화한 것. 성능 분석할 때는 경로마다 분해해서 각각 시간을 돌려봐야 한다.

### 7.5 "CLI 래퍼 성능의 상한선은 CLI 본체"

Plastic GUI가 빠른 건 영구 연결이 있기 때문. CLI를 감싼 확장이 GUI 수준 속도를 내려면 CLI 본체도 그 수준이어야 한다. `cm cat` 1회가 3초면 확장도 3초가 하한. **CLI 래퍼 확장의 성능 상한선은 CLI 본체**. 극복하려면 CLI의 사용법 자체(batch, shell mode)를 바꿔야 한다.

---

## 8. 가능한 후속 개선

우선순위 순서:

1. **디스크 영속 캐시** — 세션 간 warm 유지. 첫 refresh 16초를 0초로. 복잡도 중.
2. **`cm shell` interactive 모드** — 매 호출 3초 → 수백 ms 가능성. 복잡도 큼.
3. **Moved 파일 oldPath 복원** — `cm find` 또는 history로 조회. 사용자가 MV 많이 쓰면 필요.
4. **Binary 파일 처리** — provider를 arrayBuffer 기반으로.
5. **Multi-workspace 지원** — 현재는 첫 번째 Plastic root만. Unity multi-package 구조에서 필요할 수 있음.

지금은 사용자 1명(나 자신)의 실용 범위를 충족해서 멈춘 상태. 필요 생기면 재개.

---

## 9. 커밋 흐름 요약

주요 커밋 순서 (시간순):

```
d0b78b3  feat: 초기 구현
7f9a4f3  fix: 코드 리뷰 버그 5건 + 하위 폴더 workspace 탐지
8c7208d  docs: README + LICENSE
ca80641  feat: cm status 재설계 + phantom CH 필터 + 성능 최적화
038e003  refactor: 캐시 3종 전부 제거 — 단순성 우선
744e0f3  fix: plastic:// URI encoding을 단순 query param으로
348f549  fix: parsePlasticUri가 uri.path 사용 + 진단 로그
43c16b1  fix: cm 호출 세마포어 4개 제한 — workspace lock 경합 해결
2bcc449  feat: base content 캐시 (immutable, in-memory)
c713589  perf: Multi Diff 가속 — stale check + branch 캐싱
9e547ee  fix: in-flight refresh 대기 + branch fallback
675a57a  perf: Multi Diff 20초 지연 fix — Deleted prefetch + stale window 확대
```

12개 커밋 중 **fix/perf가 9개**. 구조적 첫 설계가 완전히 맞은 건 없었고, 사용자 피드백으로 시나리오마다 본질 원인을 찾아가며 수정했다. 이게 SCM 통합 같은 "레거시 시스템 래핑" 개발의 전형적 패턴이다.

---

*이 문서는 2026-04-11 하루 동안의 작업 기록이다. 상세 디자인 결정과 실측 수치는 각 커밋 메시지에 남겨두었다.*
