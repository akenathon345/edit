#!/usr/bin/env python3
"""
VE Edit — Étape 1 : Extraction vidéo
Découpe une vidéo en :
  - frames toutes les 0.5s (JPEG)
  - transcription audio avec timecodes
Produit un dossier bundle + index.json prêt pour l'analyse VE Edit.

Stratégie de transcription (par ordre de priorité) :
  1. faster-whisper (local, si le modèle est disponible)
  2. Google Speech Recognition (cloud, gratuit, via SpeechRecognition)
  3. Fallback : audio extrait sans transcription, à fournir manuellement
"""

import argparse
import json
import math
import os
import subprocess
import sys
from pathlib import Path


def extract_frames(video_path: str, output_dir: str, interval: float = 0.5):
    """Extracts frames at a fixed interval using ffmpeg."""
    frames_dir = os.path.join(output_dir, "frames")
    os.makedirs(frames_dir, exist_ok=True)

    # Get video duration
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", video_path],
        capture_output=True, text=True
    )
    duration = float(probe.stdout.strip())

    # Extract frames with ffmpeg
    fps = 1.0 / interval
    subprocess.run(
        ["ffmpeg", "-y", "-i", video_path, "-vf", f"fps={fps}",
         "-q:v", "2", os.path.join(frames_dir, "frame_%04d.jpg")],
        capture_output=True, text=True
    )

    # Build frame list with timecode-named files
    frames = []
    frame_files = sorted(Path(frames_dir).glob("frame_*.jpg"))
    for i, fpath in enumerate(frame_files):
        tc = round(i * interval, 2)
        if tc > duration + interval:
            break
        new_name = f"frame_{i+1:04d}_{tc:.1f}s.jpg"
        new_path = fpath.parent / new_name
        fpath.rename(new_path)
        frames.append({
            "index": i + 1,
            "timecode_s": tc,
            "filename": new_name,
            "spoken_text": ""
        })

    print(f"  → {len(frames)} frames extraites (interval={interval}s, duration={duration:.1f}s)")
    return frames, duration


def extract_audio_wav(video_path: str, output_dir: str) -> str:
    """Extracts audio as mono 16kHz WAV for transcription."""
    wav_path = os.path.join(output_dir, "audio.wav")
    subprocess.run(
        ["ffmpeg", "-y", "-i", video_path, "-ar", "16000", "-ac", "1",
         "-f", "wav", wav_path],
        capture_output=True, text=True
    )
    return wav_path


def transcribe_with_faster_whisper(video_path: str, model_size: str = "tiny") -> dict | None:
    """Try faster-whisper. Returns None if unavailable."""
    try:
        import os as _os
        # Remove proxy env vars that block HuggingFace
        env_backup = {}
        for k in ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy']:
            if k in _os.environ:
                env_backup[k] = _os.environ.pop(k)

        from faster_whisper import WhisperModel
        print(f"  → Tentative faster-whisper ({model_size})…")
        model = WhisperModel(model_size, device="cpu", compute_type="int8")
        segments_iter, info = model.transcribe(video_path, language="fr", beam_size=5)

        segments = []
        full_parts = []
        for seg in segments_iter:
            segments.append({"start": round(seg.start, 2), "end": round(seg.end, 2), "text": seg.text.strip()})
            full_parts.append(seg.text.strip())

        # Restore proxy
        _os.environ.update(env_backup)

        print(f"  → faster-whisper OK ({len(segments)} segments)")
        return {"text": " ".join(full_parts), "segments": segments}
    except Exception as e:
        print(f"  → faster-whisper indisponible: {e}")
        # Restore proxy
        import os as _os
        _os.environ.update(env_backup if 'env_backup' in dir() else {})
        return None


def transcribe_with_speech_recognition(wav_path: str, chunk_duration: float = 30.0) -> dict | None:
    """Transcribe using Google Speech Recognition (free, cloud). Chunks audio for long files."""
    try:
        import speech_recognition as sr
        import wave

        print(f"  → Tentative Google Speech Recognition…")
        recognizer = sr.Recognizer()

        # Get audio duration
        with wave.open(wav_path, 'rb') as wf:
            audio_duration = wf.getnframes() / wf.getframerate()

        n_chunks = max(1, math.ceil(audio_duration / chunk_duration))
        segments = []
        full_parts = []

        for i in range(n_chunks):
            start_s = i * chunk_duration
            end_s = min((i + 1) * chunk_duration, audio_duration)

            with sr.AudioFile(wav_path) as source:
                audio = recognizer.record(source, offset=start_s, duration=end_s - start_s)

            try:
                text = recognizer.recognize_google(audio, language="fr-FR")
                segments.append({"start": round(start_s, 2), "end": round(end_s, 2), "text": text})
                full_parts.append(text)
                print(f"    chunk {i+1}/{n_chunks}: OK ({len(text)} chars)")
            except sr.UnknownValueError:
                print(f"    chunk {i+1}/{n_chunks}: pas de parole détectée")
            except sr.RequestError as e:
                print(f"    chunk {i+1}/{n_chunks}: erreur API ({e})")
                return None

        if not segments:
            return None

        print(f"  → Google SR OK ({len(segments)} segments)")
        return {"text": " ".join(full_parts), "segments": segments}
    except ImportError:
        print("  → SpeechRecognition non installé")
        return None
    except Exception as e:
        print(f"  → Google SR échoué: {e}")
        return None


def transcribe_audio(video_path: str, wav_path: str, model_size: str = "tiny") -> dict:
    """Try all transcription backends. Returns best available result."""

    # 1. Try faster-whisper
    result = transcribe_with_faster_whisper(video_path, model_size)
    if result:
        return result

    # 2. Try Google Speech Recognition
    result = transcribe_with_speech_recognition(wav_path)
    if result:
        return result

    # 3. Fallback: empty transcript
    print("  ⚠️  Aucune transcription disponible. Fournir manuellement dans index.json.")
    return {"text": "", "segments": []}


def assign_text_to_frames(frames: list, transcript: dict, interval: float) -> None:
    """Assigns spoken text overlapping each frame's time window."""
    segments = transcript["segments"]
    for frame in frames:
        t_start = frame["timecode_s"]
        t_end = t_start + interval
        overlapping = []
        for seg in segments:
            if seg["end"] > t_start and seg["start"] < t_end:
                overlapping.append(seg["text"])
        frame["spoken_text"] = " ".join(overlapping) if overlapping else ""


def build_bundle(video_path: str, output_dir: str, interval: float = 0.5, model_size: str = "tiny"):
    """Main pipeline: extract frames + transcribe + build index.json."""
    video_name = Path(video_path).stem
    bundle_dir = os.path.join(output_dir, f"{video_name}_bundle")
    os.makedirs(bundle_dir, exist_ok=True)

    print(f"[1/4] Extraction des frames ({interval}s)…")
    frames, duration = extract_frames(video_path, bundle_dir, interval)

    print(f"[2/4] Extraction audio WAV…")
    wav_path = extract_audio_wav(video_path, bundle_dir)

    print(f"[3/4] Transcription audio…")
    transcript = transcribe_audio(video_path, wav_path, model_size)

    print(f"[4/4] Assemblage du bundle…")
    assign_text_to_frames(frames, transcript, interval)

    # Clean up WAV
    if os.path.exists(wav_path):
        os.remove(wav_path)

    index = {
        "video": video_name,
        "interval_s": interval,
        "duration_s": round(duration, 2),
        "total_frames_extracted": len(frames),
        "frames": frames,
        "full_transcript": transcript
    }

    index_path = os.path.join(bundle_dir, "index.json")
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)

    print(f"\n✅ Bundle prêt : {bundle_dir}")
    print(f"   → {len(frames)} frames")
    print(f"   → {len(transcript['segments'])} segments de transcription")
    print(f"   → index.json : {index_path}")
    return bundle_dir


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="VE Edit — Extraction vidéo")
    parser.add_argument("video", help="Chemin vers la vidéo")
    parser.add_argument("-o", "--output", default=".", help="Dossier de sortie")
    parser.add_argument("-i", "--interval", type=float, default=0.5, help="Intervalle entre frames (s)")
    parser.add_argument("-m", "--model", default="tiny", help="Modèle Whisper (tiny/base/small)")
    args = parser.parse_args()

    build_bundle(args.video, args.output, args.interval, args.model)
