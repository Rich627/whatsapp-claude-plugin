#!/bin/bash
# This file deliberately uses plain [ ] / unbraced-$VAR style; some optional
# style rules would demand the other convention. Never let an autofix
# restyle it — see scripts/watchdog.sh's header for why.
# shellcheck disable=SC1090,SC2250,SC2292
# Transcribe audio file using mlx-whisper (local, free, Apple Silicon optimized)
# Usage: whisper-transcribe.sh <audio_file_path>
# Outputs: transcription text to stdout
#
# Setup (one-time):
#   python3 -m venv ~/whisper-env
#   source ~/whisper-env/bin/activate
#   pip install mlx-whisper
#   brew install ffmpeg
#   cp scripts/whisper-transcribe.sh ~/whisper-transcribe.sh
#   chmod +x ~/whisper-transcribe.sh
#
# The whatsapp-channel plugin invokes ~/whisper-transcribe.sh on every
# incoming voice/audio message. If the script is missing or fails, the
# message falls back to a non-transcribed attachment.
#
# Exit codes:
#   1  — general failure (python/whisper error)
#   2  — the venv is missing (whisper is not installed / not set up)
#
# Contract: server.ts runs this script and treats stdout as the transcript
# verbatim, so stdout MUST stay exactly the transcript text, or empty on
# failure. Anything diagnostic goes to stderr only.

set -euo pipefail

# Ensure ffmpeg is reachable — mlx-whisper uses it to decode audio.
# Homebrew's bin is not in PATH under launchd by default.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

VENV_ACTIVATE=~/whisper-env/bin/activate
if [ ! -f "$VENV_ACTIVATE" ]; then
	echo "whisper-transcribe.sh: whisper is not installed - $VENV_ACTIVATE not found (see setup instructions at the top of this script)" >&2
	exit 2
fi
source "$VENV_ACTIVATE"

python3 -c '
import sys
import mlx_whisper

result = mlx_whisper.transcribe(sys.argv[1], path_or_hf_repo="mlx-community/whisper-large-v3-turbo")
print(result["text"].strip())
' "$1"
