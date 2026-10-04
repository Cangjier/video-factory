# inspect / analyze 家族功能拆解

> **重组后注意（2026-10-04）**：本文写于工具重组之前。`video_analyze` 的 action 名与行为**未变**，但文中提到安装模型的地方（`install_audio` / `install_matte`）现属 **`video_setup`**，运行时的 `installWith` 字段也已改成 `video_setup {action:"install_*"}`。另：`video_analyze` 的 `duration` 键此前重复声明（只看得见 `matte_status` 的语义），重组中已合并为双语义说明。重组说明见 [../工具重组方案.md](../工具重组方案.md)。
>
> **三次变更（2026-10-04，OCR 迁出）**：`video_inspect` 的 **`ocr` / `find_text` / `ocr_status` 三个 action 与它们的全部参数已整体迁出**，现在是独立插件 **`dsh-ocr`**（`C:\Users\Admin\Documents\GitHub\dsh-ocr`，工具族 `text_*`）。`video_inspect` 只剩 `verify` 与 `media`；`video_env {action:"probe"}` 也不再报告 `ocr` 状态；`src/core/ocr.mjs` / `ocr-install.mjs` 与 `src/bin/ocr.ps1` 在本仓库已删除。本文下面这三节改写成了「已迁出到 dsh-ocr」小节，只作历史记录：**读文字与坐标用 `text_read {action:"read"}`，定位字符串用 `text_find {action:"find"}`，看引擎状态用 `text_setup {action:"status"}`，装引擎用 `text_setup {action:"install"}`。**

> 事实来源：`src/tools/inspect.mjs`、`src/tools/inspect-actions.mjs`、`src/tools/analyze.mjs`、`src/tools/analyze-actions.mjs`、`src/core/probe.mjs`、`src/core/sampling.mjs`、`src/core/matte.mjs`、`src/core/audio-events.mjs`；为把判定项写准，另读了 `src/core/deliver.mjs`（verify 的判定实现）、`src/tools/plan-actions.mjs`（plan/planData 解析）、`src/tools/shared.mjs`（工具外壳与输出渲染）、`src/core/plan.mjs`（estimatedDuration 与 plan 级 matte 块）、`src/core/ffmpeg.mjs`（stdout 上限语义）、`src/core/audio-install.mjs`、`index.mjs`（config 归一化）。
> `src/core/ws.mjs` 未被 inspect / analyze 任一模块引用（只被 `src/core/tts.mjs` 引用），故按任务约定未展开。
>
> 全局约定（两个工具共有）：参数对象由 `defineFamilyTool` 组装，`action` 必填、`additionalProperties: false`（`src/tools/shared.mjs:64-107`）；`cwd` 用于解析所有相对路径，缺省时用宿主的 `context.cwd`，再退化到 `process.cwd()`；一切结果通过 `TEXT_OUTPUT` 渲染，**若结果对象带顶层字符串 `text`，渲染结果就是那段 text，而不是 JSON**（`src/tools/shared.mjs:20-25`）——这条当年对 `video_inspect ocr` 有实际后果（见「已迁出到 dsh-ocr」一节的历史记录）。所有时间为秒，"实测"数字均来自代码注释/常量中记录的在本机测得的值。

## 工具 video_inspect

**定位**：对任意媒体做"事实测量"——流元数据、成片与计划的一致性；不做任何创作判断。
**何时用**：交付前最后一关 `verify`；拿到素材先 `media` 摸清规格。
**何时不该用**：想要更深的质量判定（响度、黑帧、冻结、字幕回流、MP4 box 顺序）→ 用 `video_qc`；想知道"画面里是什么"→ 用 `video_analyze sample_frames + extract` 出图再读图；要读图上的文字与坐标 → 独立插件 `dsh-ocr`（`text_read` / `text_find`）；要生成或修改视频 → `video_render` / `video_gen`。

### action: verify

- **用途**：把成片与它渲染所依据的 plan 对比，返回 `{ok, problems}`。"`problems` 为空"是唯一干净结果的判据，任何非空项都要转述给用户而不是掩盖（`src/tools/inspect.mjs:4-7`、`src/tools/inspect-actions.mjs:72-73`）。
- **参数**（`src/tools/inspect.mjs:37-102`；迁出后这个工具只剩 5 个字段：`action` / `target` / `paths` / `plan` / `planData` / `cwd`）：

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| `target` | string | 是 | — | 仅 verify/media 有效。要校验的成片，通常 `out/final.mp4`；相对路径按 `cwd` 解析 |
| `plan` | string | 二选一 | — | 仅 verify。plan.json 路径，经 `loadPlan` + `resolvePlanPaths` |
| `planData` | object | 二选一 | — | 仅 verify。内联计划对象；**优先级高于 `plan`**，经 `parsePlan` + `resolvePlanPaths`（相对路径按 `cwd`） |
| `cwd` | string | 否 | 宿主 cwd | 全局：相对路径的解析基准 |

迁出前 schema 里还有 `paths`（media/ocr 共用）、`needle`、`match`、`region`、`scale`、`engine`、`language`、`maxSideLen`、`minScore`、`frames`、`times`；其中只有 `paths` 还留着（media 用），其余随 `ocr` / `find_text` 一起走了。对 verify **静默忽略**，不报错。

- **行为细节**：
  - `target` 为空 → `video_inspect verify: 需要 "target"（要校验的成片路径）。`；文件不存在 → `video_inspect verify: 文件不存在：<绝对路径>`（`src/tools/inspect-actions.mjs:63-69`）。
  - plan 解析走 `planFrom`：`planData` 优先，其次 `plan`；两者都缺 → 抛 **`video_plan: 需要 "plan"…`**（错误前缀写成另一个工具名，是共用工具的遗留文案，`src/tools/plan-actions.mjs:75-77`）；计划结构非法 → `计划校验失败：…`。
  - 一次 `ffprobe` 得 `info`，然后 `verifyAgainstPlan(info, plan)` 给出 6 项判定（`src/core/deliver.mjs:47-76`）：
    1. **分辨率**：`info.width !== plan.width || info.height !== plan.height` → `分辨率是 WxH，计划要求 WxH`。注意 `info` 的宽高是**旋转后的显示尺寸**（`src/core/probe.mjs:110-125`：rotation 为 90/270 时宽高互换），编码尺寸另在 `codedWidth`/`codedHeight`。
    2. **帧率**：`|info.fps - plan.fps| > 0.5` → 报错。容差 0.5 fps。`info.fps` 优先 `r_frame_rate`，为 0 时才退回 `avg_frame_rate`（`src/core/probe.mjs:129`）→ 变帧率/异常容器可能取到瞬时帧率。
    3. **时长**：`expected = estimatedDuration(plan.scenes)`（各场景时长之和，逐边界减去 `effectiveOverlap` = min(转场时长, 本场景时长/2, 前一场景时长/2)，`src/core/plan.mjs:368-386`）；`tolerance = max(1, expected * 0.06)`；超差 → `时长是 X.XXs，计划估算 Y.YYs`。即 10 s 的片子容 ±1 s，60 s 容 ±3.6 s，2 min 容 ±7.2 s。
    4. **音轨**：`!info.hasAudio` → `成片没有音轨`。**纯静音成片一定被判问题**，哪怕计划里没有旁白与音乐。
    5. **像素格式**：`info.pixFmt !== 'yuv420p'` → `像素格式是 X，多数平台要求 yuv420p`。唯一被硬性要求的格式。
    6. **体积下限**：`floorBytes = max(1000, round(width*height*max(0.1,duration)*0.01/8))`（0.01 bit/像素·秒）；`sizeBytes < floorBytes` → `文件过小(…字节…合理下限是…字节)，可能渲染失败`。该下限只为抓空流/渲染失败，不评判压缩（`src/core/deliver.mjs:17-34`）。
  - 不启动引擎、不装模型、不改文件：纯 ffprobe + 算术。
- **输出**：`{ ok, problems: string[], target: <绝对路径>, video:{width,height,fps,duration,pixFmt,videoCodec,audioCodec,hasAudio,sizeBytes}, planned:{width,height,fps,sceneCount} }`。`videoCodec`/`audioCodec` 只是信息回显，不参与判定。
- **代价**：每调用 1 次 ffprobe；无模型、无内存峰值。是本族最便宜的动作，可以每次交付都跑。
- **失败与陷阱**：
  - `problems` 非空**不是异常**：工具正常返回 `ok:false`，需要自己讲清楚。
  - `verify` 只覆盖这 6 项，**不代表成片没问题**：响度、黑帧、冻结、字幕、封面/缩略图都要 `video_qc {action:"check"}`（`src/tools/qc.mjs:4-12` 明确把它自己定位成"完整的验收套件"，verify 是冒烟测试）。
  - 缺 plan 时的报错前缀是 `video_plan:`，容易被误读成另一个工具的问题。
  - 竖屏素材带 rotation 元数据时，plan 的宽高应当写旋转后的显示尺寸，否则分辨率一项必然报错。
  - 时长按 `plan.scenes` 估算而不是精确帧数，容器/编码器取整几毫秒内不算问题（`src/core/deliver.mjs:39-41`）。
- **典型用法**：`{ "action": "verify", "target": "out/final.mp4", "plan": "plan.json" }`
- **相邻动作**：`video_render build/deliver` 之后立即跑；不通过 → `video_qc check`（更细）或 `video_plan check/duration/diagnose`（回去改计划）。

### action: media

- **用途**：任意图片/视频/音频的流元数据，一次可给多个文件。
- **参数**：

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| `target` | string | 二选一 | — | 单个文件；与 `paths` 同时给出时两者都读，`target` 在前 |
| `paths` | string[] | 二选一 | — | 多个文件；空字符串元素被丢弃 |
| `cwd` | string | 否 | 宿主 cwd | 相对路径基准 |

- **行为细节**：所有路径 `resolve(cwd)` 后交给 `probeMany`，**串行**逐个 ffprobe；单个文件失败不中断整体，进 `skipped[{path, reason}]`（`src/core/probe.mjs:173-184`）。媒体类型由**扩展名**判定（`classify`，`src/core/probe.mjs:42-48`）：`.jpg/.png/.webp/…`=image，`.mp3/.wav/…`=audio，`.mp4/.mov/.mkv/…`=video，其它=`unknown`。`normalize` 把容器差异抹平：`duration` 依次取 format→video→audio 的 duration（静帧为 0）；`sizeBytes` 为 0 时退回 `statSync`；`fps` 解析有理数 `30000/1001`；`rotation` 同时识别 `tags.rotate` 与 `displaymatrix` side-data（`src/core/probe.mjs:72-139`）。
- **输出**：`{ items: <info>[], skipped: [{path, reason}], count }`。每个 `info` 含 21 个字段：`path, name, kind, duration, sizeBytes, hasAudio, hasVideo, width, height, codedWidth, codedHeight, rotation, fps, pixFmt, videoCodec, audioCodec, sampleRate, channels, bitRate, formatName, nbFrames`（`src/core/probe.mjs:115-138`）。
- **代价**：每文件一次 ffprobe（本地文件数十至数百毫秒，网络盘/坏文件更久）；无模型。`probe` 的 `run` 默认超时 30 分钟（`src/core/ffmpeg.mjs:114`）。
- **失败与陷阱**：
  - 两个参数都没给 → `video_inspect media: 需要 "target" 或 "paths"（一个或多个文件）。`
  - 不存在的文件**不报错**，而是进 `skipped`；要它响亮失败得用 `verify`（迁出前也可以用 `find_text`）。
  - `kind` 只看扩展名：改过名的 MP4 会得到 `kind: unknown`，但 `hasVideo`/`width` 仍可能正常。
  - 目录路径也会进 `skipped`（ffprobe 失败），不会被当成"没有文件"。
- **典型用法**：`{ "action": "media", "paths": ["raw/a.mp4", "assets/cover.png"] }`
- **相邻动作**：素材入库先 `media`（整目录用 `video_env {action:"scan"}`，它内部用 `streamProblems` 标问题，见 `src/core/materials.mjs:201`）；确认规格后再 `video_plan`。

### 已迁出到 dsh-ocr：原 `ocr` / `find_text` / `ocr_status`

**这三个 action 都不在本插件里了。** 它们连同 `region` / `scale` / `engine` / `language` / `maxSideLen` / `minScore` / `frames` / `times` / `needle` / `match` 这些参数、`config.ocr` 配置节、`src/core/ocr.mjs` / `ocr-install.mjs`、`src/bin/ocr.ps1` 与 `vendor/ocr/` 一起搬到独立插件 **`dsh-ocr`**（`C:\Users\Admin\Documents\GitHub\dsh-ocr`，工具族 `text_*`）：

| 当年在 `video_inspect` | 现在在 `dsh-ocr` |
| --- | --- |
| `ocr`：读图片/视频帧里的文字，每行带像素框与置信度 | `text_read {action:"read"}` |
| `find_text`：在一张图（或视频帧）里找文字，返回框与**中心点** | `text_find {action:"find"}` |
| `ocr_status`：零成本报告引擎装没装、是哪个、会不会退回 WinRT | `text_setup {action:"status"}` |
| `video_env {action:"probe"}` 附带的 `ocr` 字段 | 没有了；用 `text_setup {action:"status"}` |
| `video_setup {action:"install_ocr"}`（装/卸引擎） | `text_setup {action:"install"}` / `{action:"remove"}` |
| `video_qc {action:"subtitle_ocr"}` 与用例 `burned_in_readable` | `text_read {action:"verify"}` |

下面这些是**当年在本仓库实测/踩坑得到的结论**，留作历史记录（实现已随能力迁走，结论仍然成立，删掉就等于重新踩一遍）：

- **引擎选择与回退链**（当年的 `readText` → `recogniseOne`，`src/core/ocr.mjs:1112-1177`）：`preference = args.engine ?? config.ocr.defaultEngine ?? 'auto'`；`winrt` 只走 Windows 自带识别器；`local` 只用离线引擎、失败原样抛出；**`auto` 会把任何失败都吞掉并退回 WinRT**，同时在 `notes` 里写明原因。`auto` 的静默降级是最大的准确度陷阱——读出来的小字已经错了（`TypeScript`→`TvpeScript`、`执行`→`执 彳 亍`，`src/core/ocr.mjs:7-12`），`engine` 字段却只是变成 `"winrt"`。追求准确要显式 `local` 让失败暴露。
- **引擎定位顺序**（当年的 `resolveOcrEngine`）：`config.ocr.enginePath` → `vendor/ocr/<id>/`（顺序由 `config.ocr.source` → `SOURCE.json.active` → 第一个装了的决定）→ 深度 4 遍历 `vendor/ocr` → `PATH`。本机当时的 `active` 是 `rapidocr-json`。
- **引擎是常驻子进程**：stdin 一行 ASCII-only JSON `{"image_path": "…"}`（非 ASCII 一律 `\uXXXX` 转义），stdout 一行 JSON；同 `executable+args` 复用会话；空闲 120 s 自动退出以释放约 500 MB 常驻内存；初始化 60 s 超时；单次识别 180 s 超时，**超时会 kill 引擎**。
- **区域裁剪与放大**：滤镜链是**先 `crop=w:h:x:y` 再 `scale=iw*k:ih*k:flags=lanczos`**；`scale:"auto"` 的倍数 = `min(3, max(1, round(1000/长边*100)/100))`。**小字要先放大**才读得准。
- **坐标回映射（最容易错的地方）**：引擎报的是四点框，插件把它降成轴对齐矩形并**永远换算回调用方那张图的坐标系**——给了 `region` 要把偏移加回去，给了放大要把倍数除回去，**先除后加，顺序反了就是平方级偏移**；这个坑当年让点击落到别处，看起来像"输入注入失败"。行按 `y` 再 `x` 排序，`box` 保留四点（旋转文字用四点比矩形准）。
- **minScore 语义**：`score < minScore` 的行不进 `text`，`lines` 永远不筛；`score` 为 `null`（WinRT）的行始终计入 `text`。
- **视频抽帧**：先 probe 拿 duration，≤0 直接报错；`times` 给了就用过滤后的 `times`，否则 `count = max(1, min(24, round(frames ?? 4)))`、时间点取 `(duration*(i+0.5))/count`（刻意跳过片头，片头常是标题卡）；每帧一次 ffmpeg 抽帧，不做缩放。
- **单文件 `ocr` 的渲染陷阱**：单文件结果带顶层字符串 `text`，而 `TEXT_OUTPUT.render` 遇到这种结果**只输出那段 text**（`src/tools/shared.mjs:20-25`）→ 模型看到的就不是 JSON，`lines`/`box`/`score` 全部不可见；多文件分支才走 JSON。这是本仓库记录在案的缺陷 #14，随 action 一起迁走了。
- **`config.ocr` 里有过没有消费者的键**：`language` / `maxSideLen` / `scale` 在代码里从未被读取，而超时文案却让人去调 `config.ocr.maxSideLen`——真正管用的是**传工具参数 `maxSideLen`，或改用 `region`**。这条是本仓库记录在案的缺陷 #15，同样随 action 迁走。

要重新测量这些数字，在 `dsh-ocr` 里跑它自己的测试；本仓库既没有这段代码，也没有 `node src/bin/vf.mjs ocr` 这个子命令。

### 原 `find_text` 的两条可用性提醒（现属 `dsh-ocr`）

当年 `find_text` 的实测结论仍然值得记着，`dsh-ocr` 的 `text_find {action:"find"}` 是同一套读取选项：

- 匹配是**纯字符串包含/相等**，不做模糊匹配；实现上先做一次识别但**强制 `minScore: 0`**——匹配必须看到引擎产出的每一行，一行 0.4 分的文本如果正好是目标就是命中。命中按 `y` 再 `x` 排序，`best` 只是阅读顺序第一个，不保证是想要的那个（同名按钮的第二个要自己挑 `matches`）；要点击就用 `center`，旋转文字用 `box` 四点比 `x/y/width/height` 可靠。
- 没命中不是错误（`ok:false`），并在 `notes` 里附上完整的 `searched` 列表。**先看 `searched` 再改 needle**；常见原因是小字被整屏缩放读不出——这时先用 `region` 只截目标附近一块。多给几个 `needle` 不额外花钱（在已识别结果上做匹配）。

（拿到 `center` 之后要点击，属于桌面自动化：2026-10-04 起那部分在独立插件 `dsh-computer-use`，本插件不报告输入通道。）

### 原 `ocr_status` 的教训（现属 `dsh-ocr`）

- 它当年是零成本报告：只读磁盘、不启动进程、不读图片，返回引擎装没装、是哪一个、参数是什么、会不会退回 WinRT。
- **它证明的是"文件在"，不是"能跑"**——引擎二进制坏了、模型缺了，它仍可能报 `available:true`。要真验证就读一张小图（在 `dsh-ocr` 里是 `text_read {action:"read"}`）。
- 当年的代价是一次目录遍历（`vendor/ocr` 深度 4，单次 walk 上限 2000 个文件）。现在这两件事都在 `dsh-ocr` 的 `text_setup {action:"status"}` 里。

## 工具 video_analyze

**定位**：对已有素材做"测量或分离"——哪一帧值得看、声音是什么、主体怎么从背景里抠出来。每个动作只报告测量值或产出一个定义明确的产物，**不替你做任何选择**（`src/tools/analyze.mjs:30`）。
**何时用**：决定用哪些镜头之前先 `sample_frames`；要对齐音乐/找静音段用 `audio_events`；需要带 alpha 的素材且背景不是纯色时用 `matte`；不确定模型装没装、代价多大时先 `audio_status` / `matte_status`。
**何时不该用**：只想要元数据 → `video_inspect media`；想读画面上的文字与坐标 → 独立插件 `dsh-ocr`（`text_read {action:"read"}` / `text_find {action:"find"}`）；想整段视频抠像 → 用 plan 里场景的 `matte` 块（`video_analyze matte` 一次只算一帧）；背景是纯色/绿幕 → 用 `chroma_key`（精确且便宜得多）。

### action: sample_frames

- **用途**：把整段视频解码成廉价灰度代理，逐帧与前帧比较打分，挑出值得看的时刻，并给出每一帧被选中的**理由**。
- **参数**（`src/tools/analyze.mjs:37-144`）：

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| `target` | string | 是 | — | 要分析的视频；文件不存在显式报错 |
| `strategy` | `"adaptive"`\|`"uniform"`\|`"scene_change"`\|`"motion_aware"` | 否 | `"adaptive"` | 选帧策略，见下 |
| `probeFps` | number | 否 | 4（上限 30） | 每秒解码多少帧参与打分；越高越能抓到短事件、越贵 |
| `targetFps` | number | 否 | 1 | 安静段的回退节拍（每秒保留几帧），决定 `periodic` 的间隔 |
| `sceneThreshold` | number | 否 | 30 | 平均绝对亮度差（0-255）达到即算硬切；**硬切检测器，不是审美阈值** |
| `motionThreshold` | number | 否 | 5 | 算"值得采样的运动"的差值阈值；调低能抓慢摇也更容易吃噪点 |
| `minFps` | number | 否 | 0.25 | 保留节拍的**下限**：再安静也至少这么频繁留一帧（默认 → 4 s 一帧） |
| `maxFps` | number | 否 | 4 | 保留节拍的**上限**，防止一个多动作镜头刷满结果 |
| `maxFrames` | number | 否 | 2000 | 保留帧数的硬上限；同时决定解码缓冲上限（见代价） |
| `maxSide` | number | 否 | 640 | 抽出的 JPEG 长边像素；每张都是要人读的图，别开大 |
| `extract` | boolean | 否 | false | 只有**严格 `true`** 才落盘 JPEG 并回填路径 |
| `outDir` | string | 否 | `<PLUGIN_ROOT>/tmp/frames` | 抽帧输出目录；`matte` 也会读这个参数（schema 只写了 sample_frames） |
| `cwd` | string | 否 | 宿主 cwd | 相对路径基准 |

- **行为细节**：
  - 先 probe 取 duration，≤0 → `无法确定视频时长，不能采样：<path>`（`src/core/sampling.mjs:316-320`）。**静帧图不能采样**。
  - 解码：`ffmpeg -an -sn -vf fps=<probeFps>,scale=160:90 -pix_fmt gray -f rawvideo -`（`src/core/sampling.mjs:263-304`）。探测几何固定 **160×90**（14400 B/帧），不由工具参数暴露；`maxStdoutBytes = 14400 × (maxFrames + 1)`，**默认 28,814,400 B**。超限的语义是 kill + 抛错（`ffmpeg 的标准输出超过 … 上限，已终止（防止无界流耗尽内存）`，`src/core/ffmpeg.mjs:148-158, 187-196`），不是截断 → **默认设置下时长超过约 500 s（2001 帧 ÷ 4 fps）的视频会直接失败**。要处理更长的片子，同时抬高 `maxFrames`（缓冲上限随之变大）或降低 `probeFps`。
  - 打分：`sceneScore` = 相邻探测帧的**平均绝对亮度差**（0-255，`meanAbsoluteDifference`，`src/core/sampling.mjs:152-159`）；首帧没有前驱 → `sceneScore: null`、理由 `first_frame`（`src/core/sampling.mjs:170-176, 214-215`）。`motionScore` **恒等于** `sceneScore`（固定探测帧率下二者是同一个测量），代码里是同一个值赋两次（`src/core/sampling.mjs:242-243` 与 `notes`）。
  - 选帧三条闸门（`selectFrames`，`src/core/sampling.mjs:196-249`），`gap` 以**探测帧序号**计：
    `minInterval = max(1, round(probeFps/maxFps))`、`targetInterval = max(1, round(probeFps/targetFps))`、`maxInterval = max(1, round(probeFps/minFps))`。默认（probeFps 4 / maxFps 4 / targetFps 1 / minFps 0.25）→ **min=1、target=4、max=16**，即 0.25 s / 1 s / 4 s。
    判定顺序：首帧 → 保留（`first_frame`）；`gap < minInterval` → **连分数都不看，直接丢**；`gap >= maxInterval` → 保留（`max_interval_fallback`，优先级高于策略）；否则按策略：
    - `uniform`：`gap >= targetInterval` → `uniform`（**完全忽略分数**，固定节拍）
    - `scene_change`：`score >= sceneThreshold` → `scene_change`；否则 `gap >= targetInterval` → `periodic`
    - `motion_aware`：`score >= motionThreshold` → `motion`；否则 `gap >= targetInterval` → `periodic`
    - `adaptive`（默认）：`score >= 30` → `scene_change`；否则 `score >= 5` → `motion`；否则 `gap >= targetInterval` → `periodic`
  - **四种策略与选帧理由的区别**（任务重点）：
    - `scene_change` 理由 = 硬切/场景切换，差值 ≥ `sceneThreshold`（30）：换镜、闪白、大跳变。
    - `motion` 理由 = 有运动但没到切，`motionThreshold`(5) ≤ 差值 < `sceneThreshold`(30)：摇镜、人物走动、画面里出现/消失东西。`adaptive` 下这个标签也覆盖"中等变化"。
    - `periodic` 理由 = 这一段既没有切也没有运动，但离上一帧已超过 `targetFps` 的节拍（默认 1 s）：用于"安静也要有覆盖"。
    - `max_interval_fallback` 理由 = 更长时间的静止，触到 `minFps` 的兜底（默认 4 s 一帧），**与策略无关**。它出现得多，说明这段素材很静。
    - `first_frame` = 第一帧，永远保留（保证不会采样到空）。
    - `uniform` = `uniform` 策略专用，纯节拍。
    - `probe_rate_fallback` 在 `SELECTION_REASONS` 里声明了（`src/core/sampling.mjs:46-54`），但 `selectFrames` **从不产生它** → 出现这个值的代码路径在未证实（当前版本是死枚举值）。
  - `maxFrames` 在循环顶部检查，达到即停止（`src/core/sampling.mjs:207`）；`skipped = 探测帧数 − 选中帧数`（含被截断的那些）。
  - **抽帧**（只有 `extract:true`）：最多 **60 张**（`MAX_EXTRACTS`，`src/tools/analyze-actions.mjs:29, 137-138`），按 `report.frames` 顺序取**前 60**，多出的在 `extract.truncated` 报数（等于"被丢的帧数"）。每张：`ffmpeg -ss <at> -i src -frames:v 1 -vf scale=… -q:v 3`（`-ss` 在 `-i` 前，按关键帧定位，允许几十毫秒误差；注释明确帧是"给人看"而非帧精确，`src/tools/analyze-actions.mjs:58-88`），长边 = `maxSide`，单张超时 120 s。文件名 `{三位序号}_{秒_两位小数}s_{reason}.jpg`；单张失败不丢整次结果，该帧 `file: null` 且带 `error`（`src/tools/analyze-actions.mjs:152-156`）。路径是**就地写回** `report.frames[i].file` 的，第 61 张起没有 `file` 字段。
- **输出**：`{ path, duration, probe:{fps,width,height,decodedFrames}, strategy, thresholds:{sceneThreshold,motionThreshold,targetFps,minFps,maxFps,maxFrames}, frames:[{index, at, reason, sceneScore, motionScore, gapFromPrevious, file?, error?}], skipped, notes }`；`extract:true` 时追加 `extract:{directory, requested, written, truncated, maxSide, note}`（`src/tools/analyze-actions.mjs:159-170`）。`at` 是对解码帧的标称时间轴（`index/probeFps`），不是精确 PTS。
- **代价**：整片解码一次（160×90 灰度，本身便宜，但受 stdout 上限约束）；内存 ≈ 帧缓冲（14400 B × 解码帧数，默认封顶约 28.8 MB）+ 结果对象。抽帧每张一次 ffmpeg（≤60 次，120 s/张超时）。**不需要任何模型**，只需 ffmpeg。
- **失败与陷阱**：
  - `strategy` 非法 → `未知采样策略 "x"；可用：adaptive, uniform, scene_change, motion_aware`。
  - 所有数值必须为正：`probeFps 必须是正数…`（probeWidth/probeHeight 不暴露）；`probeFps` >30 → `probeFps 上限为 30，收到 N`；`maxFps < minFps` → 报错；`maxFrames` 至少 1。
  - **>500 s 的视频按默认参数必失败**（见上，不是截断）。
  - 分数只在**相同 `probeFps` 与相同探测尺寸**下可比（`notes`，`src/core/sampling.mjs:346-349`）；跨视频比阈值要先统一参数。
  - 传静帧图（时长 0）会报"无法确定视频时长"。
  - `extract: "true"`（字符串）不生效，必须是布尔 `true`。
- **典型用法**：`{ "action": "sample_frames", "target": "raw/take1.mp4", "strategy": "adaptive", "extract": true, "maxSide": 512 }`
- **相邻动作**：拿到 `extract` 出的 JPEG 后逐张当图片读（`read_image`）判断画面内容与构图——那是分值给不出的；用它决定 plan 里用哪些镜头；要对齐音乐节拍再跑 `audio_events`；只想知道时长/分辨率用 `video_inspect media`。

### action: audio_events

- **用途**：把 soundtrack 分类成 AudioSet 521 类声学事件，带每段的时间戳——转录回答"说了什么字"，它回答"这段是音乐、环境声、音效还是静音"，也就是"切点有没有落在拍子上"（`src/tools/analyze.mjs:33`）。
- **参数**：

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| `target` | string | 是 | — | 视频或音频文件；文件不存在显式报错 |
| `start` | number | 否 | 0 | 只分析从这个秒数起（ffmpeg `-ss`，放在 `-i` 之前） |
| `duration` | number | 否 | 到结尾 | 只分析这么多秒；与 `start` 配合可分段走长文件。**注意这个字段在 schema 里被声明了两次，见陷阱** |
| `topK` | number | 否 | 3 | 每段保留几个标签（先取前 K，再按 `minScore` 滤） |
| `minScore` | number | 否 | 0.1 | 分数低于此值的标签直接丢掉 |
| `silenceRms` | number | 否 | 0.002 | 窗内 RMS 低于它的段报为静音、不送模型 |
| `includeSegments` | boolean | 否 | true | `false` 时不返回逐段明细，只给分组后的 label→时间戳 映射（外加 `segmentCount`） |
| `cwd` | string | 否 | 宿主 cwd | 相对路径基准 |

- **行为细节**：
  - 可用性先行：`audioEventState()` 要求 4 个文件同时存在（`yamnet/yamnet.onnx`、`yamnet/yamnet_class_map.csv`、`runtime/.../ort.wasm.mjs`、`runtime/.../ort-wasm-simd-threaded.wasm`）**且类别表恰好 521 类**，否则直接抛 `音频事件检测尚未安装（缺少 …）…`（`src/core/audio-events.mjs:118-152, 516-518`）。
  - 抽音：`ffmpeg -ss <start> -i <src> -t <duration> -vn -map a:0? -ac 1 -ar 16000 -c:a pcm_s16le -f wav`（`src/core/audio-events.mjs:196-238`）。**`start` 在 `-i` 之前（输入侧定位，关键帧粒度）**，`duration` 在输入之后（输出侧）。无音轨的判据是"ffmpeg 退出码非 0 且产物缺失或 ≤44 字节（空 WAV 头）"→ `提取不到音频：这条素材可能没有音轨（<path>）。视频没有声音时无法做音频事件检测——转录同样不可用。`
  - 只接受 16 位单声道 PCM WAV，其它形状直接拒绝（`decodeWav`，`src/core/audio-events.mjs:250-286`）。
  - 时长上限 `MAX_AUDIO_SECONDS = 7200`（2 h），超了 → `音频时长 … 超过上限 7200 秒；请用 start/duration 分段分析。`
  - 分段几何：窗 **15360 样本 = 0.96 s**，hop **7680 = 0.48 s**，相邻段重叠一半（`YAMNET_WINDOW/HOP`，`src/core/audio-events.mjs:70-79, 310-327`）→ 每段 `at = 起点/16000`、`endAt = at + 0.96`，相邻 `at` 相差 0.48 s。比一个窗还短的音频 → `segments: []` + note `音频短于一个 0.96 秒分析窗，没有任何片段可分类。`
  - **静音判定**：对该窗算 RMS，**严格小于** `silenceRms` 才判静音（等于阈值仍会分类），静音段 `{silent:true, labels:[]}` 且**不送模型**（`src/core/audio-events.mjs:436-445`）。默认 0.002 ≈ −54 dBFS。判据是整窗 RMS，不看内容，所以很轻的音乐间隙也可能被算进去。
  - 分类：一窗一次推理，输出矩阵按行平均（这里每窗 1 行）→ 全类排序 → `labels = ranked.slice(0, topK).filter(score >= minScore)`（`topLabels`，`src/core/audio-events.mjs:341-362`）。**先截断再过滤**，所以 `labels` 可能少于 `topK`，甚至为空——而该段依然是 `silent:false`（一段有声但没有任何标签过阈值）。分数保留 4 位小数。
  - `topLabels` 另外算了 `peak`（最高分那一个），但 `classifySamples` 没有把它写进 `segments`（`src/core/audio-events.mjs:454-468`）→ 工具输出里**拿不到 `peak` 字段**。
  - `events`：`{ label: [时间戳…] }`，按遇到顺序累积（`groupEvents`，`src/core/audio-events.mjs:497-506`）——这是"音乐从第几秒开始"最易扫的形状。
  - `includeSegments:false` → 丢掉 `segments`、补一个 `segmentCount`（`src/tools/analyze-actions.mjs:202-205`）。
- **输出**：`{ path, wav: null(恒为 null), durationSec, segments:[{at, endAt, rms, silent, labels:[{label, score}]}], events:{label:[at…]}, soundtrack:{windows, classified, silent, durationSec}, notes }`；`includeSegments:false` 时把 `segments` 换成 `segmentCount`。
- **代价**：**实测每窗 68-81 ms**（`src/core/audio-events.mjs:377-380`），运行时首次加载约 300 ms（`src/core/audio-events.mjs:93`）；单线程 WASM、纯 CPU、无 GPU。60 s 素材约 125 窗 ≈ 8.5-10 s；2 h 上限对应约 15000 窗（数量级上的十几分钟推理，属算术推算）。依赖 `video_env {action:"install_audio"}`：模型 16,124,200 B + 类别表 14,096 B + 运行时约 13 MB（`src/core/audio-install.mjs:70-77`，`src/core/audio-events.mjs:8-9`），工具描述写作约 28MB。
- **失败与陷阱**：
  - `target` 缺失/不存在 → `需要 "target"（要分析的视频或音频路径）` / `文件不存在：<绝对路径>`。
  - 没装模型 → 先报 `audio_status` 能给的那条 reason，指向 `install_audio`。
  - `includeSegments` 只认 `false`；其余一律返回 `segments`。
  - `start`/`duration` 非有限数被**静默忽略**（不报错），可能让你以为在分析后段其实分析了全部。
  - **schema 里 `duration` 被声明了两次**（`src/tools/analyze.mjs:98-101` 给 audio_events，`138-142` 给 matte_status），JS 对象字面量后者覆盖前者 → 模型看到的 `duration` 说明**只有 matte_status 那段**；但 audio_events 照样把它当分析长度用。写调用时别被描述误导。
  - `topK` 只截不筛、`minScore` 只筛不截：想看"这段到底像什么"就抬高 `topK` 并降低 `minScore`；想只要强信号就抬 `minScore`。
  - 想找静音段：`silent:true` 是显式字段，但阈值是整窗 RMS；不要指望它区分"音乐停"和"整体很轻"。
- **典型用法**：`{ "action": "audio_events", "target": "raw/take1.mp4", "topK": 3, "minScore": 0.1 }`
- **相邻动作**：先 `audio_status` 看装没装；找到节拍后回到 `sample_frames` 让镜头落在拍上；"说了什么字"用 `video_narrate {action:"transcribe"}`，两者互补、不重叠。

### action: audio_status

- **用途**：零成本报告音频事件检测是否可用、装了什么、有多大，不分析任何东西。
- **参数**：无（处理器是 `async audio_status()`，**忽略全部参数**，`src/tools/analyze-actions.mjs:216`）。
- **输出**：
  - 不可用：完整 state `{ available:false, kind:null, missing:[…], classes:null, model, runtime, vendorDir, reason }` + `installWith: "video_env {action:\"install_audio\"}"`（`src/tools/analyze-actions.mjs:217-220`）。
  - 可用：`{ available:true, kind:"yamnet", classes:521, vendorDir, fileCount, totalBytes, modelBytes, runtimeBytes, model, runtime, scratchDir }`——**这一支不含 `missing`/`reason`**（`src/tools/analyze-actions.mjs:221-235`）。
- **代价**：读盘 + 目录统计；不加载模型、不起进程。
- **失败与陷阱**：它证明文件在，不证明能跑（真正的加载失败只有 `audio_events` 会暴露）；`available` 要求类别表**恰好 521 类**，类别表被改动会被判不可用；不可用分支指向 `install_audio`，那是安装全部三件套（模型 + 类别表 + 运行时）的动作。
- **典型用法**：`{ "action": "audio_status" }`
- **相邻动作**：`video_env {action:"install_audio"}` 安装；`video_env {action:"probe"}` 看更全的环境。

### action: matte

- **用途**：用学习模型把主体从**非纯色**背景里抠出来，输出带 alpha 的 PNG——一张图，或给 `at` 时的一段视频里的一帧。绿幕该走 plan 的 `chroma_key`（精确且便宜约三个数量级，`src/tools/analyze.mjs:35`）。
- **参数**：

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| `target` | string | 是 | — | 图片或视频；文件不存在显式报错 |
| `at` | number | 否 | — | 视频的第几秒取帧；**省略则把 target 当静帧处理** |
| `feather` | number | 否 | 0 | 合成前对遮罩做 `gblur=sigma=<feather>` 的像素级模糊；1-3 能让边缘像照片而不是贴纸 |
| `keepMask` | boolean | 否 | false | 保留中间灰度遮罩 PNG（在结果里给 `maskPath`），否则删除 |
| `name` | string | 否 | `"matte"` | 输出文件主干名；会被清洗为非 `[\w.-]` 一律替换为 `_` |
| `outDir` | string | 否 | `<PLUGIN_ROOT>/tmp/matte/out` | 输出目录。schema 描述只写了 sample_frames，但 matte 也读它（`src/tools/analyze-actions.mjs:258-260`） |
| `cwd` | string | 否 | 宿主 cwd | 相对路径基准 |

- **行为细节**：
  - 可用性：`matteState()` 要求 `vendor/matte/u2netp.onnx` 与**共用运行时**（`ort.wasm.mjs` + `ort-wasm-simd-threaded.wasm`）都在；缺模型提示 `install_matte`，只缺运行时提示 `install_audio`（`src/core/matte.mjs:94-119`，`src/tools/analyze-actions.mjs:300-308`）。抠图**复用音频那套 13 MB WASM 运行时**，自己不重复下载。
  - 模型几何固定：输入 `float32 [1,3,320,320]`，边长不是可调项（`MATTE_SIDE=320`，`src/core/matte.mjs:53-60, 83-84`）；输出 7 个 `[1,1,320,320]`，取**第 0 个（融合预测）**当 alpha，并做 min-max 归一化到 8 位（`normaliseMask`，`src/core/matte.mjs:180-193`）——这一步让它不依赖导出时的取值范围约定。
  - 解码：`ffmpeg [-ss at] -i src -frames:v 1 -vf scale=320:320 -pix_fmt rgb24 -f rawvideo`（`src/core/matte.mjs:267-301`）→ **非方形画面被压成 320×320 送进模型**；遮罩回贴时用 bicubic 拉伸回源尺寸（源宽高由 `probe` 得到，`src/core/matte.mjs:385-391`）。注释里的理由是"放大遮罩而不是缩小画面，否则丢掉用户想留的细节"（`src/core/matte.mjs:356-362`）。
  - 合成图：`[mask]scale=W:H:flags=bicubic[,gblur=sigma=feather],format=gray[m];[src][m]alphamerge,format=rgba`，输出 PNG（`src/core/matte.mjs:393-405`）。注意 mask 的缩放必须显式写到源宽高，否则 `alphamerge` 报 "Input frame sizes do not match"（`src/core/matte.mjs:382-384`）。
  - 统计与告警：`statistics = { foregroundRatio(>127 的像素占比), meanLevel, opaquePixels, totalPixels }`（`src/core/matte.mjs:205-218`）；`foregroundRatio < 0.005` 或 `> 0.995` → `warnings` 提示"遮罩几乎全为前景/背景，模型可能没找到主体，请先看这张 PNG"（`src/tools/analyze-actions.mjs:272-282`）。
  - `name` 清洗后拼成 `<outDir>/<stem>.png`，所以 `name: ""` 会写出 `<outDir>/.png`（`src/tools/analyze-actions.mjs:262-263`）。
- **输出**：`{ path(PNG), maskPath(keepMask:true 时给出，否则 null), side(320), width, height(源尺寸), inferenceMs(仅推理耗时), statistics:{…}, raw:{min,max}, feather, warnings:[…], notes:[…] }`。
- **代价**：**实测 2071 ms / 帧**（`src/tools/analyze-actions.mjs:318`；`src/core/matte.mjs:9-11` 写作 ~2.1 s/320×320 单线程 WASM）。多线程实测只有 **1.08×** 收益，所以刻意固定单线程、不做 worker 池（`src/core/matte.mjs:134-136`、`src/tools/analyze-actions.mjs:321`）。模型仅 4,574,861 B，但需要 `install_audio` 提供的运行时。**一次调用 = 一帧**：整段视频抠像必须走 plan 里场景的 `matte` 块（那边用 `mask_fps` 把代价显式化）。
- **失败与陷阱**：
  - `target` 缺失/不存在 → `需要 "target"（要抠图的图片或视频）` / `文件不存在：<绝对路径>`；模型或运行时缺失 → `MatteError` 被包成 `video_analyze matte: …`。
  - 用 `-ss` 输入侧定位取帧，`at` 有几十毫秒级误差（对"取一帧当素材"通常无所谓，对帧精确对齐不行）。
  - **纯色背景用它是浪费**：色键是过程式的精确颜色替换，工具描述称 chroma_key 便宜约 2000 倍（`src/tools/analyze.mjs:35`）——这个倍数在代码里**没有实测常量，未证实具体数字**；能证实的是量级差异（一个色键滤镜 vs 每帧 2.1 s + 4.36 MB 模型 + 13 MB 运行时）。
  - 同一镜头 **`chroma_key` 与 `matte` 互斥**，同时配置会报"两者都是把主体从背景里分离出来…请二选一：纯色背板用 chroma_key，其它用 matte"（`src/core/scene.mjs:206-207`）。
  - 输出 PNG 的尺寸是源尺寸；320 的模型精度靠 alpha 平滑而不是边缘锐度，**要锐利边缘先调 `feather`，不要期待换模型**。
- **典型用法**：`{ "action": "matte", "target": "shots/person.jpg", "feather": 2, "keepMask": true }`
- **相邻动作**：先 `matte_status` 看代价；整段视频 → plan 的 `scene.matte`（`mask_fps` 0.5-30、默认 8；`interpolate` 默认 `hold`；`feather` 0-24，`src/core/plan.mjs:179-198`）；纯色背板 → `scene.chroma_key`。

### action: matte_status

- **用途**：报告抠图模型装没装；给了 `duration` 时，回答调用方真正的问题——**这么做要花多久**，并在几个遮罩率之间列表（遮罩率由调用方选，工具只报告，不替你决定）。
- **参数**：

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| `duration` | number | 否 | — | 视频秒数；给了（且 >0）才计算 `cost`。**schema 里 `duration` 被声明两次**，最终展示给模型的是本条（matte_status）的说明，而不是 audio_events 的（`src/tools/analyze.mjs:98-101` vs `138-142`） |

- **行为细节**：
  - 不可用分支直接返回 `matteState()`：`{ available:false, model:false, runtime:false, runtimeDir, missing:[…], reason, bytes }` + `installWith`——缺模型给 `video_env {action:"install_matte"}`，只缺运行时给 `video_env {action:"install_audio"}（推理运行时由它提供）`（`src/core/matte.mjs:104-119`，`src/tools/analyze-actions.mjs:300-308`）。
  - 可用分支：`{ available:true, model, runtime, modelBytes, runtimeShared:true, runtimeDir, scratchDir, measuredMsPerMask: 2071, notes:[…] }`——这里 `model`/`runtime` 是布尔量 `true`（来自 `matteState()` 的磁盘判定），不是模型描述对象；`runtimeDir` 指向共用的 `vendor/audio`。notes 说明"抠图与音频共用同一个 WASM 运行时，所以抠图本身只占 4.36 MB"、"实测单帧约 2.1 秒（单线程 WASM，CPU），多线程实测仅 1.08x 所以不做线程池"（`src/tools/analyze-actions.mjs:309-323`）。
  - 给 `duration > 0` 时追加 `cost`：对 `maskFps ∈ [4, 8, 12, 30]` 各算一行——`masks = max(1, min(ceil(duration*maskFps), 900))`、`estimatedMinutes = masks*2071/1000/60` 保留 1 位小数（`src/tools/analyze-actions.mjs:326-336`，`planMasks` in `src/core/matte.mjs:433-461`）。另附 `costNote`（遮罩率越高过渡越顺、越慢；每个遮罩被保持到下一个遮罩出现，低遮罩率的代价是边缘跳动）与 `interpolationNote`（实测 blend 把柔边遮罩 48 帧里 7 帧变化提升到 42 帧，只多约 9 ms 滤镜时间，锐度只降 1.3% → **想平滑先调 `interpolate`，再考虑抬 `maskFps`**）。
- **输出**：见上三段；只有给 `duration` 时才有 `cost`/`costNote`/`interpolationNote`。
- **代价**：读盘 + 纯算术；不加载模型。`cost` 表本身免费。
- **失败与陷阱**：
  - `duration` 必须是有限正数；0、负数、非数字都**静默不给 `cost` 字段**（不报错，容易以为"没代价"）。
  - **masks 上限 900**（`MAX_MASKS`，`src/core/matte.mjs:68-69`）：30 fps 遮罩率下超过 30 s 就被截断（600 s × 30 fps 要 18000 个），而 `cost` 条目里**不含 `planMasks` 的 `notes`**，所以"已截断、真实遮罩率会低于所选"这件事在 cost 里看不到（`planMasks` 只在 `src/core/matte.mjs:446-450` 生成那条 note）。900 个遮罩 × 2.071 s ≈ **31 分钟推理**（此为算术推算，非代码常量）。
  - 它证明模型/运行时文件在，不证明能推理成功。
  - `INTERPOLATION_MODES` 只剩 `hold` 与 `blend`（`src/core/matte.mjs:547`）；曾试过的 `motion`（`minterpolate`）被实测否决：48 帧丢 37 帧、成本翻倍、锐度没有收益（`src/core/matte.mjs:543-545`）。
- **典型用法**：`{ "action": "matte_status", "duration": 12 }`
- **相邻动作**：拿到 cost 表后决定 plan 里场景的 `mask_fps`；再 `video_render build`；单帧试算用 `matte`。

## 附：调用决策速查（跨 action）

**从便宜到贵**：`audio_status` ≈ `matte_status`（读盘/算术，免费）< `verify`（1 次 ffprobe）< `media`（N 次 ffprobe）< `sample_frames`（整片解码一次，无模型）< `audio_events`（~70 ms/0.48 s 音频）≪ `matte`（~2.1 s **每帧**）。（迁出前的 `ocr_status` 同属"读盘免费"、`ocr` / `find_text` 是夹在 `sample_frames` 与 `audio_events` 之间的一次识别：WinRT ~0.2 s、rapid ~1.8 s/张；两者现在都在 `dsh-ocr`。）

**按意图选动作**：
| 想知道的 | 用 | 别用 |
| --- | --- | --- |
| 成片是否等于计划 | `video_inspect verify` | `video_qc check`（更细、更贵，是 verify 的超集场景） |
| 文件规格（宽高/时长/音轨/码率） | `video_inspect media` | `analyze` 任何动作 |
| 画面上的文字与坐标 | `dsh-ocr`：`text_find {action:"find"}`（要坐标）/ `text_read {action:"read"}` + `region` | 直接读图猜 |
| 文字能不能读准 | `dsh-ocr`：`text_setup {action:"status"}` → `text_read {action:"read", engine:"local"}` | `engine:"auto"`（会静默降级到 WinRT） |
| 视频里哪些时刻值得看 | `sample_frames`（+`extract`） | 自己按固定间隔抽帧 |
| 声音是什么、音乐从哪开始、哪段静音 | `audio_events` | 转录（它只给字，不给类别） |
| 主体抠出来做图层 | 非纯色 → `matte`（单帧）/ plan `scene.matte`（整段）；纯色 → `chroma_key` | 纯色背景上跑 `matte` |
| 抠像要多久 | `matte_status {duration}` | 直接跑 `matte` 试 |

**什么时候会不可用**：
- `ocr` / `find_text`（已迁出到 `dsh-ocr`）：没有离线引擎时 `engine:"local"` 直接失败；`auto` 退到 Windows 自带识别器，准确度下降但可用。这一段随能力迁走，`video_inspect` 不再涉及。
- `audio_events`：必须 `install_audio`（模型 + 类别表 + 运行时三件套齐全且类别表 521 类）；素材没有音轨也会失败。
- `matte`：必须模型（`install_matte`）+ 共用运行时（`install_audio`）。
- `sample_frames`：只需要 ffmpeg；但**默认参数下 >约 500 s 的视频会失败**，先抬 `maxFrames`。
- `verify` / `media`：只需要 ffprobe；`verify` 还需要一份合法的 plan。
