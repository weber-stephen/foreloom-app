#!/usr/bin/env python3
"""Restore and verify the pinned offline place index for desktop builds."""

import gzip
import hashlib
import shutil
import sqlite3
from contextlib import closing
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RESOURCE = ROOT / 'src-tauri' / 'resources' / 'gazetteer.sqlite'
ARCHIVE = RESOURCE.with_suffix('.sqlite.gz')
ARCHIVE_SHA256 = '9a889d4f7ea33a8ca1ab436172c6f239709c77ce93e01987b725d0f6da78fe6a'
RESOURCE_SHA256 = '5e443b72adfd4e4b6536fe3cb7776e4e30b34286f4e37c70bb241fdd38cb9de5'


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def validate(path: Path) -> None:
    if sha256(path) != RESOURCE_SHA256:
        raise SystemExit('Gazetteer checksum mismatch')
    with closing(sqlite3.connect(f'{path.resolve().as_uri()}?mode=ro', uri=True)) as db:
        if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise SystemExit('Gazetteer SQLite integrity check failed')
        if db.execute('SELECT count(*) FROM places').fetchone()[0] < 100_000:
            raise SystemExit('Gazetteer place table is incomplete')
        if db.execute('SELECT count(*) FROM place_names').fetchone()[0] < 100_000:
            raise SystemExit('Gazetteer place-name table is incomplete')


def main() -> None:
    if not ARCHIVE.is_file() or sha256(ARCHIVE) != ARCHIVE_SHA256:
        raise SystemExit('Pinned gazetteer archive is missing or has a checksum mismatch')
    if RESOURCE.is_file() and sha256(RESOURCE) == RESOURCE_SHA256:
        validate(RESOURCE)
        print(f'Gazetteer ready: {RESOURCE}')
        return
    temporary = RESOURCE.with_suffix('.sqlite.tmp')
    try:
        with gzip.open(ARCHIVE, 'rb') as source, temporary.open('wb') as target:
            shutil.copyfileobj(source, target)
        validate(temporary)
        temporary.replace(RESOURCE)
    finally:
        temporary.unlink(missing_ok=True)
    print(f'Gazetteer ready: {RESOURCE}')


if __name__ == '__main__':
    main()
