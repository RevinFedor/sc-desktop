"""Keep Telethon session writes short, not open during download/STT waits.

Uses the existing SQLiteSession and original authorization file. No copied
tokens, extra accounts, alternate session files or changes to Telegram RPCs.
"""
from contextlib import contextmanager
import sqlite3
import threading

from telethon.sessions import SQLiteSession


class ConcurrentSQLiteSession(SQLiteSession):
    """Commit one SDK mutation atomically before returning to network code."""

    def __init__(self, session_id=None, *args, **kwargs):
        self._write_lock = threading.RLock()
        super().__init__(session_id, *args, **kwargs)

    def _cursor(self):
        # Timeout must exist before SQLiteSession schema/bootstrap operations,
        # not only after TelegramClient has already opened its session.
        if self._conn is None:
            self._conn = sqlite3.connect(
                self.filename, timeout=30, check_same_thread=False,
            )
        return self._conn.cursor()

    @contextmanager
    def _short_write(self):
        with self._write_lock:
            try:
                yield
            except BaseException:
                if self._conn is not None and self._conn.in_transaction:
                    self._conn.rollback()
                raise
            else:
                self.save()

    def save(self):
        with self._write_lock:
            return super().save()

    def _update_session_table(self):
        # The SDK's DELETE+INSERT must remain ONE transaction. Committing
        # individual SQL statements would briefly expose an empty auth row.
        with self._short_write():
            return super()._update_session_table()

    def _execute(self, stmt, *values):
        # Includes update_state and sent_files, while reads commit no changes.
        with self._short_write():
            return super()._execute(stmt, *values)

    def process_entities(self, tlo):
        with self._short_write():
            return super().process_entities(tlo)

    def get_entity_rows_by_username(self, username):
        # Normally a read; the SDK may evict duplicate username cache entries.
        with self._short_write():
            return super().get_entity_rows_by_username(username)


def telegram_session(path):
    """Open the same selected session, without a global active-account change."""
    return ConcurrentSQLiteSession(str(path))
