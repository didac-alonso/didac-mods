"""dev-relay against a pretend cluster: squeue, sbatch, srun, scancel and herdr
answered from memory, on a clock that only moves when the script sleeps.

    python3 -I -m unittest discover -s plugins/dev-relay/tests -v
"""

from __future__ import annotations

import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
import re
import tempfile
import unittest
from pathlib import Path

BIN = Path(__file__).resolve().parent.parent / "bin" / "dev-relay"
T0 = 1_800_000_000.0  # the pretend "now"


def load():
    loader = importlib.machinery.SourceFileLoader("dev_relay", str(BIN))
    spec = importlib.util.spec_from_loader("dev_relay", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def stamp(ts: float | None) -> str:
    import time
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(ts)) if ts else "N/A"


class World:
    """Jobs, one herdr server per job, and every command the script ran."""

    def __init__(self, mod, me: str | None):
        self.mod = mod
        self.t = T0
        self.me = me
        self.jobs: dict[str, dict] = {}
        self.servers: dict[str, dict] = {}
        self.ran: list[list[str]] = []
        self.envs: list[dict] = []
        self.next_id = 500
        self.on_sleep = None  # scenario hook, called with the clock after each sleep
        self.where: list[str] = []  # the job an `srun dev-relay peek|release` is running in
        self.trust: set[str] = set()  # panes where a resumed Claude stops at the folder-trust question

    # jobs and servers
    def job(self, jid: str, state="RUNNING", node="c0001", comment="", start=None, end=None):
        self.jobs[jid] = {"state": state, "node": node, "comment": comment, "start": start, "end": end}

    def server(self, jid: str, agents=(), panes=None, up=True):
        agents = [dict(a) for a in agents]
        panes = panes if panes is not None else [{"pane_id": a["pane_id"], "workspace_id": a["pane_id"].split(":")[0],
                                                  "cwd": a.get("cwd", "/w"), "agent_status": a["agent_status"]} for a in agents]
        self.servers[jid] = {"up": up, "agents": agents, "panes": [dict(p) for p in panes], "stopped": False,
                             "prompts": [], "keys": [], "started": [], "screens": {}}

    def answer(self, pane: str, yes: bool):
        """The person answers the folder-trust question in that pane of this job's herdr."""
        s = self.servers[self.me]
        s["screens"][pane] = "❯ "
        if yes:
            for a in s["agents"]:
                if a["pane_id"] == pane:
                    a["agent_status"] = "idle"
        else:
            s["agents"] = [a for a in s["agents"] if a["pane_id"] != pane]

    # the seams
    def now(self):
        return self.t

    def sleep(self, s):
        self.t += s
        if self.on_sleep:
            self.on_sleep(self)

    def spawn(self, argv, env):
        self.ran.append(["<spawn>", *argv])
        self.envs.append(env)
        prev = next((j for j, s in self.servers.items() if s["stopped"]), None)
        # herdr restores the layout it saved: the same panes, shells only
        panes = [dict(p, agent_status="unknown") for p in (self.servers[prev]["panes"] if prev else [])]
        self.server(self.me, panes=panes)

    def run(self, argv, timeout=60, env=None):
        self.ran.append(list(argv))
        self.envs.append(env or {})
        return self.dispatch(list(argv), self.where[-1] if self.where else self.me)

    def dispatch(self, argv, where):
        cmd = argv[0]
        if cmd == "squeue":
            return self.squeue(argv)
        if cmd == "sbatch":
            jid = str(self.next_id)
            self.next_id += 1
            comment = next((a.split("=", 1)[1] for a in argv if a.startswith("--comment=")), "")
            self.job(jid, state="PENDING", node=None, comment=comment)
            return 0, f"{jid}\n", ""
        if cmd == "scancel":
            self.jobs.pop(argv[1], None)
            return 0, "", ""
        if cmd == "srun":
            target = next(a.split("=", 1)[1] for a in argv if a.startswith("--jobid="))
            rest = argv[argv.index("-n1") + 1:]
            return self.dispatch(rest, target)
        if cmd == "pkill":
            return 1, "", ""
        if argv[1:2] and argv[1].endswith("dev-relay"):
            # the script itself, on that job's node
            self.where.append(where)
            out = io.StringIO()
            try:
                with contextlib.redirect_stdout(out):
                    rc = self.mod.main(argv[1:])
            finally:
                self.where.pop()
            return rc, out.getvalue(), ""
        if cmd == "herdr":
            return self.herdr(argv[3:] if argv[1:2] == ["--session"] else argv[1:], where)
        return 127, "", f"unknown {cmd}"

    def squeue(self, argv):
        if "-j" in argv:
            ids = [argv[argv.index("-j") + 1]]
        else:
            ids = list(self.jobs)
        out = []
        for jid in ids:
            j = self.jobs.get(jid)
            if not j:
                continue
            out.append("|".join([jid, j["state"], j["node"] or "(Priority)", j["comment"] or "(null)", stamp(j["start"]), stamp(j["end"])]))
        return 0, "\n".join(out) + ("\n" if out else ""), ""

    def herdr(self, args, where):
        s = self.servers.get(where)
        if not s or not s["up"]:
            return 1, "", '{"error":{"code":"server_unreachable"}}'
        ok = lambda result: (0, json.dumps({"result": result}), "")
        if args[:2] == ["agent", "list"]:
            return ok({"agents": [{"agent": "claude", "agent_session": {"value": a["id"]}, "pane_id": a["pane_id"],
                                   "workspace_id": a["pane_id"].split(":")[0], "tab_id": None, "cwd": a.get("cwd", "/w"),
                                   "agent_status": a["agent_status"], **({"name": a["name"]} if a.get("name") else {})} for a in s["agents"]]})
        if args[:2] == ["pane", "list"]:
            return ok({"panes": s["panes"]})
        if args[:2] == ["pane", "process-info"]:
            pane = args[args.index("--pane") + 1]
            busy = next((p.get("busy") for p in s["panes"] if p["pane_id"] == pane), None)
            return ok({"process_info": {"shell_pid": 1, "foreground_process_group_id": 2 if busy else 1,
                                        "foreground_processes": [{"cmdline": busy or "zsh"}]}})
        if args[:2] == ["workspace", "list"]:
            return ok({"workspaces": []})
        if args[:2] == ["agent", "send-keys"]:
            s["keys"].append((args[2], args[3]))
            for a in s["agents"]:
                if a["pane_id"] == args[2]:
                    a["agent_status"] = "idle"
            return ok({})
        if args[:2] == ["server", "stop"]:
            s["up"], s["stopped"] = False, True
            return ok({})
        if args[:2] == ["agent", "start"]:
            pane = args[args.index("--pane") + 1]
            sid = args[args.index("--resume") + 1]
            s["started"].append((args[2], pane, sid))
            blocked = pane in self.trust
            s["agents"].append({"id": sid, "pane_id": pane, "agent_status": "blocked" if blocked else "idle"})
            for p in s["panes"]:
                if p["pane_id"] == pane:
                    p["agent_status"] = "idle"
            if blocked:
                s["screens"][pane] = " Quick safety check: Is this a project you created or one you trust?\n ❯ No, exit\n   Yes, I trust this folder\n"
                return 1, "", '{"error":{"code":"agent_not_ready","message":"blocked during startup"}}'
            return ok({"agent": {}})
        if args[:2] == ["agent", "read"]:
            return 0, s["screens"].get(args[2], ""), ""
        if args[:2] == ["agent", "get"]:
            a = next((a for a in s["agents"] if a["pane_id"] == args[2]), None)
            if not a:
                return 1, "", '{"error":{"code":"agent_not_found"}}'
            return ok({"agent": {"agent": "claude", "agent_status": a["agent_status"], "pane_id": a["pane_id"]}})
        if args[:2] == ["agent", "rename"]:
            return ok({})
        if args[:2] == ["agent", "prompt"]:
            s["prompts"].append((args[2], args[3]))
            return ok({})
        if args[:2] in (["tab", "create"], ["workspace", "create"]):
            ws = args[args.index("--workspace") + 1] if "--workspace" in args else "w9"
            pane = f"{ws}:p{len(s['panes']) + 10}"
            s["panes"].append({"pane_id": pane, "workspace_id": ws, "cwd": args[args.index("--cwd") + 1], "agent_status": "unknown"})
            return ok({"root_pane": {"pane_id": pane}})
        return 2, "", f"unhandled herdr {args}"


class Base(unittest.TestCase):
    me = "200"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.mod = load()
        self.mod.CFG.update(STATE_DIR=str(root / "state"), CONFIG_DIR=str(root / "config"), HERDR_SESSION="", CARD="0",
                            LEAD="120", WINDOW="60", FORCE="10", POLL="30", GRACE="180", FRESH="20", JOB_NAME="dev-shell", SBATCH="/x.sbatch")
        self.w = World(self.mod, self.me)
        self.mod.now, self.mod.sleep, self.mod.run, self.mod.spawn_server = self.w.now, self.w.sleep, self.w.run, self.w.spawn
        self.mod.own_job = lambda: self.w.me
        self.mod.hostname = lambda: "cNEW"
        self.mod.log = lambda msg: None
        self.cards: list[dict] = []
        self.mod.post = self.cards.append
        self.state = root / "state"
        self.config = root / "config"
        self.config.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def herdr_calls(self, verb):
        return [a for a in self.w.ran if "herdr" in a and verb in " ".join(a)]


class ParseTest(Base):
    def test_squeue_fields(self):
        jobs = self.mod.parse_squeue("11|RUNNING|c0677|(null)|2026-10-27T17:36:52|2026-10-29T17:36:52\n"
                                     "12|PENDING|(Priority)|relay-of:11|N/A|N/A\n")
        self.assertEqual(jobs[0]["node"], "c0677")
        self.assertEqual(jobs[0]["comment"], "")
        self.assertAlmostEqual(jobs[0]["end"] - jobs[0]["start"], 2 * 86400)
        self.assertEqual(jobs[1], {"job": "12", "state": "PENDING", "node": None, "comment": "relay-of:11", "start": None, "end": None})

    def test_session_json(self):
        home = Path(self.tmp.name) / "home"
        (home / ".config" / "herdr").mkdir(parents=True)
        (home / ".config" / "herdr" / "session.json").write_text(json.dumps({"workspaces": [{
            "id": "w8", "public_pane_numbers": {"1": 1, "2": 2},
            "tabs": [{"panes": {"1": {"cwd": "/a"}}}, {"panes": {"2": {"cwd": "/h", "agent_session": {"agent": "claude", "value": "sid-2"}}}}]}]}))
        self.mod.HOME = home
        self.assertEqual(self.mod.session_json_sessions(),
                         [{"id": "sid-2", "pane": "w8:p2", "workspace": "w8", "tab": None, "cwd": "/h", "name": None, "status": "unknown"}])

    def test_env_scrub(self):
        os.environ.update(CLAUDE_CODE_CHILD_SESSION="1", HERDR_SOCKET_PATH="/s", HERDR_CONFIG_PATH="/c.toml", SLURM_JOB_ID="9", DEV_RELAY_X="keep")
        try:
            env = self.mod.clean_env(DEV_RELAY_PREV="7")
            self.assertNotIn("CLAUDE_CODE_CHILD_SESSION", env)
            self.assertNotIn("HERDR_SOCKET_PATH", env)
            self.assertEqual(env["HERDR_CONFIG_PATH"], "/c.toml")
            self.assertNotIn("SLURM_JOB_ID", env)
            self.assertEqual(env["DEV_RELAY_PREV"], "7")
            self.assertEqual(env["DEV_RELAY_X"], "keep")
            self.assertEqual(self.mod.clean_env(keep_slurm=True)["SLURM_JOB_ID"], "9")
        finally:
            for k in ("CLAUDE_CODE_CHILD_SESSION", "HERDR_SOCKET_PATH", "HERDR_CONFIG_PATH", "SLURM_JOB_ID", "DEV_RELAY_X"):
                os.environ.pop(k, None)


class ServerConfigTest(Base):
    def merged(self, text):
        src = Path(self.tmp.name) / "herdr.toml"
        src.write_text(text)
        os.environ["HERDR_CONFIG_PATH"] = str(src)
        try:
            return self.mod.server_config().read_text()
        finally:
            os.environ.pop("HERDR_CONFIG_PATH")

    def test_appends_a_session_table(self):
        out = self.merged('onboarding = false\n\n[theme]\nname = "catppuccin"\n')
        self.assertTrue(out.endswith("[session]\nresume_agents_on_restore = false\n"))
        self.assertIn('name = "catppuccin"', out)

    def test_overrides_inside_an_existing_one(self):
        out = self.merged('[session]\nresume_agents_on_restore = true\nother = 1\n[[keys.command]]\nkey = "x"\n')
        self.assertEqual(out.count("[session]"), 1)
        self.assertNotIn("= true", out)
        self.assertLess(out.index("resume_agents_on_restore = false"), out.index("[[keys.command]]"))
        self.assertIn('[[keys.command]]\nkey = "x"', out)


class SuperviseTest(Base):
    me = "100"

    def setUp(self):
        super().setUp()
        self.end = T0 + 3 * 3600
        self.w.job("100", start=T0 - 40 * 3600, end=self.end, node="cOLD")
        self.w.server("100", agents=[{"id": "s1", "pane_id": "w1:p1", "agent_status": "idle"}])
        self.info = self.mod.job_info("100")

    def test_waits_for_the_lead(self):
        st = self.mod.supervise_once("100", self.info, {})
        self.assertEqual(st["phase"], "running")
        self.assertFalse([a for a in self.w.ran if a[0] == "sbatch"])
        self.assertEqual(st["agents"][0]["id"], "s1")
        self.assertEqual(json.loads((self.state / "jobs" / "100.json").read_text())["phase"], "running")

    def test_submits_once_at_the_lead(self):
        os.environ["CLAUDE_CODE_CHILD_SESSION"] = "1"
        try:
            self.w.t = self.end - 119 * 60
            st = self.mod.supervise_once("100", self.info, {})
        finally:
            os.environ.pop("CLAUDE_CODE_CHILD_SESSION")
        sb = [(a, e) for a, e in zip(self.w.ran, self.w.envs) if a[0] == "sbatch"]
        self.assertEqual(len(sb), 1)
        self.assertIn("--comment=relay-of:100", sb[0][0])
        self.assertEqual(sb[0][1]["DEV_RELAY_PREV"], "100")
        self.assertNotIn("CLAUDE_CODE_CHILD_SESSION", sb[0][1])
        self.assertEqual(st["phase"], "queued")
        self.mod.supervise_once("100", self.info, st)
        self.assertEqual(len([a for a in self.w.ran if a[0] == "sbatch"]), 1)

    def test_a_successor_that_lost_its_comment_is_still_the_successor(self):
        self.w.t = self.end - 119 * 60
        st = self.mod.supervise_once("100", self.info, {})
        jid = st["successor"]["job"]
        self.w.jobs[jid]["comment"] = "***TEST_COMMENT***"      # what an scontrol update leaves here
        st = self.mod.supervise_once("100", self.info, st)
        self.assertEqual(st["successor"]["job"], jid)
        self.assertEqual(len([a for a in self.w.ran if a[0] == "sbatch"]), 1)

    def test_off_holds_and_cancels(self):
        self.w.t = self.end - 60 * 60
        (self.config / "off").touch()
        st = self.mod.supervise_once("100", self.info, {})
        self.assertEqual(st["phase"], "off")
        self.assertFalse([a for a in self.w.ran if a[0] == "sbatch"])
        self.w.job("501", state="PENDING", node=None, comment="relay-of:100")
        self.mod.supervise_once("100", self.info, st)
        self.assertIn(["scancel", "501"], self.w.ran)

    def test_now_submits_early(self):
        (self.config / "now-100").touch()
        st = self.mod.supervise_once("100", self.info, {})
        self.assertEqual(st["phase"], "queued")

    def test_restarts_a_dead_herdr_and_resumes(self):
        st = self.mod.supervise_once("100", self.info, {})
        self.w.servers["100"]["up"] = False
        self.w.servers["100"]["stopped"] = True
        st = self.mod.supervise_once("100", self.info, st)
        self.assertEqual(st["serverMisses"], 1)            # one miss is not yet a death
        st = self.mod.supervise_once("100", self.info, st)
        self.assertEqual(st["serverMisses"], 0)
        spawns = [(a, e) for a, e in zip(self.w.ran, self.w.envs) if a[0] == "<spawn>"]
        self.assertEqual(len(spawns), 1)
        self.assertTrue(spawns[0][1]["HERDR_CONFIG_PATH"].endswith("herdr-config.toml"))
        self.assertEqual([(p, sid) for _, p, sid in self.w.servers["100"]["started"]], [("w1:p1", "s1")])

    def test_no_restart_while_moving(self):
        self.w.job("501", state="RUNNING", node="cNEW", comment="relay-of:100", start=T0)
        self.mod.write_json(self.state / "relays" / "501.json", {"phase": "switching", "from": {"job": "100"}})
        self.w.servers["100"]["up"] = False
        st = self.mod.supervise_once("100", self.info, {"serverMisses": 5})
        self.assertFalse([a for a in self.w.ran if a[0] == "<spawn>"])
        self.assertEqual(st["phase"], "moving")

    def test_ready_then_moving(self):
        self.w.job("501", state="RUNNING", node="cNEW", comment="relay-of:100", start=T0)
        self.assertEqual(self.mod.supervise_once("100", self.info, {})["phase"], "ready")
        self.mod.write_json(self.state / "relays" / "501.json", {"phase": "switching", "from": {"job": "100"}})
        self.assertEqual(self.mod.supervise_once("100", self.info, {})["phase"], "moving")


class TakeoverTest(Base):
    me = "200"

    def setUp(self):
        super().setUp()
        self.end = T0 + 3 * 3600
        self.w.job("100", start=T0 - 45 * 3600, end=self.end, node="cOLD")
        self.w.job("200", start=T0, end=T0 + 48 * 3600, node="cNEW", comment="relay-of:100")
        self.mod.write_active("100")

    def relay(self):
        return json.loads((self.state / "relays" / "200.json").read_text())

    def test_moves_when_idle_in_the_window(self):
        self.w.server("100", agents=[{"id": "s1", "pane_id": "w1:p1", "agent_status": "idle", "cwd": "/a"},
                                     {"id": "s2", "pane_id": "w1:p2", "agent_status": "done", "cwd": "/b", "name": "reviewer"}],
                      panes=None)
        self.w.servers["100"]["panes"].append({"pane_id": "w1:p3", "workspace_id": "w1", "cwd": "/c", "agent_status": "unknown", "busy": "python train.py"})
        self.assertEqual(self.mod.takeover("100"), "moved")
        self.assertGreaterEqual(self.w.t, self.end - 60 * 60)   # not before the window
        self.assertLess(self.w.t, self.end - 59 * 60)
        old, new = self.w.servers["100"], self.w.servers["200"]
        self.assertTrue(old["stopped"])
        self.assertEqual(old["keys"], [])                       # nobody was interrupted
        self.assertEqual(sorted((p, s) for _, p, s in new["started"]), [("w1:p1", "s1"), ("w1:p2", "s2")])
        self.assertIn(("reviewer", "w1:p2", "s2"), new["started"])
        self.assertEqual(new["prompts"], [])                    # idle sessions only come back
        self.assertNotIn("100", self.w.jobs)                    # cancelled
        self.assertEqual(self.mod.read_active(), "200")
        rel = self.relay()
        self.assertEqual(rel["phase"], "done")
        self.assertFalse(rel["forced"])
        self.assertEqual(rel["cut"], [{"pane": "w1:p3", "cwd": "/c", "command": "python train.py"}])
        stop = next(i for i, a in enumerate(self.w.ran) if "stop" in a)
        cancel = self.w.ran.index(["scancel", "100"])
        spawn = next(i for i, a in enumerate(self.w.ran) if a[0] == "<spawn>")
        self.assertLess(stop, cancel)                           # never two servers at once:
        self.assertLess(cancel, spawn)                          # the old job is gone first

    def test_forced_with_esc_and_carry_on(self):
        self.w.server("100", agents=[{"id": "s1", "pane_id": "w1:p1", "agent_status": "working", "cwd": "/a"},
                                     {"id": "s2", "pane_id": "w1:p2", "agent_status": "idle", "cwd": "/b"}])
        self.assertEqual(self.mod.takeover("100"), "moved")
        self.assertGreaterEqual(self.w.t, self.end - 10 * 60)
        self.assertEqual(self.w.servers["100"]["keys"], [("w1:p1", "esc")])
        rel = self.relay()
        self.assertTrue(rel["forced"])
        s1 = next(s for s in rel["sessions"] if s["id"] == "s1")
        s2 = next(s for s in rel["sessions"] if s["id"] == "s2")
        self.assertEqual(s1["continue"], "herdr")                # no mod claimed it
        self.assertNotIn("continue", s2)
        prompts = self.w.servers["200"]["prompts"]
        self.assertEqual([p for p, _ in prompts], ["w1:p1"])
        self.assertIn("cOLD (job 100) to cNEW (job 200", prompts[0][1])

    def test_mod_claim_wins(self):
        self.w.server("100", agents=[{"id": "s1", "pane_id": "w1:p1", "agent_status": "working"}])

        def claim(w):
            rel = self.state / "relays" / "200.json"
            if rel.exists() and json.loads(rel.read_text()).get("phase") == "resumed":
                (self.state / "claims").mkdir(exist_ok=True)
                (self.state / "claims" / "200-s1").write_text(self.said)
        self.w.on_sleep = claim
        self.said = "sent"
        self.mod.takeover("100")
        self.assertEqual(self.w.servers["200"]["prompts"], [])
        self.assertEqual(self.relay()["sessions"][0]["continue"], "mod")

    def test_failed_claim_falls_back(self):
        self.w.server("100", agents=[{"id": "s1", "pane_id": "w1:p1", "agent_status": "working"}])
        self.said = "failed"
        self.w.on_sleep = lambda w: ((self.state / "claims").mkdir(exist_ok=True), (self.state / "claims" / "200-s1").write_text("failed"))
        self.mod.takeover("100")
        self.assertEqual(len(self.w.servers["200"]["prompts"]), 1)
        self.assertEqual(self.relay()["sessions"][0]["continue"], "herdr")

    def test_silence_is_not_idleness(self):
        # herdr there does not answer (a failed srun): wait for the deadline, then go with the snapshot
        self.w.server("100", up=False)
        self.mod.write_json(self.state / "jobs" / "100.json", {"job": "100", "node": "cOLD", "agentsAt": self.end - 15 * 60,
                            "agents": [{"id": "s1", "pane": "w1:p1", "workspace": "w1", "cwd": "/a", "status": "working", "name": None}]})
        self.w.servers["100"]["panes"] = [{"pane_id": "w1:p1", "workspace_id": "w1", "cwd": "/a", "agent_status": "unknown"}]
        self.assertEqual(self.mod.takeover("100"), "moved")
        self.assertGreaterEqual(self.w.t, self.end - 10 * 60)
        rel = self.relay()
        self.assertTrue(rel["forced"])
        self.assertEqual(rel["sessions"][0]["resumed"], "ok")

    def test_carry_on_says_the_esc_was_ours(self):
        self.w.server("100", agents=[{"id": "s1", "pane_id": "w1:p1", "agent_status": "working"}])
        self.mod.takeover("100")
        text = self.w.servers["200"]["prompts"][0][1]
        self.assertIn("that was the move, not the user", text)

    def test_now_flag_moves_at_once(self):
        self.w.server("100", agents=[{"id": "s1", "pane_id": "w1:p1", "agent_status": "working"}])
        (self.config / "now-100").touch()
        self.mod.takeover("100")
        self.assertLess(self.w.t, T0 + 600)
        self.assertFalse((self.config / "now-100").exists())

    def test_missing_pane_gets_a_tab(self):
        self.w.server("100", agents=[{"id": "s1", "pane_id": "w1:p1", "agent_status": "idle", "cwd": "/a"}])
        self.w.servers["100"]["panes"] = [{"pane_id": "w1:p5", "workspace_id": "w1", "cwd": "/z", "agent_status": "unknown"}]
        self.mod.takeover("100")
        started = self.w.servers["200"]["started"]
        self.assertEqual(len(started), 1)
        self.assertNotEqual(started[0][1], "w1:p5")
        self.assertTrue(self.herdr_calls("tab create"))

    def test_prev_gone_uses_the_snapshot(self):
        self.w.server("100", up=False)
        self.mod.write_json(self.state / "jobs" / "100.json", {"job": "100", "node": "cOLD", "agentsAt": T0 - 60,
                            "agents": [{"id": "s1", "pane": "w1:p1", "workspace": "w1", "cwd": "/a", "status": "working", "name": None}]})
        self.w.servers["100"]["panes"] = [{"pane_id": "w1:p1", "workspace_id": "w1", "cwd": "/a", "agent_status": "unknown"}]
        self.w.servers["100"]["stopped"] = True
        del self.w.jobs["100"]
        self.assertEqual(self.mod.takeover("100"), "gone")
        self.mod.fresh_start("100")
        rel = self.relay()
        self.assertEqual(rel["from"], {"job": "100", "node": "cOLD"})
        self.assertEqual(rel["sessions"][0]["resumed"], "ok")
        self.assertEqual(rel["sessions"][0]["continue"], "herdr")

    def test_off_ends_the_successor(self):
        (self.config / "off").touch()
        self.w.server("100", agents=[])
        self.assertEqual(self.mod.takeover("100"), "off")


class AdoptTest(Base):
    me = None

    def test_queues_a_held_successor_and_arms_the_state(self):
        end = T0 + 30 * 3600
        self.w.job("100", start=T0 - 18 * 3600, end=end, node="c0677")
        self.assertEqual(self.mod.adopt("100"), 0)
        sb = next(a for a in self.w.ran if a[0] == "sbatch")
        import time
        self.assertIn(f"--begin={time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(end - 120 * 60))}", sb)
        self.assertIn("--comment=relay-of:100", sb)
        self.assertEqual(self.mod.read_active(), "100")
        j = json.loads((self.state / "jobs" / "100.json").read_text())
        self.assertTrue(j["adopted"])
        self.assertEqual(j["phase"], "queued")
        self.assertEqual(self.mod.adopt("100"), 0)                 # twice: still one successor
        self.assertEqual(len([a for a in self.w.ran if a[0] == "sbatch"]), 1)

    def test_its_successor_keeps_the_state_current(self):
        self.w.me = "200"
        self.w.job("100", start=T0 - 45 * 3600, end=T0 + 3 * 3600, node="c0677")
        self.w.job("200", start=T0, end=T0 + 48 * 3600, node="cNEW", comment="relay-of:100")
        self.w.server("100", agents=[{"id": "s1", "pane_id": "w1:p1", "agent_status": "idle"}])
        self.mod.write_json(self.state / "jobs" / "100.json", {"job": "100", "phase": "queued", "adopted": True, "updatedAt": T0 - 3600})
        seen = []
        self.w.on_sleep = lambda w: seen.append(json.loads((self.state / "jobs" / "100.json").read_text())["phase"])
        self.mod.takeover("100")
        self.assertIn("ready", seen)
        j = json.loads((self.state / "jobs" / "100.json").read_text())
        self.assertEqual(j["phase"], "moving")
        self.assertEqual(j["agents"][0]["id"], "s1")


class TrustTest(Base):
    """A resumed session stopped at "do you trust this folder?": the person answers, never dev-relay."""
    me = "200"

    def setUp(self):
        super().setUp()
        self.end = T0 + 3 * 3600
        self.w.job("100", start=T0 - 45 * 3600, end=self.end, node="cOLD")
        self.w.job("200", start=T0, end=T0 + 48 * 3600, node="cNEW", comment="relay-of:100")
        self.mod.CFG["CARD"] = "1"
        self.mod.user_here = lambda: True          # the trust card goes even so
        self.w.trust.add("w8:p2")
        self.w.server("100", agents=[{"id": "sess-busy-1", "pane_id": "w8:p2", "agent_status": "working", "cwd": str(self.mod.HOME)},
                                     {"id": "sess-idle-2", "pane_id": "w8:p1", "agent_status": "idle", "cwd": "/projects/p"}])
        (self.config / "now-100").touch()

    def relay(self):
        return json.loads((self.state / "relays" / "200.json").read_text())

    def session(self, sid):
        return next(s for s in self.relay()["sessions"] if s["id"] == sid)

    def tend(self):
        self.mod.supervise_once("200", self.mod.job_info("200"), {})

    def test_stuck_session_waits_and_the_person_gets_a_card(self):
        self.mod.takeover("100")
        busy = self.session("sess-busy-1")
        self.assertEqual(busy["resumed"], "trust")
        self.assertEqual(busy["continue"], "pending")          # not sent into the question
        self.assertEqual(self.session("sess-idle-2")["resumed"], "ok")
        new = self.w.servers["200"]
        self.assertEqual(new["keys"], [])                        # dev-relay answers nothing
        self.assertEqual(new["prompts"], [])
        trust = [c for c in self.cards if "confías" in c["title"]]
        self.assertEqual(len(trust), 1)
        self.assertIn("`w8:p2`", trust[0]["description"])
        self.assertIn("`~`", trust[0]["description"])
        self.assertIn("«sigue»", trust[0]["description"])
        self.tend()                                              # still unanswered: nothing moves
        self.assertEqual(self.session("sess-busy-1")["resumed"], "trust")

    def test_carry_on_after_the_person_trusts_it(self):
        self.mod.takeover("100")
        self.w.answer("w8:p2", yes=True)
        self.tend()
        busy = self.session("sess-busy-1")
        self.assertEqual(busy["resumed"], "ok")
        self.assertEqual(busy["continue"], "pending")           # the mod's minute
        self.w.t += self.mod.TRUST_GRACE + 1
        self.tend()
        self.assertEqual(self.session("sess-busy-1")["continue"], "herdr")
        self.assertEqual([p for p, _ in self.w.servers["200"]["prompts"]], ["w8:p2"])

    def test_the_mods_claim_wins_after_trust(self):
        self.mod.takeover("100")
        self.w.answer("w8:p2", yes=True)
        (self.state / "claims").mkdir(exist_ok=True)
        (self.state / "claims" / "200-sess-busy-1").write_text("sent\n")
        self.tend()
        self.w.t += self.mod.TRUST_GRACE + 1
        self.tend()
        self.assertEqual(self.session("sess-busy-1")["continue"], "mod")
        self.assertEqual(self.w.servers["200"]["prompts"], [])

    def test_no_exit_is_respected(self):
        self.mod.takeover("100")
        self.w.answer("w8:p2", yes=False)
        self.tend()
        busy = self.session("sess-busy-1")
        self.assertEqual(busy["resumed"], "declined")
        self.assertEqual(busy["continue"], "skipped")
        self.w.t += 3600
        self.tend()
        self.assertEqual(self.w.servers["200"]["prompts"], [])

    def test_an_idle_session_only_needs_the_answer(self):
        self.w.trust = {"w8:p1"}
        self.mod.takeover("100")
        self.assertEqual(self.session("sess-idle-2")["resumed"], "trust")
        self.w.answer("w8:p1", yes=True)
        self.tend()
        self.w.t += 3600
        self.tend()
        self.assertEqual(self.session("sess-idle-2")["resumed"], "ok")
        self.assertNotIn("continue", self.session("sess-idle-2"))
        self.assertEqual([p for p, _ in self.w.servers["200"]["prompts"]], ["w8:p2"])   # only the busy one, at once

    def test_status_names_the_waiting_pane(self):
        self.mod.takeover("100")
        self.tend()
        text = self.mod.status_text(json.loads((self.state / "jobs" / "200.json").read_text()), self.relay())
        self.assertIn("waiting for you to trust their folder: sess-bus in pane w8:p2", text)


class CurrentTest(Base):
    me = None

    def test_live_pointer(self):
        self.w.job("100", start=T0 - 10, end=T0 + 3600)
        self.w.job("501", start=T0, end=T0 + 9000, comment="relay-of:100")
        self.mod.write_active("100")
        self.assertEqual(self.mod.current(180), "100")
        self.assertEqual(self.w.t, T0)

    def test_queued_successor_is_never_picked(self):
        self.w.job("100", start=T0 - 10, end=T0 + 3600)
        self.w.job("501", state="PENDING", node=None, comment="relay-of:100")
        self.mod.write_active("100")
        self.assertEqual(self.mod.current(180), "100")

    def test_waits_through_a_move(self):
        self.w.job("100", start=T0 - 10, end=T0 + 3600)
        self.w.job("501", start=T0, end=T0 + 9000, comment="relay-of:100")
        self.mod.write_active("100")
        self.mod.write_json(self.state / "relays" / "501.json", {"phase": "switching", "from": {"job": "100"}})

        def done(w):
            if w.t >= T0 + 20:
                self.mod.write_active("501")
        self.w.on_sleep = done
        self.assertEqual(self.mod.current(180), "501")

    def test_stale_pointer_falls_back_to_newest(self):
        self.w.job("300", start=T0 - 100, end=T0 + 3600)
        self.mod.write_active("100")
        self.assertEqual(self.mod.current(1800), "300")
        self.assertLessEqual(self.w.t - T0, 93)

    def test_nothing(self):
        self.assertIsNone(self.mod.current(180))

    def test_ensure_submits_one_and_waits_for_its_server(self):
        def starts(w):
            j = w.jobs.get("500")
            if j and w.t >= T0 + 60:
                j.update(state="RUNNING", node="c0042", start=T0 + 60)
            if j and w.t >= T0 + 70:
                self.mod.write_active("500")
        self.w.on_sleep = starts
        self.assertEqual(self.mod.ensure(0), "500")
        self.assertEqual(len([a for a in self.w.ran if a[0] == "sbatch"]), 1)
        self.assertFalse((self.state / "ensure.lock.d").exists())
        self.assertEqual(self.mod.ensure(0), "500")      # a second client finds it
        self.assertEqual(len([a for a in self.w.ran if a[0] == "sbatch"]), 1)

    def test_run_refuses_a_second_live_shell(self):
        self.w.me = "300"
        self.w.job("100", start=T0 - 10, end=T0 + 3600)
        self.w.job("300", start=T0, end=T0 + 9000)
        self.mod.write_active("100")
        os.environ.pop("DEV_RELAY_PREV", None)
        self.mod.cmd_run()
        self.assertIn(["scancel", "300"], self.w.ran)
        self.assertEqual(self.mod.read_active(), "100")


if __name__ == "__main__":
    unittest.main()
