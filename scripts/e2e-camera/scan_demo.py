"""Drive the demo in headless Chromium with a fake camera and assert a scan.

    pnpm dev &                       # demo on http://localhost:5173
    python3 scripts/e2e-camera/make_fake_camera.py 1HGCM82633A004352 /tmp/vin.y4m
    python3 scripts/e2e-camera/scan_demo.py /tmp/vin.y4m 1HGCM82633A004352

Needs `pip install playwright && playwright install chromium`. The decode step
calls the live NHTSA vPIC API.
"""
import asyncio
import os
import sys

from playwright.async_api import async_playwright


async def main(video_path: str, expected_vin: str) -> None:
    proxy = os.environ.get("HTTPS_PROXY")
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            proxy={"server": proxy, "bypass": "<-loopback>,localhost,127.0.0.1"} if proxy else None,
            args=[
                "--use-fake-ui-for-media-stream",
                "--use-fake-device-for-media-stream",
                f"--use-file-for-fake-video-capture={video_path}",
            ],
        )
        page = await browser.new_page()
        await page.goto(os.environ.get("DEMO_URL", "http://localhost:5173/"))
        await page.click("#scan-start")
        status = ""
        for _ in range(20):
            await page.wait_for_timeout(500)
            status = await page.inner_text("#scan-status")
            if status.startswith("Accepted"):
                break
        print("scan:  ", status, "|", await page.inner_text("#engine"))
        assert expected_vin in status, "scanner did not accept the expected VIN"
        await page.wait_for_selector("#decode dl", timeout=15_000)
        print("decode:", (await page.inner_text("#decode")).splitlines()[0])
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], sys.argv[2]))
