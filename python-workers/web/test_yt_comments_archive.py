import contextlib
import hashlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from yt_comments_archive import build_archive, write_archive
import yt_comments_ndjson as worker

VIDEO = "fixture0001"
CHANNEL = "UC" + "a" * 22


def data(comments):
    return {"id": VIDEO, "channel_id": CHANNEL, "channel": "Uploader",
            "title": "not comment authorship", "comment_count": 999, "comments": comments}


def archive(value, **options):
    return build_archive(value, video_id=VIDEO, expected_channel_id=CHANNEL,
                         sort="new", limit=0, include_replies=True, **options)


class CommentArchiveTests(unittest.TestCase):
    def test_full_more_than_100_comments_and_replies_keep_own_identity_and_text(self):
        rows = [{"id": f"root-{i}", "parent": "root", "author": f"person-{i}",
                 "author_id": f"author-{i}", "timestamp": 100 + i,
                 "text": "😀 country timezone crypto full tail " * 20} for i in range(145)]
        rows += [{"id": f"reply-{i}", "parent": "root-1", "author": "Other person",
                  "author_is_uploader": False, "modified_timestamp": 500,
                  "text": "CV age experience"} for i in range(130)]
        out = archive(data(rows))
        self.assertEqual(len(out["comments"]), 275)
        self.assertEqual(out["report"]["reply_count"], 130)
        self.assertEqual(out["comments"][-1]["parent_comment_id"], "root-1")
        self.assertEqual(out["comments"][-1]["author"], "Other person")
        self.assertEqual(out["comments"][-1]["edited_at"], 500)
        self.assertEqual(out["comments"][0]["text"], rows[0]["text"])
        self.assertIsNone(out["report"]["remote_eof"])
        self.assertEqual(out["report"]["eof_proof"], "not_exposed_by_yt_dlp_cli")

    def test_empty_disabled_unidentified_orphans_duplicates_are_not_complete(self):
        out = archive(data([]))
        self.assertEqual(out["report"]["disposition"], "empty_or_disabled_unverified")
        self.assertIsNone(out["report"]["remote_eof"])
        raw = [{"id": "child", "parent": "missing", "text": "first"},
               {"id": "child", "parent": "missing", "text": "edited"},
               {"text": "original lacking an ID"}]
        out = archive(data(raw), warnings=["WARNING: partial replies"])
        self.assertEqual(out["raw_comments"], raw)
        self.assertEqual(out["report"]["duplicate_conflicts"], ["child"])
        self.assertEqual(out["report"]["missing_parent_ids"], ["missing"])
        self.assertEqual(out["report"]["unidentified_indices"], [2])
        self.assertEqual(out["report"]["warnings"], ["WARNING: partial replies"])

    def test_wrong_video_or_channel_never_relabels_another_creator(self):
        for key in ("id", "channel_id"):
            value = data([])
            value[key] = "wrong"
            with self.assertRaisesRegex(ValueError, "identity mismatch"):
                archive(value)

    def test_original_json_write_is_exact_hash_and_preserves_unknown_raw_fields(self):
        value = archive(data([{"id": "x", "parent": "root", "text": "👩‍💻 полный текст", "extra": {"a": 1}}]))
        with tempfile.TemporaryDirectory() as root:
            filename = Path(root) / "original.json"
            sha = write_archive(filename, value)
            self.assertEqual(sha, hashlib.sha256(filename.read_bytes()).hexdigest())
            self.assertEqual(json.loads(filename.read_text()), value)
            self.assertEqual(list(Path(root).iterdir()), [filename])

    def test_actual_worker_archive_mode_uses_comments_only_all_replies_and_keeps_json(self):
        source = data([{"id": str(i), "parent": "root", "text": "body"} for i in range(151)])
        with tempfile.TemporaryDirectory() as root:
            filename = Path(root) / "original.json"
            commands = []

            class Producer:
                returncode = 0
                stdout = io.StringIO("WARNING: a reply page was unavailable\n[youtube] Extracted 151 comments\n")

                def wait(self, timeout=None):
                    return 0

            def spawn(command, **kwargs):
                commands.append(command)
                destination = Path(command[command.index("--paths") + 1]) / f"{VIDEO}.info.json"
                destination.write_text(json.dumps(source), encoding="utf-8")
                return Producer()

            argv = ["yt_comments_ndjson.py", f"https://www.youtube.com/watch?v={VIDEO}",
                    "--out-dir", root, "--limit", "0", "--with-replies",
                    "--archive-json", str(filename), "--expected-channel-id", CHANNEL]
            output = io.StringIO()
            with patch("sys.argv", argv), patch.object(worker, "fetch_meta", side_effect=AssertionError("metadata subprocess not needed")), \
                    patch.object(worker.subprocess, "Popen", side_effect=spawn), contextlib.redirect_stdout(output):
                self.assertEqual(worker.main(), 0)
            command = commands[0]
            self.assertIn("--skip-download", command)
            self.assertIn("--write-comments", command)
            self.assertNotIn("--write-subs", command)
            self.assertNotIn("--no-warnings", command)
            self.assertIn("youtube:max_comments=all;comment_sort=new", command)
            saved = next(event for event in map(json.loads, output.getvalue().splitlines()) if event["type"] == "saved")
            self.assertEqual(saved["archive_sha256"], hashlib.sha256(filename.read_bytes()).hexdigest())
            self.assertEqual(saved["count_total"], 151)
            self.assertEqual(saved["archive_report"]["warnings"], ["WARNING: a reply page was unavailable"])
            self.assertIsNone(saved["archive_report"]["remote_eof"])


if __name__ == "__main__":
    unittest.main()
