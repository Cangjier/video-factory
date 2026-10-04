# env 家族功能拆解

> **重组后注意（2026-10-04）**：本文写于工具重组之前。文中 `video_env {action:"install_ffmpeg" | "install_audio" | "install_matte"}` 现属 **`video_setup`**（当时还有第四个 `install_ocr`，见下面的三次变更），`video_env` 只保留 `probe` `presets` `scan`；错误文案里的 `video_env install_*` 前缀也相应改为 `video_setup install_*`。安装器本身的行为、参数语义与代价**未变**。重组说明与缺陷清单见 [../工具重组方案.md](../工具重组方案.md)，实时参考用 `video_guide {action:"tool", tool:"video_setup"}`。
>
> **二次变更（2026-10-04，能力迁出）**：本文记录的**输入通道部分已整体迁出**到独立插件 `dsh-computer-use`（`C:\Users\Admin\Documents\GitHub\dsh-computer-use`）。因此下列关于 `probe` 的描述已不再成立：`input` / `virtualHidVerified` 字段没有了，`video_env.probe` **不再移动真实指针**（原先的副作用随能力一起走），`components/vhfkey/`、`src/core/automation.mjs`、`src/bin/desktop.ps1`、`src/bin/interception-*.ps1`、`src/bin/driver-setup.ps1`、`vendor/interception/` 在本仓库已删除。安装动作仍属 `video_setup`，与本次迁出无关。
>
> **三次变更（2026-10-04，OCR 迁出）**：OCR 能力（离线引擎客户端 `src/core/ocr.mjs`、引擎安装器 `src/core/ocr-install.mjs`、`src/bin/ocr.ps1`、`vendor/ocr/`，以及工具层的 `video_setup {action:"install_ocr"}`）整体迁到独立插件 **`dsh-ocr`**（`C:\Users\Admin\Documents\GitHub\dsh-ocr`，工具族 `text_*`）。因此：`video_setup` 现在只有 `install_ffmpeg` / `install_audio` / `install_matte` 三个动作；`video_env {action:"probe"}` 的返回里**没有 `ocr` 字段了**；`source` / `archive` / `prune` / `remove` 这四个参数里，`prune` 随 `install_ocr` 一起消失，其余三个只服务 `install_audio` / `install_matte`。本文下面「### 已迁出到 dsh-ocr：原 `action: install_ocr`」一节只作历史记录；装引擎请用 `text_setup {action:"install"}`。

> 本文只记录代码里能证实的事实。无法从代码确认的写「未证实」并给出 `file:line` 依据。
> 涉及文件：`src/tools/env.mjs`、`src/tools/setup.mjs`、`src/tools/env-actions.mjs`、`src/tools/shared.mjs`、
> `src/core/env.mjs`、`src/core/install.mjs`、
> `src/core/audio-install.mjs`、`src/core/audio-events.mjs`、`src/core/matte-install.mjs`、
> `src/core/matte.mjs`、`src/core/materials.mjs`、`src/core/probe.mjs`、`src/core/plan.mjs`、
> `src/core/ffmpeg.mjs`。
> `src/core/ocr.mjs` / `src/core/ocr-install.mjs` / `src/core/automation.mjs` 均**已不在本仓库**
> （前两者迁到 `dsh-ocr`，后者迁到 `dsh-computer-use`），文中提到它们的地方都是历史记录。
> `src/core/audio-integrity.mjs` 未被 install / scan 引用（只被 `src/tools/audio-actions.mjs:29` 与测试引用），
> 故本文不展开。

## 工具 video_env

- **一句话定位**：环境与素材的事实报告器；只回答「这台机器能做什么」「我手上有什么素材」，不做任何创作决定（`src/tools/env.mjs:1-9`）。安装器不在这个工具里：重组后属 `video_setup`，OCR 安装器又随 OCR 能力迁到了 `dsh-ocr`。
- **什么时候该用**：
  - 任何渲染/生成动作之前，先 `probe` 确认 ffmpeg/ffprobe 成对可用（工具描述第一句就是这个用途，`src/tools/env.mjs:22`）。
  - 写 `plan.json` 之前 `scan` 一次素材目录，把「有多少图、多少视频、总时长、哪些是近似重复」变成事实再决定内容（`src/tools/env.mjs:26-27`）。
  - `probe` 报告 `audio.available === false` / `matte.available === false` 且你确实需要音频事件检测、抠图时，再调用 `video_setup` 里对应的 `install_*`。（`probe` 不再报告 OCR 状态。）
- **什么时候不该用**：
  - 不要用 `presets` / `scan` 的输出去替模型排序或挑选素材——代码明确不排序、不删减（`src/core/materials.mjs:1-6`、`src/tools/env.mjs:7`、`src/tools/env.mjs:27`）。
  - 不要为了「保险」反复调用 `install_*`：`install_ffmpeg` 的跳过判据只是目录存在（见下文陷阱），一次误判就是几百 MB。
  - 只想跑本地剪辑/配音/字幕时，不必装音频/抠图模型；缺这些模型不是 `problems`，只是 `notes`（`src/tools/env-actions.mjs:89-93`、`src/tools/env-actions.mjs:193-194`）。
- **参数模型（公共事实）**：**重组前** 7 个 action 共用同一个参数对象，`additionalProperties: false`，只有下面 10 个字段合法（`src/tools/shared.mjs:70-82`、`src/tools/env.mjs:33-66`）。**（2026-10-04 后）**`force` / `source` / `archive` / `remove` 随四个安装动作搬到了 `video_setup`，`prune` 随 `install_ocr` 一起消失，所以 `video_env` 现在只有 `root` / `recursive` / `dedupe` / `cwd` 四个字段。下面的表是迁出前的全量字段记录，每个 action 的参数表都完整列出这 10 个字段，并在「含义与取值」里标注本动作是否真的读它。
- **成本排序（下文各有依据）**：`presets`（0 进程） < `probe`（3 次 ffmpeg/ffprobe + 若干进程；迁出前还会真的动一下鼠标，现已不会） < `scan`（每文件 1 次 ffprobe；`dedupe:true` 时每张图再加 1 次 ffmpeg） < `install_matte`（4.36 MB） < `install_audio`（约 28 MB，代码描述值） < `install_ffmpeg`（几百 MB）。（`install_ocr` 的 70–80 MB 已随 OCR 迁出，见下文。）

### action: probe

- **用途**：报告这台机器能不能干活——ffmpeg/ffprobe 是否成对可用、版本与必需编解码器/滤镜是否齐全、vendored 构建是否存在、Ark key 与 TTS 配置、三个可选模型的安装状态、以及输入注入通道（虚拟 HID / Interception / SendInput）是否真的可用（`src/tools/env-actions.mjs:62-197`）。

- **参数**：

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| `action` | string | 是 | — | 固定 `"probe"`（enum 之一，`src/tools/env.mjs:32`）。 |
| `root` | string | 否 | 无 | **本动作忽略**；只有 `scan` 读它（`src/tools/env.mjs:34`）。 |
| `recursive` | boolean | 否 | `true` | **本动作忽略**；只有 `scan` 读它。 |
| `dedupe` | boolean | 否 | `true` | **本动作忽略**；只有 `scan` 读它。 |
| `force` | boolean | 否 | `false` | **本动作忽略**；schema 描述只写 install_ffmpeg / install_audio / install_matte，且这三个动作现在属 `video_setup`（`src/tools/setup.mjs:36-40`）。 |
| `source` | string | 否 | 无 | **本动作忽略**；schema 描述只服务 `install_audio` / `install_matte` 的 `remove`（`src/tools/setup.mjs:41-44`）。迁出前它还兼作 `install_ocr` 的引擎选择。 |
| `prune` | boolean | 否 | `false` | **本动作忽略**；**这个参数已经不存在了**——它唯一的使用者 `install_ocr` 随 OCR 能力迁出到 `dsh-ocr`，`video_setup` 的 schema 里没有它。 |
| `archive` | string | 否 | 无 | **本动作忽略**；schema 描述只写 install_audio / install_matte（`src/tools/setup.mjs:45-49`）。 |
| `remove` | boolean | 否 | `false` | **本动作忽略**；代码实际支持 audio / matte 两个（其中 `install_matte` 的 remove 未写进 schema 描述，见该节陷阱）。迁出前 OCR 也支持。 |
| `cwd` | string | 否 | 宿主传入的 cwd，兜底 `process.cwd()` | **本动作忽略**；`shared.mjs` 在派发前把 `context.cwd` 规范化（`src/tools/shared.mjs:100-104`）。 |

- **行为细节**：
  1. 二进制发现走三级优先：`config.ffmpegPath`/`ffprobePath` 显式路径（`existsSync` 才採用）→ `vendor/ffmpeg/bin/ffmpeg.exe`（Windows 名，非 Windows 为无扩展名）→ 手工遍历 `PATH` 的每个目录 `existsSync`（不 spawn `where`/`which`）（`src/core/env.mjs:45-61`、`src/core/env.mjs:22-23`）。
  2. `vendored` 来自 `vendoredBuild()`：只 `readdirSync('vendor/ffmpeg/bin')`，不校验可执行性（`src/core/env.mjs:123-131`）。
  3. 找到 ffmpeg 才执行 `versionOf`（`ffmpeg -version`，超时 15 s）+ `capabilitiesOf`（`ffmpeg -hide_banner -encoders` 与 `-filters`，各 20 s，`maxBuffer` 8 MB）（`src/core/env.mjs:77-117`）。`capabilitiesOf` 只在**白名单**里查找：encoders `libx264/libx265/aac`，filters `drawtext/subtitles/ass/zoompan/xfade/acrossfade/loudnorm/sidechaincompress/amix/atempo/gblur/tile/afade/concat`（`src/core/env.mjs:96-102`）。因此 `encoders`/`filters` 是「交集」，不是完整列表。
  4. 硬性 `problems` 只由 4 类构成：缺 ffmpeg、缺 ffprobe、缺必需 encoder（`libx264`、`aac`）、缺必需 filter（`zoompan`、`xfade`、`loudnorm`、`subtitles`）（`src/tools/env-actions.mjs:96-111`）。`libx265` 不在必需列表里。
  5. `ark.keyPresent` 是「`process.env[config.ark.apiKeyEnv]` 是非空字符串」（默认 env 名 `ARK_API_KEY`）（`src/tools/env-actions.mjs:78`、`index.mjs:90`）。
  6. 输入通道是**真的探测**而不是看文件在不在：`verifyVirtualHidInput()` 会读一次指针位置、把指针移动约 6% 屏幕宽/高、再读回、再移回原处，位移超过 3 像素才算失败（`src/core/automation.mjs:275-320`，容差 `<= 3` 在 `298` 行）。结论会缓存在进程内（`src/core/automation.mjs:322-323`）。`virtualKeyboardAvailable()` / `virtualMouseAvailable()` 会 spawn `components/vhfkey/out/vhfctl.exe probe`（60 s 超时，`src/core/automation.mjs:200-255`、`364-452`、`55`）；`driverAvailable()` 会 spawn `powershell.exe -File src/bin/interception-input.ps1 -Action probe`（30 s 超时，`src/core/automation.mjs:131-185`、`39-41`）。`sendInput` 是硬编码 `available: true`，不探测（`src/tools/env-actions.mjs:162`）。
  7. 幂等且基本确定性：读环境、跑只读命令；唯一的副作用就是第 6 条的指针位移（可见抖动），以及进程内缓存 verdict。

- **输出**（`src/tools/env-actions.mjs:67-196`）：
  - `ok`：bool，等价于 `problems.length === 0`（`194`）。
  - `problems[]`：仅上面 4 类硬性问题；`ok=false` 时另写一条 `logger.warn`（`195`）。
  - `ffmpeg`：`{found:false}` 或 `{found:true, path, version|null, encoders[], filters[]}`；`version` 是 `-version` 首个非空行，失败为 `null`。
  - `ffprobe`：`{found, path, version|null}`。
  - `vendored`：`{present, directory, files[]}`（只看 `vendor/ffmpeg/bin` 是否存在）。
  - `node`：`process.version`；`platform`：`"<platform> <arch>"`。
  - `presets[]`：**preset 名字数组**（`Object.keys(PRESETS)`），不是定义体（`74`）。
  - `ark`：`{baseUrl, apiKeyEnv, keyPresent, defaultModel}`；`defaultModel` 未配置时为 `null`（`index.mjs:92`）。
  - `tts`：`{provider:'edge', voice, requiresKey:false}`（`81-87`）。
  - `pathBudget`：数值，默认 200（`index.mjs:88`）。
  - `ocr`：**（2026-10-04 后）这个字段没有了**；迁出前它是 `ocrReport(config)` 的结果：`{vendored:{present,directory,engines[],files,sizeBytes}, configuredPath|null, prefer, winrtFallback, available, note}` 或 `available:true` 时替换为 `{kind,label,executable,source,args}`（当年的 `src/core/ocr.mjs:353-377`，代码已随能力迁到 `dsh-ocr`）。要问 OCR 引擎状态，用那边的 `text_setup {action:"status"}`。
  - `audio`：`audioEventState()`：`{available, kind, missing[], classes, model, runtime, vendorDir, reason}`；`available` 要求 4 个文件都在**且**类别表解析出正好 521 类（`src/core/audio-events.mjs:118-152`）。
  - `matte`：`matteState()`：`{available, model(bool), runtime(bool), runtimeDir, missing[], bytes, reason}`（`src/core/matte.mjs:94-119`）。
  - `virtualHidVerified`：`{works, detail}`，失败时 `detail` 内含具体坐标证据（`134-139`）。
  - `input`：`{transports, preference, virtualKeyboard{available,reason,note}, virtualMouse{...}, filterDriver{...}, sendInput{available:true,note}}`（`140-163`）；`transports = ['sendinput','driver','virtualkbd','virtualmouse']`，`preference = {mouse:['virtualmouse','driver','sendinput'], keyboard:['virtualkbd','sendinput','driver']}`（`src/core/automation.mjs:72`、`90-93`）。
  - `notes[]`：未设置 Ark key 的说明；迁出前还有虚拟 HID 不可用时的安装指引与 OCR 缺失时 `ocr.note` 的原文（`164-191` 是迁出前的位置）。

- **代价**：最多 4 次 ffmpeg/ffprobe 进程（15 s + 20 s + 20 s + 15 s 超时上限，`src/core/env.mjs:79/105/111`、`src/core/ffmpeg.mjs:236`）＋ 最多约 5 次 `powershell.exe`（`desktop cursor/screen/move/cursor/move`，单次 60 s 上限）＋ 1 次 interception 脚本（30 s）＋ 1–2 次 `vhfctl.exe`（60 s）。`-encoders`/`-filters` 输出最大 8 MB 各（`src/core/env.mjs:105/111`）。无网络下载、无磁盘写入。实测耗时**未证实**（代码里没有记录）。

- **失败与陷阱**：
  - 该动作几乎不抛错：缺失项被翻译成 `problems`/`notes`。真正的异常只可能来自底层 spawn 的意外错误。
  - **`notes` 会被覆盖**：先写入「虚拟 HID 不可用」的 note（`169-175`），随后若 `ark.keyPresent === false`，代码**直接重新赋值** `report.notes = ['未设置 ...']`（`177-181`），前一条被丢掉。迁出前只有 OCR 那条用的是展开追加（`189-191`）。因此「虚拟 HID 不可用 + 未设 ARK key」时你只会看到后一条。（这两条 note 的来源代码已分别迁到 `dsh-computer-use` 与 `dsh-ocr`。）
  - **`probe` 会移动真实鼠标指针**（约 6% 屏宽的一次位移再复位，`src/core/automation.mjs:287-305`）。在做屏幕自动化或录屏时调用它需要知道这一点。
  - 别把 `vendored.present === true` 当成「vendored ffmpeg 可用」：它只证明目录存在（`src/core/env.mjs:123-131`）。真正的可用性判据是 `ffmpeg.path` 是否指向 `vendor/ffmpeg/bin`。
  - `ffmpeg.version` 可能是 `null`（`versionOf` 吞掉所有异常返回 `null`，`src/core/env.mjs:82-85`），但 `problems` 不会因此变非空。
  - `encoders`/`filters` 是白名单交集：看不到某个编码器不代表 ffmpeg 没有它。
  - 未知 action 的兜底错误：`video_env: unknown action "<x>"; expected one of probe, presets, scan`（`src/tools/shared.mjs:86-89`）。迁出前这条文案还会列出四个 `install_*`（当时 `install_ocr` 在其中），现在安装动作在 `video_setup`，OCR 安装器在 `dsh-ocr`。

- **典型用法**：
```json
{ "action": "probe" }
```

- **相邻动作**：`probe` → 若 `problems` 非空且是缺 ffmpeg/ffprobe → `video_setup {action:"install_ffmpeg"}`；若 `audio.available === false` 且需要识别音乐/环境声 → `video_setup {action:"install_audio"}`；若 `matte.available === false` 且需要非纯色背景抠像 → 先 `install_audio`（补 runtime）再 `install_matte`。素材侧则接 `scan`；要读屏幕/图片上的文字或装 OCR 引擎，去独立插件 `dsh-ocr`（`text_read` / `text_setup`），本工具不再涉及。

### action: presets

- **用途**：返回画布预设表本身（宽高/fps/中文标签），供写 `plan.json` 时选 `meta.preset`。

- **参数**：

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| `action` | string | 是 | — | 固定 `"presets"`。 |
| `root` | string | 否 | 无 | **本动作忽略**（仅 `scan` 使用）。 |
| `recursive` | boolean | 否 | `true` | **本动作忽略**（仅 `scan` 使用）。 |
| `dedupe` | boolean | 否 | `true` | **本动作忽略**（仅 `scan` 使用）。 |
| `force` | boolean | 否 | `false` | **本动作忽略**（仅安装类使用）。 |
| `source` | string | 否 | 无 | **本动作忽略**（schema 描述只服务 `install_audio` / `install_matte` 的 `remove`）。 |
| `prune` | boolean | 否 | `false` | **本动作忽略**；该参数已不存在（随 `install_ocr` 迁出）。 |
| `archive` | string | 否 | 无 | **本动作忽略**（仅安装类使用）。 |
| `remove` | boolean | 否 | `false` | **本动作忽略**（仅安装类使用）。 |
| `cwd` | string | 否 | 宿主 cwd / `process.cwd()` | **本动作忽略**（仅 `scan` 使用）。 |

- **行为细节**：`presets()` 直接返回从 `plan.mjs` re-export 的同一个 `PRESETS` 常量对象（`src/tools/env-actions.mjs:42-47`、`203-205`）。定义只有一份，就是为了让「模型理解的 preset」和「渲染器理解的 preset」不可能分歧。

- **输出**：`{ presets: { <name>: { width, height, fps, label } } }`，当前键为：
  - `vertical-short` = 1080×1920@30「竖屏短视频 9:16」
  - `horizontal` = 1920×1080@30「横屏 16:9」
  - `square` = 1080×1080@30「方形 1:1」
  - `landscape-4k` = 3840×2160@30「横屏 4K」
  - `preview` = 640×360@24「快速预览」
  （`src/core/plan.mjs:20-26`）

- **代价**：纯内存对象返回。无进程、无 IO、无网络。确定性、无副作用。

- **失败与陷阱**：不会失败。注意与 `probe.presets` 的区别：`probe` 返回的是**名字数组**，这里返回**完整定义体**（`src/tools/env-actions.mjs:74` vs `204`）。

- **典型用法**：
```json
{ "action": "presets" }
```

- **相邻动作**：写 `plan.json` 之前调用；随后接 `scan`（素材）与 `video_plan {action:"check"}`。

### action: scan

- **用途**：把一个素材目录（或单个文件）变成结构化清单：每个图片/视频/音频的探测元数据、方向、近似重复标记（`duplicateOf`）、被跳过的文件及原因。**只报告、不挑选、不删除、不排序成"建议顺序"**（`src/core/materials.mjs:1-6`、`src/tools/env.mjs:26-27`）。

- **参数**：

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| `action` | string | 是 | — | 固定 `"scan"`。 |
| `root` | string | 是（本动作） | 无 | 要清点的素材目录或单个文件；非空字符串，否则抛错（`src/tools/env-actions.mjs:239-241`）。相对路径按 `context.cwd` 解析（`242`）。 |
| `recursive` | boolean | 否 | `true` | `false` 才关闭递归（判据是 `args.recursive !== false`，`src/tools/env-actions.mjs:245`）。关闭后子目录整体不进清单，也不进 `skipped`。 |
| `dedupe` | boolean | 否 | `true` | `false` 才关闭（判据 `args.dedupe !== false`，`246`）。关闭后所有 `hash`/`duplicateOf` 保持 `null`，`duplicates` 为空数组。 |
| `force` | boolean | 否 | `false` | **本动作忽略**。 |
| `source` | string | 否 | 无 | **本动作忽略**。 |
| `prune` | boolean | 否 | `false` | **本动作忽略**。 |
| `archive` | string | 否 | 无 | **本动作忽略**。 |
| `remove` | boolean | 否 | `false` | **本动作忽略**。 |
| `cwd` | string | 否 | 宿主 cwd / `process.cwd()` | 相对 `root` 的解析基准（`shared.mjs:101`）。 |

- **行为细节**：
  1. 收集：`collectFiles(root, {recursive})`。`root` 不存在 → `MaterialError('素材目录不存在：<abs>')`；`root` 是文件 → **直接返回该文件，不做扩展名过滤**（`src/core/materials.mjs:117`）；是目录 → 递归（仅当 `recursive !== false`）遍历，按名字忽略 `.ds_store` / `thumbs.db` / `desktop.ini`（均小写比较），扩展名 `classify()` 为 `unknown` 的也跳过（`21`、`128-143`、`src/core/probe.mjs:42-48`）。`readdirSync` 失败（无权限等）静默 `return`，该目录等于空（`123-127`）。
  2. 排序：文件按 `(kind, 小写 basename)` 排序，kind 顺序 image < video < audio；`skipped` 排序。目的是两次运行结果一致，不受目录枚举顺序影响（`147-154`）。
  3. 逐个 `probe(file, config)`（1 次 ffprobe，60 s 超时，`src/core/probe.mjs:149-161`、`src/core/ffmpeg.mjs:216`）。探测成功不等于可用：`streamProblems` 会因「扩展名不受支持」「没有视频流」「读不到画面尺寸(宽=0)」把文件移入 `skipped`（`src/core/probe.mjs:204-210`、`src/core/materials.mjs:196-205`）。音频文件不会触发「没有视频流」这一条（条件是 `!hasVideo && kind !== 'audio'`）。`probe` 抛错的文件同样进 `skipped`（`207-209`）。
  4. `dedupe !== false` 时，只对 `kind === 'image'` 的项计算 dHash：spawn ffmpeg，参数 `-v error -i <path> -vf scale=9:8:flags=area,format=gray -frames:v 1 -f rawvideo -`，输出按 `binary` 解码，取 72 字节，逐行 8 次左>右比较拼成 64 位 `bigint`；字节不足 72 或任何异常 → `null`（`src/core/materials.mjs:45-77`、`src/core/ffmpeg.mjs:111-160`）。**串行**执行（`for` + `await`，`214-218`）。
  5. 去重判定：只与**更早的**图片比较，Hamming 距离 `<= DUPLICATE_DISTANCE = 6` 即标记 `duplicateOf = 更早那张的路径`，命中即 `break`。因此不会形成链，重复项指向的是「第一个出现者」（`24`、`220-231`）。
  6. 输出前 `inventoryToJson` 会剥掉内部 `hash` 字段（`src/core/materials.mjs:251-266`）。
  7. 幂等/确定性：同一目录同样参数结果一致（有排序保证）；无写盘、无缓存。

- **输出**（`src/tools/env-actions.mjs:249`）：
  - `root`：绝对路径。
  - `counts`：`{total, images, videos, audio, skipped}`。
  - `images[]` / `videos[]` / `audio[]`：每项是 `probe` 的规范化结果（`path, name, kind, duration, sizeBytes, hasAudio, hasVideo, width, height, codedWidth, codedHeight, rotation, fps, pixFmt, videoCodec, audioCodec, sampleRate, channels, bitRate, formatName, nbFrames`，`src/core/probe.mjs:115-138`）**加上** `orientation`（`'portrait'|'landscape'|'square'|'unknown'`；音频或宽高为 0 时 `unknown`，`src/core/materials.mjs:164-168`）和 `duplicateOf`（无重复为 `null`）。
  - `duplicates[]`：`images` 中 `duplicateOf !== null` 的项（已剥 `hash`）。
  - `skipped[]`：`{path, reason}`；被忽略的系统文件名也会以 `reason:'扩展名不受支持'` 出现（原因串不准确，见陷阱）。
  - `totalDuration`：**只累加视频**时长的数字（秒）（`src/core/materials.mjs:246`）。
  - `summary`：中文多行摘要字符串，含目录、三类计数、视频总时长、竖/横图数量、重复图片条数、跳过文件数（`src/tools/env-actions.mjs:249`、`src/core/materials.mjs:273-288`）。

- **代价**：每个文件 1 次 ffprobe（超时 60 s，串行）；`dedupe:true` 时每张**图片**再加 1 次 ffmpeg（超时 30 s，串行，`src/core/materials.mjs:58`）。无网络。内存主要是每次子进程的输出缓冲；`scan` 不传 `onProgress`，没有进度回调开销。大目录的耗时≈文件数×单次探测时间；关掉 `dedupe` 可省掉图片那一半进程数。

- **失败与陷阱**：
  - `root` 缺失/空串 → `video_env: action "scan" needs "root" — the material folder to inventory.`（`src/tools/env-actions.mjs:240`）。
  - 目录不存在 → `video_env scan: 素材目录不存在：<abs>`（`MaterialError` 包成 `VideoFactoryError`，`251`、`src/core/materials.mjs:115`）。
  - 目录里一个可用媒体都没有 → `video_env scan: 素材目录里没有可用媒体：<abs>`（`src/core/materials.mjs:185`）。
  - **`root` 指向单个文件时不看扩展名**：一个 `.txt` 也会进入探测，最终只会出现在 `skipped` 里，并返回一个 `counts.total = 0` 的清单而不是报错（路径不同、行为不同，`src/core/materials.mjs:117`）。
  - `recursive: false` 时子目录里的文件不出现，也不出现在 `skipped` —— 容易被读成「目录是空的」。
  - `skipped` 的 `reason` 对 `.ds_store`/`thumbs.db`/`desktop.ini` 统一写成「扩展名不受支持」，与真实原因（按名字忽略）不符（`190`、`21`、`134-137`）。
  - `duplicateOf` 是**字符串路径**，不是索引；`duplicates` 与 `images` 是同一批对象的副本，按 `path` 关联更稳。
  - `dedupe:false` 时 `duplicateOf` 恒为 `null`，不要据此判断「没有重复」。

- **典型用法**：
```json
{ "action": "scan", "root": "materials/2026-spring", "recursive": true, "dedupe": true }
```
大目录只想快速摸底时：
```json
{ "action": "scan", "root": "materials", "recursive": false, "dedupe": false }
```

- **相邻动作**：`probe`（先确认 ffprobe 可用）→ `scan` → 人工/模型据清单写 `plan.json` → `video_plan {action:"check"}`。

### action: install_ffmpeg

- **用途**：`probe` 报告找不到 ffmpeg 时，把 BtbN 的 Windows GPL 静态构建下载并解包到 `vendor/ffmpeg/bin`（`src/tools/env-actions.mjs:207-230`、`src/core/install.mjs:320-356`）。

- **参数**：

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| `action` | string | 是 | — | 固定 `"install_ffmpeg"`。 |
| `root` | string | 否 | 无 | **本动作忽略**。 |
| `recursive` | boolean | 否 | `true` | **本动作忽略**。 |
| `dedupe` | boolean | 否 | `true` | **本动作忽略**。 |
| `force` | boolean | 否 | `false` | 本动作**读取**：`true` 时即使目录已存在也重新下载解包（`src/tools/env-actions.mjs:217`、`src/core/install.mjs:321-324`）。判据是严格 `=== true`。 |
| `source` | string | 否 | 无 | **本动作忽略**（schema 描述只服务 `install_audio` / `install_matte` 的 `remove`）。 |
| `prune` | boolean | 否 | `false` | **本动作忽略**。 |
| `archive` | string | 否 | 无 | **本动作忽略**——`install_ffmpeg` **没有**本地包入口（对比 `install_audio`/`install_matte`，`src/tools/env-actions.mjs:221-224`；迁出前的 `install_ocr` 也有）。 |
| `remove` | boolean | 否 | `false` | **本动作忽略**——代码里 `removeVendored()` 存在（`src/core/install.mjs:305-309`）但**全仓库无调用点**，所以视频工具层无法卸载 vendored ffmpeg。 |
| `cwd` | string | 否 | 宿主 cwd / `process.cwd()` | **本动作忽略**（无路径参数可解析）。 |

- **行为细节**：
  1. 先 `vendoredState()`：`vendor/ffmpeg/bin` 目录存在即 `present: true`，并累加其中文件大小（`src/core/install.mjs:287-299`）。`present && !force` → 直接返回 `{installed:false, reason:'已存在可用的 vendored 构建', ...before}`（`src/tools/env-actions.mjs:216-219`）。
  2. 下载：按顺序试 `ARCHIVE_CANDIDATES = ['ffmpeg-n9.0-latest-win64-gpl-9.0.zip', 'ffmpeg-master-latest-win64-gpl.zip']`，URL 形如 `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/download/<archive>`（tag 常量是 `latest`）（`src/core/install.mjs:130-139`、`328-337`）。
  3. HTTP 走自建 `httpFetch`：支持系统代理 CONNECT 隧道，**手动跟随 301/302/303/307/308 重定向最多 8 跳**（不跟重定向会下到 250 字节的跳转页；这是代码注释里写明的历史回归）（`src/core/install.mjs:48-61`、`27-47`）。单次请求 120 s 超时（`162`）。
  4. 落盘到 `vendor/ffmpeg/download.zip`，边下边算 SHA-256 并记录字节数（`161-185`）。
  5. 解包 `extractBinaries`：**把整个 zip 读进内存**（`readFile`），自己定位 EOCD（`PK\x05\x06`，最多回扫 66000 字节）、遍历中央目录，只写 base name 属于 `ffmpeg.exe`/`ffprobe.exe`/`ffplay.exe` 的条目；拒绝以 `/` 开头或含 `..` 的路径；只支持 method 0（stored）与 8（deflate），其他抛「不支持的压缩方式」；一个都没解出抛「压缩包里没有 …；下载的可能是错误的构建。」（`229-281`、`142`）。
  6. 写 `vendor/ffmpeg/SOURCE.json`：`{url, bytes, sha256, files, installedAt}`，删除 `download.zip`，返回 `{installed:true, url, bytes, sha256, files}`；action 再补 `state: vendoredState()`（`340-346`、`src/tools/env-actions.mjs:225`）。
  7. 两个候选都失败 → 删掉 scratch，抛 `InstallError`，消息列出每个候选的失败原因并给出手动放置 `ffmpeg.exe`/`ffprobe.exe` 的指引（`351-355`）。
  8. 幂等性：有源码标记没有校验哈希比对——**不做任何完整性校验**（对比音频/抠图都有 pinned sha256；迁出前的 OCR 安装器也有）。`force` 会重新下载覆盖。

- **输出**：`{installed, reason?, url?, bytes?, sha256?, files?, state}`；跳过时是 `{installed:false, reason:'已存在可用的 vendored 构建', present, directory, files, sizeBytes}`（`216-219`、`287-299`）。

- **代价**：工具描述写「需要网络和几百 MB」（`src/tools/env.mjs:28`）；**精确体积未证实**（存档大小只在安装后由 `bytes` 报告）。峰值内存 ≥ 下载 zip 大小（`extractBinaries` 整包 `readFile`，`src/core/install.mjs:230`）。磁盘：`vendor/ffmpeg/bin` 三个 exe + `SOURCE.json`（`download.zip` 结束后删除）。耗时量级取决于 GitHub 与代理链路，**未证实**。单请求超时 120 s，8 跳重定向。

- **失败与陷阱**：
  - 错误统一包成 `VideoFactoryError`：`安装 ffmpeg 失败：<InstallError.message>`（`227`）。
  - `InstallError` 文案包括：`下载失败 <status> <statusText>：<url>`、`下载响应没有内容：<url>`、`下载得到空文件：<url>`、`不是有效的 zip 文件：<path>`、`压缩包里的路径不可信：<name>`、`压缩包结构损坏（本地头缺失）：<name>`、`不支持的压缩方式 <n>：<name>`、`压缩包里没有 ffmpeg.exe / ffprobe.exe / ffplay.exe；下载的可能是错误的构建。`、`重定向次数超过 8 次，已中止：<url>`、`请求超时（<n> 秒）：<url>`（`src/core/install.mjs:60`、`113`、`163-164`、`183`、`232`、`255`、`259`、`269`、`278`）。
  - **最大陷阱：`present` 只等于「目录存在」**。手工 `mkdir vendor/ffmpeg/bin` 之后，之后所有不带 `force` 的调用都会返回「已存在可用的 vendored 构建」，而里面一个 exe 都没有（`src/core/install.mjs:288`、`src/tools/env-actions.mjs:217`）。
  - **没有哈希校验**：下载内容不会被比对到任何固定摘要，`sha256` 只是记录（`340-346`）。这与另外三个安装器语义完全不同，别假设它一样安全。
  - **无法通过工具卸载**：`remove` 传了也没用；`removeVendored` 无调用点。
  - `archive` 传了也没用——它不会读本地包。

- **典型用法**：
```json
{ "action": "install_ffmpeg" }
```
强制重装：
```json
{ "action": "install_ffmpeg", "force": true }
```

- **相邻动作**：`probe`（确认 `ffmpeg.found === false`）→ `install_ffmpeg` → 再 `probe` 确认 `ok:true` → `scan` / `video_render`。

### 已迁出到 dsh-ocr：原 `action: install_ocr`

**这个动作不在本插件里了。** 它连同 `source` / `archive` / `prune` / `remove` 的 OCR 语义、`vendor/ocr/` 与整条 7z 解包链一起搬到独立插件 **`dsh-ocr`**（`C:\Users\Admin\Documents\GitHub\dsh-ocr`，工具族 `text_*`）：装引擎用 `text_setup {action:"install"}`，卸载用 `text_setup {action:"remove"}`，看引擎状态用 `text_setup {action:"status"}`，读图片上的文字用 `text_read {action:"read"}`。`video_setup` 现在只有 `install_ffmpeg` / `install_audio` / `install_matte` 三个动作；`prune` 这个参数在本插件的 schema 里已经不存在。

下面保留的是当年在本仓库实测出来的**代价与坑**（实现已随能力迁走，结论仍然成立，删掉就等于重新踩一遍）：

| 项 | 实测值 |
| --- | --- |
| `rapidocr-json`（默认） | 引擎包 73,461,693 字节；解包约 95 MB，`prune` 后 44 MB；本机 1200×1013 截图 1.77 s/张，平均置信度 0.929；不要求 AVX |
| `paddleocr-ppocrv5` | 引擎包 80,109,123 字节；同一张图 15.9 s/张（约 9 倍慢），平均置信度 0.833；要求 AVX；**第三方构建** |
| 解包工具 | 首次另取 602,624 字节的 `7zr.exe`；解包子进程 15 分钟超时、stdout 缓冲最多 16 MB |

- **7-Zip / `7zr.exe` 的教训**：引擎包是 `.7z`，而 Windows 不装 7-Zip 就**没有任何工具能解 LZMA**（本机 `tar.exe` 直接报 `LZMA codec is unsupported`），所以安装器必须自带一个 `7zr.exe`。`7zr.exe` 的官方地址永远指向最新版，因此它的哈希**只记录不强制**（上游发版就把安装卡死，是比"哈希变了"更糟的失败）；**引擎包本身则按 pinned sha256 硬校验**，不匹配就拒绝安装。
- **本地包（`archive`）不等于免校验**：本地 `.7z` 照样算 sha256 并与 pinned 值比对；但**首次仍要联网**取 `7zr.exe`（`archive` 管不到它），而且该路径是按 `process.cwd()` 解析的，不是 `cwd` 参数。
- **安装会切换默认引擎**：manifest 里的 `active` 被设为刚装的 source，所以误装慢引擎之后需要显式卸载纠正，否则之后每次都付 9 倍时间。
- **卸载的破坏半径**：不带 `source` 卸载会删掉全部引擎**并连 `7zr.exe` 一起删**，下次安装要重新联网取。
- **`prune` 之后目录与 pinned 包不再逐字节一致**：pinned sha256 只覆盖引擎包本身，不覆盖解包后的目录，所以别指望 OCR 目录有逐文件哈希校验。

要重新测量这些数字，在 `dsh-ocr` 里跑它自己的测试与 `text_setup {action:"probe"}`；本仓库既没有这段代码，也没有 `install-ocr` / `ocr` 两个 CLI 子命令了。

### action: install_audio

- **用途**：安装音频事件检测所需的 YAMNet ONNX 模型 + `onnxruntime-web` WASM 运行时到 `vendor/audio/`，让 `video_analyze {action:"audio_events"}` 能识别音乐/环境声/音效（`src/tools/env.mjs:30`、`src/core/audio-install.mjs:1-22`）。也支持 `remove:true` 整体删除。

- **参数**：

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| `action` | string | 是 | — | 固定 `"install_audio"`。 |
| `root` | string | 否 | 无 | **本动作忽略**。 |
| `recursive` | boolean | 否 | `true` | **本动作忽略**。 |
| `dedupe` | boolean | 否 | `true` | **本动作忽略**。 |
| `force` | boolean | 否 | `false` | 本动作**读取**：`force !== true` 且「state 可用 + 校验无 mismatched/missing + checked>0」→ 跳过；否则全量（重）装（`src/core/audio-install.mjs:457-464`）。`remove` 分支忽略它。 |
| `source` | string | 否 | 无 | **本动作忽略**（schema 描述只服务 `install_audio` / `install_matte` 的 `remove`）。 |
| `prune` | boolean | 否 | `false` | **本动作忽略，且这个参数已不在 schema 里**（随 `install_ocr` 迁出）：这里的瘦身是硬编码在 `AUDIO_RUNTIME_PACKAGES` 的 `keep`/`prune`/`dropFiles` 里的，本来就不由参数控制（`97-145`）。 |
| `archive` | string | 否 | 无 | 本动作**读取**，映射到 `installAudio({modelArchive})`：指向本地 **`yamnet.onnx` 文件**，或**同时含 `yamnet.onnx` 与 `yamnet_class_map.csv` 的目录**。无论哪种，SHA-256 都按 pinned 值校验（`src/tools/env-actions.mjs:331`、`src/core/audio-install.mjs:420-438`、`483-489`）。**只能替换模型；运行时五个 npm 包没有本地入口**。 |
| `remove` | boolean | 否 | `false` | 本动作**读取**：整棵 `vendor/audio` 递归删除（`rmSync recursive`），这**包含与抠图共用的 WASM 运行时**（`src/tools/env-actions.mjs:318-326`、`src/core/audio-install.mjs:541-550`）。 |
| `cwd` | string | 否 | 宿主 cwd / `process.cwd()` | **本动作忽略**：`archive` 用 `resolve(args.archive)`，相对 `process.cwd()`（`src/tools/env-actions.mjs:331`）。 |

- **行为细节**：
  1. `remove:true`：目录不存在 → `{removed:false, reason:'本来就没有安装', ...}`；存在 → 整体删除 → `{removed:true, reason:'已删除', ...}`，并各自补 `state: audioEventState()`（`src/tools/env-actions.mjs:318-326`）。
  2. 安装前置校验（防拼写错误的 pin）：模型 `sha256` 必须匹配 `/^[0-9a-f]{64}$/`，运行时 `integrity` 必须匹配 `/^sha512-[A-Za-z0-9+/]+=*$/`，否则直接抛错（`src/core/audio-install.mjs:443-455`）。
  3. 跳过判据（`!force`）：`audioEventState().available === true` **且** `verifyInstalledAudio()` 的 `mismatched`/`missing` 都为空 **且** `checked > 0` → `{installed:false, skipped:true, verify, state}`（`457-464`、`audioEventState` 见 `src/core/audio-events.mjs:118-152`）。注意 `checked` 来自 manifest 记录的 `files[]`：**manifest 缺失或为空时 checked=0，于是会全量重装**。
  4. 模型两个文件各自：先删 scratch → 本地副本（`copyFileSync`）或 `download`（120 s 请求超时）到 `vendor/audio/.download/<name>.download` → 在 scratch 上算 SHA-256 比对 → 只在校验通过后 `writeFileSync(file.target, readFileSync(archive))`（二次落盘，保证半截文件不会污染已装好的树）→ `finally` 里无论如何删掉 scratch（`471-499`）。
  5. 运行时五个包各自：下载 tgz 到 `.download/`，用 `sriOf()` 算 `sha512-<base64>` 与 npm 的 `integrity` 逐字比对，通过后再 `tar -xzf <tgz> -C <dir> --strip-components=1 package/<keep...>` 只解出白名单成员，然后按扩展名/文件名做第二轮 prune（包根 `LICENSE` 与 `package.json` 永不删），最后删 tgz（`503-523`、`312-346`、`358-382`、`97-145`）。
  6. `writeAudioManifest()` 记录**磁盘上实际存在的**每个文件的 `{path, bytes, sha256}` 与 totals（不记录被请求但没产出的文件）（`255-295`）。
  7. `verifyInstalledAudio()` 只校验 manifest 里记录过的文件，返回 `{checked, mismatched[], missing[]}`（`224-243`）。
  8. 幂等：`force` 之外重复调用第二次会走跳过分支、零下载。确定性：pip 版本 `onnxruntime-web@1.22.0`、`flatbuffers@25.9.23`、`long@5.3.2`、`protobufjs@8.8.0`、`guid-typescript@1.0.9` 全部钉版本 + `sha512` 完整性（`97-145`）。

- **输出**：`{installed, skipped, model[], runtime[], verify, state, manifest}`（`src/tools/env-actions.mjs:334-340`、`src/core/audio-install.mjs:533`）。
  - `model[]`：每项 `{name, path, bytes, sha256}`（`492`）；`runtime[]`：`{name, version, integrity, files[], bytes, pruned}`（`519`、`345`）。
  - `verify`：`{checked, mismatched[], missing[]}`（`224-243`）。
  - `state` = `audioEventState()`：`{available, kind, missing[], classes, model, runtime, vendorDir, reason}`；`available` 需要 4 个文件齐备且类别表正好解析出 521 类（`src/core/audio-events.mjs:118-152`）。
  - `manifest`：`{model, runtime{packages[]}, modelFiles[], files[], totals{files,bytes,modelBytes,runtimeBytes}, verified, recordedAt}`（`262-290`）。
  - 另一个更详细的 `audioInstallState()`（含逐文件清单与 `modelBytes`/`runtimeBytes`）只被 `src/tools/analyze-actions.mjs:221` 使用，`video_env` 不返回它（`src/core/audio-install.mjs:200-214`）。

- **代价**：模型 `yamnet.onnx` 16,124,200 字节 + `yamnet_class_map.csv` 14,096 字节（`src/core/audio-install.mjs:65-80`）；运行时五个 tarball 的**下载体积未证实**，但解包体积有记录：`onnxruntime-web` 93,959,024 → 只留约 11.2 MB（注释 `88`），`protobufjs` 3,758,553，`flatbuffers` 288,122，`long` 139,458，`guid-typescript` 4,549。工具描述给的量级是「约 28MB，无 Python、无 GPU」（`src/tools/env.mjs:30`）。刻意不用 `onnxruntime-node`：解包 245.7 MB 且带多平台二进制（注释 `src/core/audio-install.mjs:18-20`）。需要外部 `tar.exe`（Windows 10 1803+，`393-397`）。磁盘：`vendor/audio/yamnet/` + `vendor/audio/runtime/node_modules/` + `SOURCE.json`（`.download` 每次清空）。全程串行下载。

- **失败与陷阱**：
  - **所有异常**（含普通 `Error`，不只是 `InstallError`）都被包成 `VideoFactoryError`：`安装音频事件检测失败：<message>`（`src/tools/env-actions.mjs:342`）。
  - 关键文案：`modelArchive 指向的路径不存在：<abs>`（`src/core/audio-install.mjs:424`）、`<name> 的 sha256 不匹配，已中止。\n  期望 …\n  实得 …\n下载可能被中断或被篡改；请重试，不要使用这个文件。`（`485-488`）、`<pkg>@<ver> 的完整性校验失败，已中止。\n  期望 …\n  实得 …`（`511-513`）、`无法运行 tar：…`、`tar 解包 <pkg> 失败（退出 <code>）：…`（`324`、`327`）、pin 格式错：`<name> 的 sha256 不是 64 位小写十六进制（收到 "…"）；拒绝安装，因为这样的校验不可能通过。`（`445-448`）、`<pkg> 的 integrity 格式不合法（收到 "…"）。`（`453`）。
  - **`remove:true` 会连带删掉抠图的运行时**：`vendor/audio` 整棵删除后 `matteState()` 变 `runtime:false`，抠图不可用（`541-550`、`src/core/matte.mjs:94-119`）。这是最容易误伤的一步。
  - **`archive` 只给 `.onnx` 文件时，类别表仍要联网下载**：`localFor()` 对 `classMap` 在「本地是文件」时返回 `null`，于是走下载分支（`432-438`）。要离线就得给**目录**（里面同时有 `yamnet.onnx` 和 `yamnet_class_map.csv`）。
  - `archive` 指向的目录里缺某个文件时**静默回退到下载**，不会报错（`436-437`）。
  - **运行时无法本地提供**：只接受 npm registry（`503-508`）；离线机器装不了音频事件检测。
  - `checked === 0` 会触发整树重装（manifest 被删/损坏时）：模型 16 MB + 五个包重下（`457-464`、`230`）。
  - 哈希只覆盖 manifest 记录过的文件；手工塞进去的额外文件不会被发现（`224-243`）。
  - `state.available` 还要求类别表能解析出**正好 521** 行数据——CSV 被改动/截断会让 `available:false` 而 `missing` 为空，此时 `reason` 会是 `null`（`src/core/audio-events.mjs:131-151`）。`missing` 为空但 `available` 为 false 是可能的组合，别只读 `missing`。

- **典型用法**：
```json
{ "action": "install_audio" }
```
离线机器上用手工拿到的模型目录（路径按**进程工作目录**解析）：
```json
{ "action": "install_audio", "archive": "D:\\offline\\yamnet" }
```
强制重装：
```json
{ "action": "install_audio", "force": true }
```

- **相邻动作**：`probe`（看 `audio.available`/`missing`）→ `install_audio` → `video_analyze {action:"audio_status"}` 或 `audio_events`。若要抠图而 `matte.missing = ['runtime']`，也是先 `install_audio`。

### action: install_matte

- **用途**：只装 4.36 MB 的 U²-Net 抠图模型到 `vendor/matte/`；推理运行时**故意不重复下载**，由 `install_audio` 提供（`src/tools/env.mjs:31`、`src/core/matte-install.mjs:1-13`）。也支持 `remove:true` 只删模型。

- **参数**：

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| `action` | string | 是 | — | 固定 `"install_matte"`。 |
| `root` | string | 否 | 无 | **本动作忽略**。 |
| `recursive` | boolean | 否 | `true` | **本动作忽略**。 |
| `dedupe` | boolean | 否 | `true` | **本动作忽略**。 |
| `force` | boolean | 否 | `false` | 本动作**读取**：`!force` 且「模型校验通过 **且** `matteState().runtime === true`」才跳过（`src/core/matte-install.mjs:119-125`）。 |
| `source` | string | 否 | 无 | **本动作忽略**。 |
| `prune` | boolean | 否 | `false` | **本动作忽略，且这个参数已不在 schema 里**（随 `install_ocr` 迁出）。 |
| `archive` | string | 否 | 无 | 本动作**读取**，映射到 `installMatte({modelArchive})`：指向本地 **`u2netp.onnx` 文件**（不是目录，代码用 `copyFileSync`）。SHA-256 同样按 pinned 值校验（`src/tools/env-actions.mjs:371`、`src/core/matte-install.mjs:127-151`）。 |
| `remove` | boolean | 否 | `false` | 本动作**读取**（虽然 schema 描述只写了 install_audio，代码里 matte 也实现了）：只删 `vendor/matte`，**保留共享运行时**（`src/tools/env-actions.mjs:357-365`、`src/core/matte-install.mjs:188-197`）。 |
| `cwd` | string | 否 | 宿主 cwd / `process.cwd()` | **本动作忽略**：`archive` 用 `resolve(args.archive)`，相对 `process.cwd()`（`src/tools/env-actions.mjs:371`）。 |

- **行为细节**：
  1. 先校验 pin 格式：`sha256` 不匹配 `/^[0-9a-f]{64}$/` → 抛 `MatteError`，不花任何下载（`src/core/matte-install.mjs:111-117`）。
  2. `!force` 时：`verifyInstalledMatte().ok && matteState().runtime` → `{installed:false, skipped:true, verify, state}`（`119-125`、`67-73`、`src/core/matte.mjs:94-119`）。
  3. 本地 `modelArchive` 不存在 → `MatteError('modelArchive 指向的文件不存在：<abs>')`（`130`）。
  4. 下载/拷贝到 `vendor/matte/.download/u2netp.onnx` → 算 SHA-256 → 不匹配抛 `MatteError`（含期望/实得/「不要使用这个文件」）→ 匹配才 `writeFileSync(MATTE_MODEL, …)` → `finally` 删 scratch（`132-160`）。下载走同一个 `download()`（120 s 请求超时）。
  5. 写 `vendor/matte/SOURCE.json`（`writeMatteManifest`）：模型 spec + 一个 `files[]` 记录 + `runtime:{shared:true, note}` + `recordedAt`（`79-94`）。
  6. 若 `matteState().runtime === false`，只打一条进度提示让调用者去跑 `install_audio`，**仍然返回 `installed:true`**（模型确实装好了）（`166-173`）。
  7. 幂等：模型已装且运行时在 → 零下载跳过。确定性：单文件 pinned sha256。

- **输出**：`{installed, skipped, verify, state, manifest}`（`src/tools/env-actions.mjs:374`、`src/core/matte-install.mjs:175`）。
  - `verify` = `verifyInstalledMatte()`：`{checked(0|1), ok, expected, actual|null}`（`67-73`）。
  - `state` = `matteState()`：`{available, model(bool), runtime(bool), runtimeDir, missing[], bytes|null, reason|null}`（`src/core/matte.mjs:94-119`）。注意 action 覆盖了 core 里的 `matteInstallState()`，所以返回值里没有 `installedBytes` 字段。
  - `manifest`：`{model{id,label,license,url,bytes,sha256,provenance[],provenanceWarning,input,output}, files[], runtime{shared,note}, recordedAt}`（`79-94`）。

- **代价**：4,574,861 字节（4.36 MB）一次下载；无额外运行时下载。外部依赖：`huggingface.co/Heliosoph/u2net-onnx/resolve/main/u2netp.onnx`（可能是 LFS，走重定向）（`src/core/matte.mjs:72-85`、`src/core/install.mjs:48-61`）。磁盘：`vendor/matte/u2netp.onnx` + `SOURCE.json`，`.download` 每次清空。耗时量级取决于该主机的带宽，**未证实**。

- **失败与陷阱**：
  - 错误统一包成 `VideoFactoryError`：`安装抠图模型失败：<message>`（`src/tools/env-actions.mjs:376`）。
  - 关键文案：`u2netp 的 sha256 不是 64 位小写十六进制（收到 "…"）；拒绝安装。`（`src/core/matte-install.mjs:114-116`）、`modelArchive 指向的文件不存在：<abs>`（`130`）、`u2netp.onnx 的 sha256 不匹配，已中止。\n  期望 …\n  实得 …\n下载可能被中断或被篡改；请重试，不要使用这个文件。`（`147-150`）。
  - **只缺运行时时调用 `install_matte` 是浪费**：跳过条件要求 `runtime === true`（`121`），所以运行时缺失时它会重新下载 4.36 MB 的模型，然后照样提示你去跑 `install_audio`。正确顺序是先 `install_audio`。
  - **`archive` 必须是文件**：`copyFileSync` 不接受目录（对比 `install_audio` 的 `archive` 可以给目录）。传目录时的具体错误文案**未证实**（会被包成 `安装抠图模型失败：…`）。
  - `remove:true` 与 `install_audio` 不同：它**只删模型**，`keptRuntime` 恒为 `true`，音频事件检测不受影响（`188-197`）。返回里 `reason` 是 `'已删除（共享运行时保留）'` 或 `'本来就没有安装'`（`src/tools/env-actions.mjs:363`）。
  - schema 的 `remove` 描述没提 matte，容易让人以为 matte 不能卸载——代码支持（`src/tools/env.mjs:61-64`）。
  - `verify.ok`（哈希对）与 `state.available`（模型 + 运行时都在）是两件事：前者可以为 `true` 而后者为 `false`（`src/core/matte.mjs:104-118`）。

- **典型用法**：
```json
{ "action": "install_matte" }
```
离线提供模型（路径按**进程工作目录**解析）：
```json
{ "action": "install_matte", "archive": "D:\\offline\\u2netp.onnx" }
```

- **相邻动作**：`probe`（看 `matte.missing`）→ 若 `missing` 含 `runtime` → `install_audio` → `install_matte` → `video_analyze {action:"matte_status"}` / `matte`。只想释放空间时 `install_matte {remove:true}`。

### 安装类动作的语义速查（最容易搞混的部分）

> 表里剩三个安装动作，都属 `video_setup`。原来的第四列 `install_ocr` 已随 OCR 能力迁到 `dsh-ocr`（那边的 `text_setup`），
> 它的 `source` / `archive` / `prune` 语义与实测代价见上面「已迁出到 dsh-ocr」一节，本插件不再有这些参数。

| 维度 | install_ffmpeg | install_audio | install_matte |
| --- | --- | --- | --- |
| `source` | 忽略 | 忽略（只在 `remove` 时选取删哪一个） | 忽略（只在 `remove` 时选取删哪一个） |
| `archive` | **忽略**（无本地入口） | 映射到 `modelArchive`：`.onnx` 文件**或**含两个文件的目录；只覆盖模型，**运行时要联网**（`audio-install.mjs:420-438`、`503-508`） | 映射到 `modelArchive`：**只能是 `.onnx` 文件**（`matte-install.mjs:137-139`） |
| `force` | 目录存在即跳过；`force` 重下（无哈希校验） | 校验通过即跳过；`force` 全量重下（模型 + 5 个包） | 模型校验通过**且运行时在**才跳过；`force` 重下模型 |
| `prune` | 忽略（**参数本身已不存在**） | 忽略（**参数本身已不存在**；瘦身硬编码在包表里） | 忽略（**参数本身已不存在**） |
| `remove` | **不支持**（`removeVendored` 无调用点） | 支持；删**整棵** `vendor/audio`（**连带抠图的运行时**） | 支持；只删模型，**保留共享运行时** |
| 完整性校验 | 无（只记录 sha256） | 模型 pinned sha256 + 运行时 npm `sha512` + 落地后逐文件校验 | 模型 pinned sha256 + 落地后校验 |
| 网络体积量级 | 几百 MB（描述值，精确未证实） | 约 28 MB（描述值：模型 16.1 MB + 运行时） | 4.36 MB |

**该用哪个 / 哪个更便宜**：`probe` 一次就能同时回答两件事（`audio.available` / `matte.available` 与 `missing`），所以永远先 `probe`，再按 `missing` 精确补装：`missing:['runtime']` → 装 `install_audio`（抠图与音频共用，一次搞定两个）；只需要音频事件 → `install_audio`；只需要抠图且运行时已存在 → `install_matte`。两者都不便宜，不要在 `available:true` 时再调 `install_*`（虽然会跳过，但 `install_matte` 在只缺运行时的情况下会白下 4.36 MB）。**读文字/装 OCR 引擎不在这个工具里**：那是 `dsh-ocr` 的 `text_read` / `text_setup`，`probe` 也不再报告它的状态。
