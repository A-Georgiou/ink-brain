# Ink Brain

An always-on companion for your Mac, built on GitHub Copilot. Circle or click anything on your screen and ask about it, by voice or by typing. Ink Brain sees what you are pointing at, answers out loud, and teaches visually: it sketches on your screen while it talks, animates equations and graphs like a 3Blue1Brown video, builds 3D models of the things you ask about, and opens live demos you can play with.

> Ink Brain is an independent project, not an official GitHub product. It uses GitHub Copilot through the [Copilot SDK](https://github.com/github/copilot-sdk), so you need a Copilot subscription.

## Features

- **Ask about anything on screen.** Press the hotkey, circle what you mean and talk. Ink Brain reads everything itself, including the full article or thread behind a preview, after you allow the site.
- **Hear the answer.** Replies are spoken in an on-device neural voice, with hands-free follow-ups.
- **See the explanation.** Narrated, step-by-step explanations that build up as Ink Brain talks:
  - hand-drawn sketches, arrows and diagrams on top of your screen
  - 2D motion graphics for maths and dense text: equations that rearrange themselves, colour-coded terms, graphs whose variables animate, boxes and arrows with flowing dots
  - 3D models for physical things, with parts that move on their real hinges, come apart or are cut away to show what is inside
- **Bring images to life.** Pull an image out of the screen, re-render it, or lay a live 3D or animated version over the original.
- **Remember you.** Your projects, devices and preferences, past conversations and the visuals it made, all kept on your Mac.
- **Show you how.** With your approval, it moves the mouse and types to demonstrate a step, and stops the moment you move the mouse.
- **Work with Copilot CLI and the Copilot app.** Any session can draw and speak on your screen, and you can send questions from the overlay to a session you already have open.

## Requirements

- macOS 14 or later (Apple silicon or Intel)
- Node.js 22.12 or later
- Xcode Command Line Tools (`swiftc` builds the native helper)
- A GitHub Copilot subscription, signed in with the Copilot CLI (`copilot login`)

## Getting started

```bash
git clone https://github.com/A-Georgiou/ink-brain.git
cd ink-brain
npm install
npm start
```

On first launch, a setup card asks you to allow **Ink Brain Helper** to use Screen Recording, the Microphone and Speech Recognition, and optionally Accessibility so it can operate your Mac when you approve. After switching on Screen Recording in System Settings, click **Restart helper**.

The neural voice model (Kokoro, about 90 MB) downloads on first launch; Apple voices are used until it is ready. Run `npm run doctor` at any time to check the helper, permissions, screen capture and voices.

macOS ties the helper's permissions to its exact build, so after an update that changes the helper you need to allow it again. Ink Brain clears outdated approvals when it starts, so System Settings always shows what is really allowed.

## Using Ink Brain

| To | Do this |
| --- | --- |
| Ask about your screen | Press **Option+Shift+Space**, circle, underline or click things, then talk or type. Press Enter, or stop talking, to send. |
| Leave pen mode | Press Esc. Cmd+Z, Backspace or a right-click undoes your last mark. |
| Follow up | Keep talking for about 12 seconds after an answer. |
| Go hands-free | Turn on **Talk hands-free** in the menu bar and start questions with "Ink Brain". |
| Stop or interrupt | Press the stop button on the answer, or the hotkey to ask something else. |
| Clear the screen | Close the answer bubble to clear the page you are on, or use **Clear screen** in the menu bar to clear every page. |
| Ask about audio | Turn on **Hear my screen** to ask about a video or call playing on your Mac (transcribed on-device). |
| Manage memory | **Memory** in the menu bar shows what Ink Brain remembers, turns parts off or forgets everything. |

Drawings and panels stay with the page they were made for: they hide when you switch tab, window or Space and come back when you return. Panels can be dragged by their title bar and resized from the corner.

## Copilot CLI and the Copilot app

```bash
npm run extension:install     # or Install Copilot CLI and App extension in the menu bar
npm run extension:uninstall
```

New sessions (or `/clear` in an open one) get Ink Brain's tools, so they can draw, explain and speak on your screen. If the overlay is not running, the first tool call starts it.

- A session must be allowed once per connection before it can see your screen, and taking control always needs its own approval.
- The **To:** chip in the composer sends your question to a linked session instead of the built-in one. The answer is spoken and shown in the bubble, and the question appears in the session as `[Ink Brain] ...`. **Auto** picks the newest idle session you have allowed.

## Configuration

Settings live in `~/.ink-brain/config.json` (**Open settings file** in the menu bar). Restart Ink Brain after editing.

| Key | Default | Meaning |
| --- | --- | --- |
| `hotkey` | `Alt+Shift+Space` | Shortcut for pen mode, in Electron accelerator syntax (`Alt` is Option). |
| `model` | `claude-opus-5.5` | Model for the built-in session; another vision model is used if it is unavailable. |
| `reasoningEffort` | `low` | Higher effort plans more detailed visuals but takes longer to start talking. |
| `useCustomInstructions` | `false` | Load your Copilot custom instructions into the built-in session. |
| `defaultTarget` | `auto` | `auto`, or `standalone` to always use the built-in session. |
| `stayLive` | `false` | Start in hands-free mode. |
| `wakeWord` | `ink brain` | Phrase that starts a hands-free question; an empty string accepts everything. |
| `followUpSeconds` | `12` | How long the mic stays open for a follow-up. |
| `hearScreen` | `false` | Start with **Hear my screen** on. |
| `inheritPermissions` | `false` | Run the helper with your terminal's permissions instead of its own. |
| `maxScreenshotEdge` | `1568` | Longest edge of screenshots sent to the model, in pixels. |
| `annotationTtlSeconds` | `45` | How long drawings stay. |
| `explanationTtlSeconds` | `90` | How long an explanation's drawings stay after it ends. |
| `control` | `ask` | `ask` lets Ink Brain request control of your Mac; `off` never allows it. |
| `imageGeneration` | `true` | Let the built-in session generate images. |
| `web` | `on` | `on` lets Ink Brain read web pages whenever an answer needs them; `ask` asks before each new site; `off` never allows it. |
| `webSites` | `[]` | With `ask`, the sites you chose **Always allow** for, including their subdomains. |
| `memory.enabled` | `true` | Remember facts, conversations and visuals. |
| `memory.screen` | `true` | Also remember which window and page were in front, and for how long. |
| `memory.copilotSessions` | `true` | Tell Ink Brain about your recent Copilot CLI and app sessions. |
| `memory.resumeHours` | `6` | After a restart, carry on the last conversation if it was this recent. |
| `memory.keepDays` | `30` | How long conversations and screen history are kept. |
| `voice.input`, `voice.output` | `true` | Voice input and spoken replies. |
| `voice.engine` | `neural` | `neural` for the on-device Kokoro voice, `system` for Apple voices. |
| `voice.neuralVoice`, `voice.neuralQuality`, `voice.speed` | `af_heart`, `q8`, `1` | Kokoro voice (for example `bf_emma` for British English), precision and speed. |
| `voice.voiceId`, `voice.rate`, `voice.locale` | system | Apple voice, rate (0 to 1) and recognition locale. |
| `voice.silenceMs` | `1100` | Pause that ends an utterance. |
| `voice.allowServerSpeech` | `false` | Allow Apple's server-based recognition when on-device recognition is unavailable. |
| `voice.maxSpokenChars` | `700` | Longer answers are shown in full but only partly read aloud. |

The environment variables `INK_BRAIN_MODEL` and `INK_BRAIN_HOTKEY` override the config, and `INK_BRAIN_HOME` points Ink Brain at a different settings folder.

## How it works

```
 hotkey, pen, voice                       Copilot CLI / app session
        |                                          |  live_* tools
        v                                          v
 Electron overlay (transparent,  <-- Unix socket --  session extension
 click-through, every Space)                        (extension/ink-brain.mjs)
        |                       \
        |  JSON lines on stdio   \  Copilot SDK
        v                         v
 Native helper (Swift):        Built-in Copilot session
 screen capture, speech,       with the live_* tools
 audio, input, app context
```

| Path | Role |
| --- | --- |
| `src/main/` | Electron main process: the overlay window, menu bar, turns, the built-in session (`brain.mjs`), tools (`surface.mjs`), narrated explanations (`explain.mjs`), memory, voice, web reading, control and the socket bridge for linked sessions. |
| `src/overlay/` | The overlay: pen, sketches, panels, answer bubble and composer. `sandbox.js` runs panel content in isolated frames, `scene.js` renders 3D scenes (with geometry in `shapes.js` and ready-made components in `parts.js`) and `board.js` 2D motion graphics. |
| `src/shared/` | Tool definitions, scene and board vocabularies with their validation, a safe maths expression parser, geometry and the socket protocol. |
| `extension/` | The Copilot CLI and app session extension. |
| `native/` | The Swift helper: ScreenCaptureKit, speech recognition and synthesis, audio playback, mouse and keyboard input. |

Ink Brain describes what it wants to show as data (shapes, scenes, boards), which the overlay validates and renders, so the model never has to write code for the common cases. Equations are typeset with KaTeX, 3D uses three.js with [three-bvh-csg](https://github.com/gkjohnson/three-bvh-csg) for cut-outs, and sketches use rough.js.

## Privacy and security

- Nothing is captured until you ask. Each question sends one screenshot, plus a zoomed crop around your marks, to the Copilot session you chose. The overlay is excluded from screenshots.
- Speech recognition and the neural voice run on-device (unless you allow server speech).
- Memory stays on your Mac in `~/.ink-brain/memory` (folders 0700, files 0600). Screen history records only the front app and window title, skips idle time and password managers, and is deleted after `memory.keepDays`.
- The model is told to treat screen content, audio and web pages as untrusted data and not to read out secrets it can see. Remembered text reaches it labelled as data, never as instructions.
- Web pages are read in a hidden, signed-out browser window with its own in-memory profile, which loads no images or media and refuses downloads and permissions. Set `web` to `ask` to approve each new site; every navigation then stays on sites you allowed.
- Control of your Mac needs your approval of the listed steps, and stops when you press Esc, press the hotkey or move the mouse.
- Panels run model-written code in sandboxed frames with no network access, and the overlay blocks web requests.
- Linked sessions connect over `~/.ink-brain/bridge.sock` (mode 0600) and only see your screen after you allow them.

## Development

```bash
npm test                          # unit and integration tests
npm run lint                      # ESLint
npm run doctor                    # native helper diagnostics
INK_BRAIN_DEBUG=1 npm start       # turn timings and overlay console output
node scripts/debug.mjs state      # drive a debug instance (state, snapshot, tool, turn, pen, memory, ...)
```

Set `INK_BRAIN_HOME` to run a test instance with its own settings next to your real one.

The eval suite plays real-world scenarios (circled equations, photos to model in 3D, pages to research, controls to find, code and diagrams) through Ink Brain's own brain, tools and overlay, and a vision model scores what you would see and hear:

```bash
npm run eval:capture              # capture the scenario pages once (fixtures stay local)
npm run eval -- --label mine      # run and judge every scenario (--only, --category, --repeat)
npm run eval:report -- base mine  # compare runs, by category and scenario
```

## Limitations

- macOS only. The overlay covers the display under your cursor when you press the hotkey.
- Marks are placed from coordinates read off the screenshot, so they can land slightly off on dense screens.
- Drawings follow pages by window and title, so they do not follow scrolling within a page.
- The mic pauses while Ink Brain speaks, so you interrupt with the hotkey rather than by talking over it.
- Explanations appear once the model has written all their steps, usually 10 to 30 seconds after you ask, while Ink Brain starts talking within a few seconds.
- 3D models are most faithful when the picture shows the thing straight from the side, front or above, so its shape can be traced.
- The web reader is signed out, so it cannot read private pages.
