/**
 * The cross-cutting knowledge the model needs but no single tool owns: the rules that apply
 * to every job, the cost and availability matrix, the plan.json authoring rules that the
 * schema cannot express, a symptom-to-action troubleshooting table, and the ordered recipes
 * for the jobs this plugin is actually used for.
 *
 * This is advice about *ordering and pitfalls*. It is deliberately not a pipeline executor:
 * the plugin still has no one-shot "make me a video" action, because choosing scenes, order,
 * pacing and wording is the caller's job. A playbook says which tools to call in which order
 * and what breaks when you skip a step; it never decides the content.
 *
 * Everything here is rendered by `video_guide {action:"rules"}` and
 * `video_guide {action:"playbook"}`.
 *
 * @module video-factory/tools/playbook
 */

/** Rules that hold for every job, grouped so one guide action can render them. */
export const GLOBAL_RULES = {
  divisionOfLabour: [
    'This plugin executes; you decide. It has no action that picks scenes, orders shots, sets pacing, or writes your copy — and it never will, because that is the part the user actually asked you for.',
    'Corollary: there is no one-shot "make me a video" action. Sequencing the calls is your job, and the playbooks below are the recommended sequencing.',
    'A tool returns facts, numbers, lists and files. Reading them and choosing what to do next is yours.',
  ],
  doNotHandRoll: [
    'Do NOT build an ffmpeg command line yourself for anything this plugin covers. Font resolution, filter escaping, time-base normalisation, cross-platform paths and the Windows path-length budget are exactly what video_render and audio_build exist to get right. A hand-written command that "works" typically breaks on the next machine or the next font.',
    'Do not post-process the delivered file with your own ffmpeg call either: finalize already mixes, ducks, normalises and burns subtitles in a single encode, and a second encode is a generation loss.',
    'Do not write plan.json with a script in the shell when video_plan {action:"fields"} documents the document you are authoring.',
  ],
  determinism: [
    'Deterministic: everything except video_gen. Same plan, same inputs, same bytes. Rendering twice is wasteful, not risky.',
    'Non-deterministic, and the only one: video_gen. A fixed seed makes a result approximately reproducible; nothing makes it exactly reproducible, and every call is billed.',
    'Non-deterministic because of the world, not the code: audio_build {action:"record"} captures a room.',
    'Locally inferred but hardware-dependent: video_analyze {action:"matte"}, and audio_measure {action:"audio_events"} in the sibling plugin, run a model on this machine; their timings vary, their outputs do not (fixed seeds and fixed resolution).',
  ],
  caching: [
    'Render stages cache on FILE EXISTENCE, not on a fingerprint, despite what an older comment in the renderer says: an existing, non-empty intermediate is reused. After editing plan.json or replacing material, pass force:true to EVERY stage you want redone — scene, assemble and finalize each keep their own file.',
    'Changing quality does not invalidate anything either: pass force.',
    'deliver never caches and always rewrites its side files; force does nothing there.',
    'Reuse is reported: read the "reused" field instead of assuming work happened.',
    'video_render {action:"build"} ignores sceneId and applies force to everything, so it is the wrong tool when one shot needs re-rendering: drive scene → assemble → finalize → deliver yourself.',
  ],
  generation: [
    'A plan\'s "generate" block is NOT executed by video_render. Call video_gen {action:"generate"} yourself and write the returned local path into that scene\'s source before rendering.',
    'Reference images must be LOCAL paths: a public URL is resolved as a local path and then reported as missing. Download first.',
    'The result URL from the provider expires in 24 hours, which is why the action downloads before returning: keep the local path, never the URL.',
  ],
  planAuthoring: [
    'Start from video_env {action:"presets"}: the canvas must be one of the presets, and the renderer normalises to it.',
    'Scene ids must be unique; video_plan {action:"check"} names the offender when they are not.',
    'A still scene needs motion other than "none", or diagnose reports it as a defect.',
    'A transition must be shorter than half its scene, and the FIRST scene must declare "none": video_plan {action:"duration"} throws on a transition there, and the renderer ignores it anyway.',
    'chroma_key and matte are mutually exclusive within one scene; both need a background to composite onto.',
    'subtitles.source must be an .srt or .ass file. The scaled cue JSON that layout can produce is not a subtitle file: run it through srt_write first.',
    'Leave the timeline arithmetic to video_plan {action:"duration"}: transitions overlap and hand-adding scene durations overstates the length.',
  ],
  costAndAvailability: [
    'Always available, no install, no network, no key: video_plan (all), video_narrate {action:"to_cues"|"layout"|"srt_write"|"srt_read"}, video_qc {action:"cases"}, video_guide (all), audio_measure {action:"devices"}.',
    'Needs ffmpeg on the machine (video_env {action:"probe"} says whether it is): every render action, every probe, sample_frames, all of audio_build and nearly all of audio_measure.',
    'Needs the network, no key: video_narrate {action:"synthesize"} (Edge TTS read-aloud, 60s per request).',
    'Needs an API key and costs money per call: everything in video_gen. Check arkKeyPresent with video_env {action:"probe"} first.',
    'Needs a one-time model install: matte needs video_setup {action:"install_matte"} (4.36MB) and needs the shared ONNX runtime that audio_setup {action:"install"} in the separate dsh-video-audio plugin provides (about 28MB); ffmpeg needs video_setup {action:"install_ffmpeg"} (a few hundred MB). Reading text off a picture needs the separate dsh-ocr plugin (text_setup {action:"install"}), and classifying a soundtrack needs audio_measure {action:"audio_events"} in dsh-video-audio.',
    'Expensive in wall clock, in order: video_render {action:"scene"} with matte, finalize, video_qc {action:"check"} on a long film, sample_frames, audio_build {action:"record"} (real time), matte (about 2.1s per frame).',
  ],
  qualityGates: [
    'Before rendering: video_plan {action:"check"} (and diagnose when the material is mixed shapes).',
    'After rendering: video_inspect {action:"verify"} — an empty problems array is the only clean result.',
    'Before telling the user it is done: video_qc {action:"check"} with the plan, and a reportPath so the verdicts can be read back exactly.',
    'Never report success from a non-empty problems array, and never treat a skipped case as a pass: skipped means the suite could not judge it, and the reason says why.',
  ],
  outputVisibility: [
    'Some actions return a top-level "text" field, and the tool result you see is that text alone: video_qc {action:"check"} hides counts and measurements. When you need the structured form, pass reportPath, or use an action that returns the numbers directly.',
    'Paths in results are authoritative. Use them rather than reconstructing a path from the arguments: an image can land with a different extension than you asked for.',
  ],
  troubleshooting: [
    'No ffmpeg / encoders missing → video_env {action:"probe"}, then video_setup {action:"install_ffmpeg"}.',
    'Wrong canvas, bars, or a portrait film from landscape stills → video_plan {action:"diagnose"}, then re-check against video_env {action:"presets"}.',
    'Rendered file unchanged after editing the plan → the stages cached by existence: re-run with force:true.',
    'A shot is missing or black → was the scene left as a generate block? Render video_gen first and write its path into source.',
    'Subtitles absent from the picture → subtitles.enabled and subtitles.source must point at a real .srt, and finalize must be re-run with force.',
    'Audio too quiet, too loud, or clipping → audio_measure {action:"loudness"} (EBU R128) and {action:"levels"} (sample domain, clipping runs), then video_render {action:"finalize"} for the film, or audio_build {action:"restore"} for a take.',
    'Hiss, hum or rumble in a take → audio_measure {action:"noise"} to identify it, then audio_build {action:"restore"} with the matching method.',
    'Music starts at the wrong moment, or a stretch is silent → audio_measure {action:"audio_events"} in the separate dsh-video-audio plugin (transcription cannot show this).',
    'Do not know what is in the footage → video_analyze {action:"sample_frames"} rather than guessing from the filename.',
    'A delivered file plays badly or looks wrong on a device → video_qc {action:"structure"} (container, faststart) and {action:"picture"} (black, frozen, bars).',
    'Text on screen is misread → that is the separate dsh-ocr plugin: text_setup {action:"status"}, install an engine with text_setup {action:"install"}, then read with text_read {action:"read", engine:"local"} and a region.',
    'Two recordings do not line up → audio_measure {action:"sync"} (it needs about 10s of genuinely common material).',
  ],
}

/**
 * Ordered recipes for the jobs this plugin is actually used for.
 *
 * Each step names a tool and action, why it is there, and the arguments that matter. Steps
 * that only apply when something is missing are marked as branches.
 */
export const PLAYBOOKS = {
  'vertical-narrated-short': {
    title: 'Talking-head short with narration and burned subtitles (the common case)',
    goal: 'A 9:16 film with a voiceover, on-screen subtitles, a music bed, and a verified delivery.',
    when: 'The user asks for a short video with a script or narration, usually for a vertical platform.',
    steps: [
      'video_env {action:"probe"} — confirm ffmpeg exists before planning around it. Branch: video_setup {action:"install_ffmpeg"} when it does not.',
      'video_env {action:"presets"} — take the canvas (vertical-short) rather than inventing numbers.',
      'Write the script yourself, then video_narrate {action:"synthesize"} — you get MP3 plus per-word timings.',
      'video_narrate {action:"to_cues"} — timings to subtitle cues at your line length; free to re-run.',
      'video_narrate {action:"layout"} — turn the canvas into subtitles style values for plan.json.',
      'video_narrate {action:"srt_write"} — write the .srt that plan.json subtitles.source will point at.',
      'video_env {action:"scan"} — inventory the material; choose the stills or clips yourself.',
      'Write plan.json: scenes with source, duration, motion/transition; audio.voiceover points at the MP3; subtitles.enabled with that .srt and the layout style.',
      'video_plan {action:"check"}, then {action:"diagnose"} — fix every error before spending render time.',
      'video_render {action:"build"} if nothing needs looking at, otherwise scene → assemble → finalize → deliver so one bad shot can be re-rendered alone.',
      'video_inspect {action:"verify"} — empty problems or fix and re-render.',
      'video_qc {action:"check"} with reportPath — the acceptance suite, and the answer you report to the user.',
    ],
    pitfalls: [
      'Re-synthesizing after a wording tweak is wasted time: to_cues and layout are free.',
      'The subtitles only reach the picture through finalize; if you edit the .srt afterwards, re-run finalize with force.',
    ],
  },

  'image-slideshow': {
    title: 'Stills-only film (photo essay, product gallery)',
    goal: 'A film built from stills with deliberate motion and a music bed.',
    when: 'There is no footage, only images, and the result should not look like a slideshow of frozen frames.',
    steps: [
      'video_env {action:"scan"} — get every still with its size and orientation, plus duplicate marking. Choose the subset yourself; the near-duplicates are marked, never dropped.',
      'video_env {action:"presets"} — canvas and frame rate.',
      'Decide the order and the duration of each still; that is the edit, and it is yours to make.',
      'Write plan.json with one scene per still: motion (zoompan-style), a transition shorter than half the scene, and timing that matches the music.',
      'video_plan {action:"diagnose"} — this is where a portrait plan full of landscape stills and a motion:"none" still get named.',
      'video_plan {action:"duration"} — the real length once transitions overlap; adjust until it matches the audio.',
      'video_render {action:"build"} (or the four stages), then video_inspect {action:"verify"}.',
      'video_qc {action:"check"} when the delivery matters.',
    ],
    pitfalls: [
      'A still with motion "none" is a defect the plugin will report rather than silently freeze.',
      'Ken Burns-style motion plus a dark original can produce black edges: video_qc {action:"picture"} measures edge bars.',
    ],
  },

  'edit-existing-footage': {
    title: 'Cut down existing footage into a short',
    goal: 'Find the good moments in footage nobody has watched, and cut to them.',
    when: 'There is a long recording (screen capture, event video, raw clip) and the user wants highlights.',
    steps: [
      'video_env {action:"scan"} — what is actually there, and how long each file is.',
      'video_analyze {action:"sample_frames"} with extract:true — this returns the moments that matter with the reason they were picked, plus JPEGs you can look at.',
      'video_narrate {action:"transcribe"} on the source when the words matter — the way to learn what was said.',
      'audio_measure {action:"audio_events"} in the separate dsh-video-audio plugin — where music starts, where the room goes quiet: useful for choosing cut points that land with the sound.',
      'video_inspect {action:"media"} on the shots you chose — real duration and frame rate before you plan around them.',
      'Write plan.json cutting on the moments you selected, then video_plan {action:"check"}.',
      'video_render {action:"scene"} per shot while iterating, then assemble → finalize → deliver.',
      'video_inspect {action:"verify"}, and video_qc {action:"check"} for the deliverable.',
    ],
    pitfalls: [
      'Do not sample frames by hand with equal spacing and hope: the scoring exists because a cut or a burst of movement is what makes a moment worth keeping.',
      'sample_frames on a very long file can fail on its output budget: raise maxFrames or lower probeFps, or analyse it in pieces with start/duration.',
    ],
  },

  'generate-missing-shots': {
    title: 'Fill a gap with generated footage',
    goal: 'A shot the plan needs does not exist and cannot be sourced.',
    when: 'A specific image or moment is required and no material provides it.',
    steps: [
      'video_gen {action:"models"} / {action:"image_models"} — which ids this account can actually call, and their status.',
      'Decide text-to-video, image-to-video, or first-last frame. Image-to-video is the way to keep a composition you already like.',
      'video_gen {action:"generate"} with an explicit seed when the result may need to be revisited; poll defaults are 15s and 900s.',
      'Take the returned local path and write it into that scene\'s source in plan.json — the plan\'s own generate block is inert.',
      'video_plan {action:"check"}, then video_render {action:"scene"} for that shot only.',
      'video_inspect {action:"verify"} and the usual delivery gate.',
    ],
    pitfalls: [
      'Every generate call is billed and none is reproducible: generate only what is genuinely missing.',
      'A too-small maxWaitSeconds throws after submission, so the money is spent and the result is lost — there is no retrieve action.',
      'Public image URLs do not work as references; download to a local file first.',
    ],
  },

  'audio-first': {
    title: 'Sound first: build and clean the track, then cut pictures to it',
    goal: 'A film whose timing is driven by the audio rather than by the picture.',
    when: 'Music-driven edits, podcast-style pieces, or any take that needs repair before it is usable.',
    steps: [
      'audio_measure {action:"devices"} then audio_build {action:"record"} when the audio has to be captured now — record measures the take it wrote.',
      'audio_measure {action:"identify"} — is the file complete, and does the declared length match the decoded one?',
      'audio_measure {action:"noise"} — hum, hiss, rumble or a tone: this decides the restore chain.',
      'audio_build {action:"restore"} with an explicit chain, and read the before/after numbers it returns.',
      'audio_measure {action:"speech_map"} — where the speech is and where the pauses are, for cut points.',
      'audio_build {action:"assemble"} — place takes and the music bed on one timeline at sample-exact offsets; overlap is refused unless you ask for sum.',
      'audio_measure {action:"loudness"} across takes — the spread is how inconsistent recordings become visible before the mix, not after.',
      'Then plan the picture against the assembled track, and let finalize do the film mix and the EBU R128 pass.',
    ],
    pitfalls: [
      'levels and loudness answer different questions; use both when the complaint is "it sounds wrong".',
      'assemble refuses overlaps by default, and that refusal is information: two clips really do occupy the same time.',
      'sync needs roughly ten seconds of genuinely common material, more than its own guard suggests.',
    ],
  },

  'diagnose-bad-delivery': {
    title: 'The film is wrong and it is not obvious why',
    goal: 'Turn a vague complaint into a named cause and the smallest fix.',
    when: 'The user says it looks or sounds wrong, a player misbehaves, or a previous run left a file nobody trusts.',
    steps: [
      'video_inspect {action:"verify"} — does the file still match the plan? This catches resolution, frame rate, duration and a missing audio track.',
      'video_qc {action:"cases"} once, then {action:"check"} with the plan and a reportPath — the per-case verdicts name the domain that failed.',
      'video_qc {action:"structure"} — container, codecs, faststart, per-stream durations. A track ending early shows up here.',
      'video_qc {action:"picture"} — black runs, frozen runs, edge bars, with timestamps to look at.',
      'text_read {action:"verify"} (the separate dsh-ocr plugin) — are the burned-in subtitles the ones the plan asked for? It reads them off the picture at the SRT\'s own times.',
      'video_analyze {action:"sample_frames"} — what is actually in the picture at the reported timestamps.',
      'audio_measure {action:"levels"} and {action:"loudness"} — clipping and DC in the sample domain, EBU R128 for delivery levels.',
      'video_plan {action:"diagnose"} when the suspicion is the edit rather than the encode.',
      'Fix the named cause and re-render only the stages that carry it — with force, because stages cache by file existence.',
    ],
    pitfalls: [
      'A skipped case is not a pass; read the skip reason and the notes.',
      'Do not re-render everything before reading the verdicts: the caching rule means a partial re-render is cheap only if you know which stage was wrong.',
    ],
  },

  'subtitles-only': {
    title: 'Add or replace subtitles on an existing film',
    goal: 'Subtitles that are in sync, legible, and actually in the file.',
    when: 'The picture is final and only the subtitles change — or an existing subtitle file has to be reused.',
    steps: [
      'If the film already exists and only the .srt changes: edit the .srt (or video_narrate {action:"srt_read"} → edit → {action:"srt_write"}), then re-run video_render {action:"finalize"} with force:true.',
      'If the film has no voiceover script yet: video_narrate {action:"transcribe"} to get the words, then build cues by hand or from a real script via synthesize → to_cues.',
      'video_narrate {action:"layout"} for style values that match the canvas.',
      'video_plan {action:"check"} to confirm subtitles.source points at a real .srt or .ass file.',
      'video_inspect {action:"verify"}, then text_read {action:"verify"} (the separate dsh-ocr plugin) to prove the lines are on the picture and legible.',
    ],
    pitfalls: [
      'finalize caches by file existence: without force, the previous film is returned unchanged and the subtitles look "broken" when they were never applied.',
      'The scaled cue JSON from layout is not a subtitle file: write it through srt_write.',
    ],
  },

  'bootstrap-machine': {
    title: 'This machine is missing pieces',
    goal: 'Get to a state where the pipeline can run, with the minimum downloaded.',
    when: 'video_env {action:"probe"} reports missing ffmpeg or encoders, or an action failed asking for a model.',
    steps: [
      'video_env {action:"probe"} — read the problems array: it names exactly what is missing.',
      'video_setup {action:"install_ffmpeg"} when ffmpeg or ffprobe is missing, or libx264/aac is absent from the encoders.',
      'audio_setup {action:"install"} (dsh-video-audio) before video_setup {action:"install_matte"}: the matting model reuses the runtime the audio plugin installs, and install_matte now refuses before downloading when it is absent.',
      'video_env {action:"probe"} again, then video_analyze {action:"matte_status"} for the matte side; sound and its model belong to dsh-video-audio, whose audio_setup {action:"status"} reports them.',
      'Reading text off a picture is a separate plugin: text_setup {action:"install"} (dsh-ocr), and text_setup {action:"status"} to see which engine would answer.',
    ],
    pitfalls: [
      'Do not install everything up front: ffmpeg alone is a few hundred megabytes.',
      'When a download host is blocked, pass archive with a locally obtained file — the pinned digest is still checked.',
      'A half-finished ffmpeg unpack leaves a directory that makes later installs skip: pass force to recover.',
    ],
  },
}
