# Bundled third-party material

The root MIT license covers ForeLoom app code. The project owner created the ForeLoom brand artwork. The following bundled material has separate terms. The bundled gazetteer was built from GeoNames country, administrative area, and cities500 files with `scripts/build_gazetteer.py`. The script and SQLite index do not record when those inputs were downloaded or their version. The bundled archive has a November 5, 2026 file timestamp, which does not date the GeoNames snapshot; no comparison with historical GeoNames downloads has been made. The map files have Natural Earth-style fields, but no map-generation script or source snapshot is present.

| Material | Location | Attribution and terms |
|---|---|---|
| GeoNames place data | `src-tauri/resources/gazetteer.sqlite.gz` | [GeoNames](https://www.geonames.org/) country, administrative area, and cities500 data, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); transformed by `scripts/build_gazetteer.py` and expanded for desktop builds by `scripts/prepare_gazetteer.py` |
| Country and regional boundaries, world map | `public/maps/` | [Natural Earth 1:10m cultural vectors](https://www.naturalearthdata.com/downloads/10m-cultural-vectors/), [public domain](https://www.naturalearthdata.com/about/terms-of-use/) |
| Cormorant Garamond and Source Sans 3 fonts | `src/assets/fonts/` | SIL Open Font License 1.1; full notices in the same directory |
| Heroicons and Material Symbols fallback icons | `src/assets/` | Heroicons MIT and Material Symbols Apache 2.0; see the [icon notice](../src/assets/HEROICONS_LICENSE.md) and bundled license texts |
