import sys, asyncio
from playwright.async_api import async_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765/"
OUT = sys.argv[2] if len(sys.argv) > 2 else "screenshots"
async def main():
    async with async_playwright() as p:
        try:
            b = await p.chromium.launch()
        except Exception:
            b = await p.chromium.launch(executable_path="/usr/bin/google-chrome")
        pg = await b.new_page(viewport={"width": 1440, "height": 900})
        errs = []
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errs.append(str(e)))
        await pg.goto(BASE, wait_until="networkidle"); await pg.wait_for_timeout(2500)
        print("count:", await pg.inner_text("#result-count"))
        await pg.screenshot(path=f"{OUT}/map-view.png")
        await pg.fill("#q", "positano"); await pg.wait_for_timeout(800)
        print("search:", await pg.inner_text("#result-count"))
        await pg.goto(BASE + "#/r/1077951"); await pg.wait_for_timeout(3000)
        print("detail:", (await pg.inner_text("#detail-pane"))[:300].replace("\n", " | "))
        await pg.screenshot(path=f"{OUT}/detail-view.png")
        await pg.goto(BASE + "#/browse"); await pg.wait_for_timeout(1500)
        await pg.screenshot(path=f"{OUT}/browse-view.png")
        m = await b.new_page(viewport={"width": 390, "height": 844}, is_mobile=True)
        await m.goto(BASE + "#/r/573756", wait_until="networkidle"); await m.wait_for_timeout(2500)
        await m.screenshot(path=f"{OUT}/mobile-detail.png", full_page=False)
        print("errors:", errs)
        await b.close()
asyncio.run(main())
