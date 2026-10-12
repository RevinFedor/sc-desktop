import asyncio
import base64
import hashlib
import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from telethon import types, functions
from tg_bot_contract import keyboard_original, safe_tl, bot_messages, bot_information, itkras_link_candidates, BotContractError, digest
from tg_bot_actions import run_bot_action, BotOutbox
from tg_send_text_ndjson import run_request as text_run
from telegram_text_outbox import SendError
import tg_live_ndjson as live

ACCOUNT, BOT = 1033012338, 935519651
NOW = datetime(2026, 10, 10, tzinfo=timezone.utc)
def msg(number, markup=None, text='fixture groups'):
    return types.Message(number, types.PeerUser(BOT), message=text, from_id=types.PeerUser(BOT), date=NOW, reply_markup=markup)
def request(**changes):
    return {'operation':'bot_action', 'session':'session_fixture', 'bot':'@boosty_to_bot',
            'expected_account_id':str(ACCOUNT), 'expected_peer_id':str(BOT), 'request_id':'bot-test-1',
            'purpose':'read_groups', 'confirm':True, 'action':'button', 'message_id':10, 'row':0, 'column':0,
            'expected_action_label':'🎭 Доступные группы', **changes}

class Crash(BaseException): pass
class Fake:
    def __init__(self):
        self.me = types.User(ACCOUNT, first_name='Owner', username='F9922')
        self.entity = types.User(BOT, access_hash=123, first_name='Boosty', username='boosty_to_bot', bot=True)
        self.messages = {10: msg(10, types.ReplyInlineMarkup([types.KeyboardButtonRow([
            types.KeyboardButtonCallback('🎭 Доступные группы', b'opaque\x00\xff')])]))}
        self.commands = [types.BotCommand('start', 'start groups menu')]
        self.callbacks, self.sends, self.reads = [], [], []
        self.callback_failure = None
        self.gate, self.entered = None, asyncio.Event()
    async def get_me(self): return self.me
    async def get_entity(self, target): return self.entity
    async def get_messages(self, entity, ids=None, limit=None, min_id=None):
        self.reads.append(ids)
        if isinstance(ids, list): return [self.messages.get(n) for n in ids]
        if ids is not None: return self.messages.get(ids)
        if min_id is not None: return [m for m in self.messages.values() if m.id > min_id]
        return [SimpleNamespace(id=100)]
    async def __call__(self, rpc):
        if isinstance(rpc, functions.users.GetFullUserRequest):
            return SimpleNamespace(full_user=SimpleNamespace(bot_info=types.BotInfo(user_id=BOT, commands=self.commands,
                description='Read menu; not a payment authority', menu_button=types.BotMenuButtonCommands())))
        if isinstance(rpc, functions.help.GetConfigRequest): return SimpleNamespace(message_length_max=4096)
        if isinstance(rpc, functions.messages.GetBotCallbackAnswerRequest):
            self.callbacks.append(rpc)
            self.entered.set()
            if self.gate: await self.gate.wait()
            if self.callback_failure: raise self.callback_failure
            return SimpleNamespace(message='Groups listed', url=None, alert=False, cache_time=0)
        if isinstance(rpc, functions.messages.SendMessageRequest):
            self.sends.append(rpc)
            self.messages[101] = types.Message(101, types.PeerUser(BOT), message=rpc.message, from_id=types.PeerUser(ACCOUNT), out=True, date=NOW)
            return types.UpdateShortSentMessage(101, 1, 1, NOW, out=True)
        raise AssertionError(type(rpc).__name__)
    async def disconnect(self): pass

class KeyboardTests(unittest.TestCase):
    def test_url_callback_plain_unsupported_and_unsafe_int64_are_exact(self):
        keyboard = types.ReplyInlineMarkup([types.KeyboardButtonRow([
            types.KeyboardButtonUrl('АйТи Красавчики', 'https://t.me/+fixture_only_invite'),
            types.KeyboardButtonCallback('Доступные группы', b'\x00\xffopaque'),
            types.KeyboardButtonBuy('subscribe'),
            types.KeyboardButtonUserProfile('not an action', 2**62 + 17),
        ])])
        result = keyboard_original(msg(10, keyboard))
        self.assertEqual(result['buttons'][0]['url'], 'https://t.me/+fixture_only_invite')
        self.assertEqual(base64.b64decode(result['buttons'][1]['data_base64']), b'\x00\xffopaque')
        self.assertEqual(result['buttons'][1]['data_sha256'], hashlib.sha256(b'\x00\xffopaque').hexdigest())
        self.assertFalse(result['buttons'][2]['supported_action'])
        self.assertEqual(result['buttons'][3]['raw']['user_id'], str(2**62 + 17))
        self.assertFalse(result['ui_active_keyboard_proven'])
        self.assertFalse(result['truncated'])
        self.assertEqual(result['binding']['peer_id'], str(BOT))
    def test_none_hide_force_and_bounded_continuation_do_not_fake_buttons(self):
        for markup in (None, types.ReplyKeyboardHide(), types.ReplyKeyboardForceReply()):
            out = keyboard_original(msg(1, markup))
            self.assertEqual(out['buttons'], [])
        keyboard = types.ReplyKeyboardMarkup([types.KeyboardButtonRow([types.KeyboardButton(f'row-{i}')]) for i in range(5)])
        first = keyboard_original(msg(2, keyboard), max_rows=2)
        self.assertEqual(first['next_row_offset'], 2)
        second = keyboard_original(msg(2, keyboard), row_offset=2, max_rows=2)
        self.assertEqual(second['buttons'][0]['row'], 2)
        self.assertEqual(first['binding_hash'], second['binding_hash'])
        self.assertTrue(first['truncated'])
        blocked = keyboard_original(msg(2, keyboard), max_bytes=1)
        self.assertTrue(blocked['blocked_row_too_large'])
        self.assertIsNone(blocked['next_row_offset'])
    def test_binding_changes_on_message_peer_text_and_callback_payload(self):
        one = msg(1, types.ReplyInlineMarkup([types.KeyboardButtonRow([types.KeyboardButtonCallback('groups', b'1')])]))
        initial = keyboard_original(one)['binding_hash']
        one.message = 'edited'; self.assertNotEqual(initial, keyboard_original(one)['binding_hash'])
        one.message = 'fixture groups'; one.reply_markup.rows[0].buttons[0].data = b'2'
        self.assertNotEqual(initial, keyboard_original(one)['binding_hash'])
    def test_pure_filter_excludes_om_deduplicates_alias_invites_and_does_not_guess_callback(self):
        keyboard = types.ReplyInlineMarkup([types.KeyboardButtonRow([
            types.KeyboardButtonUrl('АйТи Красавчики: Клуб', 'https://t.me/+fixture_only_invite'),
            types.KeyboardButtonUrl('АйТи Красавчики: Клуб', 'https://t.me/joinchat/fixture_only_invite'),
            types.KeyboardButtonUrl('ОМ Питер', 'https://t.me/+fixture_om'),
            types.KeyboardButtonCallback('АйТи Красавчики: Инсайдеры', b'not-a-link'),
            types.KeyboardButtonUrl('страна без owner label', 'https://t.me/+fixture_unknown'),
        ])])
        message = msg(273965, keyboard)
        result = itkras_link_candidates({'messages': [{'message_id':message.id,'text_sha256':digest(message.message),
            'reply_markup':keyboard_original(message)}], 'requested_message_ids':[273965], 'all_selected_messages_found':True, 'truncated':False})
        self.assertEqual(len(result['links']), 1)
        self.assertEqual(len(result['links'][0]['provenance']), 2)
        self.assertFalse(result['links'][0]['join_authorized_by_label_alone'])
        self.assertEqual(len(result['excluded']), 1)
        self.assertEqual(len(result['unknown']), 1)

class BotTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.client = Fake(); self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = self.temp.name
    def bound(self, **changes):
        value = request(**changes)
        value['expected_binding_hash'] = keyboard_original(self.client.messages[value['message_id']])['binding_hash']
        return value
    async def test_all_three_selected_replies_and_ads_are_read_without_send(self):
        for n in [273965,273966,273967]: self.client.messages[n] = msg(n, self.client.messages[10].reply_markup)
        value = request(operation='bot_messages', message_ids=[273965,273966,273967])
        result = await bot_messages(self.client, value)
        self.assertEqual([row['message_id'] for row in result['messages']], value['message_ids'])
        self.assertTrue(result['all_selected_messages_found'])
        self.assertEqual((await bot_information(self.client, value))['commands'][0]['command'], 'start')
        self.assertEqual(self.client.sends + self.client.callbacks, [])
    async def test_continuation_rejects_edited_keyboard_and_missing_message_is_explicit(self):
        sha = keyboard_original(self.client.messages[10])['binding_hash']
        self.client.messages[10].message = 'changed'
        with self.assertRaisesRegex(BotContractError, 'changed'):
            await bot_messages(self.client, request(operation='bot_messages',message_ids=[10],expected_binding_hashes={'10':sha}))
        result = await bot_messages(self.client, request(operation='bot_messages',message_ids=[99]))
        self.assertEqual(result['missing_message_ids'], [99])
    async def test_bot_account_peer_and_incoming_message_binding_no_fallback(self):
        for changes in ({'expected_account_id':'999'},{'expected_peer_id':'999'}):
            with self.assertRaises(BotContractError): await bot_information(self.client, request(**changes))
        self.client.messages[10].from_id = types.PeerUser(ACCOUNT)
        with self.assertRaises(BotContractError): await bot_messages(self.client, request(operation='bot_messages',message_ids=[10]))
    async def test_callback_ack_is_at_most_once_and_never_claims_membership(self):
        value = self.bound()
        out = await run_bot_action(self.client, value, self.root)
        self.assertEqual(out['state'], 'callback_acknowledged')
        self.assertFalse(out['effect_verified'])
        self.assertTrue(out['bot_reply_or_membership_not_proven'])
        again = await run_bot_action(self.client, value, self.root)
        self.assertEqual(again['state'], out['state'])
        self.assertEqual(len(self.client.callbacks), 1)
        self.assertEqual(self.client.callbacks[0].data, b'opaque\x00\xff')
    async def test_timeout_and_crash_never_retry_or_release_new_key(self):
        for failure in (TimeoutError('possibly executed'), Crash()):
            with tempfile.TemporaryDirectory() as root:
                self.client.callback_failure = failure
                value = self.bound()
                try: await run_bot_action(self.client, value, root)
                except Crash: pass
                count = len(self.client.callbacks)
                out = await run_bot_action(self.client, {**value,'operation':'bot_action_status'}, root)
                self.assertTrue(out['outcome_unknown'])
                await run_bot_action(self.client, value, root)
                self.assertEqual(len(self.client.callbacks), count)
                with self.assertRaises(SendError): await run_bot_action(self.client, {**value,'request_id':'new-key'}, root)
    async def test_parallel_same_request_dispatches_only_one_callback(self):
        self.client.gate = asyncio.Event(); value = self.bound()
        first = asyncio.create_task(run_bot_action(self.client, value, self.root))
        await self.client.entered.wait()
        other = await run_bot_action(self.client, value, self.root)
        self.assertEqual(other['state'], 'in_progress')
        self.client.gate.set(); await first
        self.assertEqual(len(self.client.callbacks), 1)
    async def test_changed_markup_and_unsupported_payment_2fa_never_dispatch(self):
        value = self.bound(); self.client.messages[10].message = 'edited'
        self.assertEqual((await run_bot_action(self.client, value, self.root))['code'], 'bot_markup_changed')
        for i,button in enumerate([types.KeyboardButtonBuy('Клуб АйТи Красавчиков оплатить'),
                                  types.KeyboardButtonCallback('Доступные группы',b'2',requires_password=True),
                                  types.KeyboardButtonCallback('OM groups',b'3')]):
            self.client.messages[10] = msg(10,types.ReplyInlineMarkup([types.KeyboardButtonRow([button])]))
            value = self.bound(request_id=f'unsupported-{i}', expected_action_label=button.text)
            self.assertEqual((await run_bot_action(self.client,value,self.root))['state'],'rejected')
        self.assertEqual(self.client.sends+self.client.callbacks,[])
    async def test_advertised_command_and_exact_reply_label_reuse_plain_sender_readback(self):
        command = request(action='command',command='/start',request_id='command-1')
        # Button-only keys are not part of the normalized command wire request.
        for key in ('message_id','row','column','expected_action_label'): command.pop(key,None)
        result = await run_bot_action(self.client,command,self.root)
        self.assertEqual(result['state'],'text_delivered'); self.assertEqual(result['message_id'],101)
        await run_bot_action(self.client,command,self.root)
        self.assertEqual(len(self.client.sends),1)
        self.client.messages[10] = msg(10,types.ReplyKeyboardMarkup([types.KeyboardButtonRow([types.KeyboardButton(' 🎭 Доступные группы ')])]))
        label = self.bound(request_id='reply-label-1',expected_action_label=' 🎭 Доступные группы ')
        result = await run_bot_action(self.client,label,self.root)
        self.assertEqual(result['state'],'text_delivered')
        self.assertEqual(self.client.sends[-1].message,' 🎭 Доступные группы ')
    async def test_unadvertised_groups_not_invented_and_source_command_must_match_sha(self):
        value = request(action='command',command='/groups')
        self.assertEqual((await run_bot_action(self.client,value,self.root))['code'],'bot_command_not_advertised')
        self.client.commands = []
        self.client.messages[11] = msg(11,text='Use /unban only if menu absent')
        value = request(action='command',command='/unban',request_id='source-command',command_source_message_id=11,
                        expected_command_source_sha256=digest(self.client.messages[11].message))
        self.assertEqual((await run_bot_action(self.client,value,self.root))['state'],'text_delivered')
    async def test_advertised_payment_command_still_outside_scope(self):
        self.client.commands = [types.BotCommand('buy_groups', 'Purchase groups')]
        value = request(action='command', command='/buy_groups', request_id='must-not-pay')
        self.assertEqual((await run_bot_action(self.client, value, self.root))['code'], 'bot_action_outside_scope')
        self.assertEqual(self.client.sends + self.client.callbacks, [])
    async def test_existing_resolve_adds_only_bot_info_without_history_or_buttons(self):
        async def factory(session): return self.client
        out = await text_run({'operation':'resolve','session':'session_fixture','target':'@boosty_to_bot'},root=self.root,client_factory=factory)
        self.assertTrue(out['bot_info']['bot_info_available'])
        self.assertEqual(out['bot_info']['reader']['version'],'bot-info-v1')
        self.assertEqual(self.client.reads,[])
        self.assertEqual(self.client.sends+self.client.callbacks,[])
    async def test_membership_info_is_read_only_and_request_needed_is_not_pending_approval(self):
        async def rpc(call):
            self.assertIsInstance(call,functions.messages.CheckChatInviteRequest)
            return types.ChatInvite(title='АйТи Красавчики: Club',photo=types.PhotoEmpty(1),participants_count=3,request_needed=True,color=0)
        self.client.__class__ = type('InviteFake',(Fake,),{'__call__':lambda current,call:rpc(call)})
        result = await live.run_membership_info(self.client,{'target':'https://t.me/+fixture_invite','expected_account_id':str(ACCOUNT)})
        self.assertFalse(result['membership_mutated']); self.assertTrue(result['request_needed'])
        self.assertIsNone(result['request_submitted']); self.assertFalse(result['ready_for_fetch'])

if __name__ == '__main__': unittest.main()
