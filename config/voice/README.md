# pivoice (bundled with apple-pi)

Voice front-end for the [pi coding agent](https://pi.dev). Speak a prompt →
transcribed on-device (whisper.cpp) → sent to `pi` → reply streamed back and
spoken aloud (`say`). No cloud, no speech API key.

```
mic ─▶ ffmpeg ─▶ whisper.cpp (STT) ─▶ pi --mode rpc ─▶ text stream ─▶ say (TTS)
```

## Two ways to run

### 1. Voice mode (from the pi TUI) — recommended

Inside any `pi` session, type **`/voice`** (or press **Ctrl+V**). apple-pi
launches pivoice on **the current session** — same conversation. Your voice
turns append to the session JSONL. Press `q` to exit voice mode, then resume
the TUI:

```sh
pi -c   # voice turns now appear in the tree
```

### 2. Standalone

```sh
pivoice            # if $PI_DIR/voice/bin is on your PATH, else:
~/.pi/voice/bin/pivoice
```

This starts a fresh "voice" session (no handoff).

## Keys (inside pivoice)

| Key | Action |
|-----|--------|
| `SPACE` / `r` | Tap to record, tap again to send |
| `a` | Abort the pi turn + stop speech |
| `n` | New session |
| `c` | Clear screen |
| `q` / Ctrl-C | Quit voice mode |

## First-run setup (OS deps, not npm)

```sh
brew install whisper-cpp
mkdir -p ~/.pi/voice/models
curl -L -o ~/.pi/voice/models/ggml-small.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin
```

macOS will prompt for **Terminal → microphone access** on first recording.

## Configuration (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `PIVOICE_MODEL` | `./models/ggml-small.en.bin` | ggml model path |
| `PIVOICE_MIC` | auto (prefers MacBook mic) | avfoundation audio index |
| `PIVOICE_SAY_VOICE` | Samantha | `say` voice |
| `PIVOICE_NO_SPEAK` | — | `1` = mute spoken replies |
| `PIVOICE_PI_CWD` | `$PWD` | working directory for pi |
| `PIVOICE_PI_ARGS` | — | extra args to `pi --mode rpc` |
| `PIVOICE_SESSION` | — | **set by `/voice`** — session JSONL to resume |

## How session handoff works

pi sessions are append-only JSONL trees. `/voice` reads the active session
file and launches pivoice with `PIVOICE_SESSION=<path>`; pivoice boots
`pi --mode rpc --session <path>`, so voice turns land in the same file. When
you `pi -c` back in the TUI, the tree shows them.

## Updating

Bundled copy is a vendored snapshot. Keep it current with:

```sh
apple-pi update --voice
```

Or run the upstream standalone: <https://github.com/jotokra/pivoice>.

## License

MIT (see repo LICENSE).
