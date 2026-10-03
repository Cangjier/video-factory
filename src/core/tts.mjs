/**
 * Narration synthesis through Microsoft Edge's read-aloud service.
 *
 * No API key is needed, the Mandarin voices are good, and — critically for this
 * pipeline — the service reports a boundary for every spoken word. Those timings
 * are what the subtitle stage regroups into cues, so one call yields both the
 * voiceover audio and the exact times it is spoken at.
 *
 * The service is reached over a hand-rolled WebSocket ({@link module:video-factory/core/ws})
 * because it demands an `Origin` header and a `Cookie`, which Node's global
 * `WebSocket` cannot set. The signature travels in the query string, not a header:
 * `Sec-MS-GEC` is the SHA-256 of the current 100-nanosecond tick count (floored to a
 * 300-second window) prefixed onto the trusted client token, hex-encoded uppercase.
 *
 * ⚠️ Licensing: Microsoft has not documented a right to redistribute read-aloud
 * output commercially; use drafts and personal content here and switch to Azure AI
 * Speech (or an equivalent licensed engine) for anything sold.
 *
 * @module video-factory/core/tts
 */
import crypto from 'node:crypto'
import { connect } from './ws.mjs'

/** The read-aloud endpoint, minus its query string. */
const SPEECH_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'

/** The public trusted client token every read-aloud client ships with. */
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'

/** The Edge build this client imitates; its major version must match the User-Agent. */
const GEC_VERSION = '143.0.3650.75'

/** Major version of {@link GEC_VERSION}, kept in step with `Sec-MS-GEC-Version`. */
const GEC_MAJOR = GEC_VERSION.split('.')[0]

/** The extension origin the service expects from the Edge read-aloud extension. */
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold'

/** Audio format requested from the service; 24 kHz mono MP3. */
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3'

/** Edge reports boundary offsets and durations in 100-nanosecond ticks. */
const TICKS_PER_SECOND = 10_000_000

/** Seconds between the Windows file-time epoch (1601) and the Unix epoch (1970). */
const WINDOWS_EPOCH_OFFSET_SECONDS = 11644473600

/** `Sec-MS-GEC` is constant within this window; the service rejects older signatures. */
const GEC_WINDOW_SECONDS = 300

/** Default voice: a natural mainland-Mandarin female voice. */
export const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural'

/** Default handshake and synthesis timeout. */
const DEFAULT_TIMEOUT_MS = 60000

/** Raised when narration cannot be synthesized. */
export class AudioError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AudioError'
  }
}

/**
 * Compute the `Sec-MS-GEC` signature for right now.
 *
 * The tick count is floored to a 300-second window and then concatenated with seven
 * zero digits — that is the 100-nanosecond-subsecond part of the file time, not a
 * numeric multiplication, and getting it wrong is rejected as a bad signature.
 *
 * @returns {string} the uppercase hex SHA-256 the service expects.
 */
function secMsGec() {
  let ticks = Math.floor(Date.now() / 1000 + WINDOWS_EPOCH_OFFSET_SECONDS)
  ticks -= ticks % GEC_WINDOW_SECONDS
  return crypto.createHash('sha256').update(`${ticks}0000000${TRUSTED_CLIENT_TOKEN}`, 'ascii').digest('hex').toUpperCase()
}

/** Weekday and month names, as the service's timestamp format spells them. */
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Format a time the way the service's own client does.
 *
 * The literal `GMT+0000 (Coordinated Universal Time)` suffix is a quirk of the
 * reference client and is reproduced verbatim; the value itself is UTC.
 *
 * @param {Date} [now] - the instant to format.
 * @returns {string} for example `Wed Oct 02 2026 13:02:46 GMT+0000 (Coordinated Universal Time)`.
 */
function edgeTimestamp(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return (
    `${DAY_NAMES[now.getUTCDay()]} ${MONTH_NAMES[now.getUTCMonth()]} ${pad(now.getUTCDate())} ${now.getUTCFullYear()} ` +
    `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`
  )
}

const XML_ESCAPES = { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }

/**
 * Escape text for inclusion in XML character data.
 * @param {string} text - raw text.
 * @returns {string} the escaped text.
 */
function escapeXml(text) {
  return text.replace(/[<>&'"]/g, (character) => XML_ESCAPES[character])
}

/**
 * Build the SSML document for one request.
 * @param {string} text - already stripped narration text.
 * @param {string} voice - voice short name.
 * @param {string} rate - rate adjustment, such as `+10%`.
 * @param {string} pitch - pitch adjustment, such as `-2Hz`.
 * @param {string} volume - volume adjustment, such as `+0%`.
 * @returns {string} the SSML to send.
 */
function buildSsml(text, voice, rate, pitch, volume) {
  return (
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
    `<voice name='${escapeXml(voice)}'>` +
    `<prosody pitch='${escapeXml(pitch)}' rate='${escapeXml(rate)}' volume='${escapeXml(volume)}'>` +
    `${escapeXml(text)}` +
    '</prosody></voice></speak>'
  )
}

/** One 32-hex-digit identifier, the form the service uses for connection and request ids. */
const randomId = () => crypto.randomUUID().replace(/-/g, '')

/**
 * Split a header-prefixed payload into a lowercase header map plus body.
 * @param {Buffer} buffer - the frame payload.
 * @param {number} headerLength - byte length of the header block.
 * @returns {{headers: Map<string,string>, body: Buffer}} the parsed parts.
 */
function splitHeaders(buffer, headerLength) {
  const headers = new Map()
  for (const line of buffer.subarray(0, headerLength).toString('latin1').split('\r\n')) {
    const index = line.indexOf(':')
    if (index > 0) headers.set(line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim())
  }
  return { headers, body: buffer.subarray(headerLength) }
}

/**
 * Read the word boundaries out of one `audio.metadata` body.
 *
 * The shape is not the obvious one: `Data.text` is itself an object and the spoken
 * text lives at `Data.text.Text`. `Offset` and `Duration` are 100-nanosecond ticks.
 *
 * @param {Buffer} body - the JSON body of the metadata frame.
 * @returns {{text: string, start: number, end: number}[]} the words found, in spoken order.
 */
function parseWordBoundaries(body) {
  const words = []
  let parsed
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    return words // a metadata frame we cannot read costs timings, not the audio
  }
  for (const item of parsed?.Metadata ?? []) {
    if (item?.Type !== 'WordBoundary') continue
    const data = item.Data ?? {}
    const text = data.text?.Text
    if (typeof text !== 'string' || text === '') continue
    const start = Number(data.Offset) / TICKS_PER_SECOND
    const end = start + Number(data.Duration) / TICKS_PER_SECOND
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    words.push({ text, start, end })
  }
  return words
}

/**
 * Synthesize narration and return the audio plus per-word timings.
 *
 * One connection produces the whole utterance: `speech.config` asks for word
 * boundaries and MP3, the SSML asks for the voice and prosody, binary frames carry
 * the audio, and `turn.end` closes the exchange.
 *
 * @param {object} input - the synthesis request.
 * @param {string} input.text - narration text; required and must not be blank.
 * @param {string} [input.voice] - voice short name; defaults to {@link DEFAULT_VOICE}.
 * @param {string} [input.rate] - rate adjustment; defaults to `+0%`.
 * @param {string} [input.pitch] - pitch adjustment; defaults to `+0Hz`.
 * @param {string} [input.volume] - volume adjustment; defaults to `+0%`.
 * @param {number} [input.timeoutMs] - give up after this long; defaults to 60000.
 * @returns {Promise<{audio: Buffer, words: {text: string, start: number, end: number}[], duration: number}>}
 *   the MP3 bytes, the word timings in seconds, and the end of the last word (0 when there are none).
 * @throws {AudioError} when the text is empty, the service fails, the wait times out, or no audio arrives.
 */
export async function synthesize(input) {
  const {
    text,
    voice = DEFAULT_VOICE,
    rate = '+0%',
    pitch = '+0Hz',
    volume = '+0%',
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = input ?? {}

  if (typeof text !== 'string' || text.trim() === '') {
    throw new AudioError('旁白文本为空，无法合成语音')
  }
  const narration = text.trim()

  const url =
    `${SPEECH_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&ConnectionId=${randomId()}` +
    `&Sec-MS-GEC=${secMsGec()}` +
    `&Sec-MS-GEC-Version=1-${GEC_VERSION}`

  const headers = {
    Pragma: 'no-cache',
    'Cache-Control': 'no-cache',
    Origin: ORIGIN,
    'User-Agent':
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
      `Chrome/${GEC_MAJOR}.0.0.0 Safari/537.36 Edg/${GEC_MAJOR}.0.0.0`,
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'en-US,en;q=0.9',
    Cookie: `muid=${crypto.randomBytes(16).toString('hex').toUpperCase()};`,
  }

  const socket = connect({ url, headers, timeoutMs })
  const chunks = []
  const words = []

  try {
    return await new Promise((resolve, reject) => {
      let settled = false
      let timer = null
      const settle = (error, value) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (error) reject(error)
        else resolve(value)
      }

      timer = setTimeout(() => settle(new AudioError(`Edge TTS 合成超时（${timeoutMs}ms）`)), timeoutMs)

      socket.on('error', (error) => settle(new AudioError(`Edge TTS 连接失败：${error?.message || error?.code || '未知错误'}`)))

      socket.on('close', () => settle(new AudioError('Edge TTS 在 turn.end 之前关闭了连接')))

      socket.on('open', () => {
        socket.send(
          `X-Timestamp:${edgeTimestamp()}\r\n` +
            'Content-Type:application/json; charset=utf-8\r\n' +
            'Path:speech.config\r\n\r\n' +
            '{"context":{"synthesis":{"audio":{"metadataoptions":' +
            '{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},' +
            `"outputFormat":"${OUTPUT_FORMAT}"}}}}\r\n`,
        )
        socket.send(
          `X-RequestId:${randomId()}\r\n` +
            'Content-Type:application/ssml+xml\r\n' +
            `X-Timestamp:${edgeTimestamp()}Z\r\n` +
            'Path:ssml\r\n\r\n' +
            buildSsml(narration, voice, rate, pitch, volume),
        )
      })

      socket.on('text', (payload) => {
        const end = payload.indexOf('\r\n\r\n')
        if (end < 0) return
        const { headers: frameHeaders, body } = splitHeaders(payload, end)
        const path = frameHeaders.get('path')

        if (path === 'turn.end') {
          if (chunks.length === 0) {
            settle(new AudioError('Edge TTS 未返回任何音频数据'))
            return
          }
          const audio = Buffer.concat(chunks)
          settle(null, { audio, words, duration: words.length > 0 ? words[words.length - 1].end : 0 })
          return
        }
        // `audio.metadata` carries the word boundaries; `turn.start` and `response`
        // carry nothing this pipeline needs.
        if (path !== 'audio.metadata') return
        words.push(...parseWordBoundaries(body))
      })

      socket.on('binary', (payload) => {
        if (payload.length < 2) return
        // The first two bytes are a big-endian header length; `Path:audio` frames
        // after it are the MP3 stream.
        const headerLength = payload.readUInt16BE(0)
        if (headerLength > payload.length) return
        const { headers: frameHeaders, body } = splitHeaders(payload, headerLength)
        if (frameHeaders.get('path') !== 'audio') return
        if (body.length > 0) chunks.push(body)
      })
    })
  } finally {
    socket.destroy()
  }
}
