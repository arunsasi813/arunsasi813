"""The fast number and date readers give exactly what the plain ones gave — on every
kind of value ColSift meets: plain numbers, 1,234.50, (250), 5%, blanks and junk;
every date layout, with and without a time, Excel serials, impossible dates."""

import random

import polars as pl
from polars.testing import assert_series_equal

import formula as F

RX_TIME = F._TIME_TAIL


def ref_number(e):
    s = (e.cast(pl.String).str.strip_chars().str.replace_all(r"[,\s]", "").str.replace(r"^\((.*)\)$", r"-$1"))
    n = s.str.strip_suffix("%").cast(pl.Float64, strict=False)
    return pl.when(s.str.ends_with("%")).then(n / 100).otherwise(n)


def ref_date(e):
    s = e.cast(pl.String).str.strip_chars()
    d = s.str.replace(RX_TIME, "")
    tries = [pl.when(d.str.contains(rx)).then(d.str.to_date(f, strict=False)) for rx, f in F.AUTO_DATE_FORMATS]
    tries.append(pl.when(s.str.contains(r"^\d{5}(?:\.\d+)?$")).then(F._serial_to_date(s)))
    return pl.coalesce(tries)


def values(n=200_000, seed=11):
    r = random.Random(seed)
    mon = ["Jan", "feb", "MAR", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Foo"]
    def one():
        k = r.randrange(26)
        d, m, y = r.randint(0, 32), r.randint(0, 13), r.choice([1999, 2026, 2030, 26, 5, 12345])
        return [f"{r.uniform(-1e6, 1e6):.2f}", f"{r.randint(-9999, 999999):,}", f"({r.randint(1, 999)})", f"{r.randint(0, 100)}%",
                f"  {r.randint(0, 99)}  ", "", "n/a", "1e3", "-0", "inf", "NaN", "1 234", "12,34,5", "(12", "5%%",
                f"{y:04d}-{m}-{d}", f"{d}/{m}/{y}", f"{d}-{m}-{y}", f"{d}.{m}.{y}", f"{d}-{r.choice(mon)}-{y}",
                f"{d} {r.choice(mon)} {y}", f"{d:02d}{r.choice(mon)}{y % 100:02d}", f"{y:04d}{m:02d}{d:02d}",
                f"{d}/{m}/{y} {r.randint(0, 25)}:{r.randint(0, 61):02d}" + r.choice(["", ":07", " PM", ".5"]),
                f"{r.randint(10000, 99999)}" + r.choice(["", ".25"]), f"{y}/{m}/{d}T10:30"][k]
    return pl.Series("v", [one() for _ in range(n)] + [None])


def test_numbers_read_exactly_as_before():
    s = values()
    df = pl.DataFrame(s)
    assert_series_equal(df.select(F.clean_number(pl.col("v")).alias("x"))["x"],
                        df.select(ref_number(pl.col("v")).alias("x"))["x"])


def test_dates_read_exactly_as_before():
    s = values()
    df = pl.DataFrame(s)
    new = df.select(F.parse_date(pl.col("v")).alias("x"))["x"]
    assert_series_equal(new, df.select(ref_date(pl.col("v")).alias("x"))["x"])
    assert new.is_not_null().sum() > 30_000, "plenty of real dates in the mix"


def test_no_two_date_layouts_claim_the_same_text():
    # what the fast reader relies on: one layout per value at most
    samples = values(50_000).drop_nulls().to_list()
    import re
    pats = [re.compile(rx) for rx, _ in F.AUTO_DATE_FORMATS]
    for v in samples:
        t = v.strip()
        assert sum(bool(p.search(t)) for p in pats) <= 1, v
