import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import library_db


class LibraryDbHelpersTest(unittest.TestCase):
    def test_desktop_root_selects_the_shared_database(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(
            os.environ,
            {"SC_DESKTOP_DIR": root},
            clear=False,
        ):
            with patch.dict(os.environ, {"SC_DESKTOP_DB": "", "MEDIA_INBOX_DB": ""}):
                self.assertEqual(library_db._db_path(), Path(root) / "library.db")

    def test_processed_ids_are_grouped_by_media_pipeline(self):
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute(
            """
            CREATE TABLE items (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              source_id INTEGER,
              external_id TEXT,
              type TEXT,
              transcribe_status TEXT,
              transcribe_engine TEXT,
              reply_resolved INTEGER DEFAULT 0,
              reactions_resolved INTEGER DEFAULT 0,
              published_at INTEGER
            )
            """
        )
        conn.executemany(
            """INSERT INTO items
                 (source_id, external_id, type, transcribe_status, transcribe_engine,
                  reply_resolved, reactions_resolved)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            [
                (3, "1", "voice", "done", "gemini", 0, 0),
                (3, "2", "video", "done", "assemblyai", 1, 1),
                (3, "3", "photo", "done", "gemini-vision", 1, 0),
                (3, "4", "document", "done", None, 0, 1),
                (3, "5", "text", "done", "gemini", 1, 1),
                (3, "6", "voice", "error", "gemini", 1, 1),
                (4, "7", "voice", "done", "gemini", 0, 0),
            ],
        )
        conn.execute(
            "CREATE TABLE post_comments (source_id INTEGER, post_external_id TEXT)"
        )
        conn.execute("INSERT INTO post_comments VALUES (?, ?)", (3, "2"))

        self.assertEqual(
            library_db.processed_external_ids_by_kind(conn, 3),
            {
                "voice": {"1": "gemini", "2": "assemblyai"},
                "photo": {"3": "gemini-vision"},
                "pdf": {"4": ""},
            },
        )
        self.assertEqual(library_db.pending_reply_external_ids(conn, 3), [1, 3, 4])
        self.assertEqual(library_db.missing_comment_post_ids(conn, 3), [6, 5, 4, 3, 1])


if __name__ == "__main__":
    unittest.main()
