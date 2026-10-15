"""jobkit's Discord cards against a local fake webhook.

    python3 -I plugins/pace-line/tests/test_jobkit.py
"""

import http.server
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from email.parser import BytesParser
from email.policy import default
from pathlib import Path

TEMPLATES = Path(__file__).resolve().parent.parent / "templates"


class Hook(http.server.BaseHTTPRequestHandler):
    posts: list = []

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        msg = BytesParser(policy=default).parsebytes(b"Content-Type: " + self.headers["Content-Type"].encode() + b"\r\n\r\n" + body)
        parts = {p.get_param("name", header="content-disposition"): p for p in msg.iter_parts()}
        Hook.posts.append({"path": self.path, "ua": self.headers["User-Agent"], "parts": parts})
        out = b'{"id": "1"}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *args):
        pass


class Notify(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.HTTPServer(("127.0.0.1", 0), Hook)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.tmp = tempfile.TemporaryDirectory()
        cls.home = Path(cls.tmp.name) / "home"
        cls.work = Path(cls.tmp.name) / "work"
        cls.work.mkdir(parents=True)
        os.chdir(cls.work)
        # the fake webhook is local: past any proxy the environment sets
        os.environ.update({"HOME": str(cls.home), "SLURM_JOB_ID": "4242", "SLURM_JOB_NAME": "train", "no_proxy": "127.0.0.1", "NO_PROXY": "127.0.0.1"})
        os.environ.pop("RANK", None)
        os.environ.pop("SLURM_PROCID", None)
        os.environ["DISCORD_WEBHOOK_URL"] = f"http://127.0.0.1:{cls.server.server_port}/api/webhooks/1/secret"
        sys.path.insert(0, str(TEMPLATES))
        import jobkit

        jobkit._DROP = cls.home / ".claude" / "discord-drop"
        jobkit._DROP.mkdir(parents=True)
        cls.jobkit = jobkit

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        os.chdir("/")
        cls.tmp.cleanup()

    def setUp(self):
        Hook.posts.clear()
        (self.jobkit._DROP / "presence.json").unlink(missing_ok=True)
        (self.work / "runs" / "4242" / "notified.json").unlink(missing_ok=True)

    def here(self, minutes_ago: float):
        at = (time.time() - minutes_ago * 60) * 1000
        (self.jobkit._DROP / "presence.json").write_text(json.dumps({"sessions": {"s": {"lastUserAt": at, "host": "c0629"}}}))

    def embed(self):
        return json.loads(Hook.posts[-1]["parts"]["payload_json"].get_content())["embeds"][0]

    def test_away_sends_the_card_with_its_image_and_marks_the_run(self):
        png = self.work / "curve.png"
        png.write_bytes(b"\x89PNG fake")
        self.assertTrue(self.jobkit.notify("detr finished", "val mAP 43.0", fields=[("mAP", 43.0), ("baseline", 41.2)], image=png))
        post = Hook.posts[-1]
        self.assertEqual(post["path"], "/api/webhooks/1/secret?wait=true")
        self.assertIn("DiscordBot", post["ua"])
        self.assertEqual(post["parts"]["files[0]"].get_content(), b"\x89PNG fake")
        e = self.embed()
        self.assertEqual(e["color"], 0x2ECC71)
        self.assertEqual(e["title"], "✅ detr finished")
        self.assertEqual(e["image"], {"url": "attachment://curve.png"})
        self.assertEqual(e["author"]["name"], "train (4242)")
        names = [f["name"] for f in e["fields"]]
        self.assertEqual(names[:2], ["mAP", "baseline"])
        self.assertIn("command", names)
        self.assertEqual(e["fields"][0]["value"], "43")
        mark = json.loads((self.work / "runs" / "4242" / "notified.json").read_text())
        self.assertEqual((mark["sent"], mark["held"]), (True, False))

    def test_held_while_the_user_is_at_a_session_unless_forced(self):
        self.here(5)
        self.assertFalse(self.jobkit.notify("done", "x"))
        self.assertEqual(Hook.posts, [])
        self.assertTrue(json.loads((self.work / "runs" / "4242" / "notified.json").read_text())["held"])
        self.assertTrue(self.jobkit.notify("asked for", "x", force=True, repro=False))
        self.assertEqual(len(Hook.posts), 1)

    def test_away_after_the_configured_time(self):
        (self.jobkit._DROP / "config.json").write_text('{"awayMinutes": 10}')
        self.here(15)
        self.assertTrue(self.jobkit.notify("done", repro=False))
        (self.jobkit._DROP / "config.json").unlink()

    def test_only_rank_zero(self):
        os.environ["RANK"] = "1"
        try:
            self.assertFalse(self.jobkit.notify("done"))
        finally:
            os.environ.pop("RANK")
        self.assertEqual(Hook.posts, [])

    def test_a_failure_sends_the_log_tail_but_not_a_timeout(self):
        log = self.work / "runs" / "slurm-4242.out"
        log.parent.mkdir(exist_ok=True)
        log.write_text("step 10\nTraceback (most recent call last):\nRuntimeError: CUDA out of memory\n")
        self.assertFalse(self.jobkit.notify_exit(143))
        self.assertFalse(self.jobkit.notify_exit(0))
        self.assertEqual(Hook.posts, [])
        self.assertTrue(self.jobkit.notify_exit(1))
        e = self.embed()
        self.assertEqual(e["color"], 0xE74C3C)
        self.assertIn("exit 1", e["title"])
        self.assertIn("CUDA out of memory", e["description"])

    def test_no_webhook_never_raises(self):
        url = os.environ.pop("DISCORD_WEBHOOK_URL")
        try:
            self.assertFalse(self.jobkit.notify("done"))
        finally:
            os.environ["DISCORD_WEBHOOK_URL"] = url

    def test_missing_and_oversized_files_are_skipped(self):
        big = self.work / "big.bin"
        with open(big, "wb") as f:
            f.truncate(11 * 1024 * 1024)
        self.assertTrue(self.jobkit.notify("done", files=[big, self.work / "nope.png"], repro=False))
        self.assertNotIn("files[0]", Hook.posts[-1]["parts"])
        big.unlink()


if __name__ == "__main__":
    unittest.main(verbosity=2)
