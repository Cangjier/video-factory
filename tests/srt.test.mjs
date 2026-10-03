/**
 * `src/core/srt.mjs` 的离线单元测试：断句、折行、时间戳格式、SRT 往返与容错、时间轴缩放。
 *
 * 全是纯函数，零 mock：不联网、不需要 ffmpeg、不读写文件。见 docs/插件设计规格.md §11。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_MAX_CHARS,
  SENTENCE_END,
  closesCue,
  dedupeCues,
  formatSrt,
  formatTimestamp,
  parseSrt,
  scaleCues,
  wordsToCues,
  wrapText,
} from '../src/core/srt.mjs'

/**
 * 把一段文本切成给定字数的“词”，并配上连续的时间戳，模拟 Edge TTS 的逐词边界。
 * 词与词之间留 0.05s（远小于 gapBreak=0.45，不会触发静音断句）。
 *
 * @param {string[]|string} texts - 词文本数组；传字符串则每 1 个字算一个词。
 * @param {{duration?: number, gap?: number}} [options] - 每个词的时长与词间空隙。
 * @returns {{text: string, start: number, end: number}[]} 逐词时间戳。
 */
function spoken(texts, { duration = 0.3, gap = 0.05 } = {}) {
  const list = typeof texts === 'string' ? [...texts] : texts
  let cursor = 0
  return list.map((text) => {
    const start = Number(cursor.toFixed(3))
    cursor += duration
    const end = Number(cursor.toFixed(3))
    cursor += gap
    return { text, start, end }
  })
}

/** 按固定字数把一段文本切块，用作“词”。 */
function chunk(text, size) {
  const parts = []
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size))
  return parts
}

test('SENTENCE_END 与 Python 版逐字符一致', () => {
  assert.equal(SENTENCE_END, '。！？!?…；;')
})

test('closesCue 只看词的最后一个字符', () => {
  assert.equal(closesCue('很好。'), true)
  assert.equal(closesCue('真的吗？'), true)
  assert.equal(closesCue('stop!'), true)
  assert.equal(closesCue('省略…'), true)
  assert.equal(closesCue('好；'), true)
  assert.equal(closesCue('很好'), false)
  assert.equal(closesCue('，中间有标点'), false)
  assert.equal(closesCue(''), false)
})

test('wordsToCues：按句末标点断句，条数与时间都符合预期', () => {
  const words = spoken(['今天', '天气', '很好。', '我们', '去', '公园', '吧！'])
  const cues = wordsToCues(words)

  assert.equal(cues.length, 2)
  assert.deepEqual(
    cues.map((cue) => cue.text),
    ['今天天气很好。', '我们去公园吧！'],
  )
  assert.deepEqual(
    cues.map((cue) => cue.index),
    [1, 2],
    'index 必须从 1 开始且连续',
  )
  assert.equal(cues[0].start, words[0].start)
  assert.equal(cues[0].end, words[2].end, '第一条应在句末词处收尾')
  assert.equal(cues[1].start, words[3].start)
  assert.equal(cues[1].end, words[6].end)
})

test('wordsToCues：超长一句按 maxChars 折行，去掉换行符后与原文本完全一致', () => {
  const sentence = '春天的花开得正好，我们一起出门去看风景' // 19 字，> 默认 18
  const words = spoken(chunk(sentence, 4))
  const cues = wordsToCues(words)

  assert.equal(cues.length, 1, '没到句末标点、也没到 6 秒，应该只有一条')
  const lines = cues[0].text.split('\n')
  assert.equal(lines.length, 2, '超长只折成两行')
  assert.equal(lines.join(''), sentence, '折行不能丢字、也不能重复')

  // 中点正好落在逗号后，本实现把逗号留在第一行。
  // （Python 版 `_wrap` 会 rstrip 掉这个逗号，等于丢一个字符；这里按需求“不丢字”保留。）
  assert.equal(lines[0], '春天的花开得正好，')
  assert.equal(lines[1], '我们一起出门去看风景')

  // 折行后的每一行都应该比原文短，否则等于没折。
  assert.ok(lines.every((line) => line.length < sentence.length))
})

test('wordsToCues：中点附近没有标点时从中间硬切，不丢字', () => {
  const sentence = '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸' // 20 字，中点无标点
  const cues = wordsToCues(spoken(chunk(sentence, 5)))

  assert.equal(cues.length, 1)
  assert.equal(cues[0].text, '一二三四五六七八九十\n甲乙丙丁戊己庚辛壬癸')
  assert.equal(cues[0].text.replace(/\n/g, ''), sentence)
})

test('wordsToCues：任意长文本折行后都不丢字不重复', () => {
  const samples = [
    '春天的花开得正好，我们一起出门去看风景',
    '没有标点的很长一段话就这样一直写下去看看会折成什么样子呢',
    '先说一句，再说一句、然后是第三句；最后一句收尾。',
    '包含 English words and 中文混排的一行字幕文本用来测试折行行为',
  ]
  for (const sentence of samples) {
    const cues = wordsToCues(spoken(chunk(sentence, 3)))
    const joined = cues.map((cue) => cue.text.replace(/\n/g, '')).join('')
    assert.equal(joined, sentence, `折行后内容必须与原文一致：${sentence}`)
  }
})

test('wrapText：短文本原样返回，长文本折成两行', () => {
  assert.equal(wrapText('短句', 18), '短句')
  assert.equal(wrapText('  两边有空格  ', 18), '两边有空格')
  assert.equal(wrapText('一二三四五六七八九十', 5), '一二三四五\n六七八九十')
})

test('wordsToCues：空输入返回空数组', () => {
  assert.deepEqual(wordsToCues([]), [])
  assert.deepEqual(wordsToCues([], { maxChars: 10 }), [])
})

test('wordsToCues：相邻重复文本只留先出现的那一条（沿用 _dedupe）', () => {
  const words = spoken(['好。', '好。', '继续。'])
  const cues = wordsToCues(words)

  assert.equal(cues.length, 2)
  assert.deepEqual(
    cues.map((cue) => cue.text),
    ['好。', '继续。'],
  )
  assert.deepEqual(
    cues.map((cue) => cue.index),
    [1, 2],
    '去重后要重新从 1 编号',
  )
  assert.equal(cues[0].end, words[0].end, '保留的是先出现那条的时间')
})

test('dedupeCues：只按相邻文本比较，不比较时间', () => {
  const cues = [
    { index: 9, start: 0, end: 1, text: '甲' },
    { index: 9, start: 0, end: 1, text: '甲' },
    { index: 3, start: 5, end: 6, text: '乙' },
    { index: 4, start: 6, end: 7, text: '甲' },
  ]
  const result = dedupeCues(cues)

  assert.deepEqual(
    result.map((cue) => cue.text),
    ['甲', '乙', '甲'],
    '不相邻的相同文本要保留',
  )
  assert.deepEqual(
    result.map((cue) => cue.index),
    [1, 2, 3],
  )
})

test('wordsToCues：沿用 Python 的静音断句与最长时长规则（可关）', () => {
  const gapped = [
    { text: '第一段', start: 0, end: 0.5 },
    { text: '第二段', start: 1.2, end: 1.7 }, // 中间 0.7s 静音 ≥ gapBreak 0.45
  ]
  assert.equal(wordsToCues(gapped).length, 2)
  assert.equal(wordsToCues(gapped, { gapBreak: Infinity }).length, 1)

  const long = [
    { text: '一二三四五', start: 0, end: 3 },
    { text: '六七八九十', start: 3, end: 7 }, // 累计 7s ≥ maxDuration 6
    { text: '甲乙丙', start: 7, end: 9 },
  ]
  const split = wordsToCues(long)
  assert.equal(split.length, 2)
  assert.equal(split[0].text, '一二三四五六七八九十')
  assert.equal(wordsToCues(long, { maxDuration: Infinity }).length, 1)
})

test('wordsToCues：maxChars 生效', () => {
  const words = spoken(['一二三四五', '六七八九十', '甲乙丙丁戊'])
  const wide = wordsToCues(words, { maxChars: 100 })
  assert.equal(wide.length, 1)
  assert.equal(wide[0].text, '一二三四五六七八九十甲乙丙丁戊')

  const narrow = wordsToCues(words, { maxChars: 6 })
  assert.equal(narrow.length, 2)
  assert.equal(narrow[0].text, '一二三四五\n六七八九十', '超过预算的一条要折行')
  assert.equal(narrow[1].text, '甲乙丙丁戊')
})

test('formatTimestamp：HH:MM:SS,mmm，补零正确', () => {
  assert.equal(formatTimestamp(0), '00:00:00,000')
  assert.equal(formatTimestamp(1.5), '00:00:01,500')
  assert.equal(formatTimestamp(61.5), '00:01:01,500')
  assert.equal(formatTimestamp(3599.999), '00:59:59,999')
  assert.equal(formatTimestamp(3600), '01:00:00,000')
  assert.equal(formatTimestamp(3661.001), '01:01:01,001')
  for (const seconds of [0, 1.5, 61.5, 3599.999, 3661.001, 86399.999]) {
    assert.match(formatTimestamp(seconds), /^\d{2,}:\d{2}:\d{2},\d{3}$/)
  }
})

test('formatTimestamp：毫秒进位不能溢出成 ,1000', () => {
  assert.equal(formatTimestamp(0.9996), '00:00:01,000', '999.6ms 要进位到秒')
  assert.equal(formatTimestamp(59.9996), '00:01:00,000')
  assert.equal(formatTimestamp(3599.9996), '01:00:00,000')
  assert.equal(formatTimestamp(0.9994), '00:00:00,999')
  assert.ok(!formatTimestamp(1.9999).includes(',1000'))
})

test('formatTimestamp：正好落在 .5ms 时按 Python round() 取偶数（银行家舍入）', () => {
  // Edge TTS 的时间戳是 100ns 刻度：examples/demo 的 89 个词里有 40 个 end 精确落在
  // x.5ms 上。Python 的 round() 遇到 .5 取偶数，所以 9512.5 -> 9512、8287.5 -> 8288、
  // 8312.5 -> 8312。要逐字节复现 Python 版的 .srt，就必须连这个舍入一起搬。
  assert.equal(formatTimestamp(0.0005), '00:00:00,000', '0.5ms -> 0（偶数）')
  assert.equal(formatTimestamp(0.0015), '00:00:00,002', '1.5ms -> 2（偶数）')
  assert.equal(formatTimestamp(0.0025), '00:00:00,002', '2.5ms -> 2（偶数）')
  assert.equal(formatTimestamp(1.0005), '00:00:01,000', '1000.5ms -> 1000（偶数）')
  assert.equal(formatTimestamp(8.2875), '00:00:08,288', '8287.5ms -> 8288')
  assert.equal(formatTimestamp(9.5125), '00:00:09,512', '9512.5ms -> 9512')
  assert.equal(formatTimestamp(0.9995), '00:00:01,000', '临界值同样要进位到秒，不能出现 ,1000')
  assert.equal(formatTimestamp(1.0004999), '00:00:01,000', '1000.4999ms 略低于 .5，取 1000')
})

test('formatTimestamp：负数按 0 处理', () => {
  assert.equal(formatTimestamp(-1), '00:00:00,000')
  assert.equal(formatTimestamp(-0.4), '00:00:00,000')
})

test('formatSrt / parseSrt 往返一致', () => {
  const cues = [
    { index: 1, start: 0, end: 1.5, text: '第一句字幕' },
    { index: 2, start: 1.5, end: 3.25, text: '第二句\n折成两行' },
    { index: 3, start: 3.25, end: 4.125, text: '第三句' },
  ]
  const srt = formatSrt(cues)

  assert.ok(!srt.startsWith('\uFEFF'), '格式化的 SRT 不带 BOM')
  assert.ok(srt.startsWith('1\n00:00:00,000 --> 00:00:01,500\n第一句字幕\n\n2\n'), '块之间空一行')
  assert.ok(srt.endsWith('\n'), '末块也以换行结尾')
  assert.ok(!srt.includes('\r'))

  assert.deepEqual(parseSrt(srt), cues, 'format 再 parse 应得到等价的字幕条')
})

test('formatSrt：空数组得到空字符串', () => {
  assert.equal(formatSrt([]), '')
})

test('parseSrt：容忍 CRLF、乱序序号、缺失序号、点号毫秒与多余空白', () => {
  const messy = [
    '\uFEFF7', // BOM + 序号乱序
    '  00:00:05.5 --> 00:00:07.25  ', // 点号毫秒（1~2 位）+ 两侧空格；"5" = 500ms
    '带 BOM 的一句',
    '',
    '00:00:07,250 --> 00:00:08,000', // 没有序号
    '没有序号的一句',
    '',
    '3',
    '00:00:08,000 --> 00:00:09,001',
    '最后一句',
    '',
    '这一块完全无法解析',
    '随便什么内容',
  ].join('\r\n')

  const cues = parseSrt(messy)

  assert.equal(cues.length, 3)
  assert.deepEqual(
    cues.map((cue) => cue.index),
    [1, 2, 3],
    '序号一律重新从 1 编号',
  )
  assert.deepEqual(
    cues.map((cue) => cue.text),
    ['带 BOM 的一句', '没有序号的一句', '最后一句'],
  )
  assert.equal(cues[0].start, 5.5)
  assert.equal(cues[0].end, 7.25)
  assert.equal(cues[2].end, 9.001)
})

test('parseSrt：解析失败的行/块跳过而不是抛异常', () => {
  assert.deepEqual(parseSrt('完全不是字幕'), [])
  assert.deepEqual(parseSrt(''), [])
  assert.deepEqual(parseSrt('   \n  '), [])
  assert.deepEqual(parseSrt('1\n00:00:01,000 --> 00:00:02,000\n'), [], '只有时间行、没有文本的块要丢掉')
  assert.deepEqual(parseSrt('1\n不是时间行\n正文'), [])

  const mixed = '1\n00:00:01,000 --> 00:00:02,000\n能解析\n\n2\n乱码一块\n\n3\n00:00:03,000 --> 00:00:04,000\n也能解析'
  assert.deepEqual(
    parseSrt(mixed).map((cue) => cue.text),
    ['能解析', '也能解析'],
  )
})

test('parseSrt：能解析 Python 版 write_srt 的输出格式', () => {
  // 模拟 Python write_srt：块尾换行 + 块间空行
  const srt = '1\n00:00:00,000 --> 00:00:01,000\n甲\n\n2\n00:00:01,000 --> 00:00:02,000\n乙\n'
  const cues = parseSrt(srt)
  assert.equal(cues.length, 2)
  assert.equal(cues[1].start, 1)
  assert.equal(cues[1].end, 2)
  assert.equal(cues[1].text, '乙')
})

test('scaleCues：按倍数缩放且不修改入参', () => {
  const cues = [
    { index: 1, start: 0, end: 1.5, text: '甲' },
    { index: 2, start: 1.5, end: 3, text: '乙' },
  ]
  const snapshot = JSON.parse(JSON.stringify(cues))
  const scaled = scaleCues(cues, 1.05)

  assert.deepEqual(cues, snapshot, '入参不能被修改')
  assert.notEqual(scaled, cues, '必须返回新数组')
  assert.notEqual(scaled[0], cues[0], '元素也必须是新对象')
  assert.equal(scaled[0].start, 0)
  assert.equal(scaled[0].end, 1.5 * 1.05)
  assert.equal(scaled[1].start, 1.5 * 1.05)
  assert.equal(scaled[1].end, 3 * 1.05)
  assert.deepEqual(
    scaled.map((cue) => cue.index),
    [1, 2],
    'index 原样保留',
  )
  assert.deepEqual(
    scaled.map((cue) => cue.text),
    ['甲', '乙'],
  )
})

test('scaleCues：0 与空数组等边界', () => {
  assert.deepEqual(scaleCues([], 2), [])
  const scaled = scaleCues([{ index: 4, start: 0, end: 2, text: '甲' }], 0.5)
  assert.deepEqual(scaled, [{ index: 4, start: 0, end: 1, text: '甲' }])
  assert.deepEqual(scaleCues([{ index: 1, start: 1, end: 2, text: '甲' }], 0), [
    { index: 1, start: 0, end: 0, text: '甲' },
  ])
})

test('DEFAULT_MAX_CHARS 与 Python 的 max_chars 默认值一致（切分用 >=，不是 >）', () => {
  assert.equal(DEFAULT_MAX_CHARS, 18)

  const words = spoken(chunk('春天的花开得正好，我们一起出门去看风景', 4))
  assert.deepEqual(wordsToCues(words), wordsToCues(words, { maxChars: 18 }), '默认值就是 18')

  // 累计字数正好等于 18 时就已经收一条（Python 是 joined_length >= max_chars）
  const exact = spoken(['一二三四五六七八九', '十甲乙丙丁戊己庚辛', '壬癸子丑寅卯辰巳午'])
  const cues = wordsToCues(exact, { maxChars: 18 })
  assert.equal(cues.length, 2)
  assert.equal(cues[0].text.length, 18)
})

test('wordsToCues：index 连续、时间单调不减', () => {
  const words = spoken('今天天气很好。我们一起去公园看花看树看湖水吧！')
  const cues = wordsToCues(words)

  assert.ok(cues.length >= 2)
  cues.forEach((cue, position) => {
    assert.equal(cue.index, position + 1)
    if (position > 0) assert.ok(cue.start >= cues[position - 1].end, '相邻字幕不应时间倒挂')
  })
})
