#!/usr/bin/env python3
"""
Extract video bundle using OpenCV + Whisper.
Usage: python3 extract_cv.py <video_path> -o <output_dir>

Produces:
  <output_dir>/frames/frame_NNNN_X.Xs.jpg
  <output_dir>/index.json  (with transcript + per-frame spoken_text)
"""

import sys
import os
import json
import shutil
import cv2
from pathlib import Path

FRAME_INTERVAL = 0.5  # seconds between frames

# Search paths for ffmpeg (needed by whisper)
FFMPEG_SEARCH = [
    "/tmp/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/opt/homebrew/bin/ffmpeg",
    "/Applications/CapCut.app/Contents/Resources/ffmpeg",
]


def find_ffmpeg():
    """Find ffmpeg binary."""
    # Check PATH first
    found = shutil.which("ffmpeg")
    if found:
        return found
    # Check known locations
    for p in FFMPEG_SEARCH:
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def transcribe_audio(video_path, ffmpeg_path=None):
    """Transcribe audio using Whisper. Returns (full_text, segments)."""
    try:
        import whisper
    except ImportError:
        print("⚠️  whisper not installed — skipping transcription")
        return "", []

    # Add ffmpeg to PATH if found outside PATH
    if ffmpeg_path and os.path.dirname(ffmpeg_path) not in os.environ.get("PATH", ""):
        os.environ["PATH"] = os.path.dirname(ffmpeg_path) + ":" + os.environ.get("PATH", "")

    print("🎤 Transcribing with Whisper (base model, fr)...")
    model = whisper.load_model("base")
    result = model.transcribe(str(video_path), language="fr")

    full_text = result.get("text", "").strip()
    segments = []
    for seg in result.get("segments", []):
        segments.append({
            "start": round(seg["start"], 1),
            "end": round(seg["end"], 1),
            "text": seg["text"].strip(),
        })

    print(f"   → {len(segments)} segments, {len(full_text)} chars")
    return full_text, segments


def map_segments_to_frames(frame_list, segments):
    """Map transcript segments to frames based on timecodes."""
    for frame in frame_list:
        t = frame["timecode_s"]
        # Find segments that overlap with this frame's time window [t, t+0.5)
        spoken = []
        for seg in segments:
            if seg["start"] <= t + 0.25 and seg["end"] >= t:
                spoken.append(seg["text"])
        frame["spoken_text"] = " ".join(spoken) if spoken else ""


def extract(video_path: str, output_dir: str):
    video_path = Path(video_path)
    output_dir = Path(output_dir)

    if not video_path.exists():
        print(f"❌ Video not found: {video_path}")
        sys.exit(1)

    # Create output structure
    frames_dir = output_dir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)

    # Open video
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        print(f"❌ Cannot open video: {video_path}")
        sys.exit(1)

    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = total_frames / fps if fps > 0 else 0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    print(f"📹 Video: {video_path.name}")
    print(f"   Duration: {duration:.1f}s | FPS: {fps:.1f} | {width}x{height}")

    # Extract frames
    frame_interval_frames = int(fps * FRAME_INTERVAL)
    frame_list = []
    frame_idx = 0
    saved_count = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        if frame_idx % frame_interval_frames == 0:
            timecode_s = frame_idx / fps
            saved_count += 1
            filename = f"frame_{saved_count:04d}_{timecode_s:.1f}s.jpg"
            filepath = frames_dir / filename

            cv2.imwrite(str(filepath), frame, [cv2.IMWRITE_JPEG_QUALITY, 85])

            frame_list.append({
                "index": saved_count - 1,
                "filename": filename,
                "timecode": f"{timecode_s:.1f}s",
                "timecode_s": round(timecode_s, 1),
                "spoken_text": "",
            })

        frame_idx += 1

    cap.release()
    print(f"🖼️  {len(frame_list)} frames extracted")

    # Transcribe audio
    ffmpeg_path = find_ffmpeg()
    if not ffmpeg_path:
        print("⚠️  ffmpeg not found — skipping transcription")
        full_text = ""
        segments = []
    else:
        print(f"   ffmpeg: {ffmpeg_path}")
        full_text, segments = transcribe_audio(video_path, ffmpeg_path)
        map_segments_to_frames(frame_list, segments)

    # Build index.json
    index = {
        "video": video_path.name,
        "duration_s": round(duration, 1),
        "fps": round(fps, 1),
        "resolution": f"{width}x{height}",
        "frame_interval_s": FRAME_INTERVAL,
        "frames_count": len(frame_list),
        "transcript": full_text,
        "transcript_segments": segments,
        "frames": frame_list,
    }

    index_path = output_dir / "index.json"
    index_path.write_text(json.dumps(index, indent=2, ensure_ascii=False), encoding="utf-8")

    print(f"✅ Bundle ready: {output_dir}")
    if full_text:
        print(f"   Transcript: {full_text[:100]}...")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("video", help="Path to video file")
    parser.add_argument("-o", "--output", required=True, help="Output directory")
    args = parser.parse_args()
    extract(args.video, args.output)
