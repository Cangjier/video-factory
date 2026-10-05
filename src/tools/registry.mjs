/**
 * The single source of truth for what every `video_*` tool and action does.
 *
 * Two consumers read this and nothing else:
 *
 * 1. **The model-facing schema.** `shared.mjs` derives each tool's `description` and its
 *    `action` enum description from here, so the two can never disagree and no sentence
 *    is paid for twice in the same request.
 * 2. **`video_guide`.** The full per-action reference is rendered from here on demand:
 *    parameters, required-ness, return shape, cost, pitfalls, a runnable example and the
 *    actions it is normally chained with.
 *
 * Why a registry instead of prose in each schema module: the surface is charged to the
 * model on every turn, so anything that is useful only *sometimes* has to be retrievable
 * rather than resident. Keeping the detail here and the summary in the schema is what
 * makes "tell DSH everything" affordable.
 *
 * Field contract per action:
 *   summary   one line, what it produces or answers (shown in the schema)
 *   use       when to reach for it (shown in the schema)
 *   avoid     the mistake it prevents, or the better alternative (shown when short)
 *   required  argument names the caller must supply beyond `action`
 *   returns   the shape and meaning of the result
 *   cost      time / network / key / install requirement, from the code
 *   gotchas   things that silently produce a wrong-looking result
 *   example   a minimal, runnable argument object
 *   seeAlso   actions normally chained with it
 *
 * @module video-factory/tools/registry
 */

/** Tool order used by `video_guide {action:"overview"}` and by the test suite. */
export const TOOL_ORDER = [
  'video_guide',
  'video_env',
  'video_setup',
  'video_plan',
  'video_narrate',
  'video_analyze',
  'video_gen',
  'video_render',
  'video_inspect',
  'video_qc',
]

/** Every tool, every action, with the detail the model needs to decide. */
export const REGISTRY = {
  video_guide: {
    purpose:
      'The full capability reference for this plugin, read on demand: what every video_* action does, which arguments it requires, what it returns, what it costs, how it fails, and the order the actions are normally used in.',
    use: [
      'before starting a video job, to see the whole surface at once (action "overview"), or the recommended order for the job you were asked for (action "playbook")',
      'before calling an action whose arguments you are not certain about (action "tool" or action "action")',
      'when a call failed in a way the schema does not explain (action "rules" lists the failure modes that repeat)',
    ],
    avoid: [
      'calling it on every turn: it is a reference, not a step in the pipeline',
      'using it to decide *what* the video should say or contain — it only describes the tools',
    ],
    needs: ['nothing: every action here is pure computation over this file'],
    next: ['video_env {action:"probe"} — confirm the machine can render at all'],
    actions: {
      overview: {
        summary: 'the whole surface in one page: every tool, every action, one line each, plus which are installed and which are cheap.',
        use: 'once, when the job is new and you want the complete menu before choosing an approach.',
        required: [],
        returns: '{ text } — a markdown index grouped by job stage, with each action line carrying its cost and requirement tag.',
        cost: 'free, no disk, no network, no install.',
        gotchas: [
          'One line per action is deliberately not enough to call from. Read the detailed entry before the first call of an unfamiliar action.',
        ],
        example: { action: 'overview' },
        seeAlso: ['rules', 'playbook', 'tool'],
      },
      playbook: {
        summary: 'the recommended order of actions for a named job, with the arguments each step needs and the mistakes that break it.',
        use: 'when you have the user request but not yet the plan: it turns "make me a 60s vertical short with voiceover" into an ordered checklist.',
        required: [],
        returns: '{ text } — with no "job", the list of playbooks and what each is for; with a "job" id, the full ordered recipe including the branches for missing material, missing ffmpeg, and failed quality checks.',
        cost: 'free.',
        gotchas: [
          'A playbook is advice about ordering, not a pipeline executor: this plugin has no one-shot "make me a video" action, by design.',
          'The creative decisions inside a step (which scenes, what order, what wording, how long) are yours; the playbook only fixes the tool order.',
        ],
        example: { action: 'playbook', job: 'vertical-narrated-short' },
        seeAlso: ['overview', 'rules'],
      },
      rules: {
        summary: 'the rules that apply to every job: what this plugin refuses to decide, the determinism contract, the cost and availability matrix, the plan.json authoring rules, and the failures that keep repeating.',
        use: 'before writing plan.json or before the first render of a session.',
        required: [],
        returns: '{ text } — markdown: do/don\'t list, cost table (time, network, API key, install), availability matrix, file layout, and a troubleshooting table mapping symptom to the action that diagnoses it.',
        cost: 'free.',
        gotchas: [
          'The single most expensive mistake it prevents is hand-rolling an ffmpeg command line instead of using video_render: the tool encodes font, escaping and time-base handling that is easy to get subtly wrong.',
        ],
        example: { action: 'rules' },
        seeAlso: ['overview', 'playbook'],
      },
      tool: {
        summary: 'one tool in full: purpose, when to use it and when not to, every action with its required arguments, returns, cost, pitfalls and an example.',
        use: 'before the first call of a tool, or when choosing between two tools that sound similar.',
        required: ['tool'],
        returns: '{ text } — one section per action of that tool, plus that tool\'s arguments with their meaning and which actions use them.',
        cost: 'free.',
        gotchas: [
          'The argument reference is generated from the live schema, so it is exact; the "required" flags are the ones the action handler actually enforces.',
        ],
        example: { action: 'tool', tool: 'video_inspect' },
        seeAlso: ['action', 'overview'],
      },
      action: {
        summary: 'one action in full, including the arguments only that action uses and a minimal runnable example.',
        use: 'when you know the tool but not the exact arguments.',
        required: ['tool', 'name'],
        returns: '{ text } — the action entry plus every argument it accepts (marked required or optional, with defaults and meaning).',
        cost: 'free.',
        gotchas: [
          'The action name goes in "name", not in "action": "action" selects this reference action, "name" names the action you are asking about.',
        ],
        example: { action: 'action', tool: 'video_render', name: 'scene' },
        seeAlso: ['tool', 'overview'],
      },
    },
  },

  video_env: {
    purpose:
      'Read-only facts about this machine and this material: whether ffmpeg is usable, which canvas shapes exist, and what is in a material folder. It decides nothing — duplicates are reported, never dropped, because choosing a still is a creative act.',
    use: [
      'first, at the start of any video job, to confirm the renderer exists at all',
      'before writing plan.json, to pick a canvas preset and to know which files exist and what shape they are',
    ],
    avoid: [
      'do not use it to install anything: that is video_setup, which downloads hundreds of megabytes',
      'do not expect "scan" to rank or pick material for you',
    ],
    needs: ['nothing to call; "probe" reports what is missing'],
    next: [
      'video_setup {action:"install_ffmpeg"} when probe reports no ffmpeg',
      'video_plan {action:"check"} once plan.json exists',
    ],
    actions: {
      probe: {
        summary:
          'report ffmpeg/ffprobe paths and versions, available encoders and filters, Edge TTS reachability, whether an Ark API key is present, and the state of the matting component together with the runtime it borrows from the audio plugin.',
        use: 'as the very first call of a job, and again after any install.',
        avoid:
          'it does not install: if ffmpeg is missing it says so, and video_setup installs it. It also does not report desktop input or text recognition: those are separate plugins (computer_*, text_*).',
        required: [],
        returns:
          '{ ok, problems[], ffmpeg{path, version, source, encoders[], filters[]}, ffprobe, vendored, shared, matte{available, runtime, runtimeDir, runtimeSource, ...}, arkKeyPresent, ttsReachable } — a missing encoder or filter appears in problems and it names it.',
        cost: 'about a second: three short process launches, no network, no disk writes, and nothing on the desktop is touched.',
        gotchas: [
          'problems is the field to read: ok alone does not say *what* is missing.',
          'An absent ARK key disables only video_gen; everything else keeps working.',
          'ffmpeg.source says which rule answered — "home" is the shared plugin home (~/.dsh-plugins/ffmpeg/bin) that all six plugins install into and read from, so a render does not depend on which checkout happens to be beside this one.',
          'Reading the state of the matting component is file inspection only: it starts no engine and moves nothing. Sound is not reported here at all — ask audio_setup {action:"status"} in the separate dsh-video-audio plugin.',
        ],
        example: { action: 'probe' },
        seeAlso: ['presets', 'video_setup'],
      },
      presets: {
        summary: 'list the canvas presets (vertical-short, horizontal, square, landscape-4k, preview) with their width, height, fps and label.',
        use: 'before writing plan.json, so the canvas matches the destination platform.',
        avoid: 'do not invent canvas numbers: plan.check validates against these and the renderer normalizes to them.',
        required: [],
        returns: '{ presets: { "vertical-short": { width, height, fps, label }, ... } }',
        cost: 'instant, pure lookup of a packaged table.',
        gotchas: ['A portrait plan built from landscape stills is reported by video_plan {action:"diagnose"} — check the preset before the material, not after.'],
        example: { action: 'presets' },
        seeAlso: ['probe', 'video_plan'],
      },
      scan: {
        summary: 'inventory a material folder: every image, video and audio file with its probe metadata, near-duplicate stills marked via duplicateOf, unsupported files skipped.',
        use: 'after probe, to turn a folder of raw material into a structured list before deciding what the video contains.',
        avoid: 'it never picks, ranks or drops material; the choosing is yours.',
        required: ['root'],
        returns:
          '{ counts, items[{ path, kind, duration, width, height, fps, sizeBytes, duplicateOf?, notes[] }], skipped[], duplicates[] } — describe() also renders a human summary.',
        cost: 'probes every file: seconds for tens of files, minutes for a large archive; no network, read-only on the material.',
        gotchas: [
          'Dedupe is perceptual (dHash), so a gradient test image may be marked a duplicate of a different-coloured gradient: correct for that input, misleading as a fixture.',
          'Unsupported or unreadable files are listed under skipped with the reason — they are not silently absent.',
        ],
        example: { action: 'scan', root: 'material', dedupe: true, recursive: true },
        seeAlso: ['probe', 'video_plan'],
      },
    },
  },

  video_setup: {
    purpose:
      'Provisioning: fetch the pinned ffmpeg build and the matting model into vendor/. The model installer verifies a pinned SHA-256; the ffmpeg installer downloads a release archive and records, but does not enforce, a digest. Removal exists for the model, not for ffmpeg. The audio-event model, and the ONNX runtime that both it and matting run on, are installed by the separate dsh-video-audio plugin: audio_setup {action:"install"}.',
    use: [
      'only when a video_env {action:"probe"} or an action\'s own error says the component is missing',
      'when a download host is blocked, pass "archive" with a locally obtained file',
    ],
    avoid: [
      'do not install "just in case": install_ffmpeg is a few hundred megabytes and the models are tens of megabytes',
      'do not re-run an install to fix a failure: read the error, then use force only when a partial copy is actually present',
    ],
    needs: ['the network for anything except "archive"; several hundred MB of disk for ffmpeg'],
    next: [
      'video_env {action:"probe"} to confirm the install landed',
      'video_analyze {action:"matte_status"} for the matting model and the runtime it borrows',
    ],
    actions: {
      install_ffmpeg: {
        summary: 'download the pinned ffmpeg static release and unpack ffmpeg/ffprobe/ffplay into the shared plugin home (~/.dsh-plugins/ffmpeg/bin), then report the version it landed on.',
        use: 'when video_env {action:"probe"} reports ffmpeg or ffprobe missing, or missing libx264/aac.',
        avoid: 'the plugin finds ffmpeg through DSH_FFMPEG (or VIDEO_FACTORY_FFMPEG), then ~/.dsh-plugins/ffmpeg/bin, then vendor/ffmpeg/bin, then PATH; install only when all of those fail. It is the same directory dsh-ffmpeg, dsh-ocr, dsh-tts and dsh-video-audio read, so one install serves every plugin.',
        required: [],
        returns: '{ directory, version, reused, bytes, state } — state is the resolved build, with `location` saying whether it came from the shared home or a legacy vendor/ffmpeg.',
        cost: 'a few hundred megabytes over the network, a minute or two.',
        gotchas: [
          'The reuse test is only "a binary directory exists", so an empty or half-unpacked directory makes every later call skip the install while ffmpeg is still missing; pass force, or delete the directory, to recover.',
          'It does not verify a pinned digest, unlike the model installers, and it accepts neither archive nor remove: there is no uninstall action for ffmpeg.',
          'The extracted layout is what keeps intermediate paths inside the Windows path budget; do not relocate it by hand. Set DSH_PLUGIN_HOME to move the whole shared home somewhere else.',
        ],
        example: { action: 'install_ffmpeg' },
        seeAlso: ['video_env'],
      },
      install_matte: {
        summary: 'download the pinned 4.36MB U²-Net model into the shared plugin home (~/.dsh-plugins/models/u2netp) so a subject can be cut out of a backdrop that is not a flat colour, or remove it.',
        use: 'when a subject must be cut from a photographic or busy background.',
        avoid: 'a green screen should use the plan-level chroma_key instead: it is exact and about two thousand times cheaper than a learned matte.',
        required: [],
        returns: '{ directory, reused, bytes, state, verify }',
        cost: '4.36MB; the inference runtime is the one dsh-video-audio installed in the shared home and is never fetched twice.',
        gotchas: [
          'The runtime is a hard prerequisite and part of the skip test: with no runtime this refuses before downloading, naming audio_setup {action:"install"} in the sibling plugin, rather than spending 4.36MB on a model that could not load.',
          'remove deletes the model only and leaves the shared runtime alone, so matting can be removed without touching audio event detection.',
        ],
        example: { action: 'install_matte' },
        seeAlso: ['video_analyze'],
      },
    },
  },

  video_plan: {
    purpose:
      'The deterministic half of plan.json: validate a plan, compute its exact timeline, print the field reference, and diagnose objective problems — without rendering anything. It never writes or fixes a plan, because the plan is the creative decision.',
    use: [
      'every time you write or edit plan.json: check before rendering, not after a failed render',
      'when a render failed and you need to know whether the plan or the machine is at fault',
    ],
    avoid: [
      'do not expect it to suggest pacing, ordering or better scenes: it reports facts, never taste',
      'do not render first and validate later: a plan error is cheap here and expensive in ffmpeg',
    ],
    needs: ['nothing but the plan document'],
    next: ['video_render {action:"scene"} to render one scene, or {action:"build"} for the chain', 'video_narrate to produce the voiceover the plan references'],
    actions: {
      check: {
        summary: 'structural validation plus referenced-file existence, unique scene ids and value ranges, reported as errors and warnings with the offending field named.',
        use: 'immediately after writing or editing plan.json, and again after any substitution of material.',
        avoid: 'strict turns warnings into failures — use it in a delivery gate, not while drafting.',
        required: [],
        returns: '{ ok, errors[{ field, message }], warnings[], normalized, scenes, durationSeconds } — normalized only fills in defaults the plan omitted.',
        cost: 'milliseconds; touches the disk only to test that referenced files exist.',
        gotchas: [
          'A referenced file that exists but is the wrong shape is diagnose\'s job, not check\'s.',
          'check does not read the plan deeply enough to promise a render: a chroma_key or matte scene whose background is missing, a matte whose model is not installed, and subtitles.source:"auto" all pass check and then fail inside the renderer.',
          'ok:false is returned, not thrown: read errors before deciding what to fix.',
        ],
        example: { action: 'check', plan: 'examples/demo/plan.json' },
        seeAlso: ['diagnose', 'duration'],
      },
      duration: {
        summary: 'the exact timeline length including transition overlap, plus the effective overlap at every boundary.',
        use: 'when the cut has to hit a target length — a 60s slot, a music bed, a narration track.',
        avoid: 'do not add scene durations by hand: transitions overlap and the arithmetic is not obvious.',
        required: [],
        returns: '{ totalSeconds, boundaries[{ from, to, overlapSeconds }], scenes[{ id, start, end }] }',
        cost: 'pure computation.',
        gotchas: [
          'Total length is shorter than the sum of scene durations whenever transitions overlap.',
          'A transition declared on the FIRST scene makes this action throw a raw TypeError: it reads the previous scene to compute the overlap and there is none. Set the first scene\'s transition to "none" — the renderer ignores it anyway.',
        ],
        example: { action: 'duration', plan: 'plan.json' },
        seeAlso: ['check', 'video_narrate'],
      },
      fields: {
        summary: 'the full plan.json field reference, packaged with the plugin.',
        use: 'before writing the first plan of a session, or when a field name is uncertain.',
        avoid: 'it is the reference for the document you author; it does not validate anything.',
        required: [],
        returns: '{ version, text } — markdown covering every field, its type and its default.',
        cost: 'free, reads nothing from disk.',
        gotchas: ['Reading it once per session is usually enough; the schema does not change between calls.'],
        example: { action: 'fields' },
        seeAlso: ['check'],
      },
      diagnose: {
        summary: 'objective problems only: a referenced file that does not exist, a still with motion "none", a transition longer than half its scene, a portrait plan full of landscape stills, a total length that misses the narration by a wide margin.',
        use: 'when check passes but the edit still looks wrong on paper.',
        avoid: 'it reports facts, never taste: it will not suggest reordering or re-timing.',
        required: [],
        returns: '{ ok, problems[{ kind, message, field?, scene? }], facts } — facts are the measurements the problems were derived from.',
        cost: 'probes the referenced media: seconds, read-only.',
        gotchas: [
          'A silent stretch, a bad take or weak material is not visible on the picture; that is video_qc territory, and for the sound itself it is audio_measure in the separate dsh-video-audio plugin.',
          'It throws when the plan itself is invalid, where check returns ok:false. Run check first.',
          'It does not inspect chroma_key or matte preconditions either, despite what an older comment in the renderer claims.',
        ],
        example: { action: 'diagnose', plan: 'plan.json', strict: false },
        seeAlso: ['check', 'video_qc'],
      },
    },
  },

  video_narrate: {
    purpose:
      'Text to speech and subtitles: synthesize narration with per-word timings, turn those timings into subtitle cues, read and write SRT, compute burn-in style from the canvas, and transcribe existing audio or video. The paths and style values it returns go straight into plan.json.',
    use: [
      'before the first render that carries narration or subtitles',
      'when only the wording or the line breaks changed: to_cues and layout are free, so re-run those instead of re-synthesizing',
      'to learn what an existing video says (transcribe)',
    ],
    avoid: [
      'do not re-run synthesize for a subtitle tweak: it costs network time and is capped per request',
      'do not build cue timings by hand: the split rules are in to_cues',
    ],
    needs: [
      'the network for synthesize (Edge TTS read-aloud, no API key)',
      'the host speech bundle for transcribe; without it the action fails and names the bundle',
    ],
    next: [
      'video_plan {action:"check"} with the returned paths in the plan',
      'video_render {action:"finalize"} burns or muxes the subtitles',
    ],
    actions: {
      synthesize: {
        summary: 'text to MP3 plus per-word timings, returned inline and written beside the audio.',
        use: 'whenever narration is needed, once per script revision at most.',
        avoid: 'each request has a hard 60-second cap, so very long copy must be split before it is sent.',
        required: ['text or textPath'],
        returns: '{ audio (bytes), words[], duration } — the caller writes them, or the action writes voiceover.mp3 and voiceover.words.json under outDir.',
        cost: 'network round trips over the Edge read-aloud WebSocket; no key, no billing; usually seconds per paragraph, hard-capped at 60s per request.',
        gotchas: [
          'The 60s cap is per request, not per scene: long narration fails rather than continuing.',
          'Word timings arrive with the audio, which is exactly why to_cues and layout can be re-run for free.',
        ],
        example: { action: 'synthesize', textPath: 'script.txt', outDir: 'narration' },
        seeAlso: ['to_cues', 'layout', 'srt_write'],
      },
      to_cues: {
        summary: 'word timings to subtitle cues, split on sentence-ending punctuation and wrapped at maxChars.',
        use: 'after synthesize, and again after any change of line length or timing scale.',
        avoid: 'pure computation — never re-synthesize to change how a line breaks.',
        required: [],
        returns: '{ cues[{ index, start, end, text }], ... } — cuesPath (or the last synthesize output) supplies the words.',
        cost: 'free, no disk, no network.',
        gotchas: [
          'Splitting is not only punctuation: a cue also breaks when the accumulated length reaches maxChars, when two words are more than 0.45s apart, or when a single cue would run past 6s, and text wraps to at most two lines.',
          'The punctuation that ended a sentence is kept in the cue, because the burn-in is expected to show it.',
        ],
        example: { action: 'to_cues', wordsPath: 'narration/voiceover.words.json', maxChars: 18 },
        seeAlso: ['synthesize', 'srt_write', 'layout'],
      },
      srt_write: {
        summary: 'serialize cues to an .srt file.',
        use: 'whenever a subtitle file is needed: plan.json subtitles.source, or a muxed sidecar.',
        avoid: 'do not hand-write SRT: the timestamp rounding here deliberately matches the reference implementation.',
        required: ['srtPath', 'cues (via cuesPath or the last to_cues)'],
        returns: '{ srtPath, cueCount }',
        cost: 'free.',
        gotchas: [
          'Cue order is preserved as given; it is not re-sorted, so a scaled or hand-edited cue list stays in your order.',
        ],
        example: { action: 'srt_write', cuesPath: 'narration/cues.json', srtPath: 'narration/voiceover.srt' },
        seeAlso: ['to_cues', 'srt_read'],
      },
      srt_read: {
        summary: 'parse an .srt file back into cues.',
        use: 'to reuse an existing subtitle file, or to re-time one that was produced elsewhere.',
        avoid: 'a malformed block is skipped rather than reported, so an empty result means "nothing parsed", not "empty file exists".',
        required: ['srtPath'],
        returns: '{ cues[...], cueCount }',
        cost: 'free.',
        gotchas: ['BOM and CRLF are tolerated; a block that fails to parse is dropped silently, so verify cueCount against what you expected.'],
        example: { action: 'srt_read', srtPath: 'narration/voiceover.srt' },
        seeAlso: ['srt_write', 'to_cues'],
      },
      layout: {
        summary: 'cue list plus canvas to the burn-in style values that go into plan.json subtitles.',
        use: 'right before writing plan.json, so the subtitles are sized for the actual canvas.',
        avoid: 'do not invent font sizes and margins: this is the arithmetic the renderer expects.',
        required: [],
        returns: '{ style: { fontSize, marginV, outline, ... }, ... } and, when scale is not 1, a scaled cue file written to disk.',
        cost: 'free.',
        gotchas: [
          'font_size is round(44 × width / 1080), margin_v is round(height × 0.104), and the outline is a 3px black edge.',
          'With scale, the returned note points at the scaled CUES JSON. That is not a subtitle file: write it through srt_write and put the .srt in subtitles.source, because the renderer treats anything that is not .ass as SRT and would feed libass a JSON file.',
        ],
        example: { action: 'layout', canvasWidth: 1080, canvasHeight: 1920, maxChars: 18 },
        seeAlso: ['to_cues', 'srt_write', 'video_plan'],
      },
      transcribe: {
        summary: 'speech to text for an existing audio or video file, through the host\'s local recogniser.',
        use: 'to learn what a video says, or to check a narrator\'s actual words against the script.',
        avoid: 'it returns whole sentences, not word timings: do not use it to build subtitles.',
        required: ['audioPath'],
        returns: '{ text, parts[{ text, start, end }], provider, ... } — long material is cut at detected pauses and the hard cuts are reported.',
        cost: 'local inference once the model is downloaded; audio is decoded to 16kHz mono and sent in chunks of about 131s / 4MiB.',
        gotchas: [
          'Without the host speech service it fails immediately and names the voice-input bundle that provides one.',
          'Naming the language improves accuracy; auto is the default.',
          'There are no per-word timings anywhere in this path.',
        ],
        example: { action: 'transcribe', audioPath: 'out/final.mp4', language: 'zh' },
        seeAlso: ['synthesize', 'video_inspect'],
      },
    },
  },

  video_render: {
    purpose:
      'Execute plan.json with ffmpeg: render each scene to a uniform clip, join the clips, mix and normalize the soundtrack, burn or mux subtitles, and write the delivery side files. It makes no creative decisions, and the same plan over the same inputs produces the same file.',
    use: [
      'after video_plan {action:"check"} passes',
      'stage by stage when any shot might need re-rendering; the one-call "build" only when nothing needs inspecting in between',
    ],
    avoid: [
      'never hand-roll an ffmpeg command line for this pipeline: font resolution, filter escaping and time-base handling are what these actions exist to get right',
      'do not render before check, and do not expect render to generate missing material',
    ],
    needs: [
      'ffmpeg (video_env {action:"probe"})',
      'every file the plan references, already on disk — a plan "generate" block is NOT executed here',
    ],
    next: ['video_inspect {action:"verify"}', 'video_qc {action:"check"}'],
    actions: {
      scene: {
        summary: 'render one scene, or every scene, to a uniform intermediate clip that shares the canvas, frame rate, pixel format, time base and an audio track of exactly the scene\'s length.',
        use: 'as the retry unit: this is where a bad shot is fixed and re-rendered on its own.',
        avoid: 'do not expect build to re-render a single shot — only this action can.',
        required: [],
        returns: '{ path, reused, sceneId, index, ... } — "reused" says the existing clip was kept.',
        cost: 'the expensive step: one ffmpeg run per scene; a matte scene additionally runs the mask model at roughly 2.1s per masked frame.',
        gotchas: [
          'Caching is "the clip file exists and is not empty", NOT a fingerprint: after editing plan.json the old clip is silently reused. Pass force:true for every stage you want redone.',
          'A scene whose plan carries a "generate" block but no source is not generated here. Call video_gen {action:"generate"} first and write the returned path into the scene.',
          'A scene list can be rendered in one call, so re-rendering everything costs everything.',
        ],
        example: { action: 'scene', plan: 'plan.json', sceneId: 's03', force: true },
        seeAlso: ['assemble', 'video_plan', 'video_gen'],
      },
      assemble: {
        summary: 'join the rendered clips into one timeline: stream copy when there are no transitions, a single filter graph with xfade when there are.',
        use: 'after the scenes you want are rendered.',
        avoid: 'do not assemble while a clip is still known to be wrong: the timeline is what finalize consumes.',
        required: [],
        returns: '{ path, reused, clipCount, duration, method }',
        cost: 'seconds without transitions (stream copy); a re-encode of the whole timeline when transitions are present.',
        gotchas: [
          'Reuse is by file existence too: after a scene is re-rendered with force, assemble also needs force or the stale timeline is kept.',
          'clips can override the input list, which is the way to assemble a deliberate subset in a custom order.',
        ],
        example: { action: 'assemble', plan: 'plan.json', force: true },
        seeAlso: ['scene', 'finalize'],
      },
      finalize: {
        summary: 'mix narration and music with sidechain ducking, normalize loudness to EBU R128, and burn or mux subtitles, encoding the picture at most once.',
        use: 'once the timeline is right and the audio assets exist.',
        avoid: 'do not reach for another encoder pass afterwards: subtitles and loudness are both handled here by design.',
        required: [],
        returns: '{ path, reused, loudness, subtitlesBurned, softSubtitles, ... }',
        cost: 'one picture encode plus the audio graph — the single most expensive remaining stage after the scenes.',
        gotchas: [
          'Reuse is by file existence: change the soundtrack, the subtitle style or the plan, and force is required or the previous final file survives.',
          'When the result is reused, subtitlesBurned and softSubtitles come back false even though the file on disk is the earlier one: they describe this run, not the file.',
        ],
        example: { action: 'finalize', plan: 'plan.json', force: true },
        seeAlso: ['assemble', 'deliver'],
      },
      deliver: {
        summary: 'write the delivery side files for the finished film: the cover frame, the contact sheet, and build-report.json with the plan verification inside it.',
        use: 'as the last render step of a delivery.',
        avoid: 'it is not a quality gate: read the problems it reports, then run video_qc for the real acceptance suite.',
        required: [],
        returns: '{ final, cover, contactSheet, report, problems[] }',
        cost: 'seconds: it extracts frames and writes JSON; no cache and no re-encode.',
        gotchas: [
          'The problems array can be non-empty while the action still succeeds: an empty array is the only clean result.',
          'The timeline argument is not read here. finalize writes <workDir>/timeline.mp4 and deliver consumes that plus outDir/final.mp4.',
          'force has no effect: deliver always rewrites its outputs.',
        ],
        example: { action: 'deliver', plan: 'plan.json', outDir: 'out' },
        seeAlso: ['finalize', 'video_inspect', 'video_qc'],
      },
      build: {
        summary: 'run scene, assemble, finalize and deliver in sequence and return the delivery report.',
        use: 'when the plan is trusted and nothing needs looking at in between — the shortest path to a file.',
        avoid: 'when any shot may need re-rendering: build ignores sceneId and cannot re-render one scene.',
        required: [],
        returns: 'the deliver report, with the intermediate stages already applied.',
        cost: 'the sum of all four stages; a mistake in the plan is paid for in full.',
        gotchas: [
          'sceneId is ignored: this action always processes every scene.',
          'force applies to every stage, which is the only way to make a build pick up edited material.',
        ],
        example: { action: 'build', plan: 'plan.json', outDir: 'out' },
        seeAlso: ['scene', 'finalize', 'deliver'],
      },
    },
  },

  video_inspect: {
    purpose:
      'Facts about a media file, and the acceptance check for a delivery: does the rendered file match the plan it came from.',
    use: [
      'verify as the last step of every delivery: an empty problems array is the only clean result',
      'media to find out what a file actually contains rather than what it was supposed to contain',
    ],
    avoid: [
      'verify compares only the plan\'s basic facts; the deeper acceptance suite is video_qc {action:"check"}',
      'reading text off a picture is not here any more: that is the dsh-ocr plugin (text_read / text_find), which owns the engine, the coordinates and the install path',
    ],
    needs: ['ffprobe for media and verify'],
    next: ['video_qc {action:"check"}', 'video_analyze {action:"sample_frames"} when a frame is what needs judging'],
    actions: {
      verify: {
        summary: 'compare a rendered file with the plan it came from — resolution, frame rate, duration within tolerance, presence of an audio track, pixel format, minimum size — and return { ok, problems }.',
        use: 'immediately after finalize or deliver, as the last step of any delivery.',
        avoid: 'it is a smoke test, not an acceptance suite: black frames, frozen runs, loudness and subtitle legibility are video_qc.',
        required: ['target (or planData plus target)'],
        returns: '{ ok, problems[{ field, expected, actual }], checked }',
        cost: 'one ffprobe plus a stat call: well under a second.',
        gotchas: [
          'problems can be empty while the film is still unwatchable: the four facts it checks are the ones a build breaks silently.',
          'Give it the plan the file was rendered from, not a newer edited one, or the comparison is meaningless.',
        ],
        example: { action: 'verify', target: 'out/final.mp4', plan: 'plan.json' },
        seeAlso: ['video_qc', 'video_render'],
      },
      media: {
        summary: 'stream metadata for any image, video or audio file, several at once.',
        use: 'to check a single file\'s shape, codec, duration or frame rate before planning around it.',
        avoid: 'a whole folder is video_env {action:"scan"}, which adds dedupe and inventory structure.',
        required: ['target or paths'],
        returns: 'per file: { path, kind, width, height, fps, duration, hasAudio, streams[], ... }',
        cost: 'one ffprobe per file: milliseconds each.',
        gotchas: ['Durations here are the container\'s declaration; audio_measure {action:"identify"} reports declared against actually decoded length.'],
        example: { action: 'media', paths: ['out/final.mp4', 'material/shot01.jpg'] },
        seeAlso: ['video_env', 'video_analyze'],
      },
    },
  },

  video_gen: {
    purpose:
      'Generate footage or still images with ByteDance Seed on Volcengine Ark — the only non-deterministic tool in this plugin: the same prompt produces a different result each time, and only a fixed seed makes it approximately reproducible.',
    use: [
      'when a shot cannot be sourced from existing material and must be created',
      'for cover art, a thumbnail, or a first/last frame to drive a generated shot',
      'call models or image_models first: which model ids are live decides what is callable at all',
    ],
    avoid: [
      'do not use it where reproducibility matters: every call is billed and none is repeatable',
      'do not generate what material already provides',
    ],
    needs: ['an Ark API key in the configured environment variable (video_env {action:"probe"} reports arkKeyPresent)', 'the network', 'money: generation is billed per call'],
    next: ['write the returned local path into the scene\'s source, then video_plan {action:"check"}', 'video_render {action:"scene"}'],
    actions: {
      models: {
        summary: 'list the Seedance video models this account can see, with their status (live / retiring / shut down), straight from the Ark model listing.',
        use: 'before the first generate of a session, and whenever a model error suggests the id went stale.',
        avoid: 'do not hard-code a model id from memory: this listing is the authority.',
        required: [],
        returns: '{ models[{ id, status, ... }] }',
        cost: 'free; one paginated listing call.',
        gotchas: ['"live" means the model is visible to the account, not that it is enabled for generation: a rejected call may still name an entitlement problem.'],
        example: { action: 'models' },
        seeAlso: ['generate', 'image_models'],
      },
      image_models: {
        summary: 'list the Seedream image models and their status the same way.',
        use: 'before generating a still.',
        avoid: 'the size limits are enforced locally anyway; this tells you which ids exist.',
        required: [],
        returns: '{ models[{ id, status, ... }] }',
        cost: 'free.',
        gotchas: ['Image area must sit between 921600 and 4624220 pixels; a size outside that is refused before anything is generated or billed.'],
        example: { action: 'image_models' },
        seeAlso: ['image', 'models'],
      },
      generate: {
        summary: 'submit one text-to-video or image-to-video task, poll it, and download the finished clip to disk.',
        use: 'when a specific shot must exist and nothing on disk provides it.',
        avoid: 'prefer existing material; prefer image-to-video when a first frame already fixes the composition.',
        required: ['prompt (plus reference for the image modes)'],
        returns: '{ localPath, model, durationSeconds, ... } — always the downloaded path, never a URL you would have to fetch.',
        cost: 'one to several minutes of polling, billed per generation; pollIntervalSeconds defaults to 15 and maxWaitSeconds to 900.',
        gotchas: [
          'The result URL is a presigned link that expires in 24 hours, which is why this action downloads before returning.',
          'reference and lastFrame must be LOCAL files. A public URL is resolved as a local path and then reported as a missing image, so download it first.',
          'maxWaitSeconds too small throws after the task was submitted, and the money is already spent; there is no retrieve action, so a timeout means paying again.',
          'The three modes are mutually exclusive and validated in the core; an option a model does not accept is rejected by name, so read the error rather than retrying blindly.',
        ],
        example: { action: 'generate', mode: 'text-to-video', prompt: '清晨的江南水乡，摇橹船穿过石桥', ratio: '9:16', duration: 5, resolution: '720p', seed: 42 },
        seeAlso: ['models', 'video_render'],
      },
      image: {
        summary: 'generate a still image from a prompt and download it, synchronously.',
        use: 'a missing insert shot, a thumbnail, cover art, or the first frame of a generated clip.',
        avoid: 'not a substitute for real photography when the still has to be a real place or product.',
        required: ['prompt or imagePrompt'],
        returns: '{ localPath, width, height, ... } — the path is authoritative, including its extension.',
        cost: 'about fifteen seconds; billed per image.',
        gotchas: [
          'The file extension follows what the service returns, so a requested "cover.png" can land as cover.jpg: use localPath, never a path you assembled yourself.',
          'Each request returns one image; ask again rather than raising imageCount.',
        ],
        example: { action: 'image', prompt: '极简科技感封面，深蓝渐变，中央留白', imageSize: '2K', outDir: 'generated' },
        seeAlso: ['image_models', 'generate'],
      },
    },
  },

  video_analyze: {
    purpose:
      'Find out what a video or a soundtrack actually contains before editing it, and cut a subject out of a backdrop: which moments are worth looking at, what the sound is made of, and one frame lifted onto a transparent background.',
    use: [
      'before choosing which footage to use and where to cut, so the choice is made on measured moments rather than guessed ones',
      'when the structure of the soundtrack matters — where music starts, which stretch is silence — which transcription cannot tell you',
      'to lift a subject for a composite, one frame at a time',
    ],
    avoid: [
      'every action reports moments, scores and labels; choosing order and pacing stays with you',
      'for a whole matted video use the plan\'s scene.matte, not this per-frame action',
      'a flat-colour backdrop is a plan-level chroma_key: exact, and far cheaper than a learned matte',
    ],
    needs: [
      'ffmpeg for sample_frames and for the frames a matte is taken from',
      'the shared ONNX runtime for matte, which audio_setup {action:"install"} in the separate dsh-video-audio plugin provides',
      'the U²-Net model (video_setup {action:"install_matte"}) plus that same runtime for matte',
    ],
    next: ['write the chosen stills or clips into plan.json', 'video_plan {action:"check"}', 'video_render {action:"scene"}'],
    actions: {
      sample_frames: {
        summary: 'score every decoded frame against its predecessor and return the moments worth a look, each with the reason it was picked (scene_change / motion / periodic / max_interval_fallback), its sceneScore and its timestamp.',
        use: 'to find the cuts and the movement in footage whose content you cannot see directly, and to pick stills from a video.',
        avoid: 'do not use it as a frame extractor for a whole film: it selects moments, it does not transcode.',
        required: ['target'],
        returns: '{ duration, probe{width,height,fps,decodedFrames}, frames[{ at, reason, sceneScore, gapFromPrevious }], skipped, extracted[] }',
        cost: 'decodes the whole file once at 160x90 greyscale, so minutes of video cost tens of seconds; extract writes at most 60 JPEGs.',
        gotchas: [
          'A long file can kill the run rather than truncate it: the decode is bounded by an output budget of about 14400 bytes per allowed frame, so a file beyond roughly 500s at the default probeFps/maxFrames must be given a higher maxFrames or a lower probeFps, or walked in pieces.',
          'Scores are only comparable between runs with the same probeFps and probe size; they are not a quality judgement.',
          'extract writes JPEGs that someone has to look at: keep maxSide small.',
        ],
        example: { action: 'sample_frames', target: 'material/source.mp4', extract: true, maxSide: 640 },
        seeAlso: ['matte_status', 'video_plan'],
      },
      matte: {
        summary: 'cut a subject out of its backdrop with a learned model and write a PNG with a transparent background — one image, or one frame of a video when "at" is given.',
        use: 'when the background is not a flat colour and the subject has to sit on something else.',
        avoid: 'a green screen should use the plan-level chroma_key: it is exact and about two thousand times cheaper; the two are mutually exclusive in one scene.',
        required: ['target'],
        returns: '{ path, maskPath, width, height, inferenceMs, statistics{ foregroundRatio }, warning? } — a foregroundRatio near 0 or 1 comes back with a warning.',
        cost: 'about 2.1s of single-threaded inference per frame at a fixed 320x320 input; one frame per call by design.',
        gotchas: [
          'It is a per-frame tool. A whole matted video belongs in the plan (scene.matte, mask_fps default 8), where raising blend quality is usually cheaper than raising maskFps.',
          'A degenerate mask is reported as a warning rather than an error: read foregroundRatio before using the PNG.',
        ],
        example: { action: 'matte', target: 'material/person.jpg', feather: 1, name: 'person-cut' },
        seeAlso: ['matte_status', 'video_plan', 'video_setup'],
      },
      matte_status: {
        summary: 'report whether the matting model is installed, and when given a duration, what a video matte would cost at several mask rates.',
        use: 'before committing to a matted scene, so the render time is chosen with the price in view.',
        avoid: 'the estimate is inference time only: it excludes decode, encode and blending.',
        required: [],
        returns: '{ available, model, runtime, inferenceMsPerFrame, estimates?{ maskFps: { masks, minutes } } } — the estimate is capped at 900 masks.',
        cost: 'free; with duration it is a multiplication, not a measurement.',
        gotchas: [
          'Runtime and model are reported separately because they are installed by different plugins: the runtime comes from audio_setup {action:"install"} in dsh-video-audio, the model from video_setup {action:"install_matte"} here. runtimeSource says which directory answered.',
          'A duration above the 900-mask cap is reported as capped: split the scene or lower maskFps rather than reading the number as the whole cost.',
        ],
        example: { action: 'matte_status', duration: 12 },
        seeAlso: ['matte', 'video_setup'],
      },
    },
  },

  video_qc: {
    purpose:
      'The acceptance suite for a finished video: named cases with explicit expectations taken from the plan or from a case file, a verdict and the measurement behind it for each, across container, picture, sound, narration timing and the delivered side files. Reading the burned-in subtitles back is a separate plugin now: dsh-ocr, text_read {action:"verify"}.',
    use: [
      'after the film exists and video_inspect {action:"verify"} has passed — verify is the smoke test, this is the test suite',
      'action "cases" first to learn the case ids, then "check" with reportPath when the verdicts have to be machine-readable',
    ],
    avoid: [
      'it does not validate the plan: that is video_plan {action:"check"}, and it belongs before rendering',
      'a case that cannot be judged returns skip with a reason, so a green report is only as good as the plan it was given',
    ],
    needs: ['ffprobe', 'ffmpeg decode for the picture cases'],
    next: ['fix what failed and re-render, then run check again', 'video_render {action:"deliver"} for the side files it inspects'],
    actions: {
      cases: {
        summary: 'list every case that can run — id, what it asserts, its severity, its default threshold, whether it compares against the plan — so a case file can be written against known ids.',
        use: 'before writing a case file, and when you want to know what the suite actually covers.',
        avoid: 'it reads no media and judges nothing.',
        required: [],
        returns: '{ cases[{ id, category, title, severity, compares, needs, enabled, overrides }], defaults{...} }',
        cost: 'free: reads the catalogue and no files.',
        gotchas: [
          'This action does not validate the ids inside a case file; an unknown id is reported when check runs, and only there.',
          'There is no case for subtitle safe-area overflow, and no case for plan legality: do not read a green suite as either.',
        ],
        example: { action: 'cases' },
        seeAlso: ['check', 'video_plan'],
      },
      check: {
        summary: 'run the suite against one delivered file and return pass/fail/skip for every case with expected against actual.',
        use: 'as the last gate before telling the user the video is done.',
        avoid: 'do not run it before the film is final: several cases re-decode the whole file.',
        required: ['target'],
        returns: '{ ok, counts{pass,fail,skip}, failures[], skipped[{id,reason}], cases[], text } — give reportPath to also write the full verdicts and measurements as JSON.',
        cost: 'the heaviest read-only action here: structure is two ffprobes, picture decodes the whole film once as greyscale.',
        gotchas: [
          'The model sees the rendered text, not the structured object: counts, failures and measurements are only visible on the tool card, so pass reportPath whenever the verdicts must be read back precisely.',
          'Without a plan, every case whose expectation comes from it is skipped with a reason — and ok can still be true. A green run without a plan proves very little.',
          'sampleFrames means a different thing per action (edge-sample frames in picture, read-backs in text_read verify), and unknown names in skip and unknown keys in thresholds are ignored silently, while only and the case-file ids are validated.',
          'A very long film can end the tool in failure rather than in a failed case: the picture decode is capped and the whole action has a timeout.',
          'Read the notes on a skip: the generic reason often names the plan even when the real cause is a disabled case or a missing tool.',
        ],
        example: { action: 'check', target: 'out/final.mp4', plan: 'plan.json', reportPath: 'out/qc.json' },
        seeAlso: ['cases', 'structure', 'picture', 'video_inspect'],
      },
      structure: {
        summary: 'the raw container facts behind the structural cases: per-stream duration and codec, colour tags, pixel aspect, and the MP4 box order that decides whether the file can play before it finishes downloading.',
        use: 'when a structural case failed and you want the measurement rather than the verdict, or when a player behaves oddly.',
        avoid: 'it renders no verdict: read the numbers and judge, or let check judge.',
        required: ['target'],
        returns: '{ streams[{ index, type, codec, durationSeconds, ... }], container{ durationSeconds, bitrate, fastStart, boxOrder[] }, ... }',
        cost: 'two ffprobes: under a second.',
        gotchas: ['A track that ends earlier than the container is visible here and nowhere else in the suite.'],
        example: { action: 'structure', target: 'out/final.mp4' },
        seeAlso: ['check', 'picture'],
      },
      picture: {
        summary: 'sample the picture at a fixed rate and report what the picture-domain cases measure — black runs, frozen runs, edge bars, luma statistics — with timestamps.',
        use: 'when a warning needs looking at, or when the film has to be judged without watching it.',
        avoid: 'it reports measurements, not verdicts.',
        required: ['target'],
        returns: '{ blackRuns[], frozenRuns[], bars{ worstFrame, ratio, at }, luma{...}, sampledFrames }',
        cost: 'one greyscale decode of the whole film at the sampling rate; the default is 2 frames per second.',
        gotchas: [
          'sampleFrames here is the number of frames sampled for the edge-bar measurement, not a subtitle count.',
          'A long film can exceed the decode budget and fail the action instead of reporting: there is no threshold override for that cap.',
        ],
        example: { action: 'picture', target: 'out/final.mp4', probeFps: 2 },
        seeAlso: ['check', 'structure'],
      },
    },
  },

}

/**
 * Look up one tool's registry entry.
 *
 * @param {string} tool - tool name.
 * @returns {object|undefined} the entry, or undefined when the tool is not registered in this file.
 */
export function lookupTool(tool) {
  return Object.prototype.hasOwnProperty.call(REGISTRY, tool) ? REGISTRY[tool] : undefined
}

/**
 * Look up one action's registry entry.
 *
 * @param {string} tool - tool name.
 * @param {string} action - action name.
 * @returns {object|undefined} the entry, or undefined when either name is unknown.
 */
export function lookupAction(tool, action) {
  const entry = lookupTool(tool)
  if (entry === undefined) return undefined
  return Object.prototype.hasOwnProperty.call(entry.actions, action) ? entry.actions[action] : undefined
}
