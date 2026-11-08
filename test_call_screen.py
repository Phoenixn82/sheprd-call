"""Stdlib-only protocol checks; execute actual bot code without loading voice models."""

import ast
import asyncio
from enum import Enum
from pathlib import Path
import re
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import AsyncMock, Mock, patch

from shown import CLIENT, PANE, DisplayText, card_id, speakable


class Frame:
    def __init__(self, message=None, **values):
        self.message = message
        self.__dict__.update(values)


class Processor:
    async def process_frame(self, frame, direction):
        pass


def load_bot():
    tree = ast.parse(Path(__file__).with_name("bot.py").read_text())
    names = {"CallSignals", "ClaudeSession", "Notice", "pronounce"}
    nodes = [node for node in tree.body if isinstance(node, (ast.ClassDef, ast.FunctionDef)) and node.name in names]
    namespace = dict(asyncio=asyncio, re=re, time=time, PANE=PANE, DisplayText=DisplayText, card_id=card_id,
                     speakable=speakable, CLIENT=CLIENT,
                     FrameProcessor=Processor, logger=Mock(), START_SECS=0.25, TURN_SILENCE=1.2, NOTE_TTL=60,
                     MUTE_MAX=300, QUESTION_HOLD=3.0,
                     FrameDirection=Enum("FrameDirection", "DOWNSTREAM UPSTREAM"))
    for name in ("OutputTransportMessageUrgentFrame", "InputAudioRawFrame", "StartFrame", "InterruptionFrame",
                 "UserStartedSpeakingFrame", "UserStoppedSpeakingFrame", "BotStoppedSpeakingFrame", "LLMContextFrame",
                 "VADUserStartedSpeakingFrame", "BotStartedSpeakingFrame"):
        namespace[name] = type(name, (Frame,), {})
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "bot.py", "exec"), namespace)
    return types.SimpleNamespace(**namespace)


bot = load_bot()


class PronounceTest(unittest.TestCase):
    def test_sheprd_is_spoken_as_shepherd(self):
        for text, said in (("Sheprd here.", "Shepherd here."), ("Ask SHEPRD or sheprd, Sheprd's call", "Ask Shepherd or Shepherd, Shepherd's call"),
                           ("sheprds and shepherd", "sheprds and shepherd"), ("Tap me (Sheprd)", "Tap me (Shepherd)"), ("", "")):
            self.assertEqual(bot.pronounce(text), said, text)
        self.assertEqual(str(bot.Notice("Sheprd")), "Sheprd")  # the screen keeps the spelling


class MarkerTest(unittest.TestCase):
    def test_every_possible_two_chunk_split_and_single_char_stream(self):
        text = "Here it is. [show]http://192.0.2.10:8096[/show] Open it."
        for chunks in ([text[:i], text[i:]] for i in range(len(text) + 1)):
            parser, spoken, cards = bot.DisplayText(), [], []
            for chunk in chunks:
                speech, shown = parser.feed(chunk)
                spoken.append(speech); cards.extend(shown)
            speech, shown = parser.feed("", final=True)
            self.assertEqual(" ".join(("".join(spoken) + speech).split()), "Here it is. Open it.")
            self.assertEqual(cards + shown, ["http://192.0.2.10:8096"])
        parser, spoken, cards = bot.DisplayText(), [], []
        for char in text:
            speech, shown = parser.feed(char)
            spoken.append(speech); cards.extend(shown)
        self.assertNotIn("show", "".join(spoken))
        self.assertEqual(cards, ["http://192.0.2.10:8096"])

    def test_unclosed_and_partial_tags_never_spoken_and_next_turn_recovers(self):
        for tail in ("[", "[sh", "[show", "[/sh", "[/show"):
            with self.subTest(tail=tail):
                parser = bot.DisplayText()
                self.assertEqual(parser.feed("Hello " + tail, final=True), ("Hello ", []))
        parser = bot.DisplayText()
        speech, shown = parser.feed("Read this [show]secret code[/sh", final=True)
        self.assertEqual(speech.strip(), "Read this")
        self.assertEqual(shown, ["secret code"])
        self.assertEqual(parser.feed("Next spoken turn.", final=True), ("Next spoken turn.", []))

    def test_nested_text_and_multiple_cards(self):
        parser = bot.DisplayText()
        speech, cards = parser.feed("Say [show]outer [show]inner[/show] end[/show] done. "
                                    "[SHOW]next[/SHOW]", final=True)
        self.assertEqual(" ".join(speech.split()), "Say done.")
        self.assertEqual(cards, ["outer inner end", "next"])

    def test_plain_brackets_and_empty_card(self):
        parser = bot.DisplayText()
        self.assertEqual(parser.feed("A [normal] bracket.", final=True), ("A [normal] bracket.", []))
        self.assertEqual(parser.feed("[show] [/show]", final=True)[1], [])
        self.assertEqual(parser.feed("[/show]Hello", final=True), ("Hello", []))


class ProtocolTest(unittest.IsolatedAsyncioTestCase):
    def session(self):
        session = bot.ClaudeSession(Mock())
        session.push_frame = AsyncMock()
        session._take = Mock()  # floor holding is call_test.py --check's job
        return session

    async def test_show_payload_keeps_marked_text_out_of_speech(self):
        session = self.session()
        await session._desk_event({"text": "Read this. [sh", "text_end": False})
        await session._desk_event({"busy": True})
        await session._desk_event({"text": "ow]first [show]inner[/show] last[/show] Done.", "text_end": True})
        self.assertEqual([call.args[0].message for call in session.push_frame.await_args_list],
                         [{"type": "busy", "busy": True}, {"type": "show", "text": "first inner last",
                          "id": card_id("first inner last", 0)}])
        spoken = []
        while not session._speech.empty():
            spoken.append(session._speech.get_nowait())
        self.assertEqual(spoken, ["Read this.", "Done."])
        await session._desk_event({"text": "[show]unclosed", "text_end": True})
        self.assertEqual(session.push_frame.await_args.args[0].message,
                         {"type": "show", "text": "unclosed", "id": card_id("unclosed", 0)})
        self.assertTrue(session._speech.empty())

    async def test_handoff_link_goes_to_the_face_and_null_closes_it(self):
        session = self.session()
        link = {"url": "https://box.example.ts.net/web-handoff/h/" + "A" * 32, "reason": "sign in"}
        await session._desk_event({"handoff": link})
        await session._desk_event({"handoff": None})
        self.assertEqual([call.args[0].message for call in session.push_frame.await_args_list],
                         [{"type": "handoff", **link}, {"type": "handoff"}])
        self.assertTrue(session._speech.empty())

    async def test_user_turn_start_stop_payloads(self):
        session = self.session()
        for name, speaking in (("UserStartedSpeakingFrame", True), ("UserStoppedSpeakingFrame", False)):
            frame = getattr(bot, name)()
            await session.process_frame(frame, bot.FrameDirection.DOWNSTREAM)
            self.assertEqual(session.push_frame.await_args_list[-2].args[0].message,
                             {"type": "user-turn", "speaking": speaking})
            self.assertIs(session.push_frame.await_args.args[0], frame)

    async def test_audio_receipt_ignores_upstream_and_empty_frames(self):
        signals = bot.CallSignals()
        signals.push_frame = AsyncMock()
        await signals.process_frame(bot.InputAudioRawFrame(audio=b"\0\0"), bot.FrameDirection.UPSTREAM)
        await signals.process_frame(bot.InputAudioRawFrame(audio=b""), bot.FrameDirection.DOWNSTREAM)
        self.assertIsNone(signals.last_audio)
        with patch.object(time, "monotonic", return_value=10):
            await signals.process_frame(bot.InputAudioRawFrame(audio=b"\0\0"), bot.FrameDirection.DOWNSTREAM)
        self.assertEqual(signals.last_audio, 10)  # silent PCM is still a live input stream

    async def test_health_heartbeat_reports_missing_fresh_and_stale_audio(self):
        for last_audio, expected in ((None, False), (9, True), (4, False)):
            signals = bot.CallSignals()
            signals.last_audio = last_audio
            signals.push_frame = AsyncMock()
            async def one_beat(_):
                if signals.push_frame.await_count:
                    raise asyncio.CancelledError
            with patch.object(asyncio, "sleep", side_effect=one_beat), patch.object(time, "monotonic", return_value=10):
                with self.assertRaises(asyncio.CancelledError):
                    await signals._watch()
            self.assertEqual(signals.push_frame.await_args.args[0].message,
                             {"type": "audio-health", "receiving": expected})


class HerdTest(unittest.IsolatedAsyncioTestCase):
    """Sheprd's herd, talker and bubble messages, driving ClaudeSession's own methods without pipecat audio."""

    def session(self):
        session = bot.ClaudeSession(Mock())
        session.floor.wait = AsyncMock()
        session.floor.said = []
        session.push_frame = AsyncMock()
        session.broadcast_interruption = AsyncMock()
        session.create_task = Mock()
        return session

    def sent(self, session):
        return [c.args[0].message for c in session.push_frame.await_args_list
                if isinstance(c.args[0], bot.OutputTransportMessageUrgentFrame)]

    def queued(self, session):
        out = []
        while not session._speech.empty():
            out.append(session._speech.get_nowait())
        return out

    async def test_herd_and_speaker_reach_the_page(self):
        session = self.session()
        herd = [{"id": "w4:pCF", "name": "api", "title": "fix it", "status": "idle", "talk": True}]
        await session._desk_event({"ready": True})
        await session._desk_event({"herd": herd})
        await session._desk_event({"speaker": {"id": "w4:pCF", "name": "api"}})
        await session._desk_event({"speaker": None})
        await session._desk_event({"speaker": "w4:pCF"})  # malformed: the desk, already the talker
        self.assertEqual(self.sent(session), [{"type": "herd", "herd": herd},
                                              {"type": "speaker", "name": "api", "id": "w4:pCF"},
                                              {"type": "speaker", "name": None, "id": None}])
        self.assertTrue(session._speech.empty())

    async def test_talker_switch_is_atomic(self):
        session = self.session()
        for talker in ({"id": "w4:pCF", "name": "api"}, {"id": "w4:p2", "name": "web"}):
            session._current, session._ahead, session._upcoming = "Old playing.", "Old ahead.", "Old upcoming."
            session._started, session.floor.said = time.monotonic(), [1.0]
            session._held, session._taken = ["Old held."], (time.monotonic(), None, "")
            session._muted = time.monotonic()
            await session._desk_event({"text": "Old one. Old two."})
            session._speech.put_nowait("Old queued.")
            session.broadcast_interruption.reset_mock(); session.push_frame.reset_mock()
            await session._desk_event({"speaker": talker})
            session.broadcast_interruption.assert_awaited_once()
            self.assertEqual(self.queued(session), [], "a sentence of the old talker survived the switch")
            self.assertEqual((session._current, session._ahead, session._upcoming, session._held, session._taken,
                              session._muted, session.floor.said), (None, None, None, None, None, None, []))
            self.assertEqual(self.sent(session), [{"type": "say-stop"}, {"type": "speaker", **talker}])
            await session._desk_event({"text": "New words."})
            self.assertEqual(self.queued(session), ["New words."], "the new talker's sentence was dropped")
        session.broadcast_interruption.reset_mock()
        await session._desk_event({"speaker": {"id": "w4:p2", "name": "web"}})  # the same talker again: no flush
        session.broadcast_interruption.assert_not_awaited()
        await session._desk_event({"speaker": None})  # nothing was playing: no interruption to send
        session.broadcast_interruption.assert_not_awaited()

    async def test_herd_notices_survive_a_talker_switch_in_order(self):
        session = self.session()
        session._current, session._started = "Old playing.", time.monotonic()
        session._ahead, session._upcoming = bot.Notice("one is done."), bot.Notice("two is done.")
        session._held = ["Old held.", bot.Notice("three needs you."), "Old held too."]
        session._taken = (time.monotonic(), None, "")
        for sentence in ("Old queued.", bot.Notice("four is idle."), "Old queued too."):
            session._speech.put_nowait(sentence)
        await session._desk_event({"speaker": {"id": "w4:pCF", "name": "api"}})
        left = self.queued(session)
        self.assertEqual(left, ["one is done.", "two is done.", "three needs you.", "four is idle."])
        self.assertTrue(all(isinstance(s, bot.Notice) for s in left))
        self.assertEqual((session._current, session._ahead, session._upcoming, session._held), (None, None, None, None))
        session.broadcast_interruption.assert_awaited_once()

    async def test_stale_stop_after_a_switch_does_not_end_the_new_talkers_sentence(self):
        session = self.session()
        session._current, session._started = "Old playing.", time.monotonic()
        await session._desk_event({"speaker": {"id": "w4:pCF", "name": "api"}})
        session._current = "New first."  # _speak pushed it before the cut audio's stop came back
        session.push_frame.reset_mock()
        await session.process_frame(bot.BotStoppedSpeakingFrame(), bot.FrameDirection.UPSTREAM)
        self.assertEqual(session._current, "New first.")
        await session.process_frame(bot.BotStartedSpeakingFrame(), bot.FrameDirection.UPSTREAM)
        await session.process_frame(bot.BotStoppedSpeakingFrame(), bot.FrameDirection.UPSTREAM)
        self.assertEqual(self.sent(session), [{"type": "say", "text": "New first.", "speaker": "api"},
                                              {"type": "said"}])
        self.assertEqual(session._heard, "New first.")

    async def test_bubble_starts_and_ends_with_the_voice(self):
        session = self.session()
        session._current = "Hello there."
        await session.process_frame(bot.BotStartedSpeakingFrame(), bot.FrameDirection.UPSTREAM)
        await session.process_frame(bot.BotStartedSpeakingFrame(), bot.FrameDirection.UPSTREAM)  # no second bubble
        await session.process_frame(bot.BotStoppedSpeakingFrame(), bot.FrameDirection.UPSTREAM)
        await session._desk_event({"speaker": {"id": "w4:pCF", "name": "api"}})
        session.push_frame.reset_mock()
        session._current = bot.Notice("web is done.")  # a herd notice is Sheprd's own voice, not the sheep's
        await session.process_frame(bot.BotStartedSpeakingFrame(), bot.FrameDirection.UPSTREAM)
        session._current = "From the sheep."
        session._started = None
        await session.process_frame(bot.BotStartedSpeakingFrame(), bot.FrameDirection.UPSTREAM)
        session._held, session._taken = [], (time.monotonic(), None, "")
        session._take = Mock()
        await session.process_frame(bot.InterruptionFrame(), bot.FrameDirection.DOWNSTREAM)
        self.assertEqual(self.sent(session), [{"type": "say", "text": "web is done.", "speaker": None},
                                              {"type": "say", "text": "From the sheep.", "speaker": "api"},
                                              {"type": "say-stop", "heard": ""}])

    async def test_cut_in_keeps_the_rest_of_the_reply_on_the_page(self):
        """He cuts in mid-sentence: say-stop carries the words he heard (the note's count), and once his turn goes to
        the desk the rest of that sentence, the held desk sentences and the desk text dropped while muted reach the
        page as "unspoken"; held herd notices are still spoken, not pasted."""
        session = self.session()
        session._current = "One two three four."
        await session.process_frame(bot.BotStartedSpeakingFrame(), bot.FrameDirection.UPSTREAM)
        session.floor.said = [2.0]
        session._started = time.monotonic() - 1.0  # half the sentence's audio played before he started talking
        session._held, session._taken = ["Held desk.", bot.Notice("api is done.")], (time.monotonic(), None, "")
        session._take = Mock()
        session.push_frame.reset_mock()
        await session.process_frame(bot.InterruptionFrame(), bot.FrameDirection.DOWNSTREAM)
        self.assertEqual(self.sent(session), [{"type": "say-stop", "heard": "One two"}])
        session._pending = ["Wait."]
        session.push_frame.reset_mock()
        await session._flush_turn()
        self.assertEqual(self.sent(session), [{"type": "unspoken", "text": "three four. Held desk."},
                                              {"type": "heard", "text": "Wait."}])
        self.assertIn('then "One two…" of "One two three four."', session._turns.get_nowait())
        self.assertEqual(self.queued(session), ["api is done."])
        session.push_frame.reset_mock()
        await session._desk_event({"text": "Late desk. More late."})  # written before the desk read his turn
        self.assertEqual(self.sent(session), [{"type": "unspoken", "text": "Late desk. More late."}])
        self.assertTrue(session._speech.empty())
        await session._desk_event({"prompt": True})
        session.push_frame.reset_mock()
        await session._desk_event({"text": "The answer."})
        self.assertEqual(self.sent(session), [])
        self.assertEqual(self.queued(session), ["The answer."])
        session._pending = ["Nothing cut."]  # a turn with nothing cut or held sends no unspoken
        session.push_frame.reset_mock()
        await session._flush_turn()
        self.assertEqual(self.sent(session), [{"type": "heard", "text": "Nothing cut."}])

    async def test_reveal_sends_the_rest_of_the_reply(self):
        """A tap on the speaking box ({"type": "reveal"}): the page gets every sentence of the reply the voice has not
        reached (not the one already on the page, not herd notices), then later desk sentences as they are queued,
        until the reply is read out or he takes the floor. The speech queue is untouched."""
        session = self.session()
        await session._desk_event({"text": "One is playing. Two is ahead. Three waits. Four waits too."})
        session._current = self.queued(session)[0]  # _speak pushed One; it plays, Two is synthesized ahead
        await session.process_frame(bot.BotStartedSpeakingFrame(), bot.FrameDirection.UPSTREAM)
        session._ahead = "Two is ahead."
        for sentence in ("Three waits.", bot.Notice("api is done."), "Four waits too."):
            session._speech.put_nowait(sentence)
        session.push_frame.reset_mock()
        await session.reveal()
        self.assertEqual(self.sent(session), [{"type": "reveal", "sentences": ["Two is ahead.", "Three waits.", "Four waits too."]}])
        self.assertEqual(self.queued(session), ["Three waits.", "api is done.", "Four waits too."], "reveal changed the speech queue")
        session.push_frame.reset_mock()
        await session._desk_event({"text": "Five came later."})
        self.assertEqual(self.sent(session), [{"type": "reveal", "sentences": ["Five came later."]}])
        self.assertEqual(self.queued(session), ["Five came later."])
        session._current, session._ahead, session._started = "Five came later.", None, None  # pushed, not yet voiced
        session.push_frame.reset_mock()
        await session.reveal()
        self.assertEqual(self.sent(session), [{"type": "reveal", "sentences": ["Five came later."]}], "an unvoiced current sentence is sent too")
        await session.process_frame(bot.BotStartedSpeakingFrame(), bot.FrameDirection.UPSTREAM)
        await session.process_frame(bot.BotStoppedSpeakingFrame(), bot.FrameDirection.UPSTREAM)  # read out: reveal ends
        session.push_frame.reset_mock()
        await session._desk_event({"text": "A new reply."})
        self.assertEqual(self.sent(session), [], "the next reply was revealed without a tap")
        session._held = []  # he has the floor: held sentences are not revealed
        await session.reveal()
        await session._desk_event({"text": "Held one."})
        self.assertEqual(self.sent(session), [])

    async def test_bubble_messages_before_the_switch(self):
        session = self.session()
        session._current = "Hello there."
        await session.process_frame(bot.BotStartedSpeakingFrame(), bot.FrameDirection.UPSTREAM)
        await session.process_frame(bot.BotStartedSpeakingFrame(), bot.FrameDirection.UPSTREAM)
        await session.process_frame(bot.BotStoppedSpeakingFrame(), bot.FrameDirection.UPSTREAM)
        await session.process_frame(bot.BotStoppedSpeakingFrame(), bot.FrameDirection.UPSTREAM)  # nothing playing
        self.assertEqual(self.sent(session), [{"type": "say", "text": "Hello there.", "speaker": None},
                                              {"type": "said"}])

    async def test_herd_notice_waits_on_the_floor_and_survives_his_turn(self):
        session = self.session()
        session._held = ["Desk sentence."]
        await session._desk_event({"herd_say": "api is done."})
        await session._desk_event({"text": "More desk."})
        self.assertEqual(session._held, ["Desk sentence.", "api is done.", "More desk."])
        self.assertIsInstance(session._held[1], bot.Notice)
        self.assertTrue(session._speech.empty(), "a notice was queued while he had the floor")
        session._pending = ["Yes do it."]
        await session._flush_turn()
        self.assertTrue(session._turns.get_nowait().endswith("Yes do it."))
        self.assertEqual(self.queued(session), ["api is done."], "the held notice was not spoken after his turn")
        await session._desk_event({"text": "Stale desk text."})  # _muted: the desk has not read his turn yet
        await session._desk_event({"herd_say": "web needs you."})
        self.assertEqual(self.queued(session), ["web needs you."])
        await session._desk_event({"herd_say": " ... "})
        self.assertTrue(session._speech.empty())

    async def test_open_sheep_goes_with_every_turn(self):
        """The page's {"type": "context"} message sets the sheep he has open; each /turn carries it (screen-aware)."""
        posts = []

        class Reply:
            status = 202
            async def __aenter__(self): return self
            async def __aexit__(self, *exc): return False

        class Client:
            def __init__(self, timeout=None): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *exc): return False
            def post(self, url, json, headers):
                assert headers == {"X-Sheprd": "1"}, headers  # the bridge refuses a call without it
                posts.append((url, json)); return Reply()

        fake = types.SimpleNamespace(ClientSession=Client, ClientTimeout=lambda total: None, ClientError=OSError)
        session = self.session()
        with patch.dict(bot.ClaudeSession._turn.__globals__, {"aiohttp": fake, "DESK_URL": "http://desk"}):
            await session._turn("hi")
            self.assertTrue(session.set_context({"type": "context", "sheep": "w4:pCF"}))
            await session._turn("is this one done?")
            for bad in ({"type": "context", "sheep": "../x"}, {"type": "context", "sheep": 4}, {"type": "context"},
                        {"type": "herd", "sheep": "w4:p2"}, "context", None):
                self.assertFalse(session.set_context(bad), bad)  # dropped: the open sheep stays
            await session._turn("and now?")
            self.assertTrue(session.set_context({"type": "context", "sheep": None}))  # the panel closed
            await session._turn("back")
        self.assertEqual(posts, [("http://desk/turn", {"text": "hi", "context": {"sheep": None}}),
                                 ("http://desk/turn", {"text": "is this one done?", "context": {"sheep": "w4:pCF"}}),
                                 ("http://desk/turn", {"text": "and now?", "context": {"sheep": "w4:pCF"}}),
                                 ("http://desk/turn", {"text": "back", "context": {"sheep": None}})])
        self.assertTrue(session._speech.empty())  # every turn reached the desk

    async def test_ready_after_a_reconnect_returns_to_the_desk(self):
        session = self.session()
        await session._desk_event({"speaker": {"id": "w4:pCF", "name": "api"}})
        session.push_frame.reset_mock()
        await session._desk_event({"ready": True})  # a fresh stream sends a speaker line only when a sheep is seated
        self.assertEqual(self.sent(session), [{"type": "speaker", "name": None, "id": None}])
        await session._desk_event({"ready": True})
        self.assertEqual(len(self.sent(session)), 1)


class AssetRouteTest(unittest.TestCase):
    """GET /sheprd/{name} serves the world's own files and the vendored Phaser by an allowlist; anything else is 404.
    Runs _with_call_page's real route function with fastapi's response classes stubbed (stdlib only)."""

    def handler(self, here=Path(__file__).parent):  # `here`: the tree the route serves from (bot.py's own by default)
        source = Path(__file__).parent
        tree = ast.parse((source / "bot.py").read_text())
        node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "_with_call_page")

        class Reply:
            def __init__(self, path=None, status_code=200, headers=None, **_):
                self.path, self.status_code, self.headers = (Path(path) if path else None), status_code, headers or {}

        responses = types.ModuleType("fastapi.responses")
        responses.FileResponse = responses.Response = responses.PlainTextResponse = Reply
        fastapi = types.ModuleType("fastapi")
        fastapi.responses = responses
        stub = types.SimpleNamespace(add_routes=lambda *a, **k: None, Guard="Guard")
        cors = types.ModuleType("fastapi.middleware.cors")
        cors.CORSMiddleware = type("CORSMiddleware", (), {})
        handlers = {}

        class App:
            user_middleware = [types.SimpleNamespace(cls=cors.CORSMiddleware), types.SimpleNamespace(cls="Other")]

            def add_middleware(self, cls):
                self.user_middleware = self.user_middleware + [types.SimpleNamespace(cls=cls)]

            def get(self, path, **_):
                def deco(fn):
                    handlers[path] = fn
                    return fn
                return deco

        namespace = dict(Path=Path, re=re, __file__=str(here / "bot.py"), media_transcript=None, DESK_URL="", InUse="InUse")
        app = App()
        with patch.dict(sys.modules, {"fastapi": fastapi, "fastapi.responses": responses, "fastapi.middleware.cors": cors,
                                      "media": stub, "shown": stub}):
            exec(compile(ast.Module(body=[node], type_ignores=[]), "bot.py", "exec"), namespace)
            namespace["_with_call_page"](lambda app: None)(app)
        self.middleware = [m.cls for m in app.user_middleware]
        self.games = handlers["/sheprd/games/{name}"]
        return here, handlers["/sheprd/{name}"]

    def test_no_cors_and_the_guard(self):
        """The runner's allow-all CORS is gone (the page is same-origin) and shown.Guard wraps the whole app, InUse
        (the restart helper's in-use answer) inside it."""
        self.handler()
        self.assertEqual(self.middleware, ["Other", "InUse", "Guard"])

    def test_allowlist(self):
        here, handler = self.handler()
        serve = lambda name: asyncio.run(handler(name))
        phaser = serve("phaser-4.2.1.min.js")
        self.assertEqual((phaser.status_code, phaser.path), (200, here / "vendor" / "phaser-4.2.1.min.js"))
        self.assertEqual(phaser.headers["Cache-Control"], "public, max-age=31536000, immutable")
        for name in ("px.js", "font.js", "tiles.js", "sprites.js", "portraits.js", "world.js"):
            reply = serve(name)
            self.assertEqual((reply.status_code, reply.path), (200, here / "world" / name), name)
            self.assertEqual(reply.headers["Cache-Control"], "no-cache", name)
        for name in ("../bot.py", "world/x.js", "vendor/other.js", "bot.py", "call.html", "nope.js", "index.html",
                     "preview.cjs", "phaser-LICENSE.md", "", "..", "world.js/", "WORLD.JS", "px.js\n"):
            self.assertEqual(serve(name).status_code, 404, repr(name))
        game = lambda name: asyncio.run(self.games(name))
        for name in ("run.js", "flap.js"):
            self.assertEqual((game(name).status_code, game(name).path), (200, here / "world" / "games" / name), name)
            self.assertEqual(game(name).headers["Cache-Control"], "no-cache", name)
        for name in ("../px.js", "px.js", "nope.js", "games.js", "", "RUN.JS", "run.js/"):
            self.assertEqual(game(name).status_code, 404, repr(name))

    def test_symlinks_and_escapes_are_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "world").mkdir()
            (root / "vendor").mkdir()
            (root / "secret.txt").write_text("private")
            (root / "world" / "real.js").write_text("// real")
            (root / "world" / "link.js").symlink_to(root / "secret.txt")  # a link out of the tree
            (root / "world" / "alias.js").symlink_to(root / "world" / "real.js")  # a link inside it: still refused
            (root / "vendor" / "phaser-4.2.1.min.js").symlink_to(root / "secret.txt")
            _, handler = self.handler(root)
            serve = lambda name: asyncio.run(handler(name))
            self.assertEqual((serve("real.js").status_code, serve("real.js").path), (200, root / "world" / "real.js"))
            for name in ("link.js", "alias.js", "phaser-4.2.1.min.js"):
                self.assertEqual(serve(name).status_code, 404, name)


if __name__ == "__main__":
    unittest.main()
