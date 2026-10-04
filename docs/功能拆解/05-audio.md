# audio 家族功能拆解

> **重组后注意（2026-10-04）**：本文写于工具重组之前，当时这 12 个 action 同属 `video_audio`。现在按用途拆成两个工具：**`video_audio_build`** = `tone` `assemble` `restore` `record`，**`video_audio_measure`** = `identify` `speech_map` `loudness` `levels` `integrity` `sync` `noise` `devices`。每个 action 的行为、参数语义与返回结构**未变**；变的是归属与「各自只声明自己用到的参数」。另外本文指出的三个「代码在用但 schema 未声明」字段（`tone` 的 `durationSeconds`、`restore`/`record` 的 `measure`、`restore` 的 `source`）已在重组中正式声明。重组说明与缺陷清单见 [../工具重组方案.md](../工具重组方案.md)。

## 工具 video_audio（重组后：video_audio_build / video_audio_measure）

**一句话定位**：`video_audio` 是音频的**测量仪 + 按显式参数造文件的机器**——12 个 action 只做两类事：读文件报数字（`identify`/`speech_map`/`loudness`/`levels`/`integrity`/`sync`/`noise`/`devices`），或按你给的每一个参数写出一个文件并把写出的文件**再测一遍**（`tone`/`assemble`/`restore`/`record`）。它从不说"这段声音好听"，也不替你选参数（`src/tools/audio.mjs:53-57`、`src/tools/audio-actions.mjs:2-13`）。

**何时用**：

- 拼一条**采样级精确**的音轨（逐段配音、多轨对齐）→ `assemble`，不要自己写 `concat` 或 `adelay`。
- 怀疑文件坏了、短了、缺帧 → `integrity`（`identify` 先看 declared vs decoded）。
- 判断"哪里响、哪里静、削没削波、响度差多少" → `loudness`（感知响度 EBU R128）与 `levels`（采样域事实）是两个不同问题，见各节。
- 噪声/工频/窄带峰定位 → `noise`；按确认过的那一项做显式修复 → `restore`。
- 两条同源录音对时 → `sync`；需要一台机器上真实麦克风 → `devices` + `record`。

**何时不该用**：

- 只想要"响度拉到 -14 LUFS"这类**归一化/ducking/淡入淡出**：本家族不做（源码里没有 `loudnorm`、`sidechaincompress`、`afade` 的实现；`loudness` 的 note 里只是提到 `loudnorm` 是别处的事，`src/tools/audio-actions.mjs:349`）。响度归一化在 `video_render` 的 finalize 阶段（`src/core/finalize.mjs:154` 使用 `loudnorm`）。
- 要按**声学类别**（音乐/语音/环境声）划分 → `video_analyze {action:"audio_events"}`，`speech_map` 的 note 自己就这么写（`src/tools/audio-actions.mjs:280-282`）。
- 要转写文本 → `video_narrate {action:"transcribe"}`，不属于本家族。
- 需要 >2 声道、或需要每段独立的滤镜/淡入淡出/变速：`assemble` 的滤波器图里没有这些（`src/core/audio-build.mjs:267-360`）。
- 要"自动判断该不该降噪/降多少"：`restore` 每一步都必须显式给参数（`src/core/audio-restore.mjs:68-169`）。

### 参数总表（schema 全字段 → 归属 action）

JSON Schema 定义在 `src/tools/audio.mjs:72-247`；`action` 与 `cwd` 是所有 action 共有的（`action` 由 `defineFamilyTool` 注入，`src/tools/shared.mjs:70-82`；`cwd` 见 `src/tools/shared.mjs:100-104`，缺省 `process.cwd()`）。下表是**全部**字段，一个不漏。

| 参数 | 类型 | 归属 action | 必填 | 默认 |
| --- | --- | --- | --- | --- |
| `action` | string（枚举 12 值） | 全部 | 是 | — |
| `cwd` | string | 全部 | 否 | 插件项目根 → 进程 cwd |
| `target` | string | identify / speech_map / loudness / levels / integrity / noise / sync / restore | 见各节 | — |
| `paths` | string[] | identify / loudness | 否（有 `target` 时可不给） | — |
| `kind` | enum sine/sweep/silence/white/pink/brown | tone | 否 | `sine` |
| `frequencyHz` | number | tone | 否 | 1000（sine 频率 / sweep 起点） |
| `sweepToHz` | number | tone | 否 | 20000 |
| `seed` | integer | tone | 否 | 1 |
| `levelDbfs` | number | tone | 否 | -3 |
| `bitDepth` | enum s16/s24/f32 | tone / assemble / restore（restore 用 `codec`，不用本字段） | 否 | `s16` |
| `clips` | object[] `{source, at, until?}` | assemble | 是（至少 1 段） | — |
| `totalSeconds` | number | assemble | 否 | 最后一段终点 + `tailSeconds` |
| `tailSeconds` | number | assemble | 否 | 0 |
| `overlap` | enum reject/sum | assemble | 否 | `reject` |
| `method` | enum concat/mix | assemble | 否 | 有重叠→`mix`，无重叠→`concat` |
| `sampleRate` | number | tone / assemble / sync（被忽略，见下）/ record / restore | 否 | tone·assemble 48000；record 48000；restore 保持源 |
| `channels` | number（1 或 2） | tone / assemble / record / restore | 否 | tone·assemble 2；record 1；restore 保持源 |
| `outPath` | string | tone / assemble / restore / record | 否 | 见各 action |
| `repair` | boolean | integrity | 否 | false |
| `repairPath` | string | integrity | `repair:true` 时必需（action 会推导默认值） | `<同目录>/<basename('.mp3' 去掉)>.repaired.mp3` |
| `noiseDb` | number | speech_map | 否 | -40 |
| `minSeconds` | number | speech_map | 否 | 0.25 |
| `clipThreshold` | number 0..1 | levels | 否 | 0.999 |
| `minClipSamples` | number | levels | 否 | 3 |
| `maxSeconds` | number | levels / sync | 否 | levels 600；sync 300 |
| `timeline` | boolean | levels / loudness | 否 | levels `true`；loudness `false` |
| `reference` | string | sync | 是 | — |
| `comparison` | string | sync | 是 | — |
| `maxLagSeconds` | number | sync | 否 | 5 |
| `windows` | number | sync | 否 | 5 |
| `mainsHz` | enum 50/60 | noise / restore | 否 | 50（noise 只回显，见陷阱） |
| `fftSize` | number（2 的幂） | noise | 否 | 8192 |
| `windowSeconds` | number | noise | 否 | 30（但回显 60，见陷阱） |
| `steps` | object[] | restore | 是（至少 1 步） | — |
| `codec` | enum pcm_s16le/pcm_f32le/aac | restore | 否 | `pcm_s16le` |
| `device` | string | record | 是 | — |
| `seconds` | number（≤3600） | record | 是 | — |
| `rtBufferMb` | number（≥8） | record | 否 | 64 |
| `durationSeconds` | number（正数） | **tone** | **是** | — |
| `measure` | boolean | restore / record | 否 | true |
| `source` | string | restore（`target` 的替代名） | 否 | — |

> **schema 缺口（重要）**：`durationSeconds`、`measure`、`source` 三个字段**代码在用、schema 里没有声明**（`durationSeconds`：`src/tools/audio-actions.mjs:117`，schema `src/tools/audio.mjs:72-247` 中不存在；`measure`：`audio-actions.mjs:553,606`；`source`：`audio-actions.mjs:536`），而 schema 是 `additionalProperties: false`（`src/tools/shared.mjs:81`）。宿主是否会因未声明字段先行拒绝**未证实**（仓库内 `defineFamilyTool.execute` 不做校验，`src/tools/shared.mjs:84-106`，但宿主侧校验行为不在本仓库）。若调用被 schema 校验挡下，`tone` 就没有合法路径，只能靠宿主放行——这是本家族最需要先验证的一点。

### 确定性契约（哪些是确定的，哪些不是）

- 除 `record` 外，所有 action 都是对 ffmpeg 的确定性调用；噪声信号必须给 `seed`（默认 1，`src/core/audio-build.mjs:45-46`）。
- 每个"写文件"的 action 都会把实际执行的命令回显：`args`、`filters`、`chain`、`inputs`（`src/core/audio-build.mjs:388,502-503`、`src/core/audio-restore.mjs:288`）。
- 产物自检：`tone`/`assemble` 用 `astats` 的 `Number of samples` 与期望采样数比较（`src/core/audio-build.mjs:381-405,473-494`）；`restore`/`record` 写完后重新 `astats` + `measureNoise`（`src/core/audio-restore.mjs:258-263`、`src/core/audio-record.mjs:217-221`）。
- "同一组参数产生逐字节相同的文件"是代码里的 **note 声明**（`src/core/audio-build.mjs:414`）与文档说法；测试只验证到 `sampleDelta === 0` 与电平误差 `<0.05 dB`（`tests/audio-actions.test.mjs:52-55`），**逐字节相同未证实**。

---

### action: tone

- **用途**：写一个**每个参数都写明**的测试信号（正弦、线性扫频、数字静音、白/粉/棕噪声），并回读验证。用于建标定素材、验证后续测量链路、造已知缺陷（满刻度削波、带限、50 Hz 哼声）。

- **参数**

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| `durationSeconds` | number | **是** | — | 时长（秒），必须 > 0；否则报 `video_audio tone: 需要 "durationSeconds"（正数，单位秒）。`（`audio-actions.mjs:117-120`）。**schema 未声明此字段** |
| `kind` | enum | 否 | `sine` | `sine`/`sweep`/`silence`/`white`/`pink`/`brown`；未知值报"未知的信号类型…可选：…"（`audio-build.mjs:89-92`） |
| `frequencyHz` | number | 否 | 1000 | sine 的频率 / sweep 的起点；必须 > 0 且 < 采样率/2（`audio-build.mjs:108-111`） |
| `sweepToHz` | number | 否 | 20000 | 仅 `kind:"sweep"`；必须 > 0 且 < Nyquist（`audio-build.mjs:125-127`） |
| `seed` | integer | 否 | 1 | 仅 white/pink/brown：`anoisesrc` 的种子，决定字节（`audio-build.mjs:103,138`） |
| `levelDbfs` | number | 否 | -3 | 标称电平；实现为全刻度信号后接一个 `volume=<n>dB`（`audio-build.mjs:144`）。`kind:"silence"` 时该值不施加（仍会回显） |
| `sampleRate` | number | 否 | 48000 | 生成采样率 |
| `channels` | number | 否 | 2 | 只允许 1 或 2，其它报"只支持 1 或 2 声道"（`audio-build.mjs:63-67`） |
| `bitDepth` | enum s16/s24/f32 | 否 | `s16` | 映射到 `pcm_s16le`/`pcm_s24le`/`pcm_f32le`（`audio-build.mjs:55,104-107`） |
| `outPath` | string | 否 | `<cwd>/audio/tone-<kind>[-<f>hz 或 <f>to<f2>hz]-<dur>s-<sr>hz-<n>ch[-<level>db]-<bitDepth>.wav` | 默认名由 `slug()` 拼接：非法字符被删、片段以 `-` 连接（`audio-actions.mjs:43-49,127-139`）。注意负数电平会拼出双连字符，例如 `tone-sine-1000hz-2s-48000hz-2ch--3db-s16.wav`；`silence` 不含电平段 |

- **行为细节**
  - `sine`/`sweep` 用 `aevalsrc` 表达式生成，**不用** ffmpeg 的 `sine` 源：注释明确说本机 `sine` 源输出约低 18 dB，用表达式才让 `levelDbfs` 说了算（`audio-build.mjs:119-122`）。扫频是线性 chirp：`sin(2π(f0·t + (f1-f0)/(2T)·t²))`（`audio-build.mjs:129`）。
  - `silence` 用 `anullsrc`，且不接 `volume`（`audio-build.mjs:133-136,144`）。
  - 噪声用 `anoisesrc=color=<kind>:amplitude=1:r=..:d=..:seed=<seed>`（`audio-build.mjs:138`）。
  - 命令形状：`-f lavfi -i <源> [-af volume=<n>dB] -ac N -ar SR -c:a <codec> <outPath>`（`audio-build.mjs:145-151`）。
  - 写完立刻重新探测 + `astats`，比较 `decodedSamples` 与 `round(duration×sampleRate)`（`audio-build.mjs:376-405`）。`astats` 用 `-v info -nostats`（`audio-measure.mjs:198-202`）。
  - 采样率处理：全程无重采样，`-ar` 就是生成率；`resolved.sampleRate` 取回读到的值（`audio-build.mjs:380`）。

- **输出**：`action`、`path`、`kind`、`args`（字符串数组）、`source`（lavfi 源串）、`resolved{sampleRate,channels,codec,bitDepth,durationSeconds,levelDbfs,frequencyHz,sweepToHz,seed}`、`written{bytes,declaredSeconds,decodedSeconds,expectedSeconds,sampleDelta}`、`measured{peakDbfs,rmsDbfs,dcOffset,peakCount,decodeErrors}`、`note`（`audio-build.mjs:384-415`）。`sampleDelta === 0` 是"时长精确"的判据；`measured.peakDbfs` 与 `levelDbfs` 的差就是电平误差。

- **代价**：一次 ffmpeg 编码（timeout 10 分钟，`audio-build.mjs:376`）+ 一次探测 + 一次 `astats`；**写文件**。文件大小 ≈ 时长 × 采样率 × 声道 × 位深字节（s16=2、s24=3、f32=4）+ 头。比实时快得多。

- **失败与陷阱**
  - 漏 `durationSeconds`：`video_audio tone: 需要 "durationSeconds"（正数，单位秒）。`（`audio-actions.mjs:119`）。**而 schema 里没有这个字段**——先确认宿主是否放行未声明字段，否则这个 action 无法调用。
  - 频率到或超过 Nyquist：`frequencyHz <f> 达到或超过奈奎斯特频率 <sr/2>，无法生成。`（`audio-build.mjs:109-111`）；扫频终点同理（`125-127`）。它拒绝而不是混叠。
  - 未知 `kind`/`bitDepth`/`channels` 都是显式报错（`89-92`、`104-107`、`63-67`）。
  - `levelDbfs: 0` 会生成满刻度信号，`levels` 会把它报成削波——这是有意的（`tests/audio-actions.test.mjs:64-87`）。
  - 用 `sine` 源"设置 -6 dBFS"的坑在实现里已绕开，但**别的工具**（自己写 lavfi）仍会踩：本机 `sine` 源低约 18 dB（`audio-build.mjs:119-121`）。

- **典型用法**
  ```json
  { "action": "tone", "kind": "sine", "frequencyHz": 1000, "durationSeconds": 2,
    "sampleRate": 48000, "channels": 1, "levelDbfs": -6, "bitDepth": "s16" }
  ```

- **相邻动作**：`levels`/`loudness` 验证电平；`assemble` 把它当片段；`identify` 看带宽；`restore` 的输入。

---

### action: assemble

- **用途**：把若干音频片段放到**同一条时间轴上、以采样点为单位**，写出结果并解码回读验证。这是"逐段配音拼成一条音轨"的正式做法。

- **参数**

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| `clips` | object[] | **是** | — | 每项 `{source, at, until?}`；`source` 必须存在，`at` 必须为有限非负数；`until` 可选，是"只用这段的前 until 秒"（`audio-actions.mjs:170-185`） |
| `clips[].at` | number | 是 | — | 起点（秒）；内部 `round(at×sampleRate)` 成采样点（`audio-build.mjs:199`） |
| `clips[].until` | number | 否 | 该片段自身时长 | 只截尾、不截头；`>片段时长` 报错（`audio-build.mjs:192-198`） |
| `clips[].source` | string | 是 | — | 任意可解出音轨的文件；滤波器图取 `[N:a]`，所以**视频文件也可作源**（`audio-build.mjs:316`） |
| `totalSeconds` | number | 否 | `requiredSeconds + tailSeconds` | 目标总长；`requiredSeconds` 由 action 按 `max(at + min(until, seconds))` 算出（`audio-actions.mjs:196-202`） |
| `tailSeconds` | number | 否 | 0 | 未给 `totalSeconds` 时在末尾留的余量 |
| `overlap` | enum reject/sum | 否 | `reject` | 重叠时"拒绝"或"相加"（`audio-build.mjs:177-180,231`） |
| `method` | enum concat/mix | 否 | 有重叠→`mix`，无重叠→`concat`（`audio-actions.mjs:216`） | `concat` 采样精确且拒绝超时线；`mix` 用 `amix` 求和 |
| `sampleRate` | number | 否 | 48000（取整） | 时间线采样率；所有片段 `aresample` 到该率（`audio-build.mjs:316`） |
| `channels` | number | 否 | 2（取整） | 只允许 1/2（`audio-build.mjs:273` + `63-67`） |
| `bitDepth` | enum s16/s24/f32 | 否 | `s16` | 输出 PCM 编码（`audio-build.mjs:453`） |
| `outPath` | string | 否 | `<cwd>/audio/timeline.wav`（每次调用**同一个名字**，`audio-actions.mjs:217-220`） | 输出文件 |

- **行为细节**
  - **放置到采样点**：先在 `planPlacements` 里把每段换算成 `atSamples`/`samples`/`endSamples`（`audio-build.mjs:184-213`），再据此生成滤波器图。**不用 `adelay`**：模块首注释说明毫秒级 `adelay` 每次拼接差若干采样，十几段后成为可听偏移（`audio-build.mjs:7-11`、`508`）。
  - **图的结构**（`audio-build.mjs:267-360`）：
    - 输入 0 是一条**覆盖整条时间线的 `anullsrc`**；每个前导静音/空隙都用 `atrim=start_sample=0:end_sample=N` 从它身上按采样切出来（`280,301-307`），静音因此不需要额外输入、也不需要毫秒取整。多个静音段时用 `asplit` 分叉（`291-297`）。
    - 每个片段：`[N:a]aresample=<rate>,aformat=sample_fmts=fltp:channel_layouts=<layout>,asetpts=PTS-STARTPTS[,atrim=end_sample=<samples>,asetpts=PTS-STARTPTS]`（`313-317`）。`until` 只体现为 `end_sample`，**头部永远是 0**。
    - `concat` 模式：按 `at` 排序后，缺的空隙插静音片、其余直接 `concat=n=..:v=0:a=1`（`322-335`）。
    - `mix` 模式：每段先与自己的前导静音 `concat` 成一条"放到位的"流，再用 `amix=inputs=N:normalize=0:duration=longest` 求和（`336-356`）。`normalize=0` 表示**不做 1/N 衰减**，重叠处就是相加（可能过载）。
    - 收尾统一 `apad=whole_len=<totalSamples>,aformat=sample_fmts=fltp`，命令再带 `-t totalSeconds`（`358,466`）。
  - **采样率处理**：所有片段 `aresample` 到时间线采样率；内部全程 `fltp`；输出 `-ar` 显式指定（`458-468`）。
  - **重叠判定**：把 placements 按 `atSamples` 排序后，**只比较相邻两项**：`previous.endSamples > next.atSamples` 才算重叠（`audio-build.mjs:215-227`）。`buildable = 无重叠 || overlap==='sum'`；`fits = requiredSamples <= totalSamples`（容差 0，`229-232,52`）。
  - **执行前守卫**（`assembleAudio`）：`!buildable` → 报"有 N 处片段重叠，而 overlap 策略是 reject…要么把起点错开，要么显式传 overlap:"sum"。"（`439-445`）；`method==='concat' && !fits` → 报"按 concat 装配时片段会超出时间线…"（`446-451`）。
  - **写完回读**：探测 + `astats`，算 `sampleDelta = decodedSamples - plan.totalSamples`，`exact = sampleDelta === 0`（`473-494`）。
  - **清单**：默认写一份 `<输出文件名>.manifest.json`（同目录），内容是整个结果对象（`511-519`）。
  - **不做 ducking、不做淡入淡出、不做响度归一化**（图里没有这类滤镜）。

- **输出**：`action`、`requestedSeconds`、`requiredSeconds`、`overlaps[]`、`methodChosen`，加上核心的 `path`、`method`、`channels`、`sampleRate`、`bitDepth`、`filters[]`（完整图）、`inputs[]`、`placements[]`（含 `atSamples/endSamples/samples/trimmed/sourceSeconds`）、`overlaps[]`（`earlier/later/seconds/fromSeconds`）、`verification`、`manifest`（`audio-actions.mjs:234-241`、`audio-build.mjs:496-519`）。
  `verification` 关键字段：`expectedSamples`、`decodedSamples`、`sampleDelta`、`exact`、`declaredSeconds`、`decodedSeconds`、`expectedSeconds`、`truncatedByTimeline`、`trimmedClips[]`、`decodeErrors`、`errorSamples`、`peakDbfs`、`rmsDbfs`、`dcOffset`（`audio-build.mjs:479-494`）。

- **代价**：一次探测/片段（`measureClips` 顺序执行，`audio-build.mjs:531-549`）+ 一次编码（timeout 30 分钟，`471`）+ 探测 + `astats`；**写 WAV + manifest**。片段多、文件大时是分钟级，不是秒级。

- **失败与陷阱**
  - `clips` 空：`video_audio assemble: 需要 "clips":[{"source":"...", "at":0}]。`（`audio-actions.mjs:172`）。
  - 片段读不出时长（损坏/非音频）：`这些片段读不出时长（文件损坏或不是音频）：<列表>`（`audio-actions.mjs:190-194`）。
  - `until` 超过片段自身长度：`clips[i].until (Xs) 超过了片段自身长度 (Ys)；要截断请给一个更小的值。`（`audio-build.mjs:194-198`）。**`until` 只能截尾**：想跳过片段开头没有对应参数。
  - 默认 `overlap:"reject"`：有重叠直接拒绝并指出第一处（`audio-build.mjs:439-445`）。要叠加必须显式 `sum`。
  - **`overlap:"sum"` + 显式 `method:"concat"` 是危险组合**：守卫只拦 `!fits`，不拦"有重叠却用 concat"。此时 `concat` 分支对重叠段不插静音、直接顺接，重叠片段的实际起点变成**前一段的终点**而不是 `at`，而 `apad` 会把总长补齐到 `totalSeconds`，所以 `verification.exact` 仍可能是 true。**这是读代码推出的行为，未运行验证**（`audio-build.mjs:322-333`、`446-451`、`479-483`）。
  - **重叠检测只看相邻对**：A(0,10s)、B(1,2s)、C(5,2s) 只报 A-B，A 与 C 的重叠不会出现在 `overlaps` 里（`audio-build.mjs:215-227`，代码事实；漏报后果为直接推论）。
  - `concat` 下片段超出 `totalSeconds` → 报错；`mix` 下不报错但会被 `-t` **截断**，并把 `verification.truncatedByTimeline` 标 true（`audio-build.mjs:487`、`466`）。
  - 不给 `outPath` 时永远写 `<cwd>/audio/timeline.wav`，**多次调用互相覆盖**（`audio-actions.mjs:220`）。
  - 不要用它做"简单拼接一个文件"：那是 `-c copy`/`concat` demuxer 的活；这里的价值在**定位与验证**。

- **典型用法**
  ```json
  { "action": "assemble",
    "clips": [ { "source": "narration/s01/voiceover.mp3", "at": 0.25 },
               { "source": "narration/s02/voiceover.mp3", "at": 12.9, "until": 9.2 } ],
    "totalSeconds": 30, "sampleRate": 48000, "channels": 1,
    "overlap": "reject", "outPath": "audio/timeline-s01.wav" }
  ```

- **相邻动作**：`tone` 造素材 → `assemble` 拼 → `identify`/`integrity` 验完整性 → `loudness` 逐段对齐电平 → `sync` 与导出混音对时（`sync` 的 `reference` 就是 `assemble` 的产物，`audio-actions.mjs:195`）。

---

### action: identify

- **用途**：报一个文件**声明**什么、**实际交付**什么：容器/编码/采样率/声道、声明时长 vs 解码采样数、解码错误、有效带宽与频谱倾斜。用于"文件是不是短了/被转码砍了高频"。

- **参数**

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| `target` | string | 二者其一 | — | 单个文件 |
| `paths` | string[] | 二者其一 | — | 多文件一次测量；`paths` 优先于 `target`（`audio-actions.mjs:85-90`） |
| `outPath` 等 | — | — | — | 本 action 只读，不用其它字段 |

- **行为细节**
  - `describeAudio`：先 `ffprobe`；失败则改读 ffmpeg 的输入报告，必要时按**文件魔数**显式指定 `-f`（`wav`/`flac`/`ogg`/`mov`/`mp3`/`aiff`）重试一次（`audio-measure.mjs:378-431,295-327`）。结果用 `answeredBy` 告诉你是哪一个答的。
  - `runAstats` 取 `Overall → Number of samples` 得精确解码采样数（`audio-measure.mjs:107-136,191-215`），`decodedSeconds = decodedSamples / sampleRate`（`927`）。
  - `decodeErrors` 是 stderr 里匹配 `Header missing|Invalid data found|Failed to read frame|Error submitting packet|corrupt` 的行数，`errorSamples` 是其去重前 6 条（`audio-measure.mjs:205-213`）。
  - 频谱（默认开，action 不传 `spectrum:false`）：只解**前 60 秒**、单声道、采样率取 `min(48000, 源采样率×2)`（`audio-measure.mjs:948-957`）。带宽 = 相对最响 bin 下降 20 dB 的最高 bin（`audio-signal.mjs:328-357`）；tilt = 固定四段 dB/octave 斜率（`audio-measure.mjs:76-81`、`audio-signal.mjs:371-395`）。频谱失败不使 action 失败，只在 `spectrum.error` 里报（`964-966`）。

- **输出**：`{action, count, files:[...]}`，每个文件：`source`、`answeredBy`、`container`、`codec`、`sampleRate`、`channels`、`declaredBitRate`、`declaredSeconds`、`decodedSeconds`、`decodedVsDeclaredSeconds`、`decodedVsDeclaredPercent`、`decodeErrors`、`errorSamples`、`stats`（astats 的 overall 块）、`spectrum{windowSeconds,bandwidth{bandwidthHz,referenceDb,searchedToHz},tilt[]}`，必要时 `note`（`audio-measure.mjs:930-969`）。

- **代价**：每个文件 3 次 ffmpeg/ffprobe 调用（探测 + astats + 频谱解码），**不写文件**；分析上限 60 秒音频。

- **失败与陷阱**：两个工具都读不出 → `无法读取媒体信息（…）：ffprobe 与 ffmpeg 都读不出来。…`（`audio-measure.mjs:425-429`）。`decodedVsDeclaredPercent` 在 `declaredSeconds === 0` 时为 null（`941`）。带宽分析只看前 60 秒，**开头是静音的文件会得到偏低的带宽**（`951`）。带宽分析率与 `noise` 不同（见 `noise` 节），两者数字不可直接互比。

- **典型用法**
  ```json
  { "action": "identify", "paths": ["narration/s01/voiceover.mp3", "audio/timeline.wav"] }
  ```

- **相邻动作**：先 `identify` 看差距 → 差距大或 `decodeErrors > 0` 时跑 `integrity`（`loudness` 的 note 也是这个建议，`audio-actions.mjs:348-351`）。

---

### action: speech_map

- **用途**：找出文件里**语音**与**静音**的区间，并给出总量、占比与最长停顿。用于配音节奏、静音裁剪、场景时长估算。

- **参数**

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| `target` | string | 是 | — | 输入文件 |
| `noiseDb` | number | 否 | -40 | 低于该电平算静音；直接进 `silencedetect=noise=<n>dB`（`audio-measure.mjs:490,503`） |
| `minSeconds` | number | 否 | 0.25 | 最短静音才上报（`=d=<n>`，`audio-measure.mjs:491,503`） |

- **行为细节**：`describeAudio` 取总时长（`492-493`），跑 `silencedetect` 到 `-f null -`（不写文件），解析 `silence_start`/`silence_end`（`src/core/transcribe.mjs:145-159`）。**没有配对的 `silence_end` 的静音会把 end 补成文件总长**（`audio-measure.mjs:508-515`），`closed` 标记它是否在文件内闭合。语音段是静音段的补集，由游标推进算出（`517-523`）。`speechRatio` 由 action 计算（`audio-actions.mjs:279`）。

- **输出**：`source`、`durationSeconds`、`thresholdDb`、`minSilenceSeconds`、`silence[]{start,end,seconds,closed}`、`speech[]{start,end,seconds}`、`speechSeconds`、`silenceSeconds`、`longestGap`、`speechRatio`、`note`（`audio-measure.mjs:528-538`、`audio-actions.mjs:276-283`）。

- **代价**：2 次 ffmpeg（探测 + silencedetect），只读；成本 ≈ 全片解码一遍。

- **失败与陷阱**：**换阈值结果就换**——这是测量不是判断，`thresholdDb`/`minSilenceSeconds` 已回显（`audio-actions.mjs:280-282`）。全部低于阈值时 `speech` 可能为空、`speechRatio` 为 0。要做声学类别划分请用 `video_analyze {action:"audio_events"}`。

- **典型用法**
  ```json
  { "action": "speech_map", "target": "narration/s01/voiceover.mp3", "noiseDb": -45, "minSeconds": 0.3 }
  ```

- **相邻动作**：`speech_map` 找静音 → 用 `assemble` 的 `until` 把尾巴静音截掉（逐段配音常见每段约 0.8 s 尾静音）。

---

### action: loudness

- **用途**：按广播标准测**感知响度**：EBU R128 积分响度 I、响度范围 LRA、真峰值 true peak、门限，外加 ffmpeg `astats` 的整轨统计；多文件时给出彼此差值，让"某一段突然变响"现形。

- **参数**

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| `target` | string | 二者其一 | — | 单个文件 |
| `paths` | string[] | 二者其一 | — | 多文件；此时额外给 `spreadLu`/`medianIntegratedLufs`/`outliersBeyond`/`damagedFiles` |
| `timeline` | boolean | 否 | **false**（只有显式 `true` 才开，`audio-actions.mjs:297`） | 附带按秒折叠的短时响度时间线与最响/最轻的那一秒 |

- **行为细节**
  - 每个文件并行跑两条 ffmpeg：`ebur128=peak=true` 与 `astats=metadata=1:reset=0`（`audio-measure.mjs:226-239`）。
  - 解析：`Integrated loudness/I`、`Threshold`、`Loudness range/LRA`、`LRA low/high`、`True peak/Peak`（`audio-measure.mjs:157-164`）；`shortTerm` 按 `t:` 切记录而不是按换行切，避免 CR 折行（`166-177`、注释 `139-144`）。`-inf` 被解析成 `-Infinity` 而不是 NaN（`88-93`）。
  - 时间线按 `floor(at)` 折叠成每秒桶，取该秒短时响度的**最大与最小**（`254-271`）；`loudestSecond`/`quietestSecond` 只在这时才有（`272-277`）。
  - `spreadLu = max-min`（≥2 个有限值才算，`audio-actions.mjs:321-322`）；`median` 用**排序后第 `floor(n/2)` 个**（偶数个取偏上的那个，不是两中值平均，`323`）；`outliersBeyond.thresholdLu = 2` LU（常量 `audio-actions.mjs:36`，判定 `328`）；`damagedFiles` = `decodeErrors > 0` 的文件（`333-335`）。

- **输出**：`{action, standard:"EBU R128 (ffmpeg ebur128), integrated I / LRA / true peak", count, files[], spreadLu, medianIntegratedLufs, outliersBeyond{thresholdLu,files[]}, damagedFiles[], note}`。`files[i]`：`source`、`integratedLufs`、`loudnessRangeLu`、`truePeakDbfs`、`thresholdLufs`、`peakDbfs`、`rmsDbfs`、`dcOffset`、`noiseFloorDb`、`decodedSamples`、`decodeErrors`、`channels`、`loudestSecond`、`quietestSecond`、`timeline`（`audio-actions.mjs:299-319`）。

- **代价**：每文件 2 次 ffmpeg（并行），只读；`timeline:true` 不增加 ffmpeg 次数，只是把解析结果留下。

- **失败与陷阱**
  - 文件帧有缺失时，响度是在**有洞的时间轴**上算出来的，note 会提示先跑 `integrity`（`audio-actions.mjs:330-351`）。
  - `loudness` **不改文件也不归一化**；它只测（要归一化去 `video_render`）。
  - **与 `levels` 的区别**：`loudness` 是感知加权 + 门控的标准量（LUFS/LU/dBTP，真峰值带过采样），`levels` 是采样域原始事实（dBFS 峰值/RMS/直流/削波）。同一文件"peak dBFS"与"true peak dBTP"可能不同。

- **典型用法**
  ```json
  { "action": "loudness", "paths": ["narration/s01/voiceover.mp3", "narration/s02/voiceover.mp3", "narration/s03/voiceover.mp3"] }
  ```

- **相邻动作**：`loudness` 找离群段 → 用 `restore` 的 `gain`？**没有 gain 步**（`RESTORE_METHODS` 无增益项，`audio-restore.mjs:38`）——对齐电平要靠 `video_render` 侧或外部处理；之后 `assemble`。

---

### action: levels

- **用途**：报**采样域**事实：峰值、RMS、波峰因数、直流偏移、**精确的削波段**（带时间戳）与逐秒电平时间线。用于判断"是否削顶、是否偏直流、某秒是不是空的"。

- **参数**

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| `target` | string | 是 | — | 输入文件 |
| `clipThreshold` | number 0..1 | 否 | 0.999 | 幅值**≥**该值即算"高采样"（比较是 `>=`，`audio-signal.mjs:172`） |
| `minClipSamples` | number | 否 | 3 | 短于该长度的连续段**不列入** `runs`，但仍计入 `totalHighSamples`（`audio-signal.mjs:153-166`） |
| `maxSeconds` | number | 否 | 600 | 只分析前这么多秒；截断会体现在 `truncatedAtMaxSeconds`（`audio-measure.mjs:787,882`） |
| `timeline` | boolean | 否 | **true**（`args.timeline !== false`，`audio-actions.mjs:373`） | 逐秒 RMS 序列；长文件可传 `false` 省输出 |

- **行为细节**
  - 用 `describeAudio` 取**文件自身采样率**与声道数（最多取 2，`audio-measure.mjs:790-792`），按 **30 秒一块**顺序解码（`chunkSeconds = 30`，`796,811-821`）——**从不重采样**，所以削波不会被抹平（action 的 note 与 `767-773` 的注释）。
  - 每块把多声道压成"每帧取绝对值最大的声道"的 mono（`827-835`，与 `audio-signal.mjs:66-79` 同义），用于削波与时间线；逐声道统计另行累加（`837-845`）。
  - 削波：`clipRuns` 扫连续 ≥ 阈值的段，给每段 `startSample/samples/peak/at/seconds`（`audio-signal.mjs:135-183`）；`totalHighSamples` 精确，`runs` 最多 200 段，超出置 `truncated`（`audio-measure.mjs:853-865`、`audio-actions.mjs:380`）。runs 的 `channel` 字段固定为 `"loudest"`。
  - 时间线：每秒一个 `{at, rmsDb}`，由 `envelopeDb(mono, rate, 1)` 产生（`audio-signal.mjs:449-457`）。
  - 对齐标记：某块解出的帧数与 `round(时长×采样率)` 相差超过 0.05 秒 → `windowAligned:false`（`824`、`633`），表示窗口边界可能落在编解码帧上。

- **输出**：`source`、`sampleRate`、`channels`、`analysedSeconds`、`requestedSeconds`、`windowAligned`、`truncatedAtMaxSeconds`、`peak`、`peakDbfs`、`rms`、`rmsDbfs`、`crestFactorDb`、`dcOffset`、`dcOffsetDbfs`、`perChannel[]{channel,peak,peakDbfs,rmsDbfs,dcOffset}`、`clipping{threshold,minRunSamples,totalHighSamples,listedRuns,truncated,runs[]}`、`timeline`（关掉时为 null）、`note`（`audio-measure.mjs:875-906`、`audio-actions.mjs:375-381`）。

- **代价**：1 次探测 + `ceil(min(时长, maxSeconds)/30)` 次解码（600 秒 → 21 次 ffmpeg），完全只读。这是"多进程、单次短"的模式，长文件较慢。

- **失败与陷阱**
  - 默认只分析前 600 秒：不要把它当全片结论（`truncatedAtMaxSeconds` 才是判据）。它**没有** `start`/`duration` 参数（文档 `docs/声音工具.md:106` 提到 `start`/`duration`，schema 与 handler 里都不存在——**文档与代码不一致**）。
  - `crestFactorDb` 在 RMS 为 0（纯静音）时为 null（`887`）。
  - `dcOffsetDbfs` 对直流 0 会给出 `-Infinity`（`dbFromAmplitude` 的约定，`audio-signal.mjs:25-29`）。
  - 削波是"连续段"概念：`minClipSamples` 只影响列举不影响总数（`tests/audio-actions.test.mjs:82-87` 正是这个行为）。

- **典型用法**
  ```json
  { "action": "levels", "target": "audio/timeline.wav", "clipThreshold": 0.999, "minClipSamples": 3, "maxSeconds": 600 }
  ```

- **相邻动作**：`tone`（满刻度）→ `levels` 验证削波检测；`levels` 发现削波后回 `assemble` 调电平或用 `restore` 的 `highpass/lowpass`（**无法降低已有削波失真**）。

---

### action: integrity

- **用途**：回答"这个文件**是不是全都在**"——走 MPEG 帧链报每一处断裂及其字节、比对声明与解码时长、统计解码器报错，并可写出一份**不碰原文件**的修复副本。这是为 edge-tts 曾产生"每 5 帧夹一个 `\r\n`、丢 20% 音频"的真实事故写的（`docs/声音工具.md:110`）。

- **参数**

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| `target` | string | 是 | — | 要审计的文件 |
| `repair` | boolean | 否 | false | true 时写出修复副本（仅在帧链适用且发现缺口时，`audio-integrity.mjs:381`） |
| `repairPath` | string | `repair:true` 时必需 | 由 action 推导：`<同目录>/<basename('.mp3' 去掉)>.repaired.mp3`（`audio-actions.mjs:395-400`） | 修复副本写到哪；**原文件永不被改写** |

- **行为细节**
  - 三条独立证据（模块注释 `audio-integrity.mjs:9-17`）：
    1. **帧链**：跳过 ID3v2（synchsafe 长度，含 footer 标志，`60-69`），从第一个合法帧头（最多向后找 4096 字节，`40,129-136`）开始逐帧走；每帧按 MPEG 版本/层/比特率索引算出 `frameBytes`（`80-114`，公式 `102`）；遇到非法帧头就向后找下一个帧头，把中间的字节记为一次 break（`180-220`）。`maxGapBytes` 默认 4096，超过即终止遍历；`maxBreaks` 默认 500（记录上限，`breakCount` 始终精确）；每次 break 记 `gap` 字节数、`gapHistogram`、以及缺口里**前 16 字节的 hex**（`0d0a` 与随机损坏含义完全不同，`213-218`）。`estimatedLostFrames = Σ max(1, ceil(gap/frameBytes)) × 次数`（`225-227`）。`stoppedEarly` 表示"前面放弃了但后面还有帧"（`200-205`）。
    2. **解码采样数**：`astats` 的 `decodedSamples ÷ sampleRate`，与 `describeAudio` 的声明时长比（`330-350`）。
    3. **解码器抱怨**：`decodeErrors` 行数 + `errorSamples` 样本（`351-352`）。
  - **修复算法**（`repairMpegFrames`，`247-308`）：逐帧整块复制，**只删字节、绝不改写帧内字节**；保留 ID3；首部游离字节与尾部残帧被删除并分别计数（`droppedLeadingBytes` / `droppedTrailingBytes`）；只删除宽度 ≤ `maxGapBytes`（默认 64）的缺口；若某处 64 字节内找不到帧头**但文件后面还有帧**，抛错拒绝（`284-290`），而不是静默丢掉后半段。
  - 内存：整个文件读进内存，上限 512 MB（`MAX_AUDIT_BYTES`，`37,322-328`）。

- **输出**：`source`、`sizeBytes`、`container`、`codec`、`answeredBy`、`sampleRate`、`channels`、`declaredSeconds`、`decodedSeconds`、`decodedVsDeclaredSeconds`、`decodedVsDeclaredPercent`、`decodeErrors`、`errorSamples`、`frameWalk{...}`、可选 `repair{path,frames,removedGaps,removedBytes,droppedLeadingBytes,droppedTrailingBytes,sizeBytes}`（`audio-integrity.mjs:339-395`）。非 MPEG 时 `frameWalk = {applies:false, note:"这不是 MPEG 音频（mp3），逐帧链检查不适用…"}`（`375-378`）。

- **代价**：1 次探测 + 1 次 `astats` + **整文件读入并逐字节遍历**（512 MB 上限，超出直接拒绝）；`repair:true` 时多写一个文件（大小 ≈ 原文件）。只读原文件。

- **失败与陷阱**
  - 文件 > 512 MB：`…超过 512 MB 的逐帧审计上限。请先用 ffmpeg 切出要检查的片段。`（`323-327`）。
  - 非 MPEG（AAC/FLAC/PCM）：逐帧检查**不适用**，只能看 `decodedVsDeclaredPercent` 与 `decodeErrors`（`375-378`、`docs/声音工具.md:120`）。
  - `repair:true` 但没有缺口 → **结果里根本没有 `repair` 字段**（`381`）；不要把它当失败。
  - 修复副本默认按 `.mp3` 去后缀；对非 `.mp3` 的 target，默认名会变成 `x.wav.repaired.mp3`（`audio-actions.mjs:399`）。
  - 宽损坏（缺口 > 64 字节且后面还有帧）会被**拒绝**，需要先切出可解码部分（`284-290`）。
  - `estimatedLostFrames/Seconds` 是**估计**（注释明说 `223-224`）。

- **典型用法**
  ```json
  { "action": "integrity", "target": "narration/s08/voiceover.mp3", "repair": true,
    "repairPath": "narration/s08/voiceover.fixed.mp3" }
  ```

- **相邻动作**：`identify`/`loudness` 发现 `decodeErrors > 0` 或时长缺口 → 先 `integrity`（必要时修复）→ 再 `assemble`；修复后建议再跑一次 `integrity` 确认 `breakCount == 0`（`tests/audio-actions.test.mjs:249-256`）。

---

### action: sync

- **用途**：测两条"同一段话"的录音之间的**偏移**与**漂移**（例如组装音轨 vs 导出混音）。用于判断时间轴是否整体错位、是否越走越偏。

- **参数**

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| `reference` | string | 是 | — | 当作正确的那个（例如 assemble 出的音轨） |
| `comparison` | string | 是 | — | 被比较的（例如导出混音） |
| `maxLagSeconds` | number | 否 | 5 | 在 0 两侧各搜多远 |
| `maxSeconds` | number | 否 | **300**（`audio-actions.mjs:428`；schema 描述只写了 levels 的 600） | 每个文件最多分析多少秒 |
| `windows` | number | 否 | 5 | 沿时间轴均分多少个窗口；>1 才能谈漂移；最小 1（`429`） |
| `sampleRate` | number | 否 | — | **被忽略**：代码写死 `ANALYSIS_SAMPLE_RATE = 8000`（`426`、`audio-measure.mjs:46`） |

- **行为细节**
  - 两文件各解码成 **8 kHz 单声道 float**（`decodePcm`，`433-435`），公共长度 `< 2 秒` 直接报错（`436-439`）。
  - 粗定位：`envelopeLag` 把两路压成 **100 Hz 包络**（`envelopeRate`，`audio-signal.mjs:475,477`），在 ±`maxLagSeconds` 上做归一化互相关（`509-526`）。**它相关的是包络，不是波形**——两次不同编码/噪声的录音波形对不上，包络（语音起止形状）却几乎一致（模块注释 `459-465`、action note `487-489`）。
  - 细化：`refineLag` 在粗定位 ±0.5 秒内逐**采样点**相关（`442`、`audio-signal.mjs:545-573`）。
  - 漂移：沿公共长度均分 `windows` 个窗口，每窗在细化值 ±0.25 秒内再细化，得到 `windows[].offsetSeconds/correlation`；对这些窗口中点做最小二乘 `linearFit` → `drift{secondsPerSecond, ppm, windows, meaning}`（`444-486`、`audio-signal.mjs:582-595`）。
  - 符号约定：`offsetSeconds` **正值 = comparison 比 reference 晚**（`audio-actions.mjs:474-475`）。

- **输出**：`reference`、`comparison`、`sampleRate`（固定 8000）、`analysedSeconds`、`offsetSeconds`、`correlation`、`offsetMeaning`、`coarse{offsetSeconds,correlation,envelopeRate}`、`windows[]{fromSeconds,toSeconds,offsetSeconds,correlation}`、`drift{secondsPerSecond,ppm,windows,meaning}`、`note`（`audio-actions.mjs:466-490`）。

- **代价**：2 次解码（各上限 `maxSeconds`）+ 纯 CPU 相关（±maxLag 的 100 Hz 包络扫描 + 逐采样细化），**不写文件**。

- **失败与陷阱**
  - 公共长度 < 2 秒：`video_audio sync: 两个文件重叠部分不足 2 秒，无法比较。`（`437-439`）。
  - **实际最短要求远大于 2 秒**：`envelopeLag` 在 `length < maxLag*2 + 8` 个包络点时返回 null（`audio-signal.mjs:496`）。按默认 `maxLagSeconds:5`、包络 100 Hz、解码 8 kHz：`step = 80` 采样/包络点，需要 ≥ 1008 个包络点 = 80 640 采样 ≈ **10.08 秒**。2–10 秒之间的文件会得到 `video_audio sync: 两段音频太短或没有可对齐的共同结构。`（`441`）。这是读代码直接算出的门槛，**未运行验证**。
  - `correlation < 0.3` 时偏移不可信（note 明说，`489`）；不要照着它改时间轴。
  - 两文件**起点必须可比**：漂移假设同一时间区间对应同一起点；若其中一条整体平移超过 `maxLagSeconds`，会得到错误的最小值而不是报错（`509-526` 只在范围内找最大相关）。
  - `sampleRate` 传了也没用（`426`）。

- **典型用法**
  ```json
  { "action": "sync", "reference": "audio/timeline.wav", "comparison": "out/mixdown.wav",
    "maxLagSeconds": 2, "windows": 8, "maxSeconds": 300 }
  ```

- **相邻动作**：`assemble` 出的轨 → 与外部混音 `sync`；偏移确认后用剪辑侧修正，本家族不提供"按偏移平移"的动作。

---

### action: noise

- **用途**：报告噪声底**由什么构成**：宽带底、50/60 Hz 工频家族（逐谐波）、四段频谱倾斜、最强的窄带峰。三者修法不同，所以分开报（模块注释 `audio-measure.mjs:642-647`）。

- **参数**

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| `target` | string | 是 | — | 输入文件 |
| `mainsHz` | 50 / 60 | 否 | 50 | **只回显为 `hum.requestedMainsHz`，不影响测量**：两族总是都测（`audio-measure.mjs:690-703,750`） |
| `fftSize` | number（2 的幂） | 否 | 8192 | 频谱 FFT 大小（`659`）；注意 `spectrumOf` 要求 2 的幂，否则抛 `fftInPlace: length must be a power of two`（`audio-signal.mjs:198-200`） |
| `windowSeconds` | number | 否 | **30**（`audio-measure.mjs:658`）；但返回的 `defaults.windowSeconds` 回显 **60**（`MEASURE_DEFAULTS.windowSeconds`，`72`），schema 描述写 30（`audio.mjs:221`） | 分析窗口长度；窗口越小越能跟随变化的底噪。实际扫描窗口会被**封顶 60 秒**（`675`） |

- **行为细节**
  - `scanPcm` 以 **48 kHz 单声道** 分窗解码（`SPECTRUM_SAMPLE_RATE`，`audio-measure.mjs:56`、`670-675`）。为何不是 8 kHz：模块注释说明在 8 kHz 上量带宽永远只会得到 4 kHz（`48-56`）。
  - 每窗算 RMS，记录**最安静窗口**；频谱取自最安静窗口——在有人说话的窗口量噪声，量到的是人声（`683-688`）。
  - 工频：对 **50 Hz 与 60 Hz 各 1..8 次谐波**逐频做 `goertzelDb`（Goertzel，逐频精确、不受 bin 落点影响），跨窗口取最大值并记 `worstAt`（`690-703`、`audio-signal.mjs:289-311`）；频率超过 24000-50 的谐波跳过（`693`）。`sum50HzDb`/`sum60HzDb` 是先转线性幅值、平方求和再转 dB（`727-733`）；`dominantFamilyHz` 取能量大的一族（`735`）。
  - 频谱衍生：`bandwidthOf`（相对最响 bin 降 20 dB，`MEASURE_DEFAULTS.bandwidthDropDb`）、`tiltOf`（固定四段：`rumble_20_120`/`low_120_500`/`speech_500_4k`/`high_4k_12k`，`76-81`）、`tonalPeaks`（最多 8 个，突出度 ≥ 6 dB，上限 24 kHz-100，`713-717`）。tilt 每段少于 4 个 bin 时 `dbPerOctave` 为 null（`audio-signal.mjs:383`）；tonalPeaks 的邻居窗口少于 8 个 bin 时跳过（`436`）。
  - 无有效音频时报 `没有可分析的有效音频：<file>`（`707-709`）。

- **输出**：`source`、`windows`、`analysedSeconds`、`windowAligned`、`broadband{meanRmsDb,loudestRmsDb,quietestRmsDb,quietestAt}`、`hum{requestedMainsHz,dominantFamilyHz,sum50HzDb,sum60HzDb,harmonics[]{familyHz,harmonic,frequencyHz,db,worstAt,amplitude}}`、`spectrum{atSeconds,fftSize,sampleRate:48000,bandwidth{bandwidthHz,referenceDb,searchedToHz},tilt[],tonalPeaks[]}`，以及 action 附上的 `defaults` 与 `note`（`audio-measure.mjs:736-765`、`audio-actions.mjs:512-523`）。

- **代价**：1 次探测 + **每 ≤60 秒一个解码进程**（10 分钟素材 ≈ 10+ 次），只读。

- **失败与陷阱**
  - `mainsHz` 不改变测量结果（只是回显），别以为传了 60 就"只测 60"（`750`）。
  - `defaults.windowSeconds` 回显 60 与真实默认 30 不一致（`audio-measure.mjs:72,658`、`audio-actions.mjs:518`）——要精确控制请显式传 `windowSeconds`。
  - `fftSize` 非 2 的幂会以底层异常形式失败（`audio-signal.mjs:198-200`）。
  - 频谱只反映"最安静的一个窗口"，**不能代表全程**；要全程看时间线用 `levels` 的 `timeline`。
  - 与 `identify` 的频谱不可直接互比：`identify` 用 `min(48000, 源率×2)` 只解前 60 秒，`noise` 固定 48 kHz 且挑选最静窗口（`audio-measure.mjs:953` vs `673`）。

- **典型用法**
  ```json
  { "action": "noise", "target": "audio/take.wav", "mainsHz": 50, "windowSeconds": 30, "fftSize": 8192 }
  ```

- **相邻动作**：`noise` 定位成因 → `restore` 只处理确认的那一项（宽带 → `denoise`；工频 → `dehum`；单一音调 → `notch`；低频隆隆 → `highpass`）→ `restore` 的 `before/after` 再确认。

---

### action: restore

- **用途**：施加一条**完全显式**的修复链（denoise / dehum / notch / gate / highpass / lowpass），写出文件，然后把写出的文件**再测一遍**并报"到底改了什么"。它不做任何自动判断。

- **参数**

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| `target`（或 `source`） | string | 是 | — | 输入文件；handler 取 `args.target ?? args.source`（`audio-actions.mjs:536`）。**`source` 未在 schema 声明** |
| `steps` | object[] | 是（≥1 步） | — | 按顺序施加；空数组报 `restore 需要至少一个 step，例如 [{method:"highpass",frequencyHz:80}]。`（`audio-restore.mjs:178-181`） |
| `steps[].method` | enum | 是 | — | `denoise`/`dehum`/`notch`/`gate`/`highpass`/`lowpass`（`audio-restore.mjs:38`） |
| `codec` | enum | 否 | `pcm_s16le` | `pcm_s16le`/`pcm_f32le`/`aac`；`aac` 写 `.m4a` 且 `-b:a 192k`（`audio-restore.mjs:41,215-229`、`audio-actions.mjs:539`） |
| `sampleRate` | number | 否 | 保持源 | 传了才加 `-ar`（`audio-restore.mjs:225`） |
| `channels` | number | 否 | 保持源 | 传了才加 `-ac`（`226`） |
| `mainsHz` | 50/60 | 否 | 50 | **只影响 before/after 的 `noise` 测量回显**；dehum 的工频由 `steps[].mainsHz` 决定（`239,261`） |
| `measure` | boolean | 否 | true（`args.measure !== false`，`audio-actions.mjs:553`） | false 时跳过前后测量（快很多）。**schema 未声明** |
| `outPath` | string | 否 | `<cwd>/audio/<源文件名去扩展>.restored.<wav 或 m4a>`（`audio-actions.mjs:540-543`） | 输出 |

  各 method 的专属参数（校验都在 `restoreStep`，`audio-restore.mjs:68-169`）：

| method | 参数 | 默认 | 生成的滤波器 |
| --- | --- | --- | --- |
| `denoise` | `noiseFloorDb`（-80..-20）**或** `trackNoise:true`；`noiseReductionDb`（0.01..97）；`noiseType`（white/vinyl/shellac/custom → `nt=w/v/s/c`） | reduction 12；type white；`trackNoise` false | `afftdn=nr=..:nt=..:tn=0|1[:nf=..]`（`95-100`） |
| `dehum` | `mainsHz`（必须 50 或 60）；`harmonics`（1..12）；`widthHz`（>0 且 ≤ mains/2） | harmonics 4；widthHz 2 | 每个谐波一个 `bandreject=f=<mains×n>:width_type=h:w=<widthHz>`（`114-118`） |
| `notch` | `frequencyHz`（>0）；`widthHz`（>0） | widthHz 10 | `bandreject=f=..:width_type=h:w=..`（`121-127`） |
| `gate` | `thresholdDb`（必需）；`rangeDb`；`ratio`（≥1）；`attackMs`；`releaseMs`；`mode`（downward/upward） | rangeDb -60；ratio 2；attack 20 ms；release 250 ms；mode downward | `agate=threshold=<线性>:range=<线性>:ratio=..:attack=..:release=..:mode=..`（`129-151`） |
| `highpass` / `lowpass` | `frequencyHz`（>0）；`poles`（1 或 2） | poles 2 | `highpass=f=..:poles=..` / `lowpass=f=..:poles=..`（`153-167`） |

- **行为细节**
  - dBFS → 线性：`agate` 的 `threshold`/`range` 要线性幅值，用 `amplitudeOption()` 换算并夹在 `1e-6..1`、保留 8 位小数（`audio-restore.mjs:46-58,139-146`）。
  - 链就是按顺序把各步滤波器用 `,` 连起来，回显为 `chain` 与 `filters[]`（`178-190`）。
  - 执行：`-v info -nostats [-f <fmt>] -i <src> -vn -af <chain> [-ar][-ac] -c:a <codec> [aac→-b:a 192k] <outPath>`（`223-232`）。输入容器探测失败时按魔数显式 `-f` 重试，结果里给 `forcedFormat`（`245-251`）。
  - `measure` 为真时：**before** = 源文件的 `astats` + `measureNoise`；**after** = 写出文件的同样两项（`236-263`）。所以"前后"绝不可能是同一个文件的两次描述。
  - `change` 的每一项都由前后**实测**相减得到；某一侧为 `-inf`/非有限时该项为 null（`265-271`）。
  - 没有 `arnndn` 步骤：`RESTORE_METHODS` 里没有它，也没有任何步骤读 `model`（`audio-restore.mjs:38`）。模块注释说"通过 `model` 支持、可选"（`18-20`），`docs/声音工具.md:169` 也这么说，但**代码里没有实现**——文档/注释与代码不一致。

- **输出**：`path`、`codec`、`source`、`chain`、`filters[]`、`resolvedSteps[]`、`args`、`forcedFormat`、`before{peakDbfs,rmsDbfs,noiseFloorDb,hum50HzDb,hum60HzDb,bandwidthHz}`、`after{同上}`、`change{peakDb,rmsDb,noiseFloorDb,hum50Hz{fromDb,toDb,changedDb},hum60Hz{...},bandwidthHz,peakDifferenceDb,linearPeakBefore,linearPeakAfter,rmsDbfsFromLevels}`、`note`（`audio-restore.mjs:281-309`）。

- **代价**：**本家族最贵的 action**。`measure:true`（默认）时 = (astats + 全文件 48 kHz 分窗噪声扫描) × 2 + 1 次编码；噪声扫描在 10 分钟素材上就是十几次解码。它是唯一"进—改—出"的写文件 action（`assemble` 是造，`restore` 是改）。

- **失败与陷阱**
  - `steps` 为空 → 明确报错（`178-181`）；未知 method → `未知的修复方法 …；可选：…`（`70-72`）。
  - `denoise` 不给 `noiseFloorDb` 也不给 `trackNoise:true` → 报错，**不会自动估**（`77-82`）；`noiseFloorDb` 超出 -80..-20 也报错（ffmpeg 限制，`83-85`）。
  - `dehum` 的 `mainsHz` 必须是 50/60；顶层 `mainsHz` **不参与** dehum（`104-106`）。
  - **本家族没有增益/归一化步骤**：修复不能"顺手把电平对上"，`change` 只报改了多少。
  - `aac` 是有损输出：after 的数字包含编码损失，别把编解码差异当成滤波器效果。
  - `measure:false` 会让 `before/after/change` 全为 null（`236-241,258-263`）——快，但也就失去了这个 action 的意义。
  - 判断口径：若 `noiseFloorDb` 几乎没变而听感变化大，问题通常在工频或窄带峰上，去看 `hum` 与 `spectrum`（note 明说，`306-308`）。

- **典型用法**
  ```json
  { "action": "restore", "target": "audio/take.wav",
    "steps": [ { "method": "highpass", "frequencyHz": 80 },
               { "method": "dehum", "mainsHz": 50, "harmonics": 3, "widthHz": 4 },
               { "method": "denoise", "noiseFloorDb": -45, "noiseReductionDb": 12 } ],
    "codec": "pcm_s16le", "outPath": "audio/take.restored.wav" }
  ```

- **相邻动作**：`noise` 定位 → `restore` 处理 → `noise`/`levels`/`loudness` 复测（或直接读 `before/after/change`）→ `assemble` 使用修好的片段。

---

### action: devices

- **用途**：列出本机 DirectShow 报出的采集设备，给出**照原样传给 `record` 的确切名字**，以及语言无关的稳定标识 `alternative`。

- **参数**

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| （无专属参数） | — | — | — | 只用 `config` 与 `cwd`（`audio-actions.mjs:569-576`） |

- **行为细节**
  - 先 `ffmpeg -devices` 判断这个构建**有没有编译 dshow**（检查 stdout 里是否有 `dshow` 这个词，`audio-record.mjs:89-91`）。没有 → `supported:false` 并给出"换一个带 dshow 的构建"的说明（`102-111`）。
  - 再 `ffmpeg -list_devices true -f dshow -i dummy`；**ffmpeg 枚举设备总会以非零退出**（读完列表后对 dummy 输入报错），这不是失败，清单在 stderr 里（`113-133`）。解析 `"名字" (audio|video)` 与随后的 `Alternative name "..."`（`54-73`）。
  - 没有设备是**正常结果**：返回 `audio/audio:[]` + 最后几行 stderr 作为 `error`（`120-131`）。

- **输出**：`supported`（true/false/null）、`audio[]{name,alternative}`、`video[]{name,alternative}`、`empty`（仅枚举分支）、`error`、`note`，以及 action 附加的 `usage` 一句（`audio-actions.mjs:572-576`）。`supported:null` 表示连 `ffmpeg -devices` 都跑不起来（`92-99`）。

- **代价**：2 次 ffmpeg 调用（各 timeout 20 秒；占用中的设备可能拖慢枚举，`83,118`），只读。

- **失败与陷阱**：`-list_devices` 的非零退出**不是**错误，不要据此判定失败（`131`）。空列表时 `error` 是 stderr 尾部文本，可能很长。设备名必须**逐字符一致**（含括号与空格）地传给 `record`。

- **典型用法**
  ```json
  { "action": "devices" }
  ```

- **相邻动作**：`devices` → `record`（把 `audio[i].name` 原样传过去）。

---

### action: record

- **用途**：从**指定名字**的设备录固定秒数，然后测量这一"条"：时长误差、峰值、直流、噪声底、工频、带宽。

- **参数**

| 参数 | 类型 | 必填 | 默认 | 含义与取值 |
| --- | --- | --- | --- | --- |
| `device` | string | **是** | — | 必须与 `devices` 列出的名字完全一致（`audio-record.mjs:153-155`） |
| `seconds` | number | **是** | — | 录制秒数，>0 且 **≤3600**（`156-158`） |
| `sampleRate` | number | 否 | 48000 | 采集采样率（`159`） |
| `channels` | number | 否 | 1 | 只允许 1 或 2（`160-161`） |
| `rtBufferMb` | number | 否 | 64 | DirectShow 实时缓冲，**至少 8**，太小会丢采样（`162-163`） |
| `measure` | boolean | 否 | true（`args.measure !== false`，`audio-actions.mjs:606`） | false 时跳过 `astats` 与噪声测量。**schema 未声明** |
| `outPath` | string | 否 | `<cwd>/audio/record-<YYYYMMDD-HHMMSS>.wav`（本地时间戳，`audio-actions.mjs:52-58,593-597`） | 输出；目录会被创建 |

- **行为细节**
  - 命令固定：`-f dshow -rtbufsize <N>M -i audio=<device> -t <seconds> -ar <sr> -ac <ch> -c:a pcm_s16le <outPath>`（`audio-record.mjs:165-176`）。
  - **进程在 `seconds + 20` 秒被强杀**（`RECORD_DEADLINE_SLACK_SECONDS = 20`，`33-34,176`），所以不会挂住（`deadlineSeconds` 会回显）。
  - 失败时若 stderr 命中 `Could not find audio only device|I/O error|device not found|in use`，会追加一句"设备名必须与 devices 列出的完全一致（包括括号和空格）；占用中的设备会枚举失败。"（`204-211`）。
  - 写完后：文件不存在 → 报"ffmpeg 结束了但没有写出文件"（`213-215`）；否则 `describeAudio` 取实际时长，`durationErrorSeconds = measuredSeconds - requestedSeconds`（`217-228`）；`measure` 为真时再跑 `astats` 与完整的 `measureNoise`（`220-221`）。
  - **非确定性**：命令与测量确定，**房间不确定**——结果永远只给数字，不给"这条好不好"（模块注释 `audio-record.mjs:1-19`；note `249-251`）。

- **输出**：`path`、`device`、`requestedSeconds`、`measuredSeconds`、`durationErrorSeconds`、`sampleRate`、`channels`、`args`、`deadlineSeconds`、`measured{peakDbfs,rmsDbfs,dcOffset,peakCount,decodeErrors}|null`、`noise{meanRmsDb,quietestRmsDb,quietestAt,dominantMainsHz,hum50HzDb,hum60HzDb,bandwidthHz}|null`、`note`（`audio-record.mjs:223-252`）。

- **代价**：**实时阻塞**——调用会占用 `seconds` 秒（最长 3600 秒 + 20 秒 slack），之后还要跑一次 `astats` 与**整条录音的噪声扫描**（48 kHz 分窗），因此总耗时 > 录音时长；**写 WAV**。

- **失败与陷阱**
  - 漏 `device`：`record 需要 device（设备的完整名称，先用 action:"devices" 列出）。`（`154`）；漏 `seconds`：`record 需要 seconds（要录多少秒，正数）。`（`157`）；>3600：`一次录音最多 3600 秒；需要更长请分段录制再装配。`（`158`）；`rtBufferMb<8`：`rtBufferMb 至少 8，太小会丢采样。`（`163`）。
  - `durationErrorSeconds` 明显为负 = 设备启动慢、开头被吃掉；`peakDbfs` 贴近 0 = 过载，先降增益再录（note `250-251`）。
  - 默认文件名带时间戳，**录音条不互相覆盖**（`51-58`）。
  - 机器没有 dshow 后端时不可能录音（先看 `devices` 的 `supported`）。

- **典型用法**
  ```json
  { "action": "devices" }
  ```
  ```json
  { "action": "record", "device": "麦克风 (USB Audio Device)", "seconds": 10,
    "sampleRate": 48000, "channels": 1, "rtBufferMb": 64 }
  ```

- **相邻动作**：`devices` → `record` → `noise`/`levels`/`loudness` 判断房间与增益 → `restore` 处理 → `assemble` 用作旁白/环境声。

---

## 决策要点（什么时候用哪一个）

| 问题 | 用哪个 | 理由（代码依据） |
| --- | --- | --- |
| 多段音频要落到精确时间点 | `assemble`，不要自己拼 ffmpeg | 采样级 `atrim/concat/apad`，写完解码回读比对，`verification.exact` 是判据；`adelay` 有毫秒取整累积误差（`audio-build.mjs:7-15,301-360,479-494`） |
| 仅"把两个文件接起来"、无定位需求 | 不必用本家族 | `assemble` 的价值在定位与验证，不在拼接本身 |
| 需要每段独立淡入淡出/变速/多声道 | 不用 `assemble` | 图里没有 `afade`/`atempo`/`pan`（`audio-build.mjs:267-360`） |
| "这段听起来多响" | `loudness` | EBU R128 积分响度/LRA/真峰值（`audio-measure.mjs:226-281`） |
| "峰值/削波/直流/哪一秒是空的" | `levels` | 采样域、按源采样率、不重采样（`audio-measure.mjs:784-907`） |
| 两个都想要 | 两个都调 | 一个文件的"peak dBFS"和"true peak dBTP"不是同一个数 |
| 静音在哪、最长停顿多久 | `speech_map` | `silencedetect` + 补集算术，阈值与最短静音必回显（`audio-measure.mjs:489-539`） |
| 噪声是什么做的 | `noise` 先，再 `restore` | 宽带/工频/倾斜三者修法不同（`audio-measure.mjs:642-647`） |
| 文件是不是缺了 20% | `integrity`（先 `identify` 看差值） | 帧链 + 解码采样数 + 解码器报错三条证据（`audio-integrity.mjs:9-17`） |
| 两条录音差多少、越走越偏多少 | `sync` | 包络互相关 + 逐采样细化 + 最小二乘漂移（`audio-actions.mjs:440-486`） |
| 需要现场收音 | `devices` + `record` | 唯一非确定性来源是房间（`audio-record.mjs:1-19`） |
| 要响度归一化/ducking | 不在本家族 | 本家族无 `loudnorm`/`sidechaincompress` 实现；归一化在 `video_render` 侧（`src/core/finalize.mjs:154`） |

**`levels` 阈值参数的准确含义**：`clipThreshold`（默认 0.999）是**幅值门槛**，比较是 `>=`（`audio-signal.mjs:172`）；`minClipSamples`（默认 3）只决定**哪些段被列进 `clips[].runs`**，不影响 `totalHighSamples` 这个精确总数（`audio-signal.mjs:143-166`）；`maxSeconds`（默认 600）截断分析范围并体现在 `truncatedAtMaxSeconds`；`timeline`（默认 true）给每秒 RMS（dBFS）。

**`measure` 与 `levels` 的区别（一句话）**：`loudness` 是**标准量**（ffmpeg `ebur128` 的 LUFS/LU/dBTP，带感知加权与门控），`levels` 是**原始量**（自算的 dBFS 峰值/RMS/波峰因数/直流/削波段，且刻意在源采样率上算以免抹平削波）。

## 未证实与文档/代码不一致（调用前请留意）

1. **`durationSeconds`/`measure`/`source` 未在 schema 声明**（`src/tools/audio.mjs:72-247` vs `audio-actions.mjs:117,553,606,536`），而 schema 是 `additionalProperties:false`（`shared.mjs:81`）。宿主是否放行**未证实**；`tone` 依赖它。
2. **逐字节确定性**只是代码 note 与文档的说法（`audio-build.mjs:414`），测试只到 `sampleDelta 0` 与 0.05 dB 电平（`tests/audio-actions.test.mjs:52-55`）。
3. **`arnndn`/`model`**：注释（`audio-restore.mjs:18-20`）与 `docs/声音工具.md:169` 说可用 `model` 显式启用，但 `RESTORE_METHODS` 与 `restoreStep` 都没有它（`audio-restore.mjs:38,68-169`）。
4. **`levels` 的 `start`/`duration`**：`docs/声音工具.md:106` 提到，schema/handler 里不存在（`audio.mjs:184-187`、`audio-actions.mjs:364-385`）。
5. **`noise` 的 `windowSeconds` 默认**：文档与 schema 说 30（`audio.mjs:221`），代码用的也是 30（`audio-measure.mjs:658`），但回显的 `defaults.windowSeconds` 是 60（`audio-actions.mjs:518`）。
6. `assemble` 的 `overlap:"sum"` + 显式 `method:"concat"` 会**静默改变重叠片段的落点**且可能仍报 `exact:true`（推论自 `audio-build.mjs:322-333,446-451`，未运行验证）。
7. `sync` 的实际最短素材约 **10.08 秒**（`audio-signal.mjs:494-496` 与 `audio-actions.mjs:427` 的算术推论），而 action 自己的守卫只要求 2 秒（`audio-actions.mjs:436-439`）。
8. `record` 在真实硬件上的行为（设备枚举、丢采样、`durationErrorSeconds` 量级）本任务未运行验证。
