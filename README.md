# Nassau County Restaurant Inspections, 2001–2026

A static, searchable map of the public inspection history for every Nassau County, NY food
service establishment in New York State Department of Health open data. It covers open and closed
places, with records from January 2001 through November 6, 2026.

**Live site:** https://raearora-lab.github.io/nassau-restaurant-inspections/

## What's here

```
docs/                 the site (served by GitHub Pages from /docs)
  index.html          single page app with hash routes: #/ map + search, #/r/<operation_id> detail, #/browse, #/about
  app.js, styles.css  vanilla JS + Leaflet + Leaflet.markercluster (from unpkg CDN)
  data/index.json     compact facility index loaded on first visit (~2.2 MB, ~0.5 MB gzipped)
  data/d/<n>.json     per-facility detail, sharded by operation_id % 256, loaded on demand
  data/viol.json      violation description dictionary referenced by detail files
  data/lists.json     curated browse lists
  data/meta.json      build counts
scripts/
  geocode.py          geocodes facilities without coordinates via the US Census batch geocoder (cached)
  build_site_data.py  builds docs/data/* from the raw NYS DOH CSVs + merged facility summary
  screenshot.py       optional headless screenshots (Playwright)
data/geocode_cache.csv  cached Census geocoder results
```

## Sources

- NYS DOH Food Service Establishment Inspections, active: https://health.data.ny.gov/d/2hcc-shji
- NYS DOH Food Service Establishment Inspections, inactive or closed: https://health.data.ny.gov/d/aaxz-j6pj
- NYS DOH Food Service Establishment Last Inspection: https://health.data.ny.gov/d/cnih-y5dw

Filter each dataset to `county = NASSAU` and download the full CSV, for example with the SODA API
(`https://health.data.ny.gov/resource/2hcc-shji.csv?county=NASSAU&$limit=50000&$offset=...`).

## Rebuild

The raw CSVs are about 210 MB, so they are not committed. To rebuild:

1. Download the raw violation-row CSVs for `2hcc-shji` (active) and `aaxz-j6pj` (closed), filtered to Nassau.
2. Produce the merged one-row-per-facility summary (`Nassau_Restaurants_Full_History.csv`). This
   step was done with a separate merge script that collapses violation rows to inspections and
   parses grades from comments.
3. Run:

```bash
pip install pandas requests
python3 scripts/geocode.py /path/to/Nassau_Restaurants_Full_History.csv   # only new addresses hit the API
SUMMARY_CSV=/path/to/Nassau_Restaurants_Full_History.csv \
ACTIVE_CSV=/path/to/nassau_inspections_2hcc-shji.csv \
CLOSED_CSV=/path/to/nassau_inspections_aaxz-j6pj.csv \
python3 scripts/build_site_data.py
python3 -m http.server 8000 --directory docs   # preview at http://localhost:8000
```

Update `DATA_THROUGH` in `build_site_data.py` and the dates in `docs/index.html` when you refresh.

## Methodology notes

- Each source row is one violation, not one visit. Rows are grouped into inspections by operation
  ID, date and inspection type, and each inspection's totals are counted once (max across sibling rows).
- Letter grades are not an official field. They are parsed from inspector comment text
  (`grade A` / `score B` style phrases). NYS DOH says this data was not collected as a grading system.
- Coverage is all permitted food service, including schools, day care, camps and institutions, not only restaurants.
- Coordinates come from the source data first. If missing, the site uses another record at the
  same address, then the US Census geocoder (benchmark `Public_AR_Current`). Points outside the
  Nassau bounding box are dropped. Places that can't be placed stay searchable without a pin.
- "Same location history" links permits that share a facility code (excluding the junk code
  `DELETE`) or a normalized street address and city.

## Disclaimer

This site republishes public government records as provided. They may contain errors and do not
describe current conditions at any business.
