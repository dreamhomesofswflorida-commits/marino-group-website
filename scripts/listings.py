#!/usr/bin/env python3
"""Daily listings sync for marinogroupswfl.com (runs on GitHub Actions).
Reads the Marino Group MLS listings page (SWFL MLS IDX), saves each home's main photo
into listings/img/, and writes listings/listings.json for the photo cards on the homepage.
Standard library only. Usage: listings.py [saved_page.html]   (no argument = download the page)"""
import html, json, os, re, sys, urllib.request

IDX_URL = "https://matrix.swflamls.com/Matrix/public/IDX.aspx?idx=90081c45"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "listings")
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MarinoGroupListings/1.0"}

def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return r.read()

def text(fragment):
    t = re.sub(r"<[^>]+>", " ", fragment)
    return re.sub(r"\s+", " ", html.unescape(t)).strip()

def parse(page):
    parts = re.split(r"<!--@Record:(\d+)@-->", page)
    out = []
    for i in range(1, len(parts) - 1, 2):
        key, block = parts[i], parts[i + 1]
        spans = [html.unescape(v).strip() for _, v in re.findall(r'<span class="([^"]*)"[^>]*>([^<]*)</span>', block)]
        t = " | ".join(x for x in spans if x)
        price = re.search(r"\$[\d,]+", t)
        if not price:
            continue
        num = int(re.sub(r"\D", "", price.group(0)))
        beds = re.search(r"(\d+)(?:\s*Bed|\+Den)", t)
        baths = re.search(r"\|\s*(\d+(?:\.\d+)?)\s*\|\s*Baths?", t)
        sqft = re.search(r"([\d,]+)\s*\|\s*Liv Area", t)
        acres = re.search(r"([\d.]+)\s*\|\s*Acres", t)
        built = re.search(r"Built in\s*\|\s*(\d{4})", t)
        kind = re.search(r"(?:Liv Area|Frontage)\s*\|\s*([^|]+?)\s*\|", t)
        cityzip = re.search(r"([A-Za-z .'-]+),\s*(\d{5})", t)
        street = [html.unescape(x).strip() for x in re.findall(r"<a[^>]*>([^<]{3,})</a>", block) if re.search(r"\d", x)]
        img = re.search(r'<img[^>]+src="(https://matrixmedia[^"]+)"', block)
        out.append({
            "id": key,
            "price": price.group(0),
            "priceNum": num,
            "rent": num < 20000,
            "beds": int(beds.group(1)) if beds else None,
            "den": "+Den" in t,
            "baths": baths.group(1) if baths else None,
            "sqft": sqft.group(1) if sqft else None,
            "acres": acres.group(1) if acres else None,
            "type": kind.group(1).strip() if kind else "",
            "built": built.group(1) if built else None,
            "street": street[0] if street else "",
            "city": cityzip.group(1).strip() if cityzip else "",
            "zip": cityzip.group(2) if cityzip else "",
            "photoSrc": html.unescape(img.group(1)) if img else "",
        })
    return out

def main():
    page = open(sys.argv[1], encoding="utf-8", errors="ignore").read() if len(sys.argv) > 1 else get(IDX_URL).decode("utf-8", "ignore")
    homes = parse(page)
    if not homes:
        print("No listings found; leaving the current files alone.")
        return 1
    os.makedirs(os.path.join(ROOT, "img"), exist_ok=True)
    keep = set()
    for h in homes:
        src = h.pop("photoSrc")
        name = h["id"] + ".jpg"; dest = os.path.join(ROOT, "img", name)
        try:  # a photo failure never drops a listing
            if src and (not os.path.exists(dest) or os.path.getsize(dest) < 40000):
                best = b""
                for size in ("Size=5", "Size=4", "Size=3", "Size=2"):  # keep the sharpest photo the MLS gives
                    try:
                        data = get(src.replace("Size=2", size))
                    except Exception:
                        continue
                    if data[:2] == b"\xff\xd8" and len(data) > len(best):
                        best = data
                if best and (not os.path.exists(dest) or len(best) > os.path.getsize(dest)):
                    open(dest, "wb").write(best)
            if os.path.exists(dest):
                h["photo"] = "listings/img/" + name; keep.add(name)
        except Exception as e:
            print("photo failed", h["id"], e)
    for f in os.listdir(os.path.join(ROOT, "img")):
        if f not in keep:
            os.remove(os.path.join(ROOT, "img", f))
    homes.sort(key=lambda h: (h["rent"], -h["priceNum"]))
    json.dump({"source": IDX_URL, "count": len(homes), "homes": homes}, open(os.path.join(ROOT, "listings.json"), "w"), indent=1)
    print(f"{len(homes)} listings saved")
    return 0

if __name__ == "__main__":
    sys.exit(main())
