#!/usr/bin/env python3
"""Build the static JSON the site loads from NYS DOH raw CSVs + the merged facility summary.

Inputs (defaults point at the box paths; override with env vars):
  SUMMARY_CSV   merged one-row-per-facility CSV (Nassau_Restaurants_Full_History.csv)
  ACTIVE_CSV    raw 2hcc-shji violation rows (active)
  CLOSED_CSV    raw aaxz-j6pj violation rows (closed/inactive)
  data/geocode_cache.csv  produced by scripts/geocode.py
Outputs (docs/data/):
  index.json        compact facility index loaded up front
  lists.json        curated browse lists
  viol.json         violation description dictionary
  d/<shard>.json    per-facility detail, shard = operation_id % 256
  meta.json         counts and build info
"""
import csv, json, os, re, shutil
from collections import defaultdict
from datetime import date
from pathlib import Path
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
BASE = Path("/workspace/nassau-restaurants")
SUMMARY = Path(os.environ.get("SUMMARY_CSV", BASE / "Nassau_Restaurants_Full_History.csv"))
ACTIVE = Path(os.environ.get("ACTIVE_CSV", BASE / "raw/nassau_inspections_2hcc-shji.csv"))
CLOSED = Path(os.environ.get("CLOSED_CSV", BASE / "raw/nassau_inspections_aaxz-j6pj.csv"))
CACHE = ROOT / "data/geocode_cache.csv"
OUT = ROOT / "docs/data"
NSHARD = 256
DATA_THROUGH = "2026-11-06"
WINDOW_START = "2023-11-09"

GRADE_RE = re.compile(r"(?i)\b(?:letter\s+)?grade\s*[:\-]?\s*([ABC])\b|\bscore\s*[:\-]?\s*([ABC])\b")
DORMANT_RE = re.compile(r"\s*(?:/+\s*)?(?:dormant|inactive)(?:\s*/+\s*(?:dormant|inactive))*\s*$", re.I)

def cs(s):
    return re.sub(r"\s+", " ", str(s or "")).strip()

def title(s):
    s = cs(s)
    out = []
    for w in s.split(" "):
        u = w.upper()
        if u in {"N", "N.", "S", "S.", "E", "E.", "W", "W."}:
            out.append(u[0] + ".")
        else:
            out.append(w[:1].upper() + w[1:].lower())
    return " ".join(out)

def grade(t):
    m = GRADE_RE.search(t or "")
    return (m.group(1) or m.group(2)).upper() if m else ""

def addr_key(a, c):
    return re.sub(r"[^A-Z0-9 ]", "", f"{cs(a)} {cs(c)}".upper())

def geo_key(a, c, z):
    return re.sub(r"\s+", " ", f"{a}|{c}|{z}".upper()).strip()

def main():
    s = pd.read_csv(SUMMARY, dtype=str).fillna("")
    print("facilities", len(s))
    # --- coordinates ---
    cache = {}
    if CACHE.exists():
        for r in csv.DictReader(open(CACHE)):
            if r["lat"]:
                cache[r["key"]] = (float(r["lat"]), float(r["lon"]))
    known_by_addr = {}
    for _, r in s[s.Latitude.ne("")].iterrows():
        known_by_addr.setdefault(addr_key(r.Address, r.City), (float(r.Latitude), float(r.Longitude)))
    src_counts = defaultdict(int)
    coords = {}
    for _, r in s.iterrows():
        oid = r["NYS Health Operation ID"]
        if r.Latitude:
            coords[oid] = (float(r.Latitude), float(r.Longitude)); src_counts["source"] += 1
        elif addr_key(r.Address, r.City) in known_by_addr:
            coords[oid] = known_by_addr[addr_key(r.Address, r.City)]; src_counts["same_address"] += 1
        elif geo_key(r.Address, r.City, r.ZIP[:5]) in cache:
            coords[oid] = cache[geo_key(r.Address, r.City, r.ZIP[:5])]; src_counts["census"] += 1
        else:
            src_counts["none"] += 1
    # sanity: keep only points in/near Nassau County bbox
    for oid, (la, lo) in list(coords.items()):
        if not (40.5 < la < 41.0 and -73.8 < lo < -73.4):
            del coords[oid]; src_counts["dropped_out_of_bbox"] += 1
    print("coords", dict(src_counts), "pinned", len(coords))

    # --- raw inspections ---
    cols = ["nys_health_operation_id", "date_of_inspection", "inspection_type", "violation_item",
            "violation_description", "critical_violation", "total_critical_violations",
            "total_crit_not_corrected", "total_noncritical_violations", "inspection_comments"]
    raw = pd.concat([pd.read_csv(ACTIVE, dtype=str, usecols=cols), pd.read_csv(CLOSED, dtype=str, usecols=cols)],
                    ignore_index=True).fillna("")
    raw["d"] = raw.date_of_inspection.str[:10]
    print("raw rows", len(raw))
    vdict, vidx = [], {}
    insp = defaultdict(dict)  # oid -> (date,type) -> rec
    for t in raw.itertuples(index=False):
        k = (t.d, t.inspection_type)
        rec = insp[t.nys_health_operation_id].get(k)
        if rec is None:
            rec = insp[t.nys_health_operation_id][k] = {"c": 0, "n": 0, "nc": 0, "cm": "", "v": [], "seen": set()}
        for fld, col in (("c", t.total_critical_violations), ("nc", t.total_crit_not_corrected), ("n", t.total_noncritical_violations)):
            try:
                rec[fld] = max(rec[fld], int(float(col)))
            except ValueError:
                pass
        cm = cs(t.inspection_comments)
        if cm and len(cm) > len(rec["cm"]):
            rec["cm"] = cm
        item = cs(t.violation_item)
        if item and item.lower() != "none":
            desc = cs(t.violation_description)
            if (item, desc) in rec["seen"]:
                continue
            rec["seen"].add((item, desc))
            if desc not in vidx:
                vidx[desc] = len(vdict); vdict.append(desc)
            rec["v"].append([item, vidx[desc], 1 if t.critical_violation == "Critical Violation" else 0])

    # --- same-location groups ---
    by_code, by_addr = defaultdict(list), defaultdict(list)
    for _, r in s.iterrows():
        oid = r["NYS Health Operation ID"]
        code = r["Facility code"].strip()
        if code and code.upper() != "DELETE":
            by_code[code].append(oid)
        by_addr[addr_key(r.Address, r.City)].append(oid)
    srow = {r["NYS Health Operation ID"]: r for _, r in s.iterrows()}

    def name_of(r):
        return DORMANT_RE.sub("", cs(r["Facility name"]) or cs(r["Operation name"])).strip(" -/")

    shards = defaultdict(dict)
    index_rows = []
    for oid, r in srow.items():
        recs = insp.get(oid, {})
        ilist = []
        for (d, typ), rec in sorted(recs.items(), key=lambda x: (x[0][0], x[0][1]), reverse=True):
            rec["v"].sort(key=lambda v: (-v[2], v[0]))
            ilist.append([d, "R" if typ.startswith("Re") else "I", rec["c"], rec["n"], rec["nc"], grade(rec["cm"]), rec["cm"], rec["v"]])
        others = set(by_code.get(r["Facility code"].strip(), [])) | set(by_addr.get(addr_key(r.Address, r.City), []))
        others.discard(oid)
        same = []
        for o in others:
            q = srow[o]
            same.append([o, name_of(q), "A" if q.Status == "Active" else "C", q["First inspection date in file"], q["Latest inspection date"]])
        same.sort(key=lambda x: x[4] or "", reverse=True)
        nm = name_of(r)
        ll = coords.get(oid)
        det = {
            "n": nm, "op": cs(r["Operation name"]) if cs(r["Operation name"]).upper() != nm.upper() else "",
            "dba": cs(r.DBA), "corp": cs(r["Operator / corporation"]), "a": title(r.Address), "c": title(r.City),
            "z": r.ZIP[:5], "m": title(r.Municipality), "t": cs(r["Establishment type"]), "s": "A" if r.Status == "Active" else "C",
            "fc": r["Facility code"], "pe": r["Permit expiration"], "g": r["Latest grade (from comments)"],
            "ll": [round(ll[0], 5), round(ll[1], 5)] if ll else None,
            "i": ilist, "same": same,
        }
        shards[int(oid) % NSHARD][oid] = det
        tg = {"Food service": "F", "Institutional": "I"}.get(r["Type group"], "O")
        index_rows.append([
            int(oid), nm, title(r.Address), title(r.City), title(r.Municipality), 1 if r.Status == "Active" else 0,
            r["Latest grade (from comments)"], round(ll[0], 5) if ll else None, round(ll[1], 5) if ll else None,
            len(ilist), sum(i[2] for i in ilist), sum(i[2] for i in ilist if i[0] >= WINDOW_START),
            ilist[0][0] if ilist else r["Latest inspection date"], tg, 1 if same else 0,
            (lambda o: o if o.upper() != nm.upper() else "")(DORMANT_RE.sub("", cs(r["Operation name"])).strip(" -/")),
        ])

    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "d").mkdir(parents=True)
    dump = lambda p, o: p.write_text(json.dumps(o, separators=(",", ":"), ensure_ascii=False))
    index_rows.sort(key=lambda x: re.sub(r"^[^A-Za-z0-9]+", "", x[1]).upper())
    dump(OUT / "index.json", {"cols": ["id", "name", "addr", "city", "muni", "open", "grade", "lat", "lon",
                                       "insp", "crit", "crit3", "last", "type", "same", "op"], "rows": index_rows})
    for k, v in shards.items():
        dump(OUT / "d" / f"{k}.json", v)
    dump(OUT / "viol.json", vdict)

    # --- curated lists ---
    I = {c: i for i, c in enumerate(["id", "name", "addr", "city", "muni", "open", "grade", "lat", "lon", "insp", "crit", "crit3", "last", "type", "same"])}
    rows = index_rows
    recent = sorted(rows, key=lambda x: x[I["last"]] or "", reverse=True)[:60]
    crit3 = sorted([x for x in rows if x[I["open"]] and x[I["crit3"]] > 0], key=lambda x: (-x[I["crit3"]], x[I["name"]]))[:50]
    latest_c = sorted([x for x in rows if x[I["grade"]] == "C"], key=lambda x: x[I["last"]] or "", reverse=True)
    # changed hands: active food-service place whose location had >=2 earlier closed operators
    turnover = []
    seen_loc = set()
    for x in rows:
        if not (x[I["open"]] and x[I["type"]] == "F" and x[I["same"]]):
            continue
        r = srow[str(x[0])]
        loc = addr_key(r.Address, r.City)
        if loc in seen_loc:
            continue
        others = [srow[o] for o in by_addr.get(loc, []) if o != str(x[0])]
        prev = [o for o in others if o.Status == "Closed" and o["Type group"] == "Food service"]
        if len(prev) >= 2:
            seen_loc.add(loc)
            turnover.append([x[0], x[I["name"]], x[I["addr"]], x[I["city"]], len(prev), [name_of(o) for o in sorted(prev, key=lambda o: o["Latest inspection date"], reverse=True)[:4]]])
    turnover.sort(key=lambda t: (-t[4], t[1]))
    def opname(x):
        r = srow[str(x[0])]
        o = DORMANT_RE.sub("", cs(r["Operation name"])).strip(" -/")
        return o if o.upper() != x[I["name"]].upper() else ""
    pick = lambda xs: [[x[0], x[I["name"]], x[I["city"]], x[I["open"]], x[I["grade"]], x[I["last"]], x[I["crit3"]], x[I["crit"]], x[I["insp"]], opname(x)] for x in xs]
    dump(OUT / "lists.json", {"recent": pick(recent), "crit3": pick(crit3), "latestC": pick(latest_c), "turnover": turnover[:60]})
    meta = {"facilities": len(rows), "open": sum(x[5] for x in rows), "closed": len(rows) - sum(x[5] for x in rows),
            "inspections": sum(x[9] for x in rows), "pinned": len(coords), "coord_sources": dict(src_counts),
            "data_through": DATA_THROUGH, "window_start": WINDOW_START, "built": str(date.today())}
    dump(OUT / "meta.json", meta)
    print(json.dumps(meta, indent=1))

if __name__ == "__main__":
    main()
