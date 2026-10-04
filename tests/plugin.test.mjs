/**
 * Offline checks for the plugin's registration contract.
 *
 * These run without DSH. Registration bugs — a tool with no name, an action the
 * dispatcher does not handle, a schema the loader would reject — are pure-function
 * problems, so they are caught here rather than by loading the plugin into a live
 * profile and reading logs. See docs/插件设计规格.md §12.1 for why that distinction
 * is enforced.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { apply, inject, name as pluginName, normalizeConfig } from '../index.mjs'
import { TOOL_NAMES } from '../src/tools/index.mjs'

/** Build a fake Cordis context that records what the plugin registers. */
function fakeContext(services = {}) {
  const registered = []
  const logs = []
  const ctx = {
    logger: {
      info: (message) => logs.push({ level: 'info', message }),
      warn: (message) => logs.push({ level: 'warn', message }),
      error: (message) => logs.push({ level: 'error', message }),
    },
    // The plugin resolves optional host services through this at call time.
    get: (name) => services[name],
    inject(services_, callback) {
      assert.deepEqual(services_, ['tools'], 'plugin should only depend on the tools service')
      callback({ tools: { register: (definition) => registered.push(definition) } })
    },
  }
  return { ctx, registered, logs }
}

test('plugin identity is stable', () => {
  assert.equal(pluginName, 'video-factory')
  assert.deepEqual(inject, ['tools'])
})

test('normalizeConfig fills defaults and resolves the verified Ark base URL', () => {
  const config = normalizeConfig(undefined)
  assert.equal(config.ark.baseUrl, 'https://ark.cn-beijing.volces.com/api/v3')
  assert.equal(config.ark.apiKeyEnv, 'ARK_API_KEY')
  assert.equal(config.ark.defaultModel, null)
  assert.equal(config.ark.pollIntervalSeconds, 15)
  assert.equal(config.pathBudget, 200)
  assert.equal(config.tts.voice, 'zh-CN-XiaoxiaoNeural')
  assert.equal(config.projectRoot, null)
  // Text recognition left for the dsh-ocr plugin, so there is no ocr config section any more:
  // an unknown key is simply ignored rather than validated.
  assert.equal(config.ocr, undefined)
  assert.deepEqual(Object.keys(config).sort(), ['ark', 'ffmpegPath', 'ffprobePath', 'pathBudget', 'projectRoot', 'tts'])
})

test('normalizeConfig rejects wrong types instead of silently coercing', () => {
  assert.throws(() => normalizeConfig({ pathBudget: -5 }), /pathBudget/)
  assert.throws(() => normalizeConfig({ projectRoot: 42 }), /projectRoot/)
  assert.throws(() => normalizeConfig({ ark: { pollIntervalSeconds: 'soon' } }), /pollIntervalSeconds/)
  assert.throws(() => normalizeConfig({ tts: { voice: [] } }), /voice/)
  assert.throws(() => normalizeConfig({ ffmpegPath: 12 }), /ffmpegPath/)
})

test('an invalid config registers nothing and says why', () => {
  const { ctx, registered, logs } = fakeContext()
  apply(ctx, { pathBudget: 'deep' })
  assert.equal(registered.length, 0)
  assert.ok(
    logs.some((entry) => entry.level === 'error' && entry.message.includes('配置无效')),
    'an invalid config must produce one clear error log',
  )
})

test('every family tool registers, with a complete and self-consistent schema', () => {
  const { ctx, registered } = fakeContext()
  apply(ctx, {})

  assert.equal(registered.length, TOOL_NAMES.length, 'every declared tool should register')

  for (const definition of registered) {
    assert.ok(TOOL_NAMES.includes(definition.name), `unexpected tool name ${definition.name}`)
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 80, `${definition.name} needs a useful description`)
    assert.equal(definition.parameters.type, 'object')
    assert.equal(definition.parameters.additionalProperties, false)

    const action = definition.parameters.properties.action
    assert.ok(Array.isArray(action?.enum), `${definition.name} must declare its action enum`)
    assert.ok(action.enum.length > 0)
    assert.deepEqual(definition.parameters.required, ['action'])
    assert.ok(action.description.length > 40, `${definition.name} action list needs an explanation`)

    assert.equal(typeof definition.execute, 'function')
    assert.equal(typeof definition.output.render, 'function')
    // The action's own description should document every legal value it lists.
    for (const value of action.enum) {
      assert.ok(
        action.description.includes(value),
        `${definition.name}: action "${value}" is in the enum but not explained`,
      )
    }
  }
})

test('unknown actions fail with an actionable message', async () => {
  const { ctx, registered } = fakeContext()
  apply(ctx, {})
  const env = registered.find((definition) => definition.name === 'video_env')
  await assert.rejects(() => env.execute({ action: 'nope' }), /video_env: unknown action "nope"/)
})

test('scan demands a root and reports a missing folder clearly', async () => {
  const { ctx, registered } = fakeContext()
  apply(ctx, {})
  const env = registered.find((definition) => definition.name === 'video_env')

  await assert.rejects(
    () => env.execute({ action: 'scan' }),
    /needs "root"/,
    'scan without a root must name the missing argument',
  )
  await assert.rejects(
    () => env.execute({ action: 'scan', root: 'no-such-material-folder' }),
    /素材目录不存在/,
    'a missing folder must be reported as missing, not as an empty inventory',
  )
})

test('every action rejects missing input instead of returning an empty result', async () => {
  const { ctx, registered } = fakeContext()
  apply(ctx, {})

  // Each entry names an action that cannot possibly succeed with no arguments. The
  // point is that an empty result must never be mistaken for a successful answer.
  const expectations = [
    ['video_narrate', 'synthesize', /需要 "text"/],
    ['video_narrate', 'to_cues', /没有可用的逐词时间戳/],
    ['video_narrate', 'srt_write', /没有可用的字幕条/],
    ['video_narrate', 'srt_read', /需要 "srtPath"/],
    ['video_narrate', 'transcribe', /需要 "audioPath"/],
    ['video_plan', 'check', /需要 "plan"/],
    ['video_plan', 'duration', /需要 "plan"/],
    ['video_render', 'assemble', /需要 "plan"|先渲染/],
    ['video_render', 'finalize', /需要 "plan"|找不到时间线/],
    ['video_inspect', 'verify', /需要 "target"/],
    ['video_inspect', 'media', /需要 "target" 或 "paths"/],
    ['video_gen', 'generate', /需要 "prompt"|没有设置/],
    ['video_gen', 'image', /需要 "prompt"|没有设置/],
  ]

  for (const [toolName, action, pattern] of expectations) {
    const definition = registered.find((entry) => entry.name === toolName)
    assert.ok(definition, `${toolName} should be registered`)
    await assert.rejects(
      () => definition.execute({ action }, { cwd: process.cwd() }),
      pattern,
      `${toolName}.${action} should refuse with an explanation`,
    )
  }
})

test('video_plan fields returns the packaged reference without touching the disk', async () => {
  const { ctx, registered } = fakeContext()
  apply(ctx, {})
  const plan = registered.find((definition) => definition.name === 'video_plan')
  const result = await plan.execute({ action: 'fields' }, { cwd: process.cwd() })
  assert.equal(result.version, 1)
  assert.ok(result.text.includes('plan.json'))
  assert.ok(result.text.includes('scenes[]'))
})

test('transcription reaches a host-provided recogniser', async () => {
  // The plugin is mounted without the speech bundle on most profiles, so the service is
  // resolved per call. This proves that when it IS present, the wiring actually reaches it
  // rather than silently doing nothing.
  const calls = []
  const service = {
    snapshot: () => ({
      selection: { providerId: 'sensevoice-local', language: 'auto' },
      providers: [{ id: 'sensevoice-local', name: 'SenseVoice', location: 'host-local', preparation: { phase: 'ready' } }],
    }),
    resolve: (request) => ({ ...request, provider: { id: 'sensevoice-local' } }),
    async transcribe(spec) {
      calls.push(spec)
      return { text: '你好世界', audioSeconds: 1.5, inferenceSeconds: 0.4 }
    },
  }

  const { ctx, registered } = fakeContext({ speechToText: service })
  apply(ctx, {})
  const narrate = registered.find((definition) => definition.name === 'video_narrate')

  // A generated tone stands in for speech: what matters here is the plumbing, not the words.
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const directory = mkdtempSync(join(tmpdir(), 'vf-asr-plugin-'))
  const { run } = await import('../src/core/ffmpeg.mjs')
  const clip = join(directory, 'clip.mp4')
  await run({
    tool: 'ffmpeg',
    args: [
      '-f', 'lavfi', '-i', 'color=c=#101010:s=160x120:r=5:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=300:duration=2',
      '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', clip,
    ],
    timeoutMs: 120_000,
  })

  const result = await narrate.execute({ action: 'transcribe', audioPath: clip, language: 'zh' }, { cwd: process.cwd() })
  assert.equal(calls.length, 1, 'the recogniser should have been called once')
  assert.equal(result.text, '你好世界')
  assert.equal(calls[0].language, 'zh', 'the language hint must be forwarded')
  assert.ok(calls[0].audio instanceof Uint8Array, 'audio must be passed as bytes')
  assert.equal(result.provider.id, 'sensevoice-local')

  // Every returned cue must carry the transcript.
  assert.ok(result.parts[0].text.includes('你好世界'))
})

test('transcription explains itself when the recogniser is absent', async () => {
  const { ctx, registered } = fakeContext()
  apply(ctx, {})
  const narrate = registered.find((definition) => definition.name === 'video_narrate')
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const directory = mkdtempSync(join(tmpdir(), 'vf-asr-absent-'))
  const clip = join(directory, 'clip.mp4')
  writeFileSync(clip, 'not a real video')

  await assert.rejects(
    () => narrate.execute({ action: 'transcribe', audioPath: clip }, { cwd: process.cwd() }),
    /voice-input-bundle/,
    'a missing recogniser must point at the bundle that provides one',
  )
})

test('presets are reported and internally consistent', async () => {
  const { ctx, registered } = fakeContext()
  apply(ctx, {})
  const env = registered.find((definition) => definition.name === 'video_env')
  const result = await env.execute({ action: 'presets' })

  assert.ok(result.presets['vertical-short'])
  for (const [key, preset] of Object.entries(result.presets)) {
    assert.ok(preset.width > 0 && preset.height > 0 && preset.fps > 0, `${key} has a nonsensical canvas`)
    assert.equal(typeof preset.label, 'string')
  }
})

test('video_inspect carries no text recognition any more', async () => {
  const { ctx, registered } = fakeContext()
  apply(ctx, {})
  const inspect = registered.find((definition) => definition.name === 'video_inspect')

  assert.deepEqual(
    inspect.parameters.properties.action.enum,
    ['verify', 'media'],
    'reading text moved to the dsh-ocr plugin; this surface must not claim it',
  )
  for (const action of ['ocr', 'find_text', 'ocr_status']) {
    await assert.rejects(
      () => inspect.execute({ action }, { cwd: process.cwd() }),
      /unknown action/,
      `${action} must not be reachable`,
    )
  }
})

test('video_setup no longer provisions an OCR engine', async () => {
  const { ctx, registered } = fakeContext()
  apply(ctx, {})
  const setup = registered.find((definition) => definition.name === 'video_setup')

  assert.deepEqual(setup.parameters.properties.action.enum, ['install_ffmpeg', 'install_audio', 'install_matte'])
  await assert.rejects(
    () => setup.execute({ action: 'install_ocr' }, { cwd: process.cwd() }),
    /unknown action/,
    'the engine installer moved to dsh-ocr text_setup {action:"install"}',
  )
})
