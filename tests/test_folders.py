"""A saved setup meets the folders that are open now: no stale files, folders per group."""

from __future__ import annotations

import shutil
from pathlib import Path

import openpyxl

import engine as E
import workspace as W
from conftest import cols, write_sales


def two_groups(f) -> dict:
    return W.normalize({"groups": [
        {"name": "Sales", "files": [str(f["jan"]), str(f["feb"])], "setup": {"columns": cols("DOC_NO", "AMOUNT")}},
        {"name": "Codes", "files": [str(f["codes"])], "setup": {"columns": cols("TAX_CODE", "DESCRIPTION")}},
    ]})


def test_loading_a_setup_never_adds_files_that_are_not_listed(data):
    tmp, f = data
    ws = two_groups(f)
    listed = W.list_files([str(f["feb"].parent)])          # only February's folder is open
    r = W.rebind(ws, listed)
    sales, codes = r["workspace"]["groups"]
    assert sales["files"] == [str(f["feb"])]
    assert codes["files"] == []
    assert r["dropped"] == {"Sales": ["sales_JAN.csv"], "Codes": ["codes.xlsx"]}
    assert all(p in listed for g in r["workspace"]["groups"] for p in g["files"])


def test_a_setup_copied_to_another_folder_follows_the_file_names(data):
    tmp, f = data
    copy = tmp / "copy"
    shutil.copytree(f["feb"].parent, copy)
    r = W.rebind(two_groups(f), W.list_files([str(copy)]))
    assert r["workspace"]["groups"][0]["files"] == [str(copy / "sales_FEB.csv")] and r["moved"] == 1


def test_adding_a_folder_later_brings_back_what_the_setup_held(data):
    tmp, f = data
    ws = two_groups(f)
    saved = {g["id"]: list(g["files"]) for g in ws["groups"]}
    first = W.rebind(ws, W.list_files([str(f["feb"].parent)]), saved)["workspace"]
    both = W.rebind(first, W.list_files([str(f["feb"].parent), str(f["jan"].parent)]), saved)["workspace"]
    assert set(both["groups"][0]["files"]) == {str(f["jan"]), str(f["feb"])}
    assert both["groups"][1]["files"] == [str(f["codes"])]


def test_rule_groups_are_resorted_over_the_listed_files_only(data):
    tmp, f = data
    ws = two_groups(f)
    ws["groups"][0]["match"] = {"mode": "pattern", "value": "sales_*"}
    r = W.rebind(ws, W.list_files([str(f["feb"].parent)]))
    assert r["workspace"]["groups"][0]["files"] == [str(f["feb"])]


def test_a_folder_assigned_to_a_group_is_read_as_it_stands_at_run_time(data):
    tmp, f = data
    ws = two_groups(f)
    ws["groups"][0].update(files=[], folders=[str(f["jan"].parent), str(f["feb"].parent)],
                           match={"mode": "pattern", "value": "sales_*"})
    ws["groups"][1].update(folders=[str(f["jan"].parent)], match={"mode": "ext", "value": ".xlsx"})
    ws["output"] = {"folder": str(tmp / "out"), "basename": "m", "format": "xlsx"}
    write_sales(f["feb"].parent / "sales_MAR.csv", 3)          # arrives after the setup was made
    got = W.expand_folders(ws)
    assert {Path(p).name for p in got["groups"][0]["files"]} == {"sales_JAN.csv", "sales_FEB.csv", "sales_MAR.csv"}
    assert [Path(p).name for p in got["groups"][1]["files"]] == ["codes.xlsx"]
    r = W.run_setup(ws)
    assert r["ok"], r
    wb = openpyxl.load_workbook(r["written"][0])
    assert wb["Sales"].max_row == 1 + 36 * 3


def test_folder_files_belong_to_their_group_before_any_rule(data):
    tmp, f = data
    ws = two_groups(f)
    ws["groups"][0].update(files=[], match={"mode": "ext", "value": ".csv;.xlsx"})
    ws["groups"][1].update(files=[], folders=[str(f["jan"].parent)], match={"mode": "manual"})
    listed = W.list_files([str(f["jan"].parent), str(f["feb"].parent)])
    g = W.auto_group(ws, listed, replace=True)["workspace"]["groups"]
    assert sorted(Path(p).name for p in g[1]["files"]) == ["codes.xlsx", "sales_JAN.csv"]
    assert [Path(p).name for p in g[0]["files"]] == ["sales_FEB.csv"]


def test_cli_folder_replaces_the_saved_files(data):
    tmp, f = data
    ws = two_groups(f)
    ws["output"] = {"folder": str(tmp / "o"), "basename": "m", "format": "xlsx"}
    E.save_profile("Two", ws)
    assert E._cli(["--profile", "Two", "--folder", str(f["jan"].parent)]) == 0
    wb = openpyxl.load_workbook(tmp / "o" / "m.xlsx")
    assert {r[0][:2] for r in list(wb["Sales"].iter_rows(values_only=True))[1:]} == {"E1"}


def test_list_folders_tags_each_file_with_its_folder_once(data):
    tmp, f = data
    r = W.list_folders([str(f["jan"].parent), {"path": str(tmp), "recursive": True}, str(tmp / "nope")])
    by = {}
    for x in r["files"]:
        by.setdefault(x["folder"], []).append(x["name"])
    assert sorted(by[str(f["jan"].parent)]) == ["codes.xlsx", "sales_JAN.csv"]
    assert sorted(by[str(tmp)]) == ["refunds_FEB.txt", "sales_FEB.csv"]       # jan's files listed once, under jan
    assert r["folders"][2]["error"]
