"""Scheduled runs. Windows Task Scheduler starts `ColSift.exe --run "<setup>"` at the
times chosen; that run has no window, works the saved setup as the Run button would
(parameters such as {PERIOD} worked out on the day) and leaves a log.

    create({setup, kind, time, days, day, notify})   kind: daily | weekdays | weekly | monthly
    listing()                                the ColSift tasks, with next and last run
    delete(name) / run_now(name) / repair(name)      repair: point a task at this ColSift
    history(setup=None)                      the runs logged, newest first
    news() / mark_seen()                     the runs since the window last showed them
    notify(title, text, open_path)           a Windows notification (--notify)

Tasks live in Task Scheduler's ColSift folder and run as the person who made them,
while they are signed in; one the PC was off for runs when it is back on.
"""

from __future__ import annotations

import json
import re
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from xml.sax.saxutils import escape

import winps

FOLDER = "ColSift"
KINDS = ("daily", "weekdays", "weekly", "monthly")
DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]
_DAY_XML = dict(zip(DAYS, ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]))
_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
           "October", "November", "December"]
HERE = Path(__file__).resolve().parent
NEVER_RAN, RUNNING = 0x41303, 0x41301
LIMIT_HOURS = 12


def task_name(setup: str) -> str:
    """Task Scheduler refuses \\ / : * ? \" < > | in a name."""
    return re.sub(r'[\\/:*?"<>|]+', "_", str(setup or "")).strip(" .") or "setup"


def launcher() -> tuple[str, list[str]]:
    """What starts ColSift: the exe itself, or Python with app.py when run from source."""
    if getattr(sys, "frozen", False) or "__compiled__" in globals():
        # a onefile exe runs from its unpack folder: argv[0] is the ColSift.exe people keep
        for cand in (sys.argv[0], sys.executable):
            p = Path(cand)
            if p.suffix.lower() == ".exe" and p.is_file():
                return str(p.resolve()), []
        return sys.executable, []
    exe = Path(sys.executable)
    quiet = exe.with_name("pythonw.exe")          # no console window on Windows
    return str(quiet if quiet.exists() else exe), [str(HERE / "app.py")]


def _quote(s: str) -> str:
    return f'"{s}"'


def arguments(setup: str, sets: dict | None = None, notify: bool = False) -> str:
    _, pre = launcher()
    parts = [_quote(x) for x in pre] + ["--run", _quote(setup)]
    for k, v in (sets or {}).items():
        parts += ["--set", _quote(f"{k}={v}")]
    return " ".join(parts + (["--notify"] if notify else []))


def parse_arguments(args: str) -> dict:
    """What a task's arguments ask for: {setup, sets, notify}."""
    sets = dict(kv.partition("=")[::2] for kv in re.findall(r'--set\s+"([^"]*)"', args or ""))
    return {"setup": setup_of(args), "sets": sets, "notify": "--notify" in (args or "")}


def _check(p: dict) -> tuple[str, str, list[str], str]:
    setup = str(p.get("setup") or "").strip()
    if not setup:
        raise ValueError("Save the setup first — a schedule runs a saved setup.")
    if '"' in setup:
        raise ValueError("A setup name with a double quote can't be scheduled — rename it.")
    kind = p.get("kind") or "daily"
    if kind not in KINDS:
        raise ValueError(f"How often: one of {', '.join(KINDS)}.")
    m = re.fullmatch(r"([01]?\d|2[0-3]):([0-5]\d)", str(p.get("time") or "").strip())
    if not m:
        raise ValueError("The time is HH:MM, 24-hour — e.g. 07:30.")
    days = [d.upper()[:3] for d in p.get("days") or []]
    if kind == "weekly":
        days = [d for d in DAYS if d in days]
        if not days:
            raise ValueError("Pick the day(s) of the week.")
    day = str(p.get("day") or "1").strip().lower()
    if kind == "monthly" and day != "last" and not (day.isdigit() and 1 <= int(day) <= 31):
        raise ValueError("Day of the month: 1 to 31, or last.")
    return setup, kind, days, f"{int(m.group(1)):02d}:{m.group(2)}" + ("|" + day if kind == "monthly" else "")


def describe(p: dict) -> str:
    """'weekdays at 07:30' — said back to the person and kept as the task's description."""
    setup, kind, days, when = _check(p)
    time, _, day = when.partition("|")
    if kind == "daily":
        return f"every day at {time}"
    if kind == "weekdays":
        return f"Monday to Friday at {time}"
    if kind == "weekly":
        return f"every {', '.join(_DAY_XML[d] for d in days)} at {time}"
    return f"on the {'last day' if day == 'last' else _ordinal(int(day))} of every month at {time}"


def _ordinal(n: int) -> str:
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def task_xml(p: dict, today: datetime | None = None) -> str:
    """The task, as Task Scheduler's XML: one calendar trigger, no window, runs when the
    PC comes back if it was off, on battery too, stopped after LIMIT_HOURS."""
    setup, kind, days, when = _check(p)
    time, _, day = when.partition("|")
    start = (today or datetime.now()).strftime("%Y-%m-%d") + f"T{time}:00"
    if kind == "daily":
        sched = "<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>"
    elif kind in ("weekdays", "weekly"):
        pick = DAYS[:5] if kind == "weekdays" else days
        sched = ("<ScheduleByWeek><DaysOfWeek>" + "".join(f"<{_DAY_XML[d]} />" for d in pick)
                 + "</DaysOfWeek><WeeksInterval>1</WeeksInterval></ScheduleByWeek>")
    else:
        sched = (f"<ScheduleByMonth><DaysOfMonth><Day>{'Last' if day == 'last' else int(day)}</Day></DaysOfMonth><Months>"
                 + "".join(f"<{m} />" for m in _MONTHS) + "</Months></ScheduleByMonth>")
    exe, _ = launcher()
    desc = f"ColSift runs the setup “{setup}” {describe(p)}. Logs: {runs_dir()}"
    return f"""<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>{escape(desc)}</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>{start}</StartBoundary>
      <Enabled>true</Enabled>
      {sched}
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT{LIMIT_HOURS}H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{escape(exe)}</Command>
      <Arguments>{escape(arguments(setup, p.get("sets"), bool(p.get("notify"))))}</Arguments>
      <WorkingDirectory>{escape(str(Path(exe).parent))}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"""


def _tn(name: str) -> str:
    return f"\\{FOLDER}\\{task_name(name)}"


def create(p: dict) -> dict:
    try:
        xml = task_xml(p)
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    with tempfile.NamedTemporaryFile("wb", suffix=".xml", delete=False) as fh:
        fh.write(xml.encode("utf-16"))
        path = fh.name
    try:
        r = winps.command(["schtasks", "/Create", "/F", "/TN", _tn(p["setup"]), "/XML", path], "Scheduling")
    finally:
        Path(path).unlink(missing_ok=True)
    if not r["ok"]:
        return r
    return {"ok": True, "name": task_name(p["setup"]), "when": describe(p)}


def delete(name: str) -> dict:
    return winps.command(["schtasks", "/Delete", "/F", "/TN", _tn(name)], "Scheduling")


def run_now(name: str) -> dict:
    return winps.command(["schtasks", "/Run", "/TN", _tn(name)], "Scheduling")


_LIST = r"""
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$tasks = @(Get-ScheduledTask -TaskPath '\__FOLDER__\' -ErrorAction SilentlyContinue)
$out = @(foreach ($t in $tasks) {
  $i = $t | Get-ScheduledTaskInfo
  $a = @($t.Actions)[0]
  [ordered]@{ name = $t.TaskName; state = "$($t.State)"; description = "$($t.Description)";
              exe = "$($a.Execute)"; args = "$($a.Arguments)"; result = [int64]$i.LastTaskResult;
              next = $(if ($i.NextRunTime) { $i.NextRunTime.ToString('yyyy-MM-dd HH:mm') } else { '' });
              last = $(if ($i.LastRunTime -and $i.LastRunTime.Year -gt 2000) { $i.LastRunTime.ToString('yyyy-MM-dd HH:mm') } else { '' }) }
})
[ordered]@{ ok = $true; tasks = $out } | ConvertTo-Json -Depth 4 -Compress
""".replace("__FOLDER__", FOLDER)


_REPAIR = r"""
$ErrorActionPreference = 'Stop'
$new = New-ScheduledTaskAction -Execute $exe -Argument $arg -WorkingDirectory $dir
Set-ScheduledTask -TaskPath '\__FOLDER__\' -TaskName $name -Action $new | Out-Null
'{"ok": true}'
""".replace("__FOLDER__", FOLDER)


def repair(name: str, args: str) -> dict:
    """Point a task at this ColSift (moved, or a copy elsewhere), keeping its schedule."""
    a = parse_arguments(args)
    if not a["setup"]:
        return {"ok": False, "error": "That task was not made by ColSift."}
    exe, _ = launcher()
    head = (f"$name = {winps.ps_quote(task_name(name))}\n$exe = {winps.ps_quote(exe)}\n"
            f"$dir = {winps.ps_quote(str(Path(exe).parent))}\n$arg = {winps.ps_quote(arguments(a['setup'], a['sets'], a['notify']))}\n")
    return winps.powershell(head + _REPAIR, "Scheduling", 120)


def same_exe(a: str, b: str) -> bool:
    norm = lambda x: str(x or "").strip().strip('"').replace("/", "\\").lower()  # noqa: E731
    return norm(a) == norm(b)


def setup_of(args: str) -> str:
    m = re.search(r'--run\s+"([^"]*)"', args or "")
    return m.group(1) if m else ""


def result_text(code: int | None, last: str) -> str:
    if not last or code == NEVER_RAN:
        return "not run yet"
    if code == RUNNING:
        return "running now"
    return {0: "finished", 1: "failed", 3: "stopped by a check"}.get(code, f"ended with code {code}")


def listing() -> dict:
    r = winps.powershell(_LIST, "Scheduling", 120)
    if not r.get("ok"):
        return r
    tasks = r.get("tasks") or []
    tasks = tasks if isinstance(tasks, list) else [tasks]
    here, _ = launcher()
    for t in tasks:
        t["setup"] = setup_of(t.get("args"))
        t["notify"] = "--notify" in (t.get("args") or "")
        t["moved"] = bool(t["setup"]) and not same_exe(t.get("exe"), here)
        t["status"] = result_text(t.get("result"), t.get("last"))
        when = re.search(r"” (.*?)\. Logs:", t.get("description") or "")
        t["when"] = when.group(1) if when else ""
    return {"ok": True, "tasks": sorted(tasks, key=lambda t: t["name"].lower())}


# ---- the run log -----------------------------------------------------------------
def runs_dir() -> Path:
    import engine as E
    d = E.profile_dir() / "runs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def log_run(entry: dict) -> None:
    with open(runs_dir() / "history.jsonl", "a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, default=str) + "\n")


def history(setup: str | None = None, limit: int = 50) -> dict:
    f = runs_dir() / "history.jsonl"
    rows = []
    if f.exists():
        for line in f.read_text(encoding="utf-8").splitlines():
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if setup is None or e.get("setup") == setup:
                rows.append(e)
    return {"ok": True, "runs": rows[::-1][:limit], "folder": str(runs_dir())}


def news() -> dict:
    """Runs since the window last showed them (none the first time: no backlog)."""
    seen = runs_dir() / "seen.txt"
    if not seen.exists():
        mark_seen()
        return {"ok": True, "runs": []}
    mark = seen.read_text(encoding="utf-8").strip()
    return {"ok": True, "runs": [r for r in history(limit=100)["runs"] if str(r.get("start") or "") > mark]}


def mark_seen() -> dict:
    newest = next(iter(history(limit=1)["runs"]), {}).get("start") or datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    (runs_dir() / "seen.txt").write_text(str(newest), encoding="utf-8")
    return {"ok": True}


# ---- a Windows notification when a scheduled run ends -------------------------------
_TOAST = r"""
$ErrorActionPreference = 'Stop'
$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($xml)
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($doc))
'{"ok": true}'
"""


def toast_xml(title: str, text: str, open_path: str | None = None) -> str:
    from xml.sax.saxutils import quoteattr
    launch = f" activationType=\"protocol\" launch={quoteattr(Path(open_path).resolve().as_uri())}" if open_path else ""
    return (f"<toast{launch}><visual><binding template=\"ToastGeneric\"><text>{escape(title)}</text>"
            f"<text>{escape(text)}</text></binding></visual></toast>")


def notify(title: str, text: str, open_path: str | None = None) -> dict:
    """Shown by Windows (as from Windows PowerShell); a click opens open_path."""
    return winps.powershell(f"$xml = {winps.ps_quote(toast_xml(title, text, open_path))}\n" + _TOAST, "A notification", 60)
