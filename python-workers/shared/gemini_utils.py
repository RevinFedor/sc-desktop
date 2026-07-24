import os
import json
import time
import logging
import requests
import mimetypes
import base64
import io
import random
import subprocess
from pathlib import Path
from datetime import datetime

try:
    from credentials import secret
except Exception:
    secret = None


def _lib_root():
    return Path(
        os.environ.get("SC_DESKTOP_DIR")
        or os.environ.get("MEDIA_INBOX_DIR")
        or (Path.home() / "Library" / "Application Support" / "sc-desktop")
    )


# --- Session log ---
_LOG_DIR = _lib_root() / "logs" / "python"
_LOG_DIR.mkdir(parents=True, exist_ok=True)
_log_file = _LOG_DIR / f"sc_{datetime.now().strftime('%Y-%m-%d')}.log"
logging.basicConfig(
    filename=str(_log_file),
    level=logging.DEBUG,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("sc")

# Лимит для inline_data (20MB), выше — File API
INLINE_SIZE_LIMIT = 20 * 1024 * 1024

# Stable internal sentinel for a successful Gemini response that contains no
# textual output. Callers that know the input modality can turn this into a
# domain-specific machine code instead of exposing a parser KeyError such as
# "'parts'" to the user.
EMPTY_TEXT_ERROR = "Model returned no text"

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

# Pricing constants for Gemini 2.5 Flash-Lite (vision/PDF/merge tier).
PRICE_INPUT_1M = 0.10
PRICE_OUTPUT_1M = 0.40

class GeminiClient:
    def __init__(self, api_key=None):
        self.api_key = api_key or os.environ.get("GEMINI_API_KEY")
        self.openai_key = os.environ.get("OPENAI_API_KEY")
        self.assemblyai_key = os.environ.get("ASSEMBLYAI_API_KEY")

        if secret:
            self.api_key = self.api_key or secret("GEMINI_API_KEY", ("api_keys", "GEMINI_API_KEY"), ("api", "gemini_api_key"))
            self.openai_key = self.openai_key or secret("OPENAI_API_KEY", ("api_keys", "OPENAI_API_KEY"), ("api", "openai_api_key"))
            self.assemblyai_key = self.assemblyai_key or secret("ASSEMBLYAI_API_KEY", ("api_keys", "ASSEMBLYAI_API_KEY"), ("api", "assemblyai_api_key"))

        # Only require GEMINI_API_KEY if we're actually going to use Gemini.
        # AssemblyAI-only flows inject a placeholder at runtime.
        if not self.api_key:
            log.debug("GEMINI_API_KEY not set; Gemini calls will fail if attempted")

        # base_url = cheap "lite" tier used for vision (describe_image/batch),
        # PDF extraction (extract_pdf) and the transcript-overlap merge.
        # Google removed the entire gemini-2.0 line (both -flash and -flash-lite
        # now 404 NOT_FOUND), so this is pinned to the 2.5 lite successor.
        # Pinned (not -latest) for determinism: a floating alias could change
        # pricing/behaviour under us. 2.5-flash-lite pricing == the constants
        # above ($0.10/$0.40 per 1M), so calculate_cost stays correct.
        self.base_url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent"
        self.transcribe_url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
        self.total_input_tokens = 0
        self.total_output_tokens = 0
        self.whisper_fallback_used = 0
        self.assemblyai_used = 0

    def calculate_cost(self):
        cost_input = (self.total_input_tokens / 1_000_000) * PRICE_INPUT_1M
        cost_output = (self.total_output_tokens / 1_000_000) * PRICE_OUTPUT_1M
        return cost_input + cost_output

    def get_stats(self):
        """Возвращает статистику использования."""
        return {
            "gemini_cost": self.calculate_cost(),
            "whisper_fallbacks": self.whisper_fallback_used,
            "assemblyai_used": self.assemblyai_used
        }

    def _request_with_retry(self, payload, max_retries=3, url=None):
        """Отправляет запрос с retry при 429 ошибке."""
        headers = {"Content-Type": "application/json"}
        base = url or self.base_url

        for attempt in range(max_retries):
            response = requests.post(f"{base}?key={self.api_key}", json=payload, headers=headers)

            if response.status_code == 429:
                wait_time = (2 ** attempt) + random.uniform(0, 1)  # Exponential backoff
                print(f"⏳ Rate limit, ждём {wait_time:.1f}с...")
                time.sleep(wait_time)
                continue

            return response

        return response  # Последняя попытка

    def transcribe_whisper(self, file_path):
        """Fallback транскрибация через OpenAI Whisper API."""
        if not self.openai_key:
            return None, "OpenAI API key not configured"

        file_path = Path(file_path)

        # Проверяем что файл существует
        if not file_path.exists():
            return None, f"Source file not found: {file_path}"

        if file_path.stat().st_size < 100:
            return None, "Source file too small/empty"

        # Всегда конвертируем в mp3 — Whisper требует правильный формат
        temp_mp3 = f"/tmp/whisper_{os.getpid()}.mp3"
        # -vn игнорирует видео, -map 0:a:0 выбирает первый аудио поток
        cmd = f'ffmpeg -y -i "{file_path}" -vn -ar 16000 -ac 1 -c:a libmp3lame -q:a 9 "{temp_mp3}" -loglevel error'
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)

        if result.returncode != 0 or not os.path.exists(temp_mp3):
            err_msg = result.stderr[:200] if result.stderr else "unknown error"
            return None, f"FFmpeg failed: {err_msg}"

        # Проверяем что файл не пустой
        if os.path.getsize(temp_mp3) < 1000:
            os.remove(temp_mp3)
            return None, "FFmpeg produced empty/tiny file"

        try:
            # Читаем файл и отправляем с правильным именем
            with open(temp_mp3, 'rb') as f:
                file_content = f.read()

            response = requests.post(
                "https://api.openai.com/v1/audio/transcriptions",
                headers={"Authorization": f"Bearer {self.openai_key}"},
                files={"file": ("audio.mp3", file_content, "audio/mpeg")},
                data={"model": "whisper-1"}
            )

            if response.status_code != 200:
                return None, f"Whisper error {response.status_code}: {response.text}"

            self.whisper_fallback_used += 1
            return response.json().get("text", ""), None

        finally:
            if os.path.exists(temp_mp3):
                os.remove(temp_mp3)

    def _compress_audio(self, file_path):
        """Сжимает аудио/видео в MP3 через FFmpeg для File API."""
        temp_path = f"/tmp/gemini_compressed_{os.getpid()}.mp3"
        cmd = f'ffmpeg -i "{file_path}" -ar 16000 -ac 1 -c:a libmp3lame -q:a 9 "{temp_path}" -y -loglevel quiet'
        result = subprocess.run(cmd, shell=True)
        if result.returncode == 0 and os.path.exists(temp_path):
            return temp_path
        return None

    def _upload_file(self, file_path):
        """Загружает файл через Gemini File API, возвращает (uri, name)."""
        url = f"https://generativelanguage.googleapis.com/upload/v1beta/files?key={self.api_key}"

        with open(file_path, 'rb') as f:
            files = {
                'metadata': (None, json.dumps({"file": {"display_name": "audio_file"}}), 'application/json'),
                'file': ('audio.mp3', f, 'audio/mp3')
            }
            response = requests.post(url, files=files)

        if response.status_code != 200:
            return None, None, f"Upload error: {response.status_code}"

        data = response.json().get("file")
        if not data:
            return None, None, "No file data in response"

        return data["uri"], data["name"], None

    def _wait_for_file_active(self, file_name, max_wait=300):
        """Ждёт пока файл станет ACTIVE."""
        url = f"https://generativelanguage.googleapis.com/v1beta/{file_name}?key={self.api_key}"
        waited = 0
        while waited < max_wait:
            response = requests.get(url)
            if response.status_code == 200:
                status = response.json().get("state")
                if status == "ACTIVE":
                    return True
            time.sleep(3)
            waited += 3
        return False

    def _delete_file(self, file_name):
        """Удаляет файл из Gemini File API."""
        url = f"https://generativelanguage.googleapis.com/v1beta/{file_name}?key={self.api_key}"
        requests.delete(url)

    def transcribe_audio_large(self, file_path):
        """Транскрибация больших файлов через File API (с сжатием)."""
        file_path = Path(file_path)

        # Сжимаем
        print("🗜️  Сжатие аудио...", end="", flush=True)
        compressed = self._compress_audio(str(file_path))
        if not compressed:
            return None, "FFmpeg compression failed"
        print(" OK")

        try:
            # Загружаем
            print("☁️  Загрузка в Gemini...", end="", flush=True)
            uri, name, err = self._upload_file(compressed)
            if err:
                return None, err
            print(" OK")

            # Ждём
            print("⏳ Ожидание обработки...", end="", flush=True)
            if not self._wait_for_file_active(name):
                self._delete_file(name)
                return None, "File processing timeout"
            print(" OK")

            # Запрос с file_uri
            payload = {
                "contents": [{
                    "parts": [
                        {"file_data": {"mime_type": "audio/mp3", "file_uri": uri}},
                        {"text": "Transcribe this audio exactly. Return ONLY the text, no comments."}
                    ]
                }],
                "generationConfig": {"temperature": 0.2, "maxOutputTokens": 65536, "thinkingConfig": {"thinkingBudget": 0}},
                "safetySettings": [
                    {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE"},
                    {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE"},
                    {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE"},
                    {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE"}
                ]
            }

            print("🎙️  Транскрибация...", end="", flush=True)
            response = self._request_with_retry(payload, url=self.transcribe_url)

            # Удаляем файл из облака
            self._delete_file(name)

            if response.status_code != 200:
                print(" ❌")
                print("⚠️  Gemini недоступен, пробую Whisper...")
                return self.transcribe_whisper(compressed)

            text, err = self._parse_response(response.json())

            # Fallback на Whisper при блокировке
            if err and ("blocked" in err.lower() or "no candidates" in err.lower() or "safety" in err.lower()):
                print(" ❌")
                print(f"⚠️  Gemini заблокировал, пробую Whisper...")
                return self.transcribe_whisper(compressed)

            print(" OK")
            return text, err

        finally:
            # Удаляем сжатый файл
            if os.path.exists(compressed):
                os.remove(compressed)

    def _get_audio_duration(self, file_path):
        """Возвращает длительность аудио/видео в секундах через ffprobe."""
        try:
            cmd = f'ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "{file_path}"'
            result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
            if result.returncode == 0 and result.stdout.strip():
                return float(result.stdout.strip())
        except:
            pass
        return 0

    def _split_audio_chunks(self, file_path, chunk_duration=600, overlap=30, prefix="chunk"):
        """Разбивает аудио на чанки с overlap. Возвращает список путей."""
        duration = self._get_audio_duration(file_path)
        if duration <= 0:
            return [file_path]

        step = chunk_duration - overlap
        chunks = []
        start = 0
        idx = 0

        while start < duration:
            chunk_path = f"/tmp/gemini_{prefix}_{os.getpid()}_{idx}.mp3"
            end = min(start + chunk_duration, duration)
            chunk_len = end - start

            cmd = f'ffmpeg -y -i "{file_path}" -ss {start} -t {chunk_len} -c:a copy "{chunk_path}" -loglevel error'
            result = subprocess.run(cmd, shell=True, capture_output=True, text=True)

            if result.returncode == 0 and os.path.exists(chunk_path) and os.path.getsize(chunk_path) > 100:
                chunks.append(chunk_path)
            else:
                # Fallback: re-encode if copy fails
                cmd = f'ffmpeg -y -i "{file_path}" -ss {start} -t {chunk_len} -ar 16000 -ac 1 -c:a libmp3lame -q:a 9 "{chunk_path}" -loglevel error'
                subprocess.run(cmd, shell=True, capture_output=True, text=True)
                if os.path.exists(chunk_path) and os.path.getsize(chunk_path) > 100:
                    chunks.append(chunk_path)

            start += step
            idx += 1

        return chunks if chunks else [file_path]

    def _merge_overlap_texts(self, texts):
        """Pairwise LLM merge: убирает дублирование на стыках чанков."""
        if len(texts) <= 1:
            return texts[0] if texts else ""

        WINDOW = 2000  # символов для анализа overlap

        merged = texts[0]
        for i in range(1, len(texts)):
            tail = merged[-WINDOW:] if len(merged) > WINDOW else merged
            head = texts[i][:WINDOW] if len(texts[i]) > WINDOW else texts[i]
            rest = texts[i][WINDOW:] if len(texts[i]) > WINDOW else ""

            # LLM merge — просим найти точку стыка
            prompt = (
                "У тебя два фрагмента транскрипции одного аудио с перекрытием ~30 секунд.\n"
                "КОНЕЦ ПРЕДЫДУЩЕГО:\n"
                f"```\n{tail}\n```\n\n"
                "НАЧАЛО СЛЕДУЮЩЕГО:\n"
                f"```\n{head}\n```\n\n"
                "Найди где заканчивается перекрытие (повторяющийся текст) и верни ТОЛЬКО новый текст из второго фрагмента, "
                "который идёт ПОСЛЕ перекрытия. Без комментариев, только чистый текст."
            )

            payload = {
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"temperature": 0.1, "maxOutputTokens": 8192}
            }

            try:
                response = self._request_with_retry(payload, url=self.base_url)
                if response.status_code == 200:
                    new_part, err = self._parse_response(response.json())
                    if new_part and not err:
                        merged = merged + "\n" + new_part + rest
                        continue
            except:
                pass

            # Fallback: наивная конкатенация (с дублированием overlap, но без потери текста)
            merged = merged + "\n" + texts[i]

        return merged

    def transcribe_audio_chunked(self, file_path, chunk_duration=600):
        """Транскрибация длинного аудио через чанки с overlap и LLM merge."""
        file_path = Path(file_path)
        log.info(f"=== CHUNKED TRANSCRIPTION START: {file_path.name} ===")

        # 1. Compress
        print("🗜️  Сжатие аудио...", end="", flush=True)
        compressed = self._compress_audio(str(file_path))
        if not compressed:
            log.error("FFmpeg compression failed")
            return None, "FFmpeg compression failed"
        print(" OK")

        duration = self._get_audio_duration(compressed)
        log.info(f"Duration: {int(duration//3600)}h {int((duration%3600)//60)}m, compressed: {Path(compressed).stat().st_size // 1024}KB")
        print(f"⏱️  Длительность: {int(duration//3600)}ч {int((duration%3600)//60)}м")

        # 2. Split
        print("✂️  Разбивка на чанки...", end="", flush=True)
        chunks = self._split_audio_chunks(compressed, chunk_duration=chunk_duration, overlap=30)
        print(f" {len(chunks)} чанков")

        texts = []
        cloud_files = []  # (name,) для cleanup

        try:
            for i, chunk_path in enumerate(chunks):
                print(f"\n📦 Чанк {i+1}/{len(chunks)}")

                # Upload
                print("  ☁️  Загрузка...", end="", flush=True)
                uri, name, err = self._upload_file(chunk_path)
                if err:
                    print(f" ❌ {err}")
                    texts.append("")
                    continue
                cloud_files.append(name)
                print(" OK")

                # Wait
                print("  ⏳ Обработка...", end="", flush=True)
                if not self._wait_for_file_active(name):
                    print(" ❌ timeout")
                    texts.append("")
                    continue
                print(" OK")

                # Transcribe
                payload = {
                    "contents": [{
                        "parts": [
                            {"file_data": {"mime_type": "audio/mp3", "file_uri": uri}},
                            {"text": "Transcribe this audio exactly. Return ONLY the text, no comments."}
                        ]
                    }],
                    "generationConfig": {"temperature": 0.2, "maxOutputTokens": 65536, "thinkingConfig": {"thinkingBudget": 0}},
                    "safetySettings": [
                        {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE"},
                        {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE"},
                        {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE"},
                        {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE"}
                    ]
                }

                print("  🎙️  Транскрибация...", end="", flush=True)
                log.info(f"Chunk {i+1}/{len(chunks)}: transcribing {chunk_path}")
                response = self._request_with_retry(payload, url=self.transcribe_url)

                if response.status_code != 200:
                    log.error(f"Chunk {i+1}: HTTP {response.status_code}")
                    print(f" ❌ HTTP {response.status_code}")
                    texts.append("")
                    continue

                text, parse_err = self._parse_response(response.json())
                log.info(f"Chunk {i+1}: {len(text) if text else 0} chars, err={parse_err}")

                # Blocked → Whisper fallback
                if parse_err and ("blocked" in parse_err.lower() or "prohibited" in parse_err.lower()):
                    log.warning(f"Chunk {i+1}: BLOCKED, trying Whisper")
                    print(f" ⚠️ заблокировано, пробую Whisper...")
                    w_text, w_err = self.transcribe_whisper(chunk_path)
                    if w_text:
                        texts.append(w_text)
                        print(f"  ✓ Whisper OK ({len(w_text)} символов)")
                    else:
                        texts.append("")
                        print(f"  ❌ Whisper: {w_err}")
                    continue

                # MAX_TOKENS — retry с половинным чанком
                if parse_err and "TRUNCATED" in str(parse_err):
                    log.warning(f"Chunk {i+1}: MAX_TOKENS, splitting in half")
                    print(" ⚠️ MAX_TOKENS, пересоздаю чанк...")
                    half_dur = chunk_duration // 2
                    sub_chunks = self._split_audio_chunks(chunk_path, chunk_duration=half_dur, overlap=30, prefix=f"sub_{i}")
                    sub_texts = []
                    for j, sub_path in enumerate(sub_chunks):
                        print(f"    🔄 Подчанк {j+1}/{len(sub_chunks)}...", end="", flush=True)
                        s_uri, s_name, s_err = self._upload_file(sub_path)
                        if s_err:
                            print(f" ❌")
                            continue
                        cloud_files.append(s_name)
                        if not self._wait_for_file_active(s_name):
                            print(" ❌ timeout")
                            continue

                        sub_payload = dict(payload)
                        sub_payload["contents"] = [{
                            "parts": [
                                {"file_data": {"mime_type": "audio/mp3", "file_uri": s_uri}},
                                {"text": "Transcribe this audio exactly. Return ONLY the text, no comments."}
                            ]
                        }]
                        s_resp = self._request_with_retry(sub_payload, url=self.transcribe_url)
                        if s_resp.status_code == 200:
                            s_text, _ = self._parse_response(s_resp.json())
                            if s_text:
                                sub_texts.append(s_text)
                                print(" OK")
                            else:
                                print(" пусто")
                        else:
                            print(f" ❌")
                        if sub_path != chunk_path and os.path.exists(sub_path):
                            os.remove(sub_path)

                    if sub_texts:
                        texts.append(self._merge_overlap_texts(sub_texts))
                    elif text:
                        texts.append(text)  # Используем обрезанный текст
                    else:
                        texts.append("")
                elif text:
                    print(f" OK ({len(text)} символов)")
                    texts.append(text)
                else:
                    print(f" ❌ {parse_err}")
                    texts.append("")

            # 3. Merge
            non_empty = [t for t in texts if t.strip()]
            if not non_empty:
                return None, "All chunks failed"

            if len(non_empty) > 1:
                log.info(f"Merging {len(non_empty)} fragments, total chars: {sum(len(t) for t in non_empty)}")
                print(f"\n🔗 Склейка {len(non_empty)} фрагментов...", end="", flush=True)
                final_text = self._merge_overlap_texts(non_empty)
                log.info(f"Merge result: {len(final_text)} chars")
                print(" OK")
            else:
                final_text = non_empty[0]

            return final_text, None

        finally:
            # Cleanup cloud files
            for name in cloud_files:
                try:
                    self._delete_file(name)
                except:
                    pass
            # Cleanup local chunks
            for chunk_path in chunks:
                if chunk_path != compressed and os.path.exists(chunk_path):
                    try:
                        os.remove(chunk_path)
                    except:
                        pass
            # Cleanup compressed
            if compressed and os.path.exists(compressed):
                try:
                    os.remove(compressed)
                except:
                    pass

    def transcribe_assemblyai(self, file_path, progress_cb=None):
        """Транскрибация через AssemblyAI SDK.

        Если передан `progress_cb(stage, **kwargs)` — вместо блокирующего
        `transcribe()` (который ждёт всю обработку молча) делается
        `submit()` + ручной polling каждые 5 сек, и progress_cb получает
        промежуточные стадии:
          stage='uploading'   — перед submit (заливаем файл на сервер)
          stage='queued'      audio_duration_sec, transcript_id
          stage='transcribing' aai_status, elapsed_sec, audio_duration_sec
          stage='completed'   — когда text получен
        Без callback'а ведёт себя как раньше (CLI).
        """
        if not self.assemblyai_key:
            return None, "ASSEMBLYAI_API_KEY not configured"

        try:
            import assemblyai as aai
        except ImportError:
            return None, "assemblyai package not installed (pip install assemblyai)"

        aai.settings.api_key = self.assemblyai_key
        aai.settings.http_timeout = 600.0  # большой timeout на upload и polling больших файлов
        aai.settings.polling_interval = 5.0

        if progress_cb is None:
            print("🔊 AssemblyAI транскрибация...", end="", flush=True)
        try:
            config = aai.TranscriptionConfig(language_detection=True)
            config.speech_models = ["universal-2"]
            transcriber = aai.Transcriber()

            if progress_cb is None:
                # Legacy CLI path — single blocking call, same as before.
                transcript = transcriber.transcribe(str(file_path), config=config)
            else:
                # NDJSON path — non-blocking submit + manual polling so the
                # UI can show "uploading → queued → transcribing M:SS / ~ETA"
                # instead of one frozen spinner for hours.
                progress_cb(stage="uploading")
                transcript = transcriber.submit(str(file_path), config=config)
                # `submit` returns once upload + initial enqueue are done; we
                # already have an id and (usually) audio_duration in ms.
                audio_dur_sec = None
                try:
                    if transcript.audio_duration:
                        audio_dur_sec = round(transcript.audio_duration / 1000.0, 1)
                except Exception:
                    pass
                progress_cb(stage="queued",
                            transcript_id=transcript.id,
                            audio_duration_sec=audio_dur_sec)

                import time as _time
                started = _time.time()
                while True:
                    # `get_by_id` re-fetches the transcript object with
                    # current status. Cheaper than wait_for_completion which
                    # blocks until done with no callback hooks.
                    transcript = aai.Transcript.get_by_id(transcript.id)
                    if transcript.status == aai.TranscriptStatus.completed:
                        progress_cb(stage="completed")
                        break
                    if transcript.status == aai.TranscriptStatus.error:
                        return None, f"AssemblyAI error: {transcript.error}"
                    # Map enum → short label (queued | processing).
                    raw = str(transcript.status)
                    short = raw.split(".")[-1].lower() if "." in raw else raw
                    progress_cb(stage="transcribing",
                                aai_status=short,
                                elapsed_sec=int(_time.time() - started),
                                audio_duration_sec=audio_dur_sec)
                    # Tighter polling than the SDK's 5s default — small
                    # files (~5 min) finish in 30-60s on AAI universal-2,
                    # so 5s ticks miss the transcribing stage entirely.
                    # 2s ticks give the UI ~10-20 progress updates per file.
                    _time.sleep(2.0)

            if transcript.status == aai.TranscriptStatus.error:
                if progress_cb is None:
                    print(" ❌")
                return None, f"AssemblyAI error: {transcript.error}"

            self.assemblyai_used += 1
            if progress_cb is None:
                print(" OK")
            return transcript.text, None
        except Exception as e:
            if progress_cb is None:
                print(" ❌")
            return None, f"AssemblyAI exception: {e}"

    def transcribe_audio(self, file_path, engine="gemini", progress_cb=None):
        """Transcribes audio. engine='gemini' or 'assemblyai'. Auto-routes for Gemini.

        `progress_cb` пробрасывается в AssemblyAI-путь (см. `transcribe_assemblyai`).
        Для Gemini пока игнорируется — там уже chunked-pipeline с собственной
        внутренней разбивкой (можно расширить в будущем по той же сигнатуре).
        """
        file_path = Path(file_path)

        # AssemblyAI route
        if engine == "assemblyai":
            return self.transcribe_assemblyai(file_path, progress_cb=progress_cb)

        # Gemini route
        file_size = file_path.stat().st_size

        # Small files — inline
        if file_size <= INLINE_SIZE_LIMIT:
            return self._transcribe_audio_inline(file_path)

        # Check duration for chunked decision
        duration = self._get_audio_duration(str(file_path))
        if duration > 1800:  # > 30 min
            return self.transcribe_audio_chunked(file_path)

        # Default — File API single request
        return self.transcribe_audio_large(file_path)

    def _transcribe_audio_inline(self, file_path):
        """Транскрибация маленьких файлов inline (< 20MB)."""
        file_path = Path(file_path)
        mime_type = mimetypes.guess_type(file_path)[0] or "audio/mp3"

        with open(file_path, "rb") as f:
            file_data = f.read()

        b64_data = base64.b64encode(file_data).decode('utf-8')

        payload = {
            "contents": [{
                "parts": [
                    {"text": "Transcribe this audio exactly. Return ONLY the text, no comments."},
                    {
                        "inline_data": {
                            "mime_type": mime_type,
                            "data": b64_data
                        }
                    }
                ]
            }],
            "generationConfig": {
                "temperature": 0.2,
                "maxOutputTokens": 65536,
                "thinkingConfig": {"thinkingBudget": 0}
            },
            "safetySettings": [
                {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE"},
                {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE"},
                {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE"},
                {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE"}
            ]
        }

        response = self._request_with_retry(payload, url=self.transcribe_url)

        if response.status_code != 200:
            print("⚠️  Gemini недоступен, пробую Whisper...")
            return self.transcribe_whisper(file_path)

        text, err = self._parse_response(response.json())

        if err and ("blocked" in err.lower() or "no candidates" in err.lower() or "safety" in err.lower()):
            print(f"⚠️  Gemini заблокировал, пробую Whisper...")
            return self.transcribe_whisper(file_path)

        return text, err

    def _compress_image(self, file_path, max_size=1024, quality=85):
        """Сжимает изображение до max_size px и возвращает base64."""
        if not HAS_PIL:
            # Без PIL — просто читаем файл
            with open(file_path, "rb") as f:
                return base64.b64encode(f.read()).decode('utf-8'), "image/jpeg"

        img = Image.open(file_path)

        # Конвертируем RGBA в RGB если нужно
        if img.mode in ('RGBA', 'P'):
            img = img.convert('RGB')

        # Уменьшаем если больше max_size
        if max(img.size) > max_size:
            img.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)

        # Сохраняем в буфер
        buffer = io.BytesIO()
        img.save(buffer, format='JPEG', quality=quality, optimize=True)
        buffer.seek(0)

        return base64.b64encode(buffer.read()).decode('utf-8'), "image/jpeg"

    def describe_image(self, file_path):
        """Describes an image (с сжатием)."""
        b64_data, mime_type = self._compress_image(file_path)

        payload = {
            "contents": [{
                "parts": [
                    {"text": "Describe this image in detail. Extract any text visible."},
                    {"inline_data": {"mime_type": mime_type, "data": b64_data}}
                ]
            }],
            "safetySettings": [
                {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE"},
                {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE"},
                {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE"},
                {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE"}
            ]
        }

        response = self._request_with_retry(payload)

        if response.status_code != 200:
            return None, f"Error {response.status_code}: {response.text}"

        return self._parse_response(response.json())

    def describe_images_batch(self, file_paths):
        """Описывает несколько изображений в одном запросе (батч)."""
        if not file_paths:
            return [], None

        parts = [{"text": f"Describe each of these {len(file_paths)} images briefly. Number each description (1, 2, 3...). Extract any visible text."}]

        for fp in file_paths:
            b64_data, mime_type = self._compress_image(fp)
            parts.append({"inline_data": {"mime_type": mime_type, "data": b64_data}})

        payload = {
            "contents": [{"parts": parts}],
            "safetySettings": [
                {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE"},
                {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE"},
                {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE"},
                {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE"}
            ]
        }

        response = self._request_with_retry(payload)

        if response.status_code != 200:
            return [], f"Error {response.status_code}: {response.text}"

        text, err = self._parse_response(response.json())
        if err:
            return [], err

        return text, None

    def _upload_file_generic(self, file_path, mime_type, display_name="uploaded_file"):
        """Загружает файл через Gemini File API (универсальная версия)."""
        url = f"https://generativelanguage.googleapis.com/upload/v1beta/files?key={self.api_key}"

        with open(file_path, 'rb') as f:
            files = {
                'metadata': (None, json.dumps({"file": {"display_name": display_name}}), 'application/json'),
                'file': (os.path.basename(file_path), f, mime_type)
            }
            response = requests.post(url, files=files)

        if response.status_code != 200:
            return None, None, f"Upload error: {response.status_code} - {response.text}"

        data = response.json().get("file")
        if not data:
            return None, None, "No file data in response"

        return data["uri"], data["name"], None

    def extract_pdf(self, file_path):
        """Извлекает текст из PDF через Gemini."""
        file_path = Path(file_path)
        file_size = file_path.stat().st_size

        # PDF всегда через File API (inline не поддерживается для PDF > несколько страниц)
        if file_size > 5 * 1024 * 1024:  # > 5MB — через File API
            return self._extract_pdf_large(file_path)

        # Маленькие PDF — inline
        with open(file_path, "rb") as f:
            b64_data = base64.b64encode(f.read()).decode('utf-8')

        payload = {
            "contents": [{
                "parts": [
                    {"text": "Extract ALL text from this PDF document. Return the complete text content, preserving structure and formatting where possible. If there are tables, format them clearly."},
                    {"inline_data": {"mime_type": "application/pdf", "data": b64_data}}
                ]
            }],
            "generationConfig": {"temperature": 0.1},
            "safetySettings": [
                {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE"},
                {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE"},
                {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE"},
                {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE"}
            ]
        }

        response = self._request_with_retry(payload)

        if response.status_code != 200:
            return None, f"Error {response.status_code}: {response.text}"

        return self._parse_response(response.json())

    def _extract_pdf_large(self, file_path):
        """Извлекает текст из большого PDF через File API."""
        # Загружаем
        uri, name, err = self._upload_file_generic(str(file_path), "application/pdf", "document.pdf")
        if err:
            return None, err

        # Ждём обработки
        if not self._wait_for_file_active(name, max_wait=120):
            self._delete_file(name)
            return None, "File processing timeout"

        # Запрос
        payload = {
            "contents": [{
                "parts": [
                    {"file_data": {"mime_type": "application/pdf", "file_uri": uri}},
                    {"text": "Extract ALL text from this PDF document. Return the complete text content, preserving structure and formatting where possible. If there are tables, format them clearly."}
                ]
            }],
            "generationConfig": {"temperature": 0.1},
            "safetySettings": [
                {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE"},
                {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE"},
                {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE"},
                {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE"}
            ]
        }

        response = self._request_with_retry(payload)

        # Удаляем файл из облака
        self._delete_file(name)

        if response.status_code != 200:
            return None, f"Error {response.status_code}: {response.text}"

        return self._parse_response(response.json())

    @staticmethod
    def _strip_repetition_loop(text):
        """Detect and strip Gemini repetition loops (e.g. 'О! О! О! О! ...' filling MAX_TOKENS)."""
        if len(text) < 500:
            return text
        import re as _re
        tail = text[-200:]
        for plen in range(2, 21):
            pat = tail[-plen:]
            escaped = _re.escape(pat)
            if _re.search(f'({escaped}){{10,}}$', text[-2000:]):
                # Find earliest start of the repeating pattern
                repeated = pat * 3
                pos = text.find(repeated)
                if pos > 100:
                    clean = text[:pos].rstrip()
                    trimmed = len(text) - len(clean)
                    log.warning(f"Repetition loop detected: pattern='{pat}', trimmed {trimmed:,} chars")
                    print(f"\n⚠️  Repetition loop: обрезано {trimmed:,} символов мусора")
                    return clean
        return text

    def _parse_response(self, result):
        try:
            if "usageMetadata" in result:
                self.total_input_tokens += result["usageMetadata"].get("promptTokenCount", 0)
                self.total_output_tokens += result["usageMetadata"].get("candidatesTokenCount", 0)

            if "candidates" in result and result["candidates"]:
                candidate = result["candidates"][0]
                finish_reason = candidate.get("finishReason", "")

                if finish_reason == "SAFETY":
                    return None, "⚠️ Blocked by Safety Filters (censorship)"

                content = candidate.get("content")
                parts = content.get("parts") if isinstance(content, dict) else None
                if not parts:
                    if finish_reason == "STOP":
                        return None, EMPTY_TEXT_ERROR
                    return None, f"No response parts (finishReason: {finish_reason or 'unknown'})"
                text = "".join([p.get("text", "") for p in parts if not p.get("thought")])
                text = self._strip_repetition_loop(text)

                if finish_reason == "MAX_TOKENS":
                    out_tokens = result.get("usageMetadata", {}).get("candidatesTokenCount", "?")
                    print(f"\n⚠️  Ответ обрезан (MAX_TOKENS: {out_tokens})")
                    return text.strip(), f"TRUNCATED:{out_tokens}"

                return text.strip(), None

            if "promptFeedback" in result and "blockReason" in result["promptFeedback"]:
                return None, f"⚠️ Prompt Blocked: {result['promptFeedback']['blockReason']}"

            return None, "No candidates returned"
        except Exception as e:
            return None, str(e)
