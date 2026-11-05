"""Memory: big text files are read in blocks into a Parquet copy; samples read only
the start of a file; results must be exactly what the plain reader gives."""

from __future__ import annotations

import polars as pl
import pytest

import engine as E


def tricky(path, n=400):
    rows = ["report header line", "ID,NAME,NOTE,AMOUNT"]
    for i in range(n):
        note = {0: "plain", 1: '"has, a comma"', 2: '"spans\ntwo lines"', 3: '"say ""hi"""', 4: ""}[i % 5]
        tail = ",extra" if i % 37 == 0 else ""                 # a ragged, wider row
        rows.append(f"{i:05d},name {i},{note},{i * 1.5}{tail}")
        if i % 50 == 0:
            rows.append("")                                    # a blank line
    path.write_text("\n".join(rows) + "\n", encoding="utf-8")
    return path


@pytest.fixture
def small_blocks(monkeypatch):
    """Every text file counts as big, and blocks are 200 bytes."""
    monkeypatch.setattr(E, "TEXT_CACHE_MB", 0.0)
    monkeypatch.setattr(E, "TEXT_BLOCK", 200)
    monkeypatch.setattr(E, "TEXT_SAMPLE_BYTES", 600)
    E._WIDTH_CACHE.clear()


def plain(src):
    E.set_cache(False)
    try:
        return E.load_lazy(src).collect()
    finally:
        E.set_cache(True)


def test_block_by_block_reads_exactly_what_the_plain_reader_does(tmp_path, small_blocks):
    f = tricky(tmp_path / "t.csv")
    src = E.Source(path=str(f), header_row=2, auto_delimiter=False, delimiter="comma")
    want = plain(src)
    assert E.cached_text(src) is None
    got = E.load_lazy(src).collect()
    assert E.cached_text(src) is not None, "the first full read leaves a Parquet copy"
    assert got.columns == want.columns == ["ID", "NAME", "NOTE", "AMOUNT", "col_5"]
    assert got.equals(want), (got.head(8), want.head(8))
    assert got.filter(pl.col("NOTE") == "spans\ntwo lines").height == 80
    assert E.load_lazy(src).collect().equals(want), "and reads it back the same"


def test_a_sample_reads_only_the_start_and_builds_no_copy(tmp_path, small_blocks):
    f = tricky(tmp_path / "t.csv")
    src = E.Source(path=str(f), header_row=2, auto_delimiter=False, delimiter="comma", sample_rows=100)
    got = E.load_lazy(src).collect()
    assert 0 < got.height < 40 and got["ID"][0] == "00000"
    assert E.cached_text(src) is None
    assert E._schema_names(E.Source(path=str(f), header_row=2)) == ["ID", "NAME", "NOTE", "AMOUNT", "col_5"]


def test_prepare_caches_big_text_files_before_a_run(data, small_blocks):
    tmp, f = data
    r = E.prepare([str(f["jan"]), str(f["feb"])], {})
    assert r["built"] == 2 and not r["errors"]
    assert E.cached_text(E.Source(path=str(f["jan"])).resolved()) is not None
    job = {"files": [str(f["jan"]), str(f["feb"])], "columns": [{"name": "DOC_NO", "include": True}],
           "output": {"folder": str(tmp / "o"), "format": "csv"}}
    r = E.run(job)
    assert r["ok"] and r["rows"] == 72


def test_settings_change_means_a_new_copy(tmp_path, small_blocks):
    f = tricky(tmp_path / "t.csv")
    a = E.Source(path=str(f), header_row=2, auto_delimiter=False, delimiter="comma")
    b = E.Source(path=str(f), header_row=1, auto_delimiter=False, delimiter="comma")
    E.load_lazy(a).collect()
    got = E.load_lazy(b).collect()
    assert got.columns[0] == "report header line" and got.equals(plain(b))


def _files(tmp_path):
    import random
    rnd = random.Random(5)
    paths = []
    for f in range(4):
        rows = []
        for r in range(300):
            key = rnd.choice(["", " ", "a1", "A1", "b2", "c3", f"u{f}{r}", "d4", "e5 "])
            rows.append({"KEY": key, "SUB": rnd.choice(["x", "y"]), "V": str(rnd.randint(1, 4))})
        p = tmp_path / f"s{f}.parquet"
        pl.DataFrame(rows).write_parquet(p)
        paths.append(p)
    return paths


@pytest.mark.parametrize("keep", ["all", "dups", "files", "first", "last", "unique"])
@pytest.mark.parametrize("distinct", [False, True])
def test_two_pass_duplicates_match_the_in_memory_ones(tmp_path, monkeypatch, keep, distinct):
    monkeypatch.setattr(E, "DEDUPE_BUCKET_ROWS", 150)          # several buckets
    monkeypatch.setattr(E, "DEDUPE_SLICE_ROWS", 70)            # and several slices of each file
    paths = _files(tmp_path)
    job = {"distinct": distinct, "batch_dupes": {"keys": ["KEY", "SUB"], "keep": keep, "count_col": "DUP_COUNT",
                                                 "files_col": "DUP_FILES", "occ_col": "DUP_NO"}}
    want = E.across_files(E.stacked([pl.scan_parquet(p) for p in paths]), job).collect()
    stage = tmp_path / "stage"
    outs = E.dedupe_files([pl.scan_parquet(p) for p in paths], job, stage)
    got = pl.concat([pl.read_parquet(x).with_columns(pl.lit(i, dtype=pl.UInt32).alias(E.SRC_COL))
                     for i, o in enumerate(outs) for x in o], how="diagonal_relaxed")
    assert got.select(want.columns).equals(want), (keep, distinct)
    counts = E.dedupe_files([pl.scan_parquet(p) for p in paths], job, stage, write=False)
    assert counts == [got.filter(pl.col(E.SRC_COL) == i).height for i in range(len(paths))]


def test_distinct_rows_alone_and_per_file(tmp_path, monkeypatch):
    monkeypatch.setattr(E, "DEDUPE_BUCKET_ROWS", 100)
    paths = _files(tmp_path)
    lfs = [pl.scan_parquet(p) for p in paths]
    monkeypatch.setattr(E, "DEDUPE_SLICE_ROWS", 64)
    outs = E.dedupe_files(lfs, {"distinct": True}, tmp_path / "st")
    got = pl.concat([pl.read_parquet(x) for o in outs for x in o])
    assert got.equals(pl.concat([p.collect() for p in lfs]).unique(maintain_order=True))
    per = E.dedupe_files(lfs, {"distinct": True}, tmp_path / "st", separately=True)
    for lf, o in zip(lfs, per):
        assert pl.concat([pl.read_parquet(x) for x in o]).equals(lf.collect().unique(maintain_order=True))


def test_the_cache_counts_clears_and_prunes_text_copies(tmp_path, small_blocks):
    f = tricky(tmp_path / "t.csv")
    src = E.Source(path=str(f), header_row=2, auto_delimiter=False, delimiter="comma")
    E.load_lazy(src).collect()
    folder = E.cached_text(src)
    assert folder.is_dir() and len(list(folder.glob("*.parquet"))) > 3, "one Parquet file per block"
    info = E.cache_info()
    assert info["entries"] == 1 and info["bytes"] > 0
    E.load_lazy(E.Source(path=str(f), header_row=1, auto_delimiter=False, delimiter="comma")).collect()
    assert E.cache_info()["entries"] == 1 and E.cached_text(src) is None, "the older layout's copy was replaced"
    assert E.cache_clear()["removed"] == 1 and E.cache_info()["entries"] == 0
