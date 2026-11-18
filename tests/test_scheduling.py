"""Scheduled runs: the task Windows is given, and the headless run it starts."""

import json
import sys
import xml.etree.ElementTree as ET
from datetime import datetime

import openpyxl
import pytest

import engine as E
import scheduling as SC
import workspace as W

NS = {"t": "http://schemas.microsoft.com/windows/2004/02/mit/task"}


def parsed(p):
    return ET.fromstring(SC.task_xml(p, today=datetime(2026, 11, 18)).split("\n", 1)[1])


def test_names_windows_accepts():
    assert SC.task_name('Month end: "AED" / USD?') == "Month end_ _AED_ _ USD_"
    assert SC.task_name("  ") == "setup"


@pytest.mark.parametrize("p, says, sched", [
    ({"kind": "daily", "time": "7:05"}, "every day at 07:05", "ScheduleByDay"),
    ({"kind": "weekdays", "time": "06:30"}, "Monday to Friday at 06:30", "ScheduleByWeek"),
    ({"kind": "weekly", "time": "18:00", "days": ["fri", "MON"]}, "every Monday, Friday at 18:00", "ScheduleByWeek"),
    ({"kind": "monthly", "time": "08:00", "day": "2"}, "on the 2nd of every month at 08:00", "ScheduleByMonth"),
    ({"kind": "monthly", "time": "23:59", "day": "last"}, "on the last day of every month at 23:59", "ScheduleByMonth"),
])
def test_each_kind_of_schedule(p, says, sched):
    p = {"setup": "Month end", **p}
    assert SC.describe(p) == says
    t = parsed(p)
    trig = t.find("t:Triggers/t:CalendarTrigger", NS)
    assert trig.find("t:StartBoundary", NS).text == f"2026-11-18T{says[-5:]}:00"
    assert trig.find(f"t:{sched}", NS) is not None
    days = [d.tag.split("}")[1] for d in trig.findall(".//t:DaysOfWeek/*", NS)]
    if p["kind"] == "weekdays":
        assert days == ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
    if p["kind"] == "weekly":
        assert days == ["Monday", "Friday"]
    if p["kind"] == "monthly":
        assert trig.find(".//t:DaysOfMonth/t:Day", NS).text == ("Last" if p["day"] == "last" else "2")
        assert len(trig.findall(".//t:Months/*", NS)) == 12


def test_the_task_runs_the_saved_setup_quietly():
    t = parsed({"setup": "Tax & fees <AED>", "kind": "daily", "time": "07:00", "sets": {"PERIOD": "2026-10"}})
    exe, pre = SC.launcher()
    act = t.find("t:Actions/t:Exec", NS)
    assert act.find("t:Command", NS).text == exe
    assert act.find("t:Arguments", NS).text.endswith('--run "Tax & fees <AED>" --set "PERIOD=2026-10"')
    assert SC.setup_of(act.find("t:Arguments", NS).text) == "Tax & fees <AED>"
    st = t.find("t:Settings", NS)
    assert st.find("t:StartWhenAvailable", NS).text == "true"            # missed while off: runs when back
    assert st.find("t:DisallowStartIfOnBatteries", NS).text == "false"    # laptops
    assert st.find("t:MultipleInstancesPolicy", NS).text == "IgnoreNew"
    assert t.find("t:Principals/t:Principal/t:LogonType", NS).text == "InteractiveToken"
    assert "“Tax & fees <AED>” every day at 07:00" in t.find("t:RegistrationInfo/t:Description", NS).text
    if not getattr(sys, "frozen", False):
        assert pre and pre[0].endswith("app.py")


@pytest.mark.parametrize("p, err", [
    ({"kind": "daily", "time": "07:00"}, "Save the setup"),
    ({"setup": "A", "kind": "hourly", "time": "07:00"}, "How often"),
    ({"setup": "A", "kind": "daily", "time": "7pm"}, "HH:MM"),
    ({"setup": "A", "kind": "daily", "time": "24:00"}, "HH:MM"),
    ({"setup": "A", "kind": "weekly", "time": "07:00", "days": []}, "day(s) of the week"),
    ({"setup": "A", "kind": "monthly", "time": "07:00", "day": "32"}, "1 to 31"),
    ({"setup": 'say "hi"', "kind": "daily", "time": "07:00"}, "double quote"),
])
def test_what_is_refused(p, err):
    r = SC.create(p)
    assert r["ok"] is False and err in r["error"]


def test_create_hands_schtasks_the_xml(monkeypatch):
    seen = {}

    def cmd(args, what="", timeout=0):
        seen["args"] = args
        if "/XML" in args:
            seen["xml"] = open(args[-1], "rb").read().decode("utf-16")
        return {"ok": True, "out": "SUCCESS"}
    monkeypatch.setattr(SC.winps, "command", cmd)
    r = SC.create({"setup": "Month end", "kind": "weekdays", "time": "06:45"})
    assert r == {"ok": True, "name": "Month end", "when": "Monday to Friday at 06:45"}
    assert seen["args"][:5] == ["schtasks", "/Create", "/F", "/TN", "\\ColSift\\Month end"]
    assert seen["xml"].startswith('<?xml version="1.0" encoding="UTF-16"?>') and "<Monday />" in seen["xml"]
    SC.delete("Month end")
    assert seen["args"] == ["schtasks", "/Delete", "/F", "/TN", "\\ColSift\\Month end"]
    SC.run_now("Month end")
    assert seen["args"] == ["schtasks", "/Run", "/TN", "\\ColSift\\Month end"]


def test_elsewhere_than_windows_it_says_so(monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    assert "Windows" in SC.create({"setup": "A", "kind": "daily", "time": "07:00"})["error"]
    assert "Windows" in SC.listing()["error"]


def test_the_listing_reads_task_scheduler(monkeypatch):
    one = {"ok": True, "tasks": {"name": "Month end", "state": "Ready", "args": '"app.py" --run "Month end"', "result": 0x41303,
                                 "last": "", "next": "2026-11-19 07:00",
                                 "description": "ColSift runs the setup “Month end” every day at 07:00. Logs: C:\\x"}}
    monkeypatch.setattr(SC.winps, "powershell", lambda s, w, t: one)
    t = SC.listing()["tasks"]
    assert t == [{**one["tasks"], "setup": "Month end", "status": "not run yet", "when": "every day at 07:00"}]
    assert SC.result_text(3, "2026-11-18 07:00") == "stopped by a check" and SC.result_text(0, "x") == "finished"


def test_a_headless_run_works_the_saved_setup_and_logs_it(data):
    import app
    tmp, f = data
    ws = W.normalize({"name": "Month end", "folders": [str(tmp / "jan")],
                      "groups": [{"name": "Sales", "setup": {"columns": [{"name": "DOC_NO", "include": True},
                                                                         {"name": "TAX_CODE", "include": True}],
                                                             "filters": {"type": "group", "mode": "and", "children": [
                                                                 {"type": "rule", "column": "TAX_CODE", "op": "equals", "value": "{CODE}"}]}},
                                  "match": {"mode": "pattern", "value": "sales_*"}}],
                      "params": [{"name": "CODE", "mode": "fixed", "value": "YQ"}],
                      "output": {"folder": str(tmp / "out"), "format": "xlsx", "basename": "tax_{CODE}"}})
    E.save_profile("Month end", ws)
    code = app.headless_run(["--run", "Month end"])
    h = SC.history("Month end")["runs"]
    assert code == 0, open(h[0]["log"], encoding="utf-8").read()
    assert len(h) == 1 and h[0]["ok"] and h[0]["code"] == 0 and h[0]["written"], h
    out = h[0]["written"][0]
    rows = list(openpyxl.load_workbook(out).active.iter_rows(values_only=True))[1:]
    assert rows and {r[1] for r in rows} == {"YQ"}
    log = open(h[0]["log"], encoding="utf-8").read()
    assert "the setup “Month end”, started" in log and "finished" in log and "(exit code 0)" in log
    # a parameter given on the command line, and a setup that isn't there
    assert app.headless_run(["--run", "Month end", "--set", "CODE=XT"]) == 0
    assert app.headless_run(["--run", "Nope"]) == 2
    runs = SC.history()["runs"]
    assert [r["setup"] for r in runs] == ["Nope", "Month end", "Month end"]
    assert runs[1]["written"][0].endswith("tax_XT.xlsx") and runs[0]["ok"] is False
    assert "No setup named Nope" in open(runs[0]["log"], encoding="utf-8").read()
    assert app.headless_run(["--run"]) == 2
    assert all(json.dumps(r) for r in runs)


def test_notify_rides_in_the_arguments_and_comes_back_out():
    args = SC.arguments("Month end", {"PERIOD": "2026-10"}, notify=True)
    assert args.endswith('--run "Month end" --set "PERIOD=2026-10" --notify')
    assert SC.parse_arguments(args) == {"setup": "Month end", "sets": {"PERIOD": "2026-10"}, "notify": True}
    t = parsed({"setup": "Month end", "kind": "daily", "time": "07:00", "notify": True})
    assert t.find("t:Actions/t:Exec/t:Arguments", NS).text.endswith("--notify")
    x = SC.toast_xml("ColSift — A&B", "Failed <oops>", "/tmp/a b.log")
    assert 'launch="file:///tmp/a%20b.log"' in x and "A&amp;B" in x and "&lt;oops&gt;" in x
    ET.fromstring(x)                                                      # well-formed


def test_a_task_that_starts_another_copy_is_noticed_and_repaired(monkeypatch):
    exe, _ = SC.launcher()
    old = {"name": "Month end", "exe": r"D:\old\ColSift.exe", "args": '--run "Month end" --notify', "result": 0, "last": "x"}
    same = {"name": "Daily", "exe": exe.upper(), "args": SC.arguments("Daily"), "result": 0, "last": "x"}
    seen = {}

    def ps(script, what, timeout):
        seen.setdefault("scripts", []).append(script)
        return {"ok": True, "tasks": [old, same]}
    monkeypatch.setattr(SC.winps, "powershell", ps)
    t = {x["name"]: x for x in SC.listing()["tasks"]}
    assert t["Month end"]["moved"] is True and t["Month end"]["notify"] is True
    assert t["Daily"]["moved"] is False
    assert SC.repair("Month end", old["args"])["ok"]
    head = seen["scripts"][-1].splitlines()
    assert head[0] == "$name = 'Month end'" and head[1] == f"$exe = '{exe}'"
    assert head[3].startswith("$arg = ") and head[3].endswith('--run "Month end" --notify\'')
    assert "Set-ScheduledTask" in seen["scripts"][-1]
    assert SC.repair("x", "--something")["ok"] is False


def test_news_is_what_ran_since_the_window_last_looked(monkeypatch):
    assert SC.news()["runs"] == []                                        # first time: no backlog
    SC.log_run({"setup": "A", "start": "2999-01-01 07:00:00", "ok": True})
    SC.log_run({"setup": "B", "start": "2999-01-01 08:00:00", "ok": False})
    assert [r["setup"] for r in SC.news()["runs"]] == ["B", "A"]
    SC.mark_seen()
    assert SC.news()["runs"] == []
    SC.log_run({"setup": "C", "start": "2999-01-02 07:00:00", "ok": True})
    assert [r["setup"] for r in SC.news()["runs"]] == ["C"]


def test_a_run_with_notify_tells_windows(data, monkeypatch):
    import app
    tmp, f = data
    told = []
    monkeypatch.setattr(SC, "notify", lambda title, text, path: told.append((title, text, path)) or {"ok": True})
    E.save_profile("Quick", W.normalize({"name": "Quick", "folders": [str(tmp / "jan")],
                                         "groups": [{"name": "S", "match": {"mode": "pattern", "value": "sales_*"},
                                                     "setup": {"columns": [{"name": "DOC_NO", "include": True}]}}],
                                         "output": {"folder": str(tmp / "q"), "format": "csv", "basename": "q"}}))
    assert app.headless_run(["--run", "Quick", "--notify"]) == 0
    assert app.headless_run(["--run", "Missing", "--notify"]) == 2
    assert told[0][0] == "ColSift — Quick" and told[0][1] == "Finished — 1 file written." and told[0][2].endswith(".log")
    assert told[1][1].startswith("Failed:") and "click for the log" in told[1][1]
    runs = SC.history()["runs"]
    assert runs[0]["notified"] is True and runs[1]["notified"] is True
    assert app.headless_run(["--run", "Quick"]) == 0 and len(told) == 2  # no --notify, no notification
    assert "notified" not in SC.history()["runs"][0]
