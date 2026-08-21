#!/usr/bin/env python3
"""Rewrite a .vsix so the same source always produces the same bytes.

`vsce package` builds a zip with whatever mtimes the working tree happens to
have and whatever order the filesystem happens to return, so two builds of the
same commit differ. That makes the artifact's checksum meaningless as a
statement about which source is installed — which is the whole point of
recording it.

This normalises the three sources of nondeterminism:
  * entry order      -> sorted by name
  * modification time -> a fixed epoch (default: the commit date, via
                         SOURCE_DATE_EPOCH)
  * external attrs    -> fixed permissions, so the builder's umask cannot leak in

Usage: normalize-vsix.py <path.vsix> [<epoch>]
"""

import os
import shutil
import sys
import zipfile


def normalize(path: str, epoch: int) -> None:
    # ZIP timestamps cannot represent anything before 1980.
    ts = max(epoch, 315532800)
    date_time = tuple(__import__("time").gmtime(ts)[:6])

    tmp = path + ".normalized"
    with zipfile.ZipFile(path, "r") as src:
        entries = sorted(src.infolist(), key=lambda i: i.filename)
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as out:
            for info in entries:
                data = src.read(info.filename)
                clean = zipfile.ZipInfo(filename=info.filename, date_time=date_time)
                clean.compress_type = zipfile.ZIP_DEFLATED
                clean.create_system = 3  # unix, so attrs are stable across platforms
                clean.external_attr = (0o644 << 16) | (info.external_attr & 0xFF)
                if info.is_dir():
                    clean.external_attr = (0o755 << 16) | 0x10
                out.writestr(clean, data)

    shutil.move(tmp, path)


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2

    path = sys.argv[1]
    if len(sys.argv) > 2:
        epoch = int(sys.argv[2])
    else:
        epoch = int(os.environ.get("SOURCE_DATE_EPOCH", "315532800"))

    normalize(path, epoch)
    return 0


if __name__ == "__main__":
    sys.exit(main())
