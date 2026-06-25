#!/usr/bin/env python3
"""
Fetch every interactive map (Map: namespace) from the Forever Winter wiki.gg
DataMaps install, save the source JSON locally, and download all referenced
images (background tiles + marker icons) so the viewer works fully offline.

Stdlib only. Re-runnable: skips images already on disk.
"""
import json, os, re, sys, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE = "https://theforeverwinter.wiki.gg"
NS_MAP = 2900
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
IMG_DIR = os.path.join(ROOT, "assets", "img")
UA = "ForeverWinterMapsArchiver/1.0 (personal offline viewer)"

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(IMG_DIR, exist_ok=True)


def http_get(url, binary=False, tries=6):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            return data if binary else data.decode("utf-8")
        except urllib.error.HTTPError as e:  # noqa
            last = e
            if e.code == 429:  # rate limited: back off hard
                wait = int(e.headers.get("Retry-After") or 0) or (4 * (i + 1))
                time.sleep(min(wait, 30))
            else:
                time.sleep(1.5 * (i + 1))
        except Exception as e:  # noqa
            last = e
            time.sleep(1.5 * (i + 1))
    raise last


def list_map_pages():
    titles, cont = [], ""
    while True:
        url = (f"{BASE}/api.php?action=query&list=allpages&apnamespace={NS_MAP}"
               f"&aplimit=500&format=json&apcontinue={urllib.parse.quote(cont)}")
        d = json.loads(http_get(url))
        titles += [p["title"] for p in d["query"]["allpages"]]
        cont = d.get("continue", {}).get("apcontinue")
        if not cont:
            break
    return titles


def slugify(title):
    # "Map:Downtown Lost Angels" -> "downtown-lost-angels"
    name = title.split(":", 1)[1] if title.startswith("Map:") else title
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def img_filename(ref):
    """Normalize an image reference to a stable on-disk filename."""
    ref = ref.strip().replace(" ", "_")
    # MediaWiki capitalises the first letter of file names.
    return ref[:1].upper() + ref[1:] if ref else ref


def classify(name):
    if name.endswith("Aerial"):
        return "aerial"
    if re.match(r"^Tunnel [A-D]\d", name) or name == "Tunnels":
        return "tunnel"
    return "surface"


def collect_images(mapjson):
    refs = set()
    bg = mapjson.get("background")
    backgrounds = mapjson.get("backgrounds") or ([bg] if bg else [])
    for b in backgrounds:
        if not b:
            continue
        if b.get("image"):
            refs.add(b["image"])
        for t in b.get("tiles", []) or []:
            if t.get("image"):
                refs.add(t["image"])
        for o in b.get("overlays", []) or []:
            if o.get("image"):
                refs.add(o["image"])
    for g in (mapjson.get("groups") or {}).values():
        if g.get("icon"):
            refs.add(g["icon"])
        if g.get("overrideIcon"):
            refs.add(g["overrideIcon"])
    for cat in (mapjson.get("categories") or {}).values():
        if cat.get("overrideIcon"):
            refs.add(cat["overrideIcon"])
    for arr in (mapjson.get("markers") or {}).values():
        for m in arr:
            if isinstance(m, dict):
                if m.get("icon"):
                    refs.add(m["icon"])
                if m.get("image"):  # popup photo (boss/item screenshot)
                    refs.add(m["image"])
    return {img_filename(r) for r in refs if r}


def download_image(fname):
    dest = os.path.join(IMG_DIR, fname)
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return ("skip", fname)
    time.sleep(0.2)  # be polite to the wiki
    url = f"{BASE}/wiki/Special:FilePath/{urllib.parse.quote(fname)}"
    try:
        data = http_get(url, binary=True)
        if len(data) < 100:
            return ("tiny", fname)
        with open(dest, "wb") as f:
            f.write(data)
        return ("ok", fname)
    except Exception as e:  # noqa
        return (f"FAIL:{e}", fname)


def main():
    print("Listing Map: pages ...")
    titles = list_map_pages()
    candidates = [t for t in titles if not t.endswith("/doc")
                  and t != "Map:Default categories"
                  and not t.startswith("Map:Map:")]
    print(f"  {len(titles)} pages, {len(candidates)} map candidates")

    manifest, all_imgs = [], set()
    for title in sorted(candidates):
        name = title.split(":", 1)[1]
        try:
            raw = http_get(f"{BASE}/wiki/{urllib.parse.quote(title.replace(' ', '_'))}?action=raw")
            mj = json.loads(raw)
        except Exception as e:  # noqa
            print(f"  SKIP {title}: {e}")
            continue
        if mj.get("$fragment") or not (mj.get("background") or mj.get("backgrounds")):
            print(f"  skip (fragment/no-bg) {title}")
            continue
        slug = slugify(title)
        with open(os.path.join(DATA_DIR, slug + ".json"), "w", encoding="utf-8") as f:
            json.dump(mj, f, ensure_ascii=False)
        imgs = collect_images(mj)
        all_imgs |= imgs
        nmark = sum(len(v) for v in (mj.get("markers") or {}).values())
        manifest.append({"id": slug, "name": name, "type": classify(name),
                         "file": f"data/{slug}.json", "markers": nmark,
                         "images": len(imgs)})
        # flag anything that needs fragment resolution
        for k in ("include", "$mixin", "mixins"):
            if k in mj:
                print(f"  NOTE {title} has '{k}': {mj[k]}")
        print(f"  + {name:28s} type={classify(name):7s} markers={nmark:4d} imgs={len(imgs)}")

    manifest.sort(key=lambda m: (["surface", "tunnel", "aerial"].index(m["type"]), m["name"]))
    with open(os.path.join(ROOT, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump({"generated": time.strftime("%Y-%m-%d"), "maps": manifest}, f,
                  ensure_ascii=False, indent=1)
    print(f"\n{len(manifest)} maps saved. {len(all_imgs)} unique images to fetch ...")

    results = {}
    with ThreadPoolExecutor(max_workers=3) as ex:
        futs = {ex.submit(download_image, fn): fn for fn in sorted(all_imgs)}
        done = 0
        for fut in as_completed(futs):
            status, fn = fut.result()
            results[status.split(":")[0]] = results.get(status.split(":")[0], 0) + 1
            done += 1
            if status.startswith("FAIL") or status == "tiny":
                print(f"   !{status}  {fn}")
            if done % 25 == 0:
                print(f"   ... {done}/{len(all_imgs)}")
    print("\nImage results:", results)

    # image list used by the service worker for full "Save all offline"
    on_disk = sorted(f for f in os.listdir(IMG_DIR)
                     if os.path.isfile(os.path.join(IMG_DIR, f)))
    with open(os.path.join(ROOT, "assets", "img-list.json"), "w", encoding="utf-8") as f:
        json.dump({"count": len(on_disk), "images": ["assets/img/" + n for n in on_disk]},
                  f, indent=0)
    print(f"img-list.json: {len(on_disk)} images")
    print("DONE.")


if __name__ == "__main__":
    main()
