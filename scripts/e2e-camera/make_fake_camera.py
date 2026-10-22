"""Render a Code 39 VIN barcode into a .y4m clip Chromium can use as a fake camera.

    python3 scripts/e2e-camera/make_fake_camera.py 1HGCM82633A004352 /tmp/vin.y4m

Needs Pillow and ffmpeg. The VIN default is the widely published sample used
throughout the tests, not a customer vehicle.
"""
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

# n = narrow, w = wide; bars and spaces alternate starting with a bar.
CODE39_PATTERNS = {
    "0": "nnnwwnwnn", "1": "wnnwnnnnw", "2": "nnwwnnnnw", "3": "wnwwnnnnn", "4": "nnnwwnnnw",
    "5": "wnnwwnnnn", "6": "nnwwwnnnn", "7": "nnnwnnwnw", "8": "wnnwnnwnn", "9": "nnwwnnwnn",
    "A": "wnnnnwnnw", "B": "nnwnnwnnw", "C": "wnwnnwnnn", "D": "nnnnwwnnw", "E": "wnnnwwnnn",
    "F": "nnwnwwnnn", "G": "nnnnnwwnw", "H": "wnnnnwwnn", "J": "nnnnwwwnn", "K": "wnnnnnnww",
    "L": "nnwnnnnww", "M": "wnwnnnnwn", "N": "nnnnwnnww", "P": "nnwnwnnwn", "R": "nnwnnnwwn",
    "S": "nnnnwnwwn", "T": "nnnnnnwww", "U": "wwnnnnnnw", "V": "nwwnnnnnw", "W": "wwwnnnnnn",
    "X": "nwnnwnnnw", "Y": "wwnnwnnnn", "Z": "nwwnwnnnn", "*": "nwnnwnwnn",
}


def render_code39(text: str, narrow: int = 4, wide: int = 10, height: int = 220) -> Image.Image:
    sequence = f"*{text}*"
    elements: list[tuple[int, bool]] = []
    for position, character in enumerate(sequence):
        for index, kind in enumerate(CODE39_PATTERNS[character]):
            elements.append((narrow if kind == "n" else wide, index % 2 == 0))
        if position < len(sequence) - 1:
            elements.append((narrow, False))  # inter-character gap
    quiet_zone = 20 * narrow
    width = sum(size for size, _ in elements) + 2 * quiet_zone
    image = Image.new("L", (width, height + 60), 255)
    draw = ImageDraw.Draw(image)
    x = quiet_zone
    for size, is_bar in elements:
        if is_bar:
            draw.rectangle([x, 20, x + size - 1, 20 + height], fill=0)
        x += size
    draw.text((quiet_zone, height + 30), text, fill=0)
    return image


def main() -> None:
    vin = sys.argv[1] if len(sys.argv) > 1 else "1HGCM82633A004352"
    output = Path(sys.argv[2] if len(sys.argv) > 2 else "fake-camera.y4m")
    barcode = render_code39(vin)
    frame = Image.new("L", (1280, 720), 255)
    scaled = barcode.resize((1200, int(barcode.height * 1200 / barcode.width)))
    frame.paste(scaled, (40, 200))
    with tempfile.TemporaryDirectory() as directory:
        frame_path = Path(directory) / "frame.png"
        frame.convert("RGB").save(frame_path)
        subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-y", "-loop", "1", "-i", str(frame_path),
             "-t", "3", "-r", "15", "-pix_fmt", "yuv420p", str(output)],
            check=True,
        )
    print(output)


if __name__ == "__main__":
    main()
