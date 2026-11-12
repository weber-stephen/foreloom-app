#!/usr/bin/env python3
"""Build ForeLoom's compact, offline GeoNames-derived gazetteer."""
import csv
import sqlite3
import sys
from pathlib import Path

if len(sys.argv) != 3:
    raise SystemExit('usage: build_gazetteer.py <geonames-dir> <output.sqlite>')

source = Path(sys.argv[1])
output = Path(sys.argv[2])
output.parent.mkdir(parents=True, exist_ok=True)
if output.exists(): output.unlink()
db = sqlite3.connect(output)
db.executescript('''
PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
CREATE TABLE places(id TEXT PRIMARY KEY, level TEXT NOT NULL, parent_id TEXT, country_code TEXT NOT NULL, admin1_code TEXT, admin2_code TEXT, name TEXT NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL);
CREATE TABLE place_names(normalized TEXT NOT NULL, place_id TEXT NOT NULL REFERENCES places(id));
CREATE INDEX idx_place_names_normalized ON place_names(normalized);
CREATE INDEX idx_places_parent ON places(parent_id);
''')

def norm(value):
    return ' '.join(''.join(ch.lower() if ch.isalnum() or ch.isspace() else ' ' for ch in value).split())

def add(place_id, level, parent_id, country, admin1, admin2, name, lat, lon, aliases=()):
    db.execute('INSERT OR IGNORE INTO places VALUES(?,?,?,?,?,?,?,?,?)', (place_id, level, parent_id, country, admin1, admin2, name, lat, lon))
    for alias in {name, *aliases}:
        value = norm(alias)
        if value: db.execute('INSERT INTO place_names VALUES(?,?)', (value, place_id))

countries = {}
with open(source / 'countryinfo.txt', encoding='utf-8') as f:
    for row in csv.reader((line for line in f if not line.startswith('#')), delimiter='\t'):
        if len(row) < 9: continue
        code, name, capital = row[0], row[4], row[5]
        if not code: continue
        place_id = f'country:{code}'
        countries[code] = place_id
        add(place_id, 'country', None, code, None, None, name, 0, 0, [capital])

regions = {}
with open(source / 'admin1.txt', encoding='utf-8') as f:
    for row in csv.reader(f, delimiter='\t'):
        if len(row) < 4: continue
        key, name, ascii_name = row[:3]
        parts = key.split('.', 1)
        if len(parts) != 2 or parts[0] not in countries: continue
        country, code = parts
        place_id = f'region:{key}'
        regions[key] = place_id
        add(place_id, 'region', countries[country], country, code, None, name, 0, 0, [ascii_name])

counties = {}
with open(source / 'admin2.txt', encoding='utf-8') as f:
    for row in csv.reader(f, delimiter='\t'):
        if len(row) < 4: continue
        key, name, ascii_name = row[:3]
        parts = key.split('.')
        if len(parts) != 3 or parts[0] not in countries: continue
        country, admin1, admin2 = parts
        place_id = f'county:{key}'
        counties[key] = place_id
        add(place_id, 'county', regions.get(f'{country}.{admin1}', countries[country]), country, admin1, admin2, name, 0, 0, [ascii_name])

with open(source / 'cities500.txt', encoding='utf-8') as f:
    for row in csv.reader(f, delimiter='\t'):
        if len(row) < 12 or row[6] != 'P': continue
        geoname_id, name, ascii_name, alternate, lat, lon, _, _, country, _, admin1, admin2 = row[:12]
        if country not in countries: continue
        parent = counties.get(f'{country}.{admin1}.{admin2}') or regions.get(f'{country}.{admin1}') or countries[country]
        add(f'locality:{geoname_id}', 'locality', parent, country, admin1, admin2, name, float(lat), float(lon), [ascii_name, *alternate.split(',')[:30]])

db.commit()
db.execute('VACUUM')
db.close()
