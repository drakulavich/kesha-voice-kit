#!/usr/bin/env python3
"""Regenerate tone-no-eos.ogg, the #767 regression fixture.

The fixture is a 0.5 s Ogg/Opus tone whose final page has the end-of-stream
flag cleared, so symphonia never learns `n_frames` and `probe_duration_seconds`
reports `None` -- the container shape of every Russian benchmark voice message.

ffmpeg is required to regenerate, and only to regenerate: the fixture is
checked in, and neither the tests nor the engine shell out to ffmpeg. Output
is not bit-reproducible across ffmpeg/libopus builds (the vendor string and
VBR packet sizes drift), so re-run the rust tests after regenerating.

    python3 rust/tests/fixtures/regen-tone-no-eos.py
"""

import pathlib
import shutil
import struct
import subprocess
import sys
import tempfile

OUT = pathlib.Path(__file__).with_name("tone-no-eos.ogg")
EOS_FLAG = 0x04


def ogg_crc32(page: bytes) -> int:
    """Ogg's CRC-32: poly 0x04C11DB7, init 0, no reflection, no final xor."""
    crc = 0
    for byte in page:
        crc ^= byte << 24
        for _ in range(8):
            crc = ((crc << 1) ^ 0x04C11DB7) & 0xFFFFFFFF if crc & 0x80000000 else (crc << 1) & 0xFFFFFFFF
    return crc


def page_offsets(data: bytes) -> list[tuple[int, int]]:
    """Walk the page chain, yielding (offset, length) for each Ogg page."""
    pages = []
    off = 0
    while off < len(data):
        if data[off : off + 4] != b"OggS":
            raise SystemExit(f"not an Ogg stream: no capture pattern at byte {off}")
        segment_count = data[off + 26]
        header_len = 27 + segment_count
        body_len = sum(data[off + 27 : off + header_len])
        pages.append((off, header_len + body_len))
        off += header_len + body_len
    return pages


def clear_eos(data: bytes) -> bytes:
    offset, length = page_offsets(data)[-1]
    page = bytearray(data[offset : offset + length])
    if not page[5] & EOS_FLAG:
        raise SystemExit("last page already lacks the end-of-stream flag")
    page[5] &= ~EOS_FLAG
    page[22:26] = b"\0\0\0\0"
    page[22:26] = struct.pack("<I", ogg_crc32(bytes(page)))
    return data[:offset] + bytes(page)


def main() -> None:
    if shutil.which("ffmpeg") is None:
        raise SystemExit("ffmpeg is required to regenerate this fixture: brew install ffmpeg")
    with tempfile.TemporaryDirectory(prefix="kesha-regen-tone-") as tmp:
        raw = pathlib.Path(tmp) / "tone.ogg"
        subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5:sample_rate=16000",
                "-c:a", "libopus", "-ac", "1", "-b:a", "16k", str(raw),
            ],
            check=True,
        )
        OUT.write_bytes(clear_eos(raw.read_bytes()))
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)", file=sys.stderr)


if __name__ == "__main__":
    main()
