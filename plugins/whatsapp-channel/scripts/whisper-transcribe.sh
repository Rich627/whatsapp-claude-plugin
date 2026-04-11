#!/bin/bash
# Transcribe audio file using mlx-whisper (local, free, Apple Silicon optimized)
# Usage: whisper-transcribe.sh <audio_file_path>
# Outputs: transcription text to stdout
#
# Setup (one-time):
#   python3 -m venv ~/whisper-env
#   source ~/whisper-env/bin/activate
#   pip install mlx-whisper
#   brew install ffmpeg
#   cp plugins/whatsapp-channel/scripts/whisper-transcribe.sh ~/whisper-transcribe.sh
#   chmod +x ~/whisper-transcribe.sh
#
# The whatsapp-channel plugin invokes ~/whisper-transcribe.sh on every
# incoming voice/audio message. If the script is missing or fails, the
# message falls back to a non-transcribed attachment.

# Ensure ffmpeg is reachable — mlx-whisper uses it to decode audio.
# Homebrew's bin is not in PATH under launchd by default.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

source ~/whisper-env/bin/activate

python3 -c "
import sys
import mlx_whisper

result = mlx_whisper.transcribe(sys.argv[1], path_or_hf_repo=\"mlx-community/whisper-large-v3-turbo\")
print(result[\"text\"].strip())
" "$1"
