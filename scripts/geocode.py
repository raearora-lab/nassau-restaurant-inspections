#!/usr/bin/env python3
"""Geocode facilities lacking coordinates with the free US Census Bureau batch geocoder.

Results are cached in data/geocode_cache.csv (keyed by normalized address) so reruns only
send addresses not yet attempted. Usage: python3 scripts/geocode.py [path/to/Full_History.csv]
"""
import csv, io, sys, time, re
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import pandas as pd, requests

ROOT = Path(__file__).resolve().parent.parent
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/workspace/nassau-restaurants/Nassau_Restaurants_Full_History.csv")
CACHE = ROOT / "data" / "geocode_cache.csv"
URL = "https://geocoding.geo.census.gov/geocoder/locations/addressbatch"
CHUNK = 1000

def key(addr, city, zip_):
    return re.sub(r"\s+", " ", f"{addr}|{city}|{zip_}".upper()).strip()

def main():
    df = pd.read_csv(SRC, dtype=str).fillna("")
    need = df[df["Latitude"].eq("")]
    rows = {}
    for _, r in need.iterrows():
        z = r["ZIP"][:5]
        rows[key(r["Address"], r["City"], z)] = (re.sub(r"\s+", " ", r["Address"]).strip(), r["City"].strip(), z)
    cache = {}
    if CACHE.exists():
        for r in csv.DictReader(open(CACHE)):
            cache[r["key"]] = r
    todo = [k for k in rows if k not in cache]
    print(f"facilities missing coords: {len(need)}; unique addresses: {len(rows)}; to geocode: {len(todo)}", flush=True)
    keys = {str(i): k for i, k in enumerate(todo)}
    items = list(keys.items())
    chunks = [items[i:i + CHUNK] for i in range(0, len(items), CHUNK)]

    def run(chunk):
        buf = io.StringIO()
        w = csv.writer(buf)
        for i, k in chunk:
            a, c, z = rows[k]
            w.writerow([i, a, c, "NY", z])
        for attempt in range(4):
            try:
                resp = requests.post(URL, files={"addressFile": ("a.csv", buf.getvalue())},
                                     data={"benchmark": "Public_AR_Current"}, timeout=600)
                resp.raise_for_status()
                out = {}
                for rec in csv.reader(io.StringIO(resp.text)):
                    if not rec:
                        continue
                    rid = rec[0]
                    match = rec[2] if len(rec) > 2 else ""
                    lon = lat = ""
                    if match == "Match" and len(rec) > 5 and "," in rec[5]:
                        lon, lat = rec[5].split(",")
                    out[rid] = {"key": keys[rid], "status": match or "No_Match",
                                "match_type": rec[3] if len(rec) > 3 else "",
                                "matched_address": rec[4] if len(rec) > 4 else "",
                                "lat": lat, "lon": lon}
                print(f"  chunk ok: {len(out)} rows", flush=True)
                return out
            except Exception as e:
                print("  retry", attempt, e, flush=True)
                time.sleep(10 * (attempt + 1))
        return {}

    with ThreadPoolExecutor(4) as ex:
        for out in ex.map(run, chunks):
            for v in out.values():
                cache[v["key"]] = v
    with open(CACHE, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["key", "status", "match_type", "matched_address", "lat", "lon"])
        w.writeheader()
        for v in cache.values():
            w.writerow(v)
    matched = sum(1 for k in rows if cache.get(k, {}).get("lat"))
    print(f"address match rate: {matched}/{len(rows)} = {matched/len(rows):.1%}")

if __name__ == "__main__":
    main()
