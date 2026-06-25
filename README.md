# The Forever Winter — Map Atlas

A fast, installable, **offline** viewer for every interactive map in
*The Forever Winter*. It wraps the same map data, tiles and marker icons used by
the [official wiki](https://theforeverwinter.wiki.gg/wiki/Maps) (which ships them
through the wiki.gg **DataMaps** extension) into one clean, full-screen app —
instead of being buried in nested tabs on a wiki page.

**39 maps**, all browsable from one menu:

- **10 surface regions** — Ashen Mesa, Scorched Enclave, Elephant Mausoleum,
  Mech Trenches, Scrapyard Nexus, Frozen Swamp, Stairway Gate, Babel,
  Downtown Lost Angels, Underground Cemetery
- **16 tunnels** — Tunnel A1–A4, B1–B4, C1–C4, D1–D4 (plus a combined Tunnels map)
- **12 aerial reference maps**

## Features

- 🗺️ Zoom/pan interactive maps (Leaflet), faithful to the wiki layout
- 🎚️ Toggle marker layers — spawns, extractions, loot crates, water, explosives,
  lockboxes, bosses/events, etc. (with **Show all / Hide all / Defaults**)
- 🔍 Search markers by name on the current map and fly straight to them
- 🌓 Background switches where the wiki has them (e.g. *Show toxic water*,
  *Show coordinates*)
- 📌 Marker popups with screenshots, notes and a link to the wiki article
- 📱 **Installable PWA** — add it to a phone/tablet/second monitor home screen
- ✈️ **Works offline** — all tiles and icons are bundled; tap *Save all maps
  offline* once to guarantee everything is cached

## Use it

Open the published page (GitHub Pages) and, optionally, install it:

- **Desktop (Chrome/Edge):** click the install icon in the address bar.
- **Android (Chrome):** menu → *Add to Home screen*.
- **iOS (Safari):** Share → *Add to Home Screen*.

Then hit **⤓ Save all maps offline** once so it keeps working with no internet —
handy on a second screen while playing.

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| `M` | toggle the Maps panel |
| `L` | toggle the Layers panel |
| `/` | focus search |
| `Esc` | clear search |

## Updating the data

If the wiki adds maps or moves markers, re-pull everything (needs Python 3):

```bash
python tools/fetch_maps.py     # refetches map JSON + images, rebuilds manifests
```

It pulls every page in the wiki's `Map:` namespace, saves the source JSON to
`data/`, downloads all referenced tiles/icons/photos to `assets/img/`, and
regenerates `manifest.json` (the map list) and `assets/img-list.json` (the
offline cache list). It skips images already on disk and backs off politely on
rate limits.

The PWA icons can be regenerated with `node tools/make_icons.mjs`.

## How it works

Each wiki map is a JSON document (DataMaps schema) describing a tiled or single
background image plus marker groups in image-pixel coordinates. The viewer
(`app.js`) renders them with Leaflet using `CRS.Simple`, placing both the
background tiles and the markers in that same pixel space. No build step, no
framework — just static files.

```
index.html · app.js · styles.css   the app
sw.js · manifest.webmanifest        PWA / offline
data/*.json                         per-map source data (from the wiki)
assets/img/*                        bundled tiles, marker icons, popup photos
assets/vendor/                      Leaflet (vendored for offline use)
tools/                              data fetcher + icon generator
```

## Credits & licence

Map data, tiles and icons come from **The Forever Winter Wiki**
(theforeverwinter.wiki.gg) and its contributors, available under
**CC BY-SA 3.0**. This project is an unofficial, fan-made convenience wrapper and
is not affiliated with Fun Dog Studios or wiki.gg. *The Forever Winter* is a
trademark of its respective owner.

The viewer code in this repository is provided as-is for personal use.
