#!/usr/bin/env python3
"""Package the approved porch artwork using the project's pinned Tauri CLI.

The source is slightly rectangular. An SVG container adds transparent padding
at integer pixel coordinates, preserving the original PNG without cropping or
stretching it. Tauri handles platform formats and size conversion.
"""

import base64
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets/logo/Linger Pixel Porch Icon Set FINAL.png"
ICONS = ROOT / "client/src-tauri/icons"
DESKTOP_ICONS = (
    "32x32.png", "128x128.png", "128x128@2x.png",
    "icon.png", "icon.ico", "icon.icns",
)


def main():
    data = SOURCE.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        raise SystemExit("The approved artwork must be a PNG.")
    width, height = struct.unpack(">II", data[16:24])
    side = max(width, height)
    x, y = (side - width) // 2, (side - height) // 2
    encoded = base64.b64encode(data).decode("ascii")
    with tempfile.TemporaryDirectory(prefix="linger-icons-") as temporary:
        work = Path(temporary)
        square = work / "porch.svg"
        square.write_text(
            f'<svg xmlns="http://www.w3.org/2000/svg" '
            f'xmlns:xlink="http://www.w3.org/1999/xlink" '
            f'width="{side}" height="{side}" viewBox="0 0 {side} {side}">'
            f'<image x="{x}" y="{y}" width="{width}" height="{height}" '
            f'xlink:href="data:image/png;base64,{encoded}"/></svg>\n'
        )
        output = work / "icons"
        subprocess.run(
            ["pnpm", "tauri", "icon", str(square), "--output", str(output)],
            cwd=ROOT / "client", check=True,
        )
        # Mobile and store-specific assets are not part of the desktop bundle.
        for name in DESKTOP_ICONS:
            shutil.copyfile(output / name, ICONS / name)
    print(f"Updated {len(DESKTOP_ICONS)} desktop icons from {SOURCE.name}.")


if __name__ == "__main__":
    main()
