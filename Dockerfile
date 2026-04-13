# VE Edit API — Dockerfile pour Railway / Render / Fly / DigitalOcean
# Node 20 + Python 3.11 + ffmpeg + faster-whisper

FROM node:20-bookworm-slim

# Install Python, ffmpeg, build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Node deps first (better Docker layer caching)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Python venv with faster-whisper (tiny model) + SpeechRecognition fallback
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir \
        faster-whisper \
        SpeechRecognition

ENV PATH="/opt/venv/bin:$PATH"
ENV PYTHONUNBUFFERED=1

# App code (everything except what's in .dockerignore)
COPY . .

# Tmp dir for video bundles
ENV BUNDLE_TMP_DIR=/tmp/ve-edit-bundles
RUN mkdir -p ${BUNDLE_TMP_DIR}

# Pre-download faster-whisper "tiny" model so first request is fast
RUN python3 -c "from faster_whisper import WhisperModel; WhisperModel('tiny', device='cpu', compute_type='int8')" || true

ENV PORT=3002
EXPOSE 3002

CMD ["node", "server.js"]
