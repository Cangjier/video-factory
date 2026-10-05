# video-factory

**素材进，成片出。** 一个 DeepSeek Harness 插件：把图片、视频片段、音乐和一段文案，变成一条能直接发布的 mp4。

```
DSH 决定做什么  →  video_* 工具确定性地执行
```

**插件只提供确定性工具，流程与创作决策全部归 DSH。** 没有"一键出片"命令，因为镜头顺序、节奏、时长、选哪张图——这些都是创作判断，不该由工具替你决定。

- 工具清单、契约、设计取舍：[docs/插件设计规格.md](docs/插件设计规格.md)
- **功能全解（12 工具 / 58 action 索引 + core 模块地图 + CLI 清单）**：[docs/功能全解.md](docs/功能全解.md)
- **工具重组方案（前后对照、成本账、审计发现的 18 条缺陷）**：[docs/工具重组方案.md](docs/工具重组方案.md)
- 声音工具（创建/识别/质量/录制/噪音）参考：[docs/声音工具.md](docs/声音工具.md)
- 成片验收套件（28 条确定性用例）：[docs/质量检查.md](docs/质量检查.md)
- **桌面自动化已拆成独立插件**：`dsh-computer-use`（工具族 `computer_*`）
- **读图取字已拆成独立插件**：[dsh-ocr](https://github.com/Cangjier/dsh-ocr)（工具族 `text_*`）——本插件不再包含 OCR 引擎、读字取坐标与字幕回读

---

## 工具

插件注册 **12 个工具、53 个 action**（不含已迁出的 `dsh-ocr`），分两层：**常驻 schema 只放"选择所需"**（做什么、必填什么、最易犯的错），**完整细节按需读** `video_guide`——参数必填与默认、返回值、耗时、陷阱、示例全部可从 guide 取回，不必常驻。同一份散文只有一个来源（`src/tools/registry.mjs`），schema 与 guide 都由它派生，**不可能互相矛盾**。

| 工具 | action | 做什么 |
| --- | --- | --- |
| `video_guide` | `overview` `playbook` `rules` `tool` `action` | **按需的完整能力目录**：每个 action 的参数必填与默认、返回值、耗时、陷阱、示例、相邻动作；10 组全局规则与成本矩阵；8 条端到端流程 |
| `video_env` | `probe` `presets` `scan` | 环境自检、画布预设、素材盘点（只读事实） |
| `video_setup` | `install_ffmpeg` `install_audio` `install_matte` | 供应：装/卸 ffmpeg、YAMNet、U²-Net |
| `video_narrate` | `synthesize` `to_cues` `srt_write` `srt_read` `layout` `transcribe` | 文案→配音+逐词时间戳；断句；SRT 读写；字幕排版；**语音转文字** |
| `video_plan` | `check` `duration` `fields` `diagnose` | 计划校验、精确时长、字段速查、客观问题诊断 |
| `video_render` | `scene` `assemble` `finalize` `deliver` `build` | 单镜头、拼接、合成、交付、整链 |
| `video_inspect` | `verify` `media` | 成片验收、媒体元信息 |
| `video_gen` | `models` `generate` `image_models` `image` | 方舟模型发现；**文生视频**；**文生图** |
| `video_analyze` | `sample_frames` `audio_events` `audio_status` `matte` `matte_status` | **自适应抽帧**、**音频事件识别**、**抠像** |
| `video_audio_build` | `tone` `assemble` `restore` `record` | **造与修声音**：参数全指定的测试信号、采样级拼轨、显式修复链、定时录音 |
| `video_audio_measure` | `identify` `speech_map` `loudness` `levels` `integrity` `sync` `noise` `devices` | **量声音**：声明 vs 实际、语音/静音图、EBU R128、削波与直流、帧链完整性审计与修复、双轨偏移与漂移、噪声底与工频交流声、采集设备枚举 |
| `video_qc` | `cases` `check` `structure` `picture` | **成片验收套件**：28 条确定性用例（容器/画面/声音/旁白时序/交付物），逐条给出期望、实测、证据与 pass/fail/skip；用例文件可调阈值与级别；容器事实、画面事实可单独查 |

**先说清楚边界**：`scan` 只盘点不取舍（重复图**标注**而非删除）；`check` 只判断不修改；`diagnose` 只报客观事实（"静止图没给 motion"），不报品味（"这个镜头该放前面"）；`sample_frames` 报"哪一帧动了、动了多少"和选中它的理由，不报"这个运镜好不好"；`audio_events` 报"这一段是什么声音"，不报"配乐合不合适"；`matte` 报"这是主体"，不报"抠得好不好"；`video_audio_build` / `video_audio_measure` 的每个 action 也只报数字或写出参数完全指定的文件——它不会说"这段录音能用"；`video_qc` 的判断全部来自 plan、用例文件或文档里写明的默认值，它给的是 `expected` vs `actual` 和通过与否，**期望值构不出来时是 `skip` 加原因，不是通过**。`video_gen` 是**唯一不满足"同输入同输出"**的工具——同 prompt 不同结果，它是执行器不是确定性算子。

**读图取字不在本插件里了**：`video_inspect` 曾经有 `ocr` / `find_text` / `ocr_status`，`video_setup` 曾经有 `install_ocr`，`video_qc` 曾经有 `subtitle_ocr` 与"烧录字幕可被 OCR 读回"用例。它们连同 OCR 引擎、WinRT 回退、坐标回算与 `vendor/ocr/` 一起搬到了 **`dsh-ocr`**（工具族 `text_*`）。理由很直接：识别文字需要引擎、安装路径和一套自己的坐标空间，而这些跟"把素材渲染成成片"没有关系。装 `dsh-ocr` 后：读字 `text_read {action:"read"}`，定位 `text_find {action:"find"}`，装引擎 `text_setup {action:"install"}`，字幕回读 `text_read {action:"verify"}`。

---

## 安装

插件已装进 `desktop` profile。装到别的 profile：

```powershell
# 用插件管理器，spec 指向本仓库
#   plugin_manager install_bundle  target = C:\Users\Admin\Documents\GitHub\video-factory
# 或手工：profile 的 package.json 加依赖与 bundle 行
#   "video-factory": "link:C:/Users/Admin/Documents/GitHub/video-factory"
```

装好后 `video_*` 工具**当场可用，不需要重启**（实测 `application: "applied"`）。

**修改插件源码后需要重启 DSH**：Node 按路径缓存 ES 模块，重新启用插件不会重新导入模块。

**读图取字单独装**：`dsh-ocr` 是另一个 bundle（[Cangjier/dsh-ocr](https://github.com/Cangjier/dsh-ocr)），同样用插件管理器装即可。两者互不依赖：只装本插件就没有 `text_*` 工具，只装 `dsh-ocr` 也能读字（它会自己找 ffmpeg，找不到就只读静态图）。

### ffmpeg

一份 ffmpeg 静态构建（含 libx264/libx265/libass），装在**共享目录** `~/.dsh-plugins/ffmpeg/bin/`。
它不属于某个插件：`dsh-ffmpeg`、`dsh-ocr`、`dsh-tts`、`dsh-video-audio`、`video-factory` 读的是同一份，
所以一个 200 MB 的构建在磁盘上只有一份。换机器时：

```
video_setup {action: "install_ffmpeg"}
```

或用命令行：`node src/bin/vf.mjs install`。发现顺序是 `DSH_FFMPEG`（或 `VIDEO_FACTORY_FFMPEG`）环境变量
→ `~/.dsh-plugins/ffmpeg/bin/` → 本插件 `vendor/ffmpeg/bin/`（旧位置）→ `PATH`，报告里的 `source`
会说清哪一条命中。`DSH_PLUGIN_HOME` 可以把整个共享根换到别处（比如 D 盘）。

### 读图取字：已迁到 `dsh-ocr`（独立插件）

本插件**不再读文字**。`video_inspect` 的 `ocr` / `find_text` / `ocr_status`、`video_setup` 的 `install_ocr`、
`video_qc` 的 `subtitle_ocr` 与"烧录字幕可被 OCR 读回"用例，连同 OCR 引擎、WinRT 回退、裁剪放大与坐标回算、
`vendor/ocr/`，全部搬到了同目录的 **`dsh-ocr`**（工具族 `text_*`）。

拆开的理由不是"功能太多"，而是**依赖方向不对**：识别文字需要引擎、引擎安装路径、一套自己的坐标空间
（裁剪偏移 + 放大倍数要回算到调用者图像的像素系），而渲染成片一件都不需要。把它们绑在一起，
只读一张截图也要拖上整个视频工具链。

| 要做的事 | 现在用 |
| --- | --- |
| 读出图上的文字（带像素框与置信度） | `text_read {action:"read", target:"截图.png", region:"600,100,620,56", scale:"auto"}` |
| 按文字找位置（返回可点的中心点） | `text_find {action:"find", target:"截图.png", needle:"始终安装"}` |
| 装/查/删离线 OCR 引擎 | `text_setup {action:"install"}` / `{action:"status"}` / `{action:"remove"}` |
| 回读烧录字幕，和 SRT 逐条比对 | `text_read {action:"verify", target:"out/final.mp4", srt:"out/narration/voiceover.srt"}` |

安装：仓库在 [Cangjier/dsh-ocr](https://github.com/Cangjier/dsh-ocr)（本机同目录克隆 `../dsh-ocr` 即可），装法与插件管理方式同本插件。
**没装 `dsh-ocr` 时本插件一切照常**——它只是不再有读字能力，渲染、配音、字幕、验收都不受影响。

### 云端生成（可选）

只有火山方舟一家。需要环境变量 `ARK_API_KEY`——**且必须让 DSH 进程能看到它**（设成系统环境变量后重启 DSH）。没有 Key 时**只有 AI 生成不可用**，本地剪辑、配音、字幕全部照常。

商用前注意两点：**Edge TTS 的商用授权不明确**，商用一律换 CosyVoice / Azure；**AI 生成内容有标识义务**，公开发布前加显式水印。

### 语音转文字（可选，需另开一个 bundle）

`video_narrate {action:"transcribe"}` 能读出**已有**视频或音频说了什么。它不自己实现识别，而是调用 DSH 自带的本地识别 Provider（SenseVoice + Silero VAD，**无需 Python、无需 GPU、完全离线**）。

**前提**：在「设置 → 插件管理」里启用 `@deepseek-ai/dsh-experimental-voice-input-bundle`，然后重启 DSH。

| 项 | 说明 |
| --- | --- |
| 首次使用 | 自动下载模型约 **239 MB**（INT8），校验 SHA-256，缓存到 `~/.dsh/speech-to-text/sensevoice`，之后完全离线 |
| 模型来源 | HuggingFace 与 HF-Mirror 双源自动探测，失败自动换源 |
| 语种 | `auto` / `zh` / `en` / `yue` / `ja` / `ko` |
| 单次上限 | 宿主限制每次请求 **4 MB**，约 131 秒；更长的音频会自动切分 |
| 切分策略 | 用 `silencedetect` 找**自然停顿**处切，避免切断词；找不到停顿才按上限硬切，并在返回值里标注 |
| 精度 | **整句级，没有逐词时间戳**（服务只支持完整录音转写）。要逐词精度请用 `video_narrate {action:"synthesize"}` |

没有启用时它不会让插件失效——只会明确提示你去启用哪个 bundle。

---

## 音频事件检测（可选，强烈建议装）

**转录解决"说了什么话"，这一项解决"这是什么声音"**——是背景音乐、是环境噪音、还是静音。剪片子卡点要用的是后者，而它以前完全读不出来。

```
video_setup {action: "install_audio"}        # 装 YAMNet + WASM 运行时，约 28 MB
video_analyze {action: "audio_events", target: "out/final.mp4"}
```

输出是**逐窗的标签 + 时间点**，时间点可直接用于剪辑：

```
18.50s，37 个分析窗（分类 37，静音 0）
  Music        32 次  1.92, 2.4, 2.88, 3.36, 3.84, 4.32, 4.8, 5.76 …
  Chirp tone    3 次  0.48, 0.96, 1.44
  Sine wave     5 次  0.48, 0.96, 1.44, 1.92, 2.88
```

| 项 | 说明 |
| --- | --- |
| 模型 | **YAMNet**（AudioSet **521 类**，ONNX）。与参考项目用的 PANNs 同一套本体，标签语义可直接对比 |
| 运行时 | **WASM**，不装 Python、不要 GPU、无原生库 |
| 体积 | 模型 15.39 MB + 运行时 13.01 MB = **28.40 MB**（比 OCR 引擎的 44.7 MB 还小） |
| 速度 | 单窗实测 **68–81 ms**；窗长 0.96 s、跳步 0.48 s，**每步有 480 ms 预算**，用掉不到两成 |
| 几何 | 16 kHz 单声道；窗口 15360 采样、跳步 7680 |
| 静音 | RMS 低于 `silenceRms`（默认 0.002）的窗报 `silent: true`，**不强行贴标签** |
| 校验 | 模型按 **sha256**、运行时按 npm **sha512 integrity** 硬校验后才落盘；`install_audio` 幂等，已装且校验通过则跳过 |
| 网络 | 自动走系统代理（见"踩过的坑"）。如果托管方完全不可达：`install_audio {archive:"D:/模型"}` 指向一个含 `yamnet.onnx` + `yamnet_class_map.csv` 的目录，或直接指向 `.onnx` 文件——**sha256 照样硬校验** |
| 失败安全 | 模型先落到临时目录、校验通过才移入。下载中断**不会**破坏已装好的树（实测：两次 `fetch failed` 后 128/128 校验仍全绿） |
| 删除 | `video_setup {action:"install_audio", remove: true}`（**会删掉共享目录里的 YAMNet 模型，连带删掉 `lib/onnxruntime-web`——抠像的运行时也在那里，抠像会一起不可用**） |
| 不做 | **不建议商用前跳过来源核对**。模型来源链见下 |

**为什么不用原生 `onnxruntime-node`**：它解包 **245.7 MB**（三平台 × 两架构的原生库），并且会打破本插件"纯 ESM、无依赖边"的性质。实测两条路径在同一个窗上**分数一致到小数点后六位**（0.977061 vs 0.977062），所以选了小的。

**来源必须如实说**：权重经过两次个人转存，没有官方发布哈希。

```
Google YAMNet（Apache-2.0，TF-Hub）
  → jafet21/yamnetonnx → niobures/YAMNet → ~/.dsh-plugins/models/yamnet/yamnet.onnx
```

清单里记录的 sha256 是**首次落盘时的完整性锚点**，用于防篡改与复现，**不构成来源合法性证明**。完整溯源写在 `~/.dsh-plugins/models/yamnet/SOURCE.json`。

---

## 自适应抽帧

均匀抽帧会把预算浪费在静止镜头上，又漏掉真正的那一刀。`sample_frames` 解码一份灰度代理流，逐帧与前一帧做**平均绝对亮度差**，让剪切点和运动自己冒出来：

```
video_analyze {action: "sample_frames", target: "out/final.mp4", extract: true}
```

**每一帧都带选中理由**，这是它区别于"给我 N 帧"的地方：

| reason | 含义 |
| --- | --- |
| `first_frame` | 第一帧永远选中，保证不会抽成空 |
| `scene_change` | 场景分 ≥ `sceneThreshold`（默认 30）→ 硬切 |
| `motion` | 运动分 ≥ `motionThreshold`（默认 5） |
| `periodic` | 分不够但到了 `targetFps` 的节奏（默认 1 fps） |
| `max_interval_fallback` | 长期静止的兜底，`minFps` 决定（默认 0.25 fps） |

实测在一条 4 段纯色合成视频上，三处剪切点全部命中，分数 46.0 / 46.0 / 64.9。

`extract: true` 会把选中的帧写成 JPEG，**直接交给 `read_image` 看**——分值负责"哪里要紧"，眼睛负责"画面好不好"。两者不是替代关系。

**分值只在同一探测几何下可比**：它是 0–255 的平均绝对亮度差，改 `probeFps` 或探测分辨率就会变。每次返回都会回显实际用的几何与阈值。

---

## 纯色背景替换（绿幕）

**不需要任何模型。** 纯色背板直接走 ffmpeg `colorkey`，开销基本只有解码。只有背景**不是**纯色时，才需要 `video_analyze {action:"matte"}` 那条学习式路径。

```jsonc
{
  "id": "s01", "kind": "image", "source": "material/主持人口播.jpg",
  "chroma_key": {
    "color": "#00B140",      // 要抠掉的颜色
    "similarity": 0.3,       // 越大抠得越狠
    "blend": 0.1,            // 边缘过渡
    "background": "#102040", // 替换背景（目前仅纯色）
    "spill": true            // 去溢色：绿幕反光留在主体边缘的绿边
  }
}
```

**必须给 `background`**，否则看不出效果：抠像产生的是 alpha，而镜头最后会转成 `yuv420p`，alpha 在那一步被丢弃。没有背景可合成时，滤镜等于没生效。

去溢色的通道由 `color` **自动推断**（绿幕去绿、蓝幕去蓝），所以不会出现"绿幕配蓝色去溢色"这种错配。

实测（1920×1080，30 fps）：绿幕完全消失，主体完整保留，背景正确铺上。

| 限制 | 说明 |
| --- | --- |
| 与 `overlays[]` 不能同时用 | 合成会把滤镜图拆成多段并引入第二个输入，文字叠加需要另接一段。组合使用**直接报错**，而不是产出一张时序错误的图 |
| 背景仅支持纯色 | 图片/视频背景需要第二个输入，尚未实现 |

**默认值偏保守**，这是刻意的：`similarity` 是 RGB 距离，有用值取决于布光、溢色和压缩。我拿合成板标定过，发现**一大段取值都能完美分离**——也就是说合成板根本选不出正确值，只有真实素材能。所以默认宁可多留一点，也不要把主体吃掉，并把实际生效的数值回报出来供你对着真实帧调。

---

## 抠像：背景不是纯色时（可选）

绿幕用上面的 `chroma_key`，**免费且精确**。背景是任意照片或运动镜头时，才需要学习式抠像。

```
video_setup {action: "install_audio"}                            # 先装共享运行时
video_setup {action: "install_matte"}                            # 4.36 MB
video_analyze {action: "matte", target: "素材/人物.jpg"}          # 输出透明背景 PNG
video_analyze {action: "matte_status", duration: 20}             # 先问要花多少时间
```

| 项 | 说明 |
| --- | --- |
| 模型 | **U²-Net p**（显著性目标抠像，ONNX），**Apache-2.0** |
| 体积 | **仅 4.36 MB** —— 推理运行时**与音频事件检测共用**，不重复下载 |
| 速度 | 实测 **1.9–2.4 秒/帧**（320×320，单线程 WASM，CPU） |
| 几何 | 输入固定 `[1,3,320,320]`；输出 7 个 `[1,1,320,320]`，**首位是融合预测** |
| 输出 | 带 alpha 的 PNG；遮罩被放大回原尺寸，边缘靠 `feather` 平滑 |
| 校验 | sha256 硬校验；`modelArchive` 可指向本地 `.onnx`；幂等 |
| 删除 | `video_setup {action:"install_matte", remove: true}`（**保留共享运行时**，不会顺手弄坏音频检测） |

### 视频抠像：`mask_fps` 由你（或 DSH）决定

计划里给镜头加 `matte` 块，就得到逐帧抠像并换背景：

```jsonc
{
  "id": "s01", "kind": "video", "source": "素材/人物.mp4",
  "matte": {
    "enabled": true,
    "mask_fps": 8,            // ← 遮罩帧率：越高过渡越顺，耗时越长
    "interpolate": "blend",   // ← hold（保持）| blend（相邻遮罩交叉淡入）
    "background": "#102040",  // 必须给，否则 alpha 会被编码器丢掉
    "feather": 1              // 边缘羽化，1–3 像素能去掉"贴纸感"
  }
}
```

**先调 `interpolate`，再考虑抬高 `mask_fps`。** 这是实测结论，不是理论：

| 模式 | 48 帧里变化的帧 | 边缘锐度 | 额外耗时 |
| --- | --- | --- | --- |
| `hold`（默认） | **7** | 1.009 | — |
| `blend` | **42** | 0.996（−1.3%） | **+9 ms** |
| `motion`（已否决） | 36（**丢帧**，只剩 37 帧） | 1.009 | +88 ms |

`blend` 把平滑度提高 6 倍，而代价几乎为零——相对每个遮罩约 **2.1 秒**的推理成本，9 ms 可以忽略；
边缘软化 1.3% 对遮罩而言正是想要的效果。所以 **`mask_fps: 4` + `blend` 比 `mask_fps: 8` + `hold`
更平滑、也更便宜**。

`motion`（`minterpolate` 运动插值）实测**被否掉**：会丢帧、成本翻倍，边缘锐度却不比 `blend` 好。
在单通道 alpha 上估算运动是没有回报的复杂度。

**为什么 `mask_fps` 是个参数而不是内置默认**：它是"过渡平滑度 ↔ 渲染耗时"的权衡，取决于镜头里有没有转身、手势、快速运动——这是**创作判断**，归 DSH。插件执行给定的帧率，并如实回报成本。

实现上，遮罩序列以 `mask_fps` 声明的帧率喂给 ffmpeg，于是**每个遮罩被保持到下一个遮罩出现**。
`interpolate: "blend"` 在这之上做相邻遮罩的交叉淡入，把台阶换成斜坡；`hold` 则保留台阶，
因为那正是"这个帧率"的字面含义。

| mask_fps | 1 分钟 30fps 成片的推理耗时（实测外推） |
| --- | --- |
| 4 | 约 13 分钟 |
| 8 | 约 26 分钟 |
| 12 | 约 39 分钟 |
| 30（逐帧） | 约 52 分钟 |

**实测硬件上限**：无 GPU、CPU + 单线程 WASM。16 线程实测只有 **1.08x** 加速，所以不做线程池——这条路的天花板就在这里。

| 限制 | 说明 |
| --- | --- |
| 与 `chroma_key` 不能同时用 | 两者都是"把主体从背景分离"，同时配置会先抠一次再抠一次，直接报错 |
| 与 `overlays[]` 不能同时用 | 合成把滤镜图拆成多段并引入第二个输入，文字叠加需要另接一段，尚未实现 |
| 背景仅支持纯色 | 图片/视频背景需要第二个输入，尚未实现 |

---

## DSH 能"看懂"一条视频吗？

能看画面，也能识别声音类别了。但有几件事仍然做不到，分开说清楚：

| 能力 | 状态 |
| --- | --- |
| 看单张图 | ✅ 模型原生支持（`read_image`） |
| 找"哪一刻值得看" | ✅ `video_analyze {action:"sample_frames"}` —— 剪切点与运动自动选中，带理由与分值 |
| 抽帧落盘再逐张看图 | ✅ `sample_frames {extract:true}` 写出 JPEG，路径直接可读 |
| 读出画面上的文字与坐标 | ✅ 独立插件 `dsh-ocr`：`text_read {action:"read"}` / `text_find {action:"find"}` |
| 语音转文字 | ✅ 启用语音 bundle 后，`video_narrate {action:"transcribe"}` |
| 识别音乐 / 环境音 / 音效 | ✅ `video_analyze {action:"audio_events"}`（需先 `install_audio`） |
| 抠出主体（绿幕） | ✅ `plan.json` 的 `chroma_key`，零模型零成本 |
| 抠出主体（任意背景） | ✅ `plan.json` 的 `matte` 或 `video_analyze {action:"matte"}`（需先 `install_matte`）；**约 2 秒/帧** |
| 逐帧扫全片的**画面含义** | ⚠️ 可行但慢、费上下文；关键帧已能自动筛，但每张图仍要进上下文 |
| 判断**响度**是否合规 | ⚠️ 渲染链用 EBU R128 归一，但**读不出"这段响不响"**的感知判断 |
| **判断运镜舒不舒服** | ❌ **本质限制**：差值法能给出"哪里在动、动得多剧烈"，给不出"这个推拉好不好看" |
| 判断**卡点准不准** | ⚠️ 已有两项输入（音频事件的时间点 + 画面运动的时间点），但"准不准"的结论仍需你下 |

最后两条是本质限制，不是没实现：可以确认"这一帧画面对不对""这一段是什么声音"，但**审美判断仍需人的眼睛和耳朵**。

---

## 用命令行

同一批操作也暴露成 CLI，便于调试和跑测试：

```powershell
node src/bin/vf.mjs doctor
node src/bin/vf.mjs scan examples/demo/material --json
node src/bin/vf.mjs check --plan examples/demo/plan.json
node src/bin/vf.mjs narrate --text script.txt --out narration
node src/bin/vf.mjs render --plan examples/demo/plan.json --all --out out
node src/bin/vf.mjs render --plan plan.json --scene s03 --force   # 只重渲染一个镜头
node src/bin/vf.mjs make-test-material --dir tmp/material --scenes 6
node src/bin/vf.mjs install-audio                                  # 装音频事件模型 + WASM 运行时
node src/bin/vf.mjs frames out/final.mp4 --probe-fps 6             # 自适应抽帧
node src/bin/vf.mjs audio out/final.mp4 --top-k 2 --min-score 0.2   # 音频事件识别
node src/bin/vf.mjs install-matte                                  # 装抠像模型（4.36 MB）
node src/bin/vf.mjs matte 素材/人物.jpg --feather 1                 # 抠出主体，输出透明 PNG
```

读字没有命令行入口——它与本插件无关了。`dsh-ocr` 自己带 CLI：
`node ../dsh-ocr/src/bin/ocr.mjs read 截图.png --region 600,100,620,56 --scale auto --find "始终安装"`。

## 端到端验证

```powershell
node --test "tests/*.test.mjs"                                    # 286 个离线用例
node src/bin/vf.mjs render --plan examples/demo/plan.json --all --out examples/demo/out
node src/bin/vf.mjs probe examples/demo/out/final.mp4
```

跑完检查 `out/build-report.json` 的 `problems` 数组——**空数组才算干净交付**，非空必须翻译给用户。

---

## plan.json

计划是 DSH 与插件之间**唯一的契约**。完整字段速查：

```
video_plan {action: "fields"}
```

```jsonc
{
  "version": 1,
  "meta": { "title": "我的成片", "preset": "vertical-short", "quality": "medium" },
  "audio": { "voiceover": "narration/voiceover.mp3", "music": "素材/bgm.mp3",
             "music_gain_db": -20, "duck": true, "fade_out": 2.0 },
  "subtitles": { "enabled": true, "source": "narration/voiceover.srt", "burn": true },
  "scenes": [
    { "kind": "image", "source": "素材/01.jpg", "duration": 3.5, "motion": "zoom-in",
      "overlays": [{ "text": "开场标题", "anchor": "bottom-center" }] },
    { "kind": "video", "source": "素材/clip.mp4", "duration": 5.0, "fit": "cover", "start": 2.0,
      "transition": { "type": "fade", "duration": 0.5 } },
    { "kind": "color", "color": "#101820", "duration": 2.0 },
    { "kind": "generated", "duration": 5,
      "generate": { "mode": "text-to-video", "prompt": "清晨的城市天际线，缓慢推近", "resolution": "720p" } }
  ]
}
```

关键字段：`motion`（静止图运动，建议每镜轮换）、`fit`（`cover` 裁切填满 / `contain` 留黑边 / `blur-pad` 模糊填充）、
`transition`（进镜转场，**有效重叠 = min(转场时长, 本镜×0.5, 上一镜×0.5)**）、`duck`（说话时压低音乐）。

---

## 架构

```
index.mjs              插件入口：apply / inject / 工具注册
src/tools/*.mjs        工具 schema 与 action 实现（唯一知道 DSH 存在的层）
src/core/*.mjs         确定性内核：纯 ESM、零第三方依赖、可离线单测
```

静态依赖不在仓库里，在**共享目录** `~/.dsh-plugins`（六个插件共用；`DSH_PLUGIN_HOME` 可换根）：

```
~/.dsh-plugins/ffmpeg/bin/            一份 ffmpeg 静态构建，全家共用
~/.dsh-plugins/models/yamnet/         YAMNet 模型 + 类别表（可选；装之前 audio_events 不可用）
~/.dsh-plugins/models/u2netp/         U²-Net 抠像模型（可选）
~/.dsh-plugins/lib/onnxruntime-web/   WASM 推理运行时（抠像与音频事件共用，只装一次）
vendor/ffmpeg/  vendor/audio/  vendor/matte/   旧位置，仍然读（装过就不用搬）
```

读图取字的引擎目录已经随能力一起搬到 `dsh-ocr`，它装在 `~/.dsh-plugins/ocr/`。

**内核不依赖 DSH**，所以"确定性"可离线证明。渲染分四阶段，每阶段独立可调、独立缓存：

| 阶段 | 做什么 | 缓存键 |
| --- | --- | --- |
| `scene` | 每个镜头统一画布/帧率/像素格式/时间基，**音轨长度精确等于镜头时长** | 镜头参数指纹 |
| `assemble` | 无转场走 concat 流复制；有转场走单条 `xfade` 滤镜图 | 画布+顺序+转场指纹 |
| `finalize` | 混音（sidechain 闪避）+ EBU R128 + 字幕烧录，**视频最多重编码一次** | 时间线+音频+字幕指纹 |
| `deliver` | 封面帧、缩略图总览、验收报告 | 每次重做（便宜） |

改一个字幕样式只有 `finalize` 重跑；改一个镜头只有那一个镜头重跑。

**为什么先统一规格**：concat demuxer 对 `time_base`、SAR、`pix_fmt`、音频采样率任何一项不一致都会**静默出错**——不是报错，而是画面卡住、音频错位、播放器在接缝处停下。统一规格是让后续操作安全的前提。

---

## 踩过的坑（都已在实现中修正）

| 坑 | 表现 | 处理 |
| --- | --- | --- |
| 只加 `-nostdin` 不加 `-y` | 重跑时 ffmpeg 要交互确认，退出码 1，stderr 只有一行 `Duration:` | 两者总是一起加 |
| ffprobe 不接受 `-y` | `Failed to set value '-y' for option 'nostdin'` | ffmpeg 与 ffprobe 用不同的前缀 |
| ffprobe 对损坏文件返回 **exit 0** | 只是把 width/height 报成 0，真错误在 stderr | `scan` 检查尺寸，不只看探测是否成功 |
| 本机 ffmpeg 无 fontconfig | 字体必须显式指定 | 把 CJK 字体拷进工作目录按相对路径引用 |
| 中文内联进滤镜串 | 被 BOM / 编码 / 冒号转义毁掉，静默渲染成空白 | 一律走 `textfile=`，绝不内联 |
| 滤镜图输出不能 stream copy | `Filtering and streamcopy cannot be used together` | 滤镜图只含音频时才能 `-map 0:v -c:v copy` |
| `amix` 默认减半 | 混音后半音量 | 总是 `normalize=0` |
| `zoompan` 整数栅格 | 静止图运动有可见抖动 | 先 4 倍超采样再 `zoompan` |
| 感知哈希分不清渐变 | 合成渐变图会被互相判为重复 | 已知限制，用真实照片测去重 |
| Windows 260 字符路径 | 超限报错极具误导性 | 提前检查路径预算（默认 200） |
| Windows 没有能解 `.7z` 的工具 | `tar.exe` 报 `LZMA codec is unsupported`，7-Zip 通常没装 | 安装器顺带取官方 `7zr.exe`（0.6 MB）解包。这条教训随 OCR 引擎一起搬到了 `dsh-ocr` |
| OCR 坐标乘错方向 | 放大图的框要**除以**倍数、**再加**裁剪偏移；反了就是平方级偏移，点击落到别处 | 在一处换算、单测覆盖旋转框与偏移+缩放组合。现属 `dsh-ocr` |
| 常驻 OCR 引擎拖住进程 | 短命脚本会等空闲计时器（120 s）才退出 | 插件卸载时释放会话，测试与 CLI 显式释放。现属 `dsh-ocr` |
| **系统代理对 Node 不可见** | `install_*` 从插件里报 `fetch failed`，但同一个 URL 在 PowerShell 里 **1.4 秒就取到**。Node 的 `fetch` 既不读 Windows 注册表代理，也不认 `HTTPS_PROXY`（Node 24 实测：设了变量、加了 `NODE_USE_ENV_PROXY=1`，仍然直连超时）。而 `Invoke-WebRequest`、浏览器、其它 Windows 程序都走注册表代理 | 自己读注册表 `ProxyEnable`/`ProxyServer`，用 `http CONNECT` + `tls` 建隧道；`undici` 在 Node 24 里**不可导入**，所以只能用内置模块手写 |
| 代理下漏掉重定向 | HF 的 `/resolve/` 返回 **307/302** 跳 CDN。第一版 `httpFetch` 不跟重定向，于是把 278 字节的 "Temporary Redirect" 页面当成模型下载并去校验哈希 | 跟随重定向（上限 8 跳），并在每跳后排空响应体 |
| **静音时间线让 `loudnorm` 产出 NaN** | 没有配音也没有音乐的 plan 在最后一步失败：`[aac] Input contains (near) NaN/+-Inf`。报错只说编码器，**完全没提响度**，靠逐段二分才定位到 `loudnorm`。此前**任何空音频块的 plan 都渲染不出成片** | 静音源跳过 `loudnorm`（静音没有响度可归一），只固定编码器要的采样格式。回归测试 `tests/finalize.test.mjs`（已回退验证过它真的会失败） |
| **`lavfi` 源默认无限长** | 抠像背景输入不加 `-t` 时 `overlay` 无休止产帧；画面被输出 `-t` 截住而音频耗尽，又死在 AAC 编码器上，报的还是 NaN | 背景输入按镜头时长加 `-t` |
| **`-v error` 把测量一起静音** | `signalstats` / `metadata=print` 走日志系统，`-v error` 下 `spawnSync` 拿回空字符串，看起来像"没有数据" | 需要测量时用 `-v info` |
| **语音合成漏掉了代理** | `video_narrate {action:"synthesize"}` 报 `ECONNRESET`，而**同一台机器、同一个进程**里 `install_*` 下载一切正常——"装了代理就只剩配音不可用"。代理只被 `install.mjs` 学会过一次，`ws.mjs` 建连用的还是裸 `tls.connect` | 代理逻辑抽成 `core/proxy.mjs`（`install.mjs` 原样再导出，调用方不受影响），`ws.mjs` 建 socket 前先问 `systemProxy()`，有代理就走 CONNECT 隧道。`connect()` 仍同步返回 emitter，所以 `tts.mjs` 一行没改。回归测试 `tests/proxy.test.mjs` 用**本地假代理断言真正到达的 `CONNECT` 行**，不依赖公网 |
| **edge-tts 音频里嵌了 CRLF，丢了 20%** | 逐段配音拼进视频后"生涩、不连贯、不清晰、不协调"，而且整条音轨比时码短约 3 秒、**最后一句没有声音**（字幕照旧在走）。真因不在服务端音质：服务端每条 `Path:audio` 消息是 `[2字节 headerLength][头部][\r\n][音频]`，客户端按 `headerLength` 切片，把这 2 字节留在了文件里——每 720 字节（5 个 MP3 帧）一个 2 字节缺口，解码器每个缺口报废一帧。逐帧扫描：`breakCount=102`、`gapHistogram={2:102}`、缺口字节恒为 `0d0a`；解码 12.250 s 的文件只解出 9.792 s | `tts.mjs` 不再按 `headerLength` 切片，改为**在声明长度两侧找 MPEG 同步字**（`audioBodyOffset`）：两种 framing 都对，格式变了也不会再错。`video_audio_measure {action:"integrity"}` 逐帧报缺口与字节，`repair:true` 只删帧间窄缺口、原文件不改写；测试用真实 libmp3lame 编码再注入 CRLF，断言"检测 → 解码确认损失 → 修复回原字节" |
| **ffprobe 会把某些 WAV 误判成 MPEG-TS** | 48 kHz 单声道、数据恰好长得像 TS 同步字节的 WAV：`ffprobe` 与 `ffmpeg` 自动探测都报 `End of file` 退出，文件其实完全正常（`-f wav` 一指定就能读） | `describeAudio()` 先试 ffprobe、失败改读 ffmpeg 的输入报告；`runAudio()` / `decodePcm()` 失败时按**文件头**（RIFF/WAVE、ID3、`0xFFEx`、ftyp、fLaC…）显式指定 `-f` 重试一次，并在结果里标出 `answeredBy` / `forcedFormat`。单测覆盖文件头识别与 ffmpeg 输入报告解析 |
| **ffmpeg 的 `sine` 源比满刻度低约 18 dB** | 用 `sine=frequency=..` 生成"−6 dBFS"的信号，实测峰值 −24 dBFS，标称电平全是假的 | 正弦与扫频改用 `aevalsrc`（按构造满刻度），`levelDbfs` 才成立；端到端测试断言 −6 dBFS 的正弦峰值误差 < 0.05 dB |
| **`astats` 的统计走日志系统** | `-v error` 下 `Number of samples` / `Peak level dB` 一行都不打印，看起来像"这个文件没有统计" | 所有统计读取统一 `-v info -nostats`（与上面 `signalstats` 是同一条教训的第二次） |
| **毫秒级 `adelay` 拼不出精确时间轴** | 十几段逐段合成再 `adelay` 拼接，每段差几十个采样点，累计成可听见的偏移 | `assemble` 用 `atrim=start_sample/end_sample` + `concat` + `apad=whole_len`，位置就是采样点编号，写完再解码比对采样数（`verification.exact`） |

完整清单见 `docs/插件设计规格.md` §5.3 与 §12.1（后者的教训：**能用纯函数离线验证的，先在本地测到全绿再打真实服务**）。

---

## 云端生成：只做火山方舟

契约**已用真实 Key 实证**，其中几条推翻了公开资料。

### 视频（Seedance）—— 异步

| 项 | 实测结论 |
| --- | --- |
| 服务端有 `GET /models` | 可直接列出账号可见模型与状态，**不要硬编码模型 id** |
| 公开资料推荐的默认模型 | `doubao-seedance-1-5-pro-251215` **已下线**（`Shutdown`） |
| `duration` | Seedance 2.0 是 **4–15 秒**（1/2/3 与 16 都拒） |
| `service_tier` | **2.0 / 2.0-fast / 2.0-mini 全部不支持**，传了直接报错 |
| 参数支持 | **按「模型 + 模式」分别限定**，不是一套参数通用 |
| 结果 URL | TOS 预签名链接，**24 小时过期**——必须立刻下载落盘 |
| 调用形态 | 提交 → 轮询 → 下载；实测 4 秒片约 **87 秒**完成 |

```powershell
#   video_gen {action: "models"}                    先看有哪些模型（不花钱）
#   video_gen {action: "generate", prompt: "...", duration: 4, resolution: "480p"}
```

### 图像（Seedream）—— 同步

| 项 | 实测结论 |
| --- | --- |
| 端点 | `POST /images/generations`，**同步返回**，没有轮询 |
| 响应 | `data[0] = { url, size: "2496x1664", output_format: "jpeg" }` |
| 尺寸 | 预设字符串（`1k` / `2K`）或 `WxH`；**面积 921,600 – 4,622,220 像素** |
| 越界处理 | **本地先拒**（`512x512` 太小、`8192x8192` 太大），不花钱就暴露错误 |
| 结果 URL | 同样是 **24 小时过期**的 TOS 预签名链接，必须立刻下载 |
| 调用形态 | 同步，实测 2K 图约 **12 秒**，产出 2496×1664 JPEG |
| 模型现状 | `3-0-t2i` 与 `seededit-3-0` 已下线；在售为 `5-0-flash` / `5-0-pro` / `4-0-20260415` |

```powershell
#   video_gen {action: "image_models"}              先看有哪些图像模型（不花钱）
#   video_gen {action: "image", prompt: "...", imageSize: "2k"}
```

命令行同理：`node src/bin/vf.mjs image --prompt "…" --size 2k`

**文件扩展名以服务端报告的格式为准**：调用方写 `cover.png` 而服务端返回 jpeg 时，落地的是 `cover.jpg`。这不是吹毛求疵——下游的 `classify()` 按扩展名判断素材类型，扩展名说谎会让后续步骤走错分支。
