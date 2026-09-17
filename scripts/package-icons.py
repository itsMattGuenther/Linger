#!/usr/bin/env python3
"""Check packaged icons, not just the source assets. Uses only the standard library.

Pass an extracted Linux package root or a Windows executable (app or installer).
PE resources are inspected as data; this script never runs the supplied program.
"""

import argparse
import configparser
from pathlib import Path
import struct

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "client/src-tauri/icons"


def ico_images(data):
    reserved, kind, count = struct.unpack_from("<HHH", data)
    assert reserved == 0 and kind == 1 and count > 0, "Not an ICO file"
    return [data[offset:offset + size] for size, offset in
            (struct.unpack_from("<II", data, 6 + index * 16 + 8) for index in range(count))]


def pe_icons(data):
    """Resolve the PE resource tree and return only RT_ICON image bytes."""
    assert data[:2] == b"MZ", "Not a Windows executable"
    pe, = struct.unpack_from("<I", data, 0x3c)
    assert data[pe:pe + 4] == b"PE\0\0", "Missing PE header"
    count, = struct.unpack_from("<H", data, pe + 6)
    optional_size, = struct.unpack_from("<H", data, pe + 20)
    optional = pe + 24
    magic, = struct.unpack_from("<H", data, optional)
    assert magic in (0x10b, 0x20b), "Unknown PE format"
    directories = optional + (112 if magic == 0x20b else 96)
    resource_rva, = struct.unpack_from("<I", data, directories + 16)
    sections = [struct.unpack_from("<IIII", data, optional + optional_size + index * 40 + 8)
                for index in range(count)]

    def locate(rva):
        for virtual_size, address, raw_size, offset in sections:
            if address <= rva < address + max(virtual_size, raw_size):
                return offset + rva - address
        raise AssertionError("Resource outside PE sections")

    base = locate(resource_rva)

    def walk(relative, depth=0, resource_type=None):
        assert depth <= 3, "Unexpected resource tree depth"
        directory = base + relative
        named, numbered = struct.unpack_from("<HH", data, directory + 12)
        found = []
        for index in range(named + numbered):
            name, child = struct.unpack_from("<II", data, directory + 16 + index * 8)
            kind = name if depth == 0 else resource_type
            if kind != 3:  # RT_ICON
                continue
            if child & 0x80000000:
                found.extend(walk(child & 0x7fffffff, depth + 1, kind))
            else:
                rva, size = struct.unpack_from("<II", data, base + child)
                start = locate(rva)
                found.append(data[start:start + size])
        return found

    return walk(0)


def check_pe(path, icon):
    actual = pe_icons(path.read_bytes())
    expected = ico_images(icon.read_bytes())
    assert actual, f"No icon resources: {path.name}"
    assert all(image in actual for image in expected), f"Wrong or missing porch icon: {path.name}"
    print(f"PASS {path.name}: all {len(expected)} approved ICO images embedded")


def check_linux(root):
    desktop = root / "usr/share/applications/Linger.desktop"
    if not desktop.exists():
        desktop = root / "usr/share/applications/linger-client.desktop"
    parser = configparser.ConfigParser(interpolation=None)
    parser.read(desktop)
    entry = parser["Desktop Entry"]
    assert entry["Name"] == "Linger", "Launcher product name must be capitalized"
    assert entry["Exec"] == "linger-client", "Launcher does not start the packaged binary"
    assert entry["Icon"] == "linger-client", "Launcher icon identity changed"
    assert entry["StartupWMClass"] == "linger-client", "X11 launcher identity changed"
    for size, name in ((32, "32x32.png"), (128, "128x128.png"), (256, "128x128@2x.png")):
        installed = root / f"usr/share/icons/hicolor/{size}x{size}/apps/linger-client.png"
        if size == 256 and not installed.exists():
            # Current Tauri names the @2x PNG's scale directory this way.
            installed = root / "usr/share/icons/hicolor/256x256@2/apps/linger-client.png"
        assert installed.read_bytes() == (ICONS / name).read_bytes(), f"Wrong {size}px Linux icon"
    assert (root / "usr/bin/linger-client").is_file(), "Packaged program missing"
    print("PASS Linux package: launcher identity and all three installed porch icons")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pe", type=Path, action="append", default=[])
    parser.add_argument("--icon", type=Path, default=ICONS / "icon.ico")
    parser.add_argument("--linux-root", type=Path)
    args = parser.parse_args()
    if not args.pe and args.linux_root is None:
        parser.error("supply --pe or --linux-root")
    for path in args.pe:
        check_pe(path, args.icon)
    if args.linux_root is not None:
        check_linux(args.linux_root)


if __name__ == "__main__":
    main()
