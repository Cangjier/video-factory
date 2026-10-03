/**
 * 字幕几何：逐词时间戳 → 字幕条，以及 SRT 的序列化与解析。
 *
 * 全部是纯计算——不联网、不调用 ffmpeg、不做文件读写——所以断句规则、折行位置、
 * 时间戳格式都能离线对拍。断句、折行、去重、时间戳格式都被逐条钉死
 * 的 `words_to_cues` / `_closes_cue` / `_wrap` / `_dedupe` / `write_srt` / `read_srt` /
 * `scale_cues` / `_format_timestamp`。
 *
 * 有意的差异只有一处，见 {@link wrapText}：Python 折行时会把断点处的分隔符
 * （"，,、 "）`rstrip`/`lstrip` 掉，等于丢一个字符；这里把它保留下来，保证折行不丢字。
 *
 * 另一个容易踩的坑是时间戳取整：Python 的 `round()` 是银行家舍入，而 Edge TTS 的
 * 时间戳大量精确落在 x.5ms 上。为了让 JS 版能逐字节复现 Python 写出的 .srt，
 * 这里照搬了它——实现见下面的 `roundMilliseconds`。
 *
 * @module video-factory/core/srt
 */

/**
 * 一个词的文本与它在音频里的时间（秒）。
 * @typedef {{text: string, start: number, end: number}} Word
 */

/**
 * 一条字幕：序号从 1 开始，text 里可能含一个 '\n'（折行）。
 * @typedef {{index: number, start: number, end: number, text: string}} Cue
 */

/**
 * 句末标点：遇到这些字符就结束一条字幕。与 Python 版 `_SENTENCE_END` 完全一致。
 * @type {string}
 */
export const SENTENCE_END = '。！？!?…；;'

/** 折行时优先在其后断行的分隔符（"，,、 " 及其后的空白）。 */
const BREAK_AFTER = '，,、 '

/** 每行默认字数上限（固定行为）。 */
export const DEFAULT_MAX_CHARS = 18

/** 一条字幕默认最长停留时长，秒（固定行为）。 */
export const DEFAULT_MAX_DURATION = 6.0

/** 超过这个静音时长就另起一条字幕，秒（固定行为）。 */
export const DEFAULT_GAP_BREAK = 0.45

/**
 * 取一个数值选项：只有不是数值（undefined、字符串、NaN）时才回退默认值。
 *
 * `Infinity` 是合法取值——它是关掉某条规则的办法（例如 `gapBreak: Infinity`
 * 就是只按句末标点断句），所以这里不能要求取值有限。
 *
 * @param {unknown} value - 调用方传进来的值。
 * @param {number} fallback - 默认值。
 * @returns {number} 实际使用的值。
 */
function numericOption(value, fallback) {
  return typeof value === 'number' && !Number.isNaN(value) ? value : fallback
}

/**
 * 判断一个词是否是句末词。
 *
 * @param {string} text - 词文本。
 * @returns {boolean} 最后一个字符属于 {@link SENTENCE_END} 时为 true。
 */
export function closesCue(text) {
  if (typeof text !== 'string' || text.length === 0) return false
  return SENTENCE_END.includes(text[text.length - 1])
}

/**
 * 把一条字幕文本折成最多两行。
 *
 * 超过 maxChars 时先在中点附近找分隔符（"，,、 "）断行，找不到就从中间硬切。
 * 折行按字符数，不按词——中文没有空格。
 *
 * **与 Python 版的差异**：`audio.py` 的 `_wrap` 会 `rstrip("，,、 ")` / `lstrip()`，
 * 断点处的那个标点会从字幕里消失（"很好，我们" 折在逗号处会变成 "很好" + "我们"）。
 * 这里把分隔符留在第一行末尾，因此恒有
 * `wrapText(text, n).replace(/\n/g, '') === text.trim()`：不丢字、不重复。
 *
 * @param {string} text - 待折行的文本。
 * @param {number} [maxChars=DEFAULT_MAX_CHARS] - 每行字数上限。
 * @returns {string} 折行结果，可能含一个 '\n'。
 */
export function wrapText(text, maxChars = DEFAULT_MAX_CHARS) {
  const stripped = String(text ?? '').trim()
  const budget = numericOption(maxChars, DEFAULT_MAX_CHARS)
  if (stripped.length <= budget) return stripped

  const midpoint = Math.floor(stripped.length / 2)
  for (let offset = 0; offset < midpoint; offset += 1) {
    for (const candidate of [midpoint - offset, midpoint + offset]) {
      if (candidate > 0 && candidate < stripped.length && BREAK_AFTER.includes(stripped[candidate - 1])) {
        return `${stripped.slice(0, candidate)}\n${stripped.slice(candidate)}`
      }
    }
  }
  return `${stripped.slice(0, midpoint)}\n${stripped.slice(midpoint)}`
}

/**
 * 去掉与上一条文本完全相同的字幕，并把剩下的从 1 重新编号。
 *
 * 语义与 Python 版 `_dedupe` 一致：**只比较文本**（相邻、精确相等），不比较时间；
 * 保留的是先出现的那一条（时间也是先出现那条的时间）。
 *
 * @param {Cue[]} cues - 原始字幕条。
 * @returns {Cue[]} 新数组，入参不被修改。
 */
export function dedupeCues(cues) {
  const result = []
  for (const cue of cues) {
    if (result.length > 0 && result[result.length - 1].text === cue.text) continue
    result.push({ index: result.length + 1, start: cue.start, end: cue.end, text: cue.text })
  }
  return result
}

/**
 * 逐词时间戳 → 字幕条。
 *
 * 累积词，遇到下列任一条件就收一条字幕（与 Python 版 `words_to_cues` 一致）：
 * 词的最后一个字符是句末标点、累计字数达到 maxChars、与下一个词之间的静音达到
 * gapBreak、本条已持续到 maxDuration；输入结束时剩余的词也收一条。最后按
 * {@link dedupeCues} 去重并重新编号。
 *
 * gapBreak / maxDuration 沿用 Python 版的默认值 0.45 / 6.0。如果手里是合成的
 * 时间戳（词间空档偏大），传 `{ gapBreak: Infinity, maxDuration: Infinity }` 即可
 * 只按句末标点断句。
 *
 * @param {Word[]} words - 逐词时间戳，按朗读顺序，单位秒。
 * @param {object} [options] - 可选参数。
 * @param {number} [options.maxChars=DEFAULT_MAX_CHARS] - 每行字数上限，超出按字符折行。
 * @param {number} [options.maxDuration=DEFAULT_MAX_DURATION] - 单条最长时长，秒。
 * @param {number} [options.gapBreak=DEFAULT_GAP_BREAK] - 触发另起一条的静音时长，秒。
 * @returns {Cue[]} 字幕条，index 从 1 开始；start/end 保留原浮点精度。
 */
export function wordsToCues(words, options = {}) {
  const maxChars = numericOption(options.maxChars, DEFAULT_MAX_CHARS)
  const maxDuration = numericOption(options.maxDuration, DEFAULT_MAX_DURATION)
  const gapBreak = numericOption(options.gapBreak, DEFAULT_GAP_BREAK)

  const source = Array.isArray(words) ? words : []
  const cues = []
  let current = []
  let joinedLength = 0

  const flush = () => {
    if (current.length === 0) return
    cues.push({
      index: cues.length + 1,
      start: current[0].start,
      end: current[current.length - 1].end,
      text: wrapText(current.map((word) => word.text).join(''), maxChars),
    })
    current = []
    joinedLength = 0
  }

  for (let position = 0; position < source.length; position += 1) {
    const raw = source[position] ?? {}
    const word = {
      text: typeof raw.text === 'string' ? raw.text : '',
      start: raw.start,
      end: raw.end,
    }
    current.push(word)
    joinedLength += word.text.length

    const next = position + 1 < source.length ? source[position + 1] : null
    const pause = next ? next.start - word.end : 0
    const elapsed = current[current.length - 1].end - current[0].start

    if (
      closesCue(word.text)
      || joinedLength >= maxChars
      || pause >= gapBreak
      || elapsed >= maxDuration
      || next === null
    ) {
      flush()
    }
  }
  flush()
  return dedupeCues(cues)
}

/**
 * 整条时间轴按倍数缩放，用于字幕与重新剪辑过的画面重新对齐。
 *
 * index 与 text 原样保留（Python 版 `scale_cues` 不重新编号）。
 *
 * @param {Cue[]} cues - 原始字幕条。
 * @param {number} factor - 起止时间的乘数。
 * @returns {Cue[]} 新数组、新对象，入参不被修改；时间保留浮点精度，不取整。
 */
export function scaleCues(cues, factor) {
  const list = Array.isArray(cues) ? cues : []
  return list.map((cue) => ({
    index: cue.index,
    start: cue.start * factor,
    end: cue.end * factor,
    text: cue.text,
  }))
}

/**
 * 把毫秒数取整，语义完全等于 Python 的 `round()`：正好落在 .5 时取偶数（银行家舍入），
 * 不是 `Math.round` 的“四舍五入”。
 *
 * 这不是学术细节：Edge TTS 的时间戳是 100ns 刻度，词尾大量落在 x.5ms 上——
 * `examples/demo` 的 89 个词里有 40 个是精确的 .5ms，9 条字幕里有 3 个时间戳因此
 * 与 Python 版差 1ms。要逐字节复现 Python 写出的 .srt，就必须连这个舍入一起搬。
 * 若确实只想要四舍五入，把这里换成 `Math.round` 即可（1 行）。
 *
 * @param {number} value - 非负的毫秒数。
 * @returns {number} 整数毫秒。
 */
function roundMilliseconds(value) {
  const floor = Math.floor(value)
  const fraction = value - floor
  if (fraction > 0.5) return floor + 1
  if (fraction < 0.5) return floor
  return floor % 2 === 0 ? floor : floor + 1
}

/**
 * 秒 → SRT 时间戳 `HH:MM:SS,mmm`。
 *
 * 毫秒取整（同 Python 的 `round()`，含 .5 取偶数）；进位成整秒时，是先合成整数毫秒
 * 再按 3600000/60000/1000 分解，所以自然进到秒，不会输出 `00:00:00,1000`。
 * 负数按 0 处理（同 Python 版）；NaN / Infinity 也按 0（Python 版这里会抛异常，
 * 本实现不抛）。
 *
 * @param {number} seconds - 秒数。
 * @returns {string} `HH:MM:SS,mmm`，时/分/秒补零到 2 位，毫秒补零到 3 位。
 */
export function formatTimestamp(seconds) {
  const value = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const total = roundMilliseconds(value * 1000)
  const hours = Math.floor(total / 3_600_000)
  const minutes = Math.floor((total % 3_600_000) / 60_000)
  const secs = Math.floor((total % 60_000) / 1000)
  const millis = total % 1000
  return (
    `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:` +
    `${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`
  )
}

/**
 * 字幕条 → SRT 文本（不含 BOM）。
 *
 * 与 Python 的 `write_srt` 逐字节一致：每条是 `序号\n起 --> 止\n文本\n`，
 * 块与块之间再空一行，因此结果以换行结尾。序号取 `cue.index`，不重排。
 *
 * @param {Cue[]} cues - 字幕条。
 * @returns {string} SRT 文本；空数组得到空字符串。
 */
export function formatSrt(cues) {
  const list = Array.isArray(cues) ? cues : []
  const blocks = list.map(
    (cue) => `${cue.index}\n${formatTimestamp(cue.start)} --> ${formatTimestamp(cue.end)}\n${cue.text}\n`,
  )
  return blocks.join('\n')
}

/** SRT 时间行：`HH:MM:SS,mmm --> HH:MM:SS,mmm`，毫秒分隔符逗号或点都接受。 */
const TIME_LINE = /(\d+):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/

/**
 * 把匹配到的四段数字换算成秒；毫秒不足 3 位时右补零（"5" 是 500ms，不是 5ms）。
 *
 * @param {string} hours - 时。
 * @param {string} minutes - 分。
 * @param {string} secs - 秒。
 * @param {string} millis - 毫秒，1~3 位。
 * @returns {number} 秒数，保留精度。
 */
function toSeconds(hours, minutes, secs, millis) {
  return (
    Number(hours) * 3600 + Number(minutes) * 60 + Number(secs) + Number(millis.padEnd(3, '0')) / 1000
  )
}

/**
 * 解析 SRT 文本 → 字幕条。
 *
 * 宽容策略与 Python 的 `read_srt` 一致：忽略 BOM；`\r\n`（以及单独的 `\r`）都当换行；
 * 序号缺失、乱序、甚至没有序号都行——序号不参与解析，结果一律从 1 重新编号；
 * 时间行两侧的空格和多余内容会被忽略；毫秒分隔符 `,` 与 `.` 都接受。
 * 单个块里找不到时间行、或者时间行后面没有文本，就跳过这块，不抛异常；
 * 整体无法解析（空串、非字符串、只有序号）时返回空数组。
 *
 * @param {string} text - SRT 文件内容。
 * @returns {Cue[]} 字幕条，按文件顺序。
 */
export function parseSrt(text) {
  if (typeof text !== 'string' || text.trim() === '') return []

  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim()
  const cues = []

  for (const block of normalized.split(/\n\s*\n/)) {
    const lines = block.split('\n').filter((line) => line.trim() !== '')
    const timeLineIndex = lines.findIndex((line) => TIME_LINE.test(line))
    if (timeLineIndex === -1) continue

    const match = TIME_LINE.exec(lines[timeLineIndex])
    if (match === null) continue

    const body = lines.slice(timeLineIndex + 1).join('\n')
    if (body === '') continue

    cues.push({
      index: cues.length + 1,
      start: toSeconds(match[1], match[2], match[3], match[4]),
      end: toSeconds(match[5], match[6], match[7], match[8]),
      text: body,
    })
  }
  return cues
}
