"""Synthetic full-history/CLI regressions: never connect to Telegram or auth DB."""
import asyncio
import contextlib
import io
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from test_tg_voice_checkpoint import load_fetch_fixture
from tg_voice_policy import FetchTraversalCache, MediaStorageError, UnknownMediaDelivery
from telethon.errors import FloodWaitError
from telethon.tl.types import Channel, ChatPhotoEmpty, Message, PeerChannel, PeerUser, User


def message(mid):
    return Message(id=mid, peer_id=PeerChannel(333), date=datetime(2026, 1, 1, tzinfo=timezone.utc),
                   message="fixture " + str(mid), from_id=PeerUser(111))


class FakeClient:
    def __init__(self, batches=None, head=100):
        self.entity = Channel(id=333, title="fixture", photo=ChatPhotoEmpty(),
                              date=datetime(2026, 1, 1, tzinfo=timezone.utc), megagroup=True)
        self.get_me = mock.AsyncMock(return_value=User(id=111, first_name="fixture"))
        self.get_entity = mock.AsyncMock(return_value=self.entity)
        self.disconnect = mock.AsyncMock()
        self.download_profile_photo = mock.AsyncMock(return_value=None)
        self.history_calls = []
        self.batches = list(batches or [[]])
        self.iteration_calls = []
        self.head = head
        self.flood_sleep_threshold = 60

    async def get_messages(self, _entity, **kwargs):
        self.history_calls.append(kwargs)
        if "ids" in kwargs:
            ids = kwargs["ids"]
            return [message(mid) for mid in ids] if isinstance(ids, list) else message(ids)
        return [message(self.head)] if self.head else []

    def iter_messages(self, **kwargs):
        self.iteration_calls.append(kwargs)
        batch = self.batches[min(len(self.iteration_calls) - 1, len(self.batches) - 1)]
        async def iterate():
            for entry in batch:
                if isinstance(entry, BaseException):
                    raise entry
                yield entry
        return iterate()


class FetchTraversalTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sc-fetch-traversal-fixture-")
        self.root = Path(self.temp.name)
        self.fetch = load_fetch_fixture(self.root)
        self.fetch.SESSION_PATH.touch()
        self.fetch._FULL_HISTORY_REPORT = True
        self.fetch._SKIP_PROFILE_PHOTO = True
        self.fetch._EXPECTED_ACCOUNT_ID = 111
        self.fetch._EXPECTED_PEER_ID = -1000000000333
        self.events = []
        self.fetch.emit = self.events.append

    def tearDown(self):
        self.temp.cleanup()

    async def run_fetch(self, client, mode="all", **kwargs):
        with mock.patch.object(self.fetch, "TelegramClient", return_value=client), \
                mock.patch.object(self.fetch, "_resolve_linked_chat", new=mock.AsyncMock(return_value=(None, False))):
            return await self.fetch.run("fixture", mode, None, None, None, **kwargs)

    def eof_events(self):
        return [event for event in self.events if event["type"] == "traversal" and "remote_eof" in event]

    async def test_all_history_kwargs_head_snapshot_all_topics_sparse_ids(self):
        client = FakeClient([[message(100), message(98), message(1)]])
        self.assertEqual(await self.run_fetch(client), 0)
        self.assertEqual(client.history_calls, [{"limit": 1}])
        self.assertEqual(len(client.iteration_calls), 1)
        kwargs = client.iteration_calls[0]
        self.assertIsNone(kwargs["limit"])
        self.assertEqual((kwargs["min_id"], kwargs["max_id"], kwargs["reverse"]), (0, 101, False))
        self.assertNotIn("reply_to", kwargs)
        self.assertNotIn("offset_date", kwargs)
        self.assertEqual(client.flood_sleep_threshold, 0)
        self.assertEqual(self.eof_events()[-1]["rows_emitted"], 3)
        self.assertEqual(self.eof_events()[-1]["unreturned_id_gaps"], 97)
        self.assertTrue(self.eof_events()[-1]["remote_eof"])
        client.download_profile_photo.assert_not_awaited()

    async def test_empty_snapshot_never_opens_unbounded_iterator(self):
        client = FakeClient(head=0)
        self.assertEqual(await self.run_fetch(client), 0)
        self.assertEqual(client.iteration_calls, [])
        self.assertEqual(self.eof_events()[-1]["rows_seen"], 0)
        self.assertTrue(self.eof_events()[-1]["remote_eof"])

    async def test_iteration_error_reports_incomplete_not_false_eof(self):
        client = FakeClient([[message(100), RuntimeError("fixture history disconnected")]])
        with self.assertRaisesRegex(RuntimeError, "history disconnected"):
            await self.run_fetch(client)
        self.assertFalse(any(event.get("remote_eof") is True for event in self.events))
        self.assertFalse(any(event["type"] == "done" for event in self.events))
        self.assertEqual(self.eof_events()[-1]["rows_emitted"], 1)
        self.assertEqual(self.eof_events()[-1]["resume_offset_id"], 100)
        client.disconnect.assert_awaited_once()

    async def test_floodwait_uses_exclusive_cursor_and_never_reprocesses_paid_message(self):
        client = FakeClient([[message(100), FloodWaitError(request=None, capture=2)],
                             [message(100), message(98), message(1)]])
        media = mock.AsyncMock()
        with mock.patch.object(self.fetch, "process_media", new=media), \
                mock.patch.object(self.fetch.asyncio, "sleep", new=mock.AsyncMock()) as sleep:
            self.assertEqual(await self.run_fetch(client, process_voice=True, transcribe_engine="soniox"), 0)
        self.assertEqual([call.args[0].id for call in media.await_args_list], [100, 98, 1])
        self.assertEqual(client.iteration_calls[1]["offset_id"], 100)
        self.assertEqual(client.iteration_calls[1]["max_id"], 101)
        self.assertEqual(client.iteration_calls[1]["min_id"], 0)
        sleep.assert_awaited_once_with(3)
        waiting = next(event for event in self.events if event["type"] == "flood-wait")
        self.assertEqual(waiting["retry_after_seconds"], 2)
        self.assertFalse(waiting["remote_eof"])
        self.assertEqual(self.eof_events()[-1]["rows_emitted"], 3)

    async def test_repeated_floodwait_is_bounded_and_deadline_is_explicit(self):
        client = FakeClient([[FloodWaitError(request=None, capture=5)]])
        with mock.patch.object(self.fetch.asyncio, "sleep", new=mock.AsyncMock()) as sleep:
            with self.assertRaises(FloodWaitError) as error:
                await self.run_fetch(client)
        self.assertEqual(error.exception.code, "telegram_flood_wait")
        self.assertEqual(error.exception.retry_after_seconds, 60)
        self.assertEqual(sleep.await_count, 60)
        self.assertFalse(self.eof_events()[-1]["remote_eof"])

    async def test_many_short_floodwaits_continue_same_cursor_without_head_replay(self):
        client = FakeClient([[message(100), FloodWaitError(request=None,capture=3)]] +
            [[FloodWaitError(request=None,capture=3)] for _ in range(7)] + [[message(98), message(1)]])
        media = mock.AsyncMock()
        with mock.patch.object(self.fetch,'process_media',new=media), mock.patch.object(self.fetch.asyncio,'sleep',new=mock.AsyncMock()) as sleep:
            self.assertEqual(await self.run_fetch(client,process_voice=True,transcribe_engine='soniox'),0)
        self.assertEqual([call.args[0].id for call in media.await_args_list],[100,98,1])
        self.assertTrue(self.eof_events()[-1]['remote_eof'])
        self.assertEqual(client.history_calls,[{'limit':1}])
        self.assertEqual(sleep.await_count,8)
        self.assertGreater(sleep.await_args_list[-1].args[0],4)

    async def test_cancel_during_floodwait_preserves_frozen_head_and_no_eof(self):
        self.fetch._TRAVERSAL_STATE_DIR = str(self.root / "state")
        self.fetch._TRAVERSAL_REQUEST_ID = "fixture-original-request"
        client = FakeClient([[message(100), FloodWaitError(request=None, capture=2)]])
        with mock.patch.object(self.fetch.asyncio, "sleep", new=mock.AsyncMock(side_effect=asyncio.CancelledError())):
            with self.assertRaises(asyncio.CancelledError):
                await self.run_fetch(client)
        state = FetchTraversalCache(self.fetch._TRAVERSAL_STATE_DIR, self.fetch._TRAVERSAL_REQUEST_ID,
                                    111, -1000000000333).load()
        self.assertEqual(state["head_message_id"], 100)
        self.assertEqual(state["state"], "interrupted")
        self.assertFalse(state["remote_eof"])
        self.assertFalse(any(event["type"] == "done" for event in self.events))

    async def test_restart_replays_from_same_frozen_head_not_unacknowledged_cursor(self):
        self.fetch._TRAVERSAL_STATE_DIR = str(self.root / "state")
        self.fetch._TRAVERSAL_REQUEST_ID = "fixture-original-request"
        first = FakeClient([[message(100), RuntimeError("lost desktop ACK")]])
        with self.assertRaises(RuntimeError):
            await self.run_fetch(first)
        second = FakeClient([[message(100), message(1)]], head=200)
        self.assertEqual(await self.run_fetch(second), 0)
        self.assertEqual(second.history_calls, [], "resume must not resnapshot a moving head")
        self.assertEqual(second.iteration_calls[0]["max_id"], 101)
        self.assertNotIn("offset_id", second.iteration_calls[0], "no metadata commit ACK permits durable cursor skip")

    async def test_exact_account_and_peer_fences_precede_all_history_and_avatar(self):
        for account_mismatch in (True, False):
            client = FakeClient()
            self.fetch._EXPECTED_ACCOUNT_ID = 222 if account_mismatch else 111
            self.fetch._EXPECTED_PEER_ID = -1000000000444
            self.assertEqual(await self.run_fetch(client), 4)
            self.assertEqual(client.history_calls, [])
            self.assertEqual(client.iteration_calls, [])
            client.download_profile_photo.assert_not_awaited()
            if account_mismatch:
                client.get_entity.assert_not_awaited()

    async def test_fatal_asr_outcome_aborts_id_list_and_media_only_without_done(self):
        self.fetch._FULL_HISTORY_REPORT = False
        for mode in ("id_list", "media_only"):
            for failure in (UnknownMediaDelivery("fixture unknown ACK"), MediaStorageError("fixture no disk")):
                self.events.clear()
                client = FakeClient()
                with mock.patch.object(self.fetch, "process_media", new=mock.AsyncMock(side_effect=failure)):
                    with self.assertRaises(type(failure)):
                        await self.run_fetch(client, mode, process_voice=True, transcribe_engine="soniox",
                                             message_ids=[10], media_only_msg_ids=[10])
                self.assertFalse(any(event["type"] == "done" for event in self.events))

    async def test_fatal_media_during_full_history_counts_already_emitted_metadata(self):
        client = FakeClient([[message(100)]])
        with mock.patch.object(self.fetch, "process_media", new=mock.AsyncMock(side_effect=UnknownMediaDelivery("fixture ACK"))):
            with self.assertRaises(UnknownMediaDelivery):
                await self.run_fetch(client, process_voice=True, transcribe_engine="soniox")
        self.assertEqual(self.eof_events()[-1]["rows_emitted"], 1)
        self.assertEqual(self.eof_events()[-1]["resume_offset_id"], 0, "uncompleted media does not advance retry cursor")
        self.assertFalse(self.eof_events()[-1]["remote_eof"])

    async def test_skip_profile_photo_is_optional_legacy_default_stays_available(self):
        self.fetch._FULL_HISTORY_REPORT = False
        self.fetch._SKIP_PROFILE_PHOTO = False
        client = FakeClient()
        await self.run_fetch(client, mode="last_n")
        client.download_profile_photo.assert_awaited_once()


class FetchCliFlagsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sc-fetch-cli-fixture-")
        self.fetch = load_fetch_fixture(Path(self.temp.name))
        self.fetch.emit = mock.Mock()

    def tearDown(self):
        self.temp.cleanup()

    def test_cli_globals_and_exact_resume_scope_are_set_before_run(self):
        argv = ["tg_fetch_json.py", "fixture", "--mode", "all", "--session", "fixture-session",
            "--full-history-report", "--traversal-state-dir", self.temp.name,
            "--traversal-request-id", "original-fixture-id", "--expected-account-id", "111",
            "--expected-peer-id", "-1000000000333", "--skip-profile-photo", "--voice-types", "voice,audio",
            "--voice-max-duration-sec", "1200", "--reuse-transcripts", "--transcribe-engine", "soniox", "--process-voice"]
        run = mock.AsyncMock(return_value=0)
        with mock.patch.object(sys, "argv", argv), mock.patch.object(self.fetch, "run", new=run):
            with self.assertRaises(SystemExit) as exited:
                self.fetch.main()
        self.assertEqual(exited.exception.code, 0)
        self.assertTrue(self.fetch._FULL_HISTORY_REPORT)
        self.assertEqual(self.fetch._EXPECTED_PEER_ID, -1000000000333)
        self.assertEqual(self.fetch._EXPECTED_ACCOUNT_ID, 111)
        self.assertEqual(self.fetch._TRAVERSAL_REQUEST_ID, "original-fixture-id")
        self.assertEqual(self.fetch._VOICE_POLICY.kinds, ("voice", "audio"))
        self.assertEqual(self.fetch._VOICE_POLICY.max_seconds, 1200)
        self.assertTrue(self.fetch._VOICE_POLICY.reuse_existing)
        self.assertTrue(self.fetch._SKIP_PROFILE_PHOTO)
        self.assertIsNone(run.call_args.args[2])
        self.assertTrue(run.call_args.kwargs["process_voice"])

    def test_full_history_rejects_topic_or_new_only_scope_before_any_client(self):
        for args in (["--topic-ids", "1"], ["--since-msgid", "10"], ["--mode", "last_n"],
                     ["--limit", "10"], ["--limit", "0"], ["--date", "2026-01-01"],
                     ["--date-to", "2026-01-01"], ["--url", "https://t.me/fixture/10"],
                     ["--message-ids", "10"], ["--media-only-msg-ids", "10"],
                     ["--comments-only-post-ids", "10"], ["--comments-only-source-id", "1"]):
            run = mock.AsyncMock()
            argv = ["tg_fetch_json.py", "fixture", "--mode", "all", "--full-history-report", *args]
            with mock.patch.object(sys, "argv", argv), mock.patch.object(self.fetch, "run", new=run), \
                    contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as error:
                    self.fetch.main()
            self.assertEqual(error.exception.code, 2)
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
