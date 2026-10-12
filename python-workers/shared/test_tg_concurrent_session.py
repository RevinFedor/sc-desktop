import datetime
import multiprocessing
import sqlite3
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from telethon import TelegramClient, types
from telethon.crypto import AuthKey
from telethon.sessions import SQLiteSession
from tg_concurrent_session import ConcurrentSQLiteSession, telegram_session


def worker_session_hold(path, ready, release, output):
    """Simulate a worker awaiting remote media after caching an entity."""
    session = telegram_session(path)
    session.process_entities([types.User(id=42, access_hash=123, first_name="Fixture")])
    output.put(session._conn.in_transaction)
    ready.set()
    release.wait(8)
    session.close()


class ConcurrentSessionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sc-session-concurrency-")
        self.path = str(Path(self.temp.name) / "fixture")

    def tearDown(self):
        self.temp.cleanup()

    def seed(self, path=None):
        s = telegram_session(path or self.path)
        s.set_dc(2, "149.154.167.51", 443)
        s.auth_key = AuthKey(bytes(range(256)))  # deliberately synthetic
        return s

    def test_real_sdk_client_accepts_same_session_instance(self):
        s = self.seed()
        client = TelegramClient(s, 1, "fixture-api-hash")
        self.assertIs(client.session, s)
        self.assertEqual(s.filename, self.path + ".session")
        s.close()

    def test_two_processes_can_mutate_while_background_worker_waits(self):
        self.seed().close()
        context = multiprocessing.get_context("spawn")
        ready, release, output = context.Event(), context.Event(), context.Queue()
        worker = context.Process(target=worker_session_hold, args=(self.path, ready, release, output))
        worker.start()
        try:
            self.assertTrue(ready.wait(8))
            self.assertFalse(output.get(timeout=3))
            short = telegram_session(self.path)
            short.auth_key = short.auth_key  # TelegramClient.connect performs this write
            short.process_entities([types.User(id=99, access_hash=456, first_name="Short RPC")])
            self.assertFalse(short._conn.in_transaction)
            self.assertEqual(short.get_entity_rows_by_id(42)[0], 42)
            short.close()
        finally:
            release.set()
            worker.join(8)
            if worker.is_alive():
                worker.terminate()
                worker.join()
        self.assertEqual(worker.exitcode, 0)

    def test_all_sdk_mutations_finish_without_pending_write_transaction(self):
        s = self.seed()
        s.takeout_id = 13
        self.assertFalse(s._conn.in_transaction)
        s.set_update_state(42, types.updates.State(1, 2, datetime.datetime.now(datetime.timezone.utc), 3, 0))
        self.assertFalse(s._conn.in_transaction)
        s.cache_file(b"fixture-digest", 123, types.InputDocument(1, 2, b""))
        self.assertFalse(s._conn.in_transaction)
        s.process_entities([types.User(id=42, access_hash=123, username="fixture", first_name="Fixture")])
        self.assertFalse(s._conn.in_transaction)
        self.assertIsNotNone(s.get_entity_rows_by_username("fixture"))
        self.assertFalse(s._conn.in_transaction)
        s.close()

    def test_failed_auth_row_replace_rolls_back_atomically(self):
        s = self.seed()
        original = s.auth_key.key
        s._conn.execute("CREATE TRIGGER reject_auth BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT,'fixture'); END")
        s._conn.commit()
        with self.assertRaises(sqlite3.IntegrityError):
            s.auth_key = AuthKey(b"different" * 32)
        other = telegram_session(self.path)
        self.assertEqual(other.auth_key.key, original)
        self.assertFalse(s._conn.in_transaction)
        other.close()
        s.close()

    def test_existing_sdk_file_is_compatible_without_new_authorization(self):
        old = SQLiteSession(self.path)
        old.set_dc(2, "149.154.167.51", 443)
        old.auth_key = AuthKey(bytes(range(256)))
        old.save()
        old.close()
        new = telegram_session(self.path)
        self.assertEqual(new.auth_key.key, bytes(range(256)))
        self.assertEqual(new.dc_id, 2)
        self.assertFalse(new._conn.in_transaction)
        new.close()
        self.assertEqual([p.name for p in Path(self.temp.name).glob("*.session")], ["fixture.session"])

    def test_accounts_remain_isolated(self):
        a = self.seed()
        b = telegram_session(str(Path(self.temp.name) / "other"))
        b.set_dc(1, "149.154.175.53", 443)
        b.auth_key = AuthKey(b"b" * 256)
        self.assertNotEqual(a.auth_key.key, b.auth_key.key)
        self.assertNotEqual(a.filename, b.filename)
        b.close()
        a.close()

    def test_stock_sdk_reproduces_write_lock_until_explicit_save(self):
        self.seed().close()
        background = SQLiteSession(self.path)
        short = SQLiteSession(self.path)
        background.process_entities([types.User(id=42, access_hash=123, first_name="Fixture")])
        self.assertTrue(background._conn.in_transaction)
        short._conn.execute("PRAGMA busy_timeout=10")
        try:
            with self.assertRaisesRegex(sqlite3.OperationalError, "locked"):
                short.auth_key = short.auth_key
            short._conn.rollback()
            background.save()
            short.auth_key = short.auth_key
            short.save()
        finally:
            short.close()
            background.close()

    def test_parallel_cache_and_state_writes_finish_without_lost_rows(self):
        self.seed().close()
        failures = []
        def write(actor):
            session = telegram_session(self.path)
            try:
                for n in range(30):
                    ident = actor * 1000 + n
                    session.process_entities([types.User(id=ident, access_hash=ident+1, first_name="Fixture")])
                    session.set_update_state(ident, types.updates.State(n, 0, datetime.datetime.now(datetime.timezone.utc), n, 0))
                    self.assertFalse(session._conn.in_transaction)
            except BaseException as error:
                failures.append(error)
            finally:
                session.close()
        workers = [threading.Thread(target=write, args=(actor,)) for actor in (1,2)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(8)
            self.assertFalse(worker.is_alive())
        self.assertEqual(failures, [])
        check = telegram_session(self.path)
        for actor in (1,2):
            for n in range(30):
                self.assertIsNotNone(check.get_entity_rows_by_id(actor * 1000 + n))
                self.assertEqual(check.get_update_state(actor * 1000 + n).pts,n)
        check.close()


if __name__ == "__main__":
    unittest.main()
