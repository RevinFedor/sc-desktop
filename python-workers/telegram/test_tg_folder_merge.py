import asyncio
import copy
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).parent))
from telethon import types, functions, utils
from tg_folder_merge import (TITLE, FolderOutbox, folder_read, run_folder_merge,
                             merge_plan, filters_hash, filter_hash, confirmed_groups)

class SimulatedCrash(BaseException):
    pass


def group(chat_id=3928484154, name="АйТи Красавчики: Инсайдеры", **kwargs):
    return types.Channel(chat_id, name, types.ChatPhotoEmpty(), None, access_hash=9922, megagroup=True, **kwargs)


def folder(fid=4, name=TITLE, **kwargs):
    return types.DialogFilter(fid, types.TextWithEntities(name, []), [], [], [], **kwargs)


class FakeClient:
    def __init__(self, folders=None, groups=None):
        self.folders = copy.deepcopy(folders or [])
        self.groups = groups if groups is not None else [group()]
        self.calls = []
        self.account = 1033012338
        self.failure = None
        self.apply = True
        self.read_failure = False
        self.on_get = None

    async def get_me(self):
        return SimpleNamespace(id=self.account)

    async def iter_dialogs(self, **kwargs):
        for entity in self.groups:
            yield SimpleNamespace(entity=entity)

    async def __call__(self, rpc):
        self.calls.append(type(rpc).__name__)
        if isinstance(rpc, functions.messages.GetDialogFiltersRequest):
            if self.read_failure:
                raise TimeoutError()
            if self.on_get:
                self.on_get(self)
            return SimpleNamespace(filters=copy.deepcopy(self.folders))
        if isinstance(rpc, functions.messages.UpdateDialogFilterRequest):
            if self.apply:
                self.folders = [f for f in self.folders if getattr(f, "id", None) != rpc.id] + [copy.deepcopy(rpc.filter)]
            if self.failure:
                self.read_failure = True
                raise self.failure
            return True
        raise AssertionError(type(rpc).__name__)


def request(client, key="vu-1", **change):
    return {"operation": "folder_merge", "session": "session_4531193", "expected_account_id": "1033012338",
            "title": TITLE, "request_id": key, "confirm": True, "purpose": "itkras_vu",
            "expected_snapshot_hash": filters_hash(client.folders),
            "chats": [{"chat_id": "3928484154", "expected_title": "АйТи Красавчики: Инсайдеры"}], **change}


def status(key="vu-1", **change):
    return {"operation": "folder_merge_status", "session": "session_4531193", "expected_account_id": "1033012338", "title": TITLE, "request_id": key, **change}


class FolderTests(unittest.IsolatedAsyncioTestCase):
    async def test_server_repositions_added_peer_without_dropping_old_members(self):
        existing = folder(106); existing.include_peers = [types.InputPeerChat(777)]
        class Reposition(FakeClient):
            async def __call__(self, rpc):
                out = await super().__call__(rpc)
                if isinstance(rpc, functions.messages.UpdateDialogFilterRequest):
                    self.folders[0].include_peers.reverse()
                return out
        client = Reposition([existing])
        with tempfile.TemporaryDirectory() as root:
            out = await run_folder_merge(client, request(client), root)
        self.assertEqual(out['state'], 'verified')
        self.assertEqual(client.calls.count('UpdateDialogFilterRequest'), 1)

    async def test_additive_readback_edit_preserves_exact_old_proposal_without_replay(self):
        class OtherAddition(FakeClient):
            async def __call__(self, rpc):
                out = await super().__call__(rpc)
                if isinstance(rpc, functions.messages.UpdateDialogFilterRequest):
                    self.folders[0].include_peers.append(types.InputPeerChat(777))
                return out
        client = OtherAddition([folder(106)])
        with tempfile.TemporaryDirectory() as root:
            out = await run_folder_merge(client, request(client), root)
        self.assertEqual(out['state'], 'verified')
        self.assertEqual(client.calls.count('UpdateDialogFilterRequest'), 1)
        self.assertIn(-777, [utils.get_peer_id(p) for p in client.folders[0].include_peers])

    async def test_basic_group_absent_from_dialogs_requires_full_self_membership(self):
        basic = types.Chat(5088454966, 'АйТи Красавчики: Азербайджан', types.ChatPhotoEmpty(), 14, None, 1)
        class Basic(FakeClient):
            async def get_entity(self, peer):
                self_case.assertIsInstance(peer, types.PeerChat); return basic
            async def __call__(self, rpc):
                if isinstance(rpc, functions.messages.GetFullChatRequest):
                    return SimpleNamespace(full_chat=SimpleNamespace(participants=SimpleNamespace(participants=[SimpleNamespace(user_id=self.account)])))
                return await super().__call__(rpc)
        self_case = self; client = Basic(groups=[])
        out = await confirmed_groups(client, [{'chat_id': '-5088454966', 'expected_title': basic.title}])
        self.assertEqual(out[0]['peer_id'], '-5088454966')
        client.account = 42
        async def missing(self, rpc): return SimpleNamespace(full_chat=SimpleNamespace(participants=SimpleNamespace(participants=[])))
        client.__class__.__call__ = missing
        with self.assertRaises(Exception): await confirmed_groups(client, [{'chat_id': '-5088454966', 'expected_title': basic.title}])
        # Positive raw IDs still do not guess a namespace or broaden a scan.
        with self.assertRaises(Exception): await confirmed_groups(client, [{'chat_id': '5088454966', 'expected_title': basic.title}])

    async def test_pinned_member_is_not_duplicated_and_folder_reader_includes_it(self):
        from tg_resolve_folder_ndjson import _explicit_filter_peers
        vu = folder(106)
        vu.pinned_peers = [utils.get_input_peer(group())]
        other = types.InputPeerChat(123)
        vu.include_peers = [other]
        client = FakeClient([vu])
        with tempfile.TemporaryDirectory() as root:
            out = await run_folder_merge(client, request(client), root)
        self.assertEqual(out["state"], "verified")
        self.assertEqual(out["added_peer_ids"], [])
        self.assertEqual(client.calls.count("UpdateDialogFilterRequest"), 0)
        self.assertEqual([utils.get_peer_id(p) for p in _explicit_filter_peers(vu)], [-1003928484154, -123])

    async def test_legacy_pinned_duplicate_reconciles_original_without_second_rpc(self):
        client = FakeClient([folder(106)])
        client.folders[0].pinned_peers = [utils.get_input_peer(group())]
        legacy = __import__('tg_folder_merge')
        actual_merge = legacy.merge_plan
        def old_plan(folders, groups):
            original, merged, created, added = actual_merge(folders, groups)
            merged.include_peers.append(groups[0]["peer"])
            return original, merged, created, [groups[0]["peer_id"]]
        old_call = client.__call__
        # Simulate Telegram's canonicalization, not a fake echo of the proposal.
        class Normalizing(FakeClient):
            async def __call__(self, rpc):
                result = await super().__call__(rpc)
                if isinstance(rpc, functions.messages.UpdateDialogFilterRequest):
                    for f in self.folders:
                        pins = {utils.get_peer_id(p) for p in f.pinned_peers}
                        f.include_peers = [p for p in f.include_peers if utils.get_peer_id(p) not in pins]
                return result
        client = Normalizing(client.folders)
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as root, patch.object(legacy, 'merge_plan', old_plan):
            out = await run_folder_merge(client, request(client), root)
        self.assertEqual(out["state"], "verified")
        self.assertEqual(client.calls.count("UpdateDialogFilterRequest"), 1)
        self.assertEqual(out["added_peer_ids"], [])

    async def test_original_geek_member_restored_without_join_or_removing_current_groups(self):
        current = folder(106)
        current.include_peers = [types.InputPeerChannel(3928484154, 9922)]
        original = group(3796703048, "No geeks are welcome")
        client = FakeClient([current], [group(), original])
        change = {"chats": [{"chat_id": "-1003796703048", "expected_title": "No geeks are welcome"}]}
        with tempfile.TemporaryDirectory() as root:
            out = await run_folder_merge(client, request(client, **change), root)
        self.assertEqual(out["state"], "verified")
        self.assertEqual({p.channel_id for p in client.folders[0].include_peers}, {3928484154, 3796703048})
        self.assertNotIn("JoinChannelRequest", client.calls)

    async def test_read_current_filter_and_true_tl_group_kind_no_guess(self):
        client = FakeClient([types.DialogFilterDefault(), folder()])
        out = await folder_read(client, request(client))
        self.assertTrue(out["inventory_complete"])
        self.assertEqual(out["matching_folder_ids"], [4])
        self.assertEqual(out["confirmed_members"][0]["peer_id"], "-1003928484154")
        self.assertEqual(out["confirmed_members"][0]["kind"], "megagroup")
        self.assertEqual(client.calls, ["GetDialogFiltersRequest"])

    async def test_union_preserves_every_original_field_and_other_folders(self):
        vu = folder(4, contacts=True, groups=True, exclude_muted=True, title_noanimate=True, color=2, emoticon="custom")
        vu.title.entities = [types.MessageEntityBold(0, 2)]
        vu.pinned_peers = [types.InputPeerChat(123)]
        vu.include_peers = [types.InputPeerChat(123), types.InputPeerUser(9, 888)]
        vu.exclude_peers = [types.InputPeerChat(999)]
        other = folder(8, "Другое")
        client = FakeClient([vu, other])
        original = copy.deepcopy(client.folders[0])
        other_hash = filter_hash(client.folders[1])
        events = []
        with tempfile.TemporaryDirectory() as root:
            out = await run_folder_merge(client, request(client), root, events.append)
        self.assertEqual(out["state"], "verified")
        self.assertEqual(out["folder_id"], 4)
        self.assertEqual(out["include_count"], 3)
        self.assertTrue(out["other_filters_unchanged"])
        merged = next(f for f in client.folders if f.id == 4)
        merged.include_peers.pop()
        self.assertEqual(filter_hash(merged), filter_hash(original))
        self.assertEqual(filter_hash(next(f for f in client.folders if f.id == 8)), other_hash)
        self.assertEqual(out["removals"], 0)
        self.assertTrue(out["sc_refresh_required"])
        self.assertFalse(out["sc_materialized_verified"])
        self.assertEqual(events[0]["stage"], "dispatching_folder_update")

    async def test_create_uses_free_custom_id_not_index_and_deduplicates(self):
        client = FakeClient([types.DialogFilterDefault(), folder(2, "Other")])
        intent = request(client)
        intent["chats"] *= 2
        with tempfile.TemporaryDirectory() as root:
            out = await run_folder_merge(client, intent, root)
            retry = await run_folder_merge(client, intent, root)
        self.assertEqual(out["folder_id"], 3)
        self.assertEqual(out["include_count"], 1)
        self.assertEqual(retry["state"], "verified")
        self.assertEqual(client.calls.count("UpdateDialogFilterRequest"), 1)
        self.assertEqual(next(f for f in client.folders if getattr(f, "id", 0) == 3).title.text, "\u0412\u0423")

    async def test_already_included_does_not_send_rpc_or_rejoin(self):
        vu = folder(); vu.include_peers = [utils.get_input_peer(group())]
        client = FakeClient([vu])
        with tempfile.TemporaryDirectory() as root:
            out = await run_folder_merge(client, request(client), root)
        self.assertEqual(out["state"], "verified")
        self.assertEqual(out["added_peer_ids"], [])
        self.assertNotIn("UpdateDialogFilterRequest", client.calls)

    async def test_existing_exclusion_preserved_and_reported(self):
        vu = folder(); vu.exclude_peers = [utils.get_input_peer(group())]
        client = FakeClient([vu]); before = filters_hash(client.folders)
        with tempfile.TemporaryDirectory() as root:
            out = await run_folder_merge(client, request(client), root)
        self.assertEqual(out["code"], "folder_existing_exclusion_conflict")
        self.assertEqual(filters_hash(client.folders), before)
        self.assertNotIn("UpdateDialogFilterRequest", client.calls)
        self.assertNotIn("folder_id", out)

    async def test_stale_and_concurrent_edit_never_overwritten(self):
        for mutate_during in (False, True):
            client = FakeClient([folder()])
            intent = request(client)
            if not mutate_during:
                client.folders[0].color = 4
            else:
                count = 0
                def change(client):
                    nonlocal count
                    count += 1
                    if count == 2:
                        client.folders[0].color = 4
                client.on_get = change
            with tempfile.TemporaryDirectory() as root:
                out = await run_folder_merge(client, intent, root)
            self.assertEqual(out["code"], "folder_snapshot_changed")
            self.assertNotIn("UpdateDialogFilterRequest", client.calls)

    async def test_wrong_account_title_om_pending_and_ambiguous_rejected(self):
        cases = [FakeClient([folder()], [group(left=True)]), FakeClient([folder()], []),
                 FakeClient([folder(), folder(8)]), FakeClient([folder()], [group(), group()])]
        wrong = FakeClient([folder()]); wrong.account = 7309115053; cases.append(wrong)
        for client in cases:
            with tempfile.TemporaryDirectory() as root:
                out = await run_folder_merge(client, request(client), root)
            self.assertEqual(out["state"], "rejected")
            self.assertNotIn("UpdateDialogFilterRequest", client.calls)
        for entity in (group(name="ОМ Красавчики"), group(name="Other"),
                       types.Channel(3928484154, "АйТи Красавчики", types.ChatPhotoEmpty(), None, access_hash=3, broadcast=True)):
            client = FakeClient(groups=[entity])
            with self.assertRaises(Exception):
                await confirmed_groups(client, [{"chat_id": str(entity.id), "expected_title": entity.title}])

    async def test_lost_ack_no_replay_and_readback_recovery(self):
        client = FakeClient([folder()]); client.failure = TimeoutError()
        with tempfile.TemporaryDirectory() as root:
            intent = request(client)
            out = await run_folder_merge(client, intent, root)
            self.assertEqual(out["state"], "unknown")
            self.assertNotIn("folder_id", out)
            with self.assertRaises(Exception):
                await run_folder_merge(client, request(client, "new-key"), root)
            again = await run_folder_merge(client, intent, root)
            self.assertEqual(again["state"], "unknown")
            client.read_failure = False
            recovered = await run_folder_merge(client, status(), root)
            self.assertEqual(recovered["state"], "verified")
            self.assertEqual(recovered["folder_id"], 4)
        self.assertEqual(client.calls.count("UpdateDialogFilterRequest"), 1)

    async def test_process_crash_dispatching_reconciles_only(self):
        client = FakeClient([folder()]); client.failure = SimulatedCrash()
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(SimulatedCrash):
                await run_folder_merge(client, request(client), root)
            client.read_failure = False
            result = await run_folder_merge(client, status(), root)
            self.assertEqual(result["state"], "verified")
        self.assertEqual(client.calls.count("UpdateDialogFilterRequest"), 1)

    async def test_ack_without_matching_readback_is_not_success_and_new_key_fenced(self):
        client = FakeClient([folder()]); client.apply = False
        with tempfile.TemporaryDirectory() as root:
            out = await run_folder_merge(client, request(client), root)
            self.assertEqual(out["state"], "unknown")
            self.assertNotIn("folder_id", out)
            with self.assertRaises(Exception):
                await run_folder_merge(client, request(client, "new-key"), root)
        self.assertEqual(client.calls.count("UpdateDialogFilterRequest"), 1)

    async def test_status_prepared_never_writes_wrong_binding_never_reconciles(self):
        client = FakeClient([folder()])
        with tempfile.TemporaryDirectory() as root:
            box = FolderOutbox(root); box.reserve(request(client)); box.close()
            result = await run_folder_merge(client, status(), root)
            self.assertEqual(result["state"], "prepared")
            with self.assertRaises(Exception):
                await run_folder_merge(client, status(expected_account_id="7309115053"), root)
        self.assertEqual(client.calls, [])

    async def test_basic_chat_shared_filter_and_busy_lock_keep_contract(self):
        chat = types.Chat(42, "Клуб АйТи Красавчиков", types.ChatPhotoEmpty(), 9, None, 1)
        client = FakeClient(groups=[chat])
        groups = await confirmed_groups(client, [{"chat_id": "42", "expected_title": chat.title}])
        self.assertEqual(groups[0]["peer_id"], "-42")
        shared = types.DialogFilterChatlist(9, types.TextWithEntities(TITLE, []), [], [], has_my_invites=True, color=1)
        _old, merged, _created, added = merge_plan([shared], groups)
        self.assertTrue(merged.has_my_invites); self.assertEqual(merged.color, 1); self.assertEqual(added, ["-42"])
        with tempfile.TemporaryDirectory() as root:
            box = FolderOutbox(root); record = box.reserve(request(client))
            with box.lock(record["fingerprint"]) as locked:
                self.assertTrue(locked)
                result = await run_folder_merge(client, status(), root)
                self.assertEqual(result["state"], "in_progress")
            box.close()

    async def test_dialog_network_deadline_is_unknown_inventory_not_absence(self):
        client = FakeClient()
        async def disconnected(**kwargs):
            raise asyncio.TimeoutError()
            yield None
        client.iter_dialogs = disconnected
        with tempfile.TemporaryDirectory() as root:
            out = await run_folder_merge(client, request(client), root)
        self.assertEqual(out['code'], 'folder_dialog_inventory_timeout')
        self.assertNotIn('folder_id', out)
        self.assertNotIn('UpdateDialogFilterRequest', client.calls)


if __name__ == "__main__":
    unittest.main()
