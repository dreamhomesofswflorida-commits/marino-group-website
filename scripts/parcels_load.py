import json, os, re, sys, time, urllib.request, urllib.parse

SB = "https://ssbnylpqoxnzwxhsmomc.supabase.co/rest/v1/rpc/ingest_parcels"
AK = os.environ.get('ANON_KEY') or re.search(r'SUPABASE_ANON_KEY\s*:\s*"([^"]+)"', open(os.path.join(os.path.dirname(__file__), '..', 'js', 'config.js')).read()).group(1)
IK = os.environ['INGEST_KEY']
LEE = "https://services2.arcgis.com/LvWGAAhHwbCJ2GMP/ArcGIS/rest/services/Lee_County_Parcels/FeatureServer/0/query"
FL = "https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Cadastral/FeatureServer/0/query"


def get(url, params, tries=5):
    data = urllib.parse.urlencode(params).encode()
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data=data), timeout=120) as r:
                j = json.load(r)
            if 'error' in j:
                raise Exception(str(j['error'])[:200])
            return j
        except Exception as e:
            print('retry', i, e, flush=True)
            time.sleep(5 * (i + 1))
    raise Exception('failed ' + str(params.get('where')))


def push(rows):
    if len(rows) > 500:
        return sum(push(rows[i:i + 500]) for i in range(0, len(rows), 500))
    if not rows:
        return 0
    body = json.dumps({"p_key": IK, "p_rows": rows}).encode()
    req = urllib.request.Request(SB, data=body, headers={"apikey": AK, "Authorization": "Bearer " + AK, "Content-Type": "application/json"})
    for i in range(5):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return int(r.read())
        except Exception as e:
            print('push retry', i, e, flush=True)
            time.sleep(5)
    return 0


def norm(s):
    return re.sub(r'\s+', ' ', (s or '').upper().strip())


def split_unit(addr, unit):
    addr = norm(addr)
    unit = norm(unit)
    m = re.match(r'^(.*?)\s+(?:#|UNIT |APT |STE |BLDG )\s*([\w-]+)$', addr)
    if m:
        addr, unit = m.group(1), unit or m.group(2)
    unit = re.sub(r'^(#|UNIT|APT|STE)\s*', '', unit)
    return addr, unit


def num(v):
    try:
        if v is None:
            return ''
        f = float(v)
        return '' if f <= 0 else str(int(round(f)))
    except Exception:
        return ''


def load_lee():
    off, total = 0, 0
    flds = "SITEADDR,SITEUNIT,SITECITY,SITEZIP,DORCODE,BEDROOMS,BATHROOMS,HEATEDAREA,MINBUILTY,NUMUNITS"
    while True:
        j = get(LEE, {"where": "DORCODE IN ('01','02','03','04','05','08') AND SITEADDR IS NOT NULL", "outFields": flds,
                      "returnGeometry": "false", "orderByFields": "OBJECTID", "resultOffset": off, "resultRecordCount": 2000, "f": "json"})
        feats = j.get('features', [])
        rows = []
        for f in feats:
            a = f['attributes']
            addr, unit = split_unit(a.get('SITEADDR'), a.get('SITEUNIT'))
            zip5 = str(a.get('SITEZIP') or '')[:5]
            if not addr or not zip5 or not addr[0].isdigit():
                continue
            b = a.get('BATHROOMS')
            rows.append({"k": f"{addr}|{unit}|{zip5}", "a": addr, "u": unit, "c": norm(a.get('SITECITY')), "z": zip5, "co": "Lee",
                         "dor": a.get('DORCODE') or '', "b": num(a.get('BEDROOMS')), "ba": (str(b) if b and b > 0 else ''),
                         "s": num(a.get('HEATEDAREA')), "y": num(a.get('MINBUILTY')), "n": num(a.get('NUMUNITS'))})
        total += push(rows)
        print('lee', off, len(feats), total, flush=True)
        if len(feats) < 2000 and not j.get('exceededTransferLimit'):
            break
        off += len(feats)


def load_fl(co, name, ucs=('001', '002', '003', '004', '005', '008'), start=0):
    total = 0
    for uc in ucs:
        last = start; start = 0
        while True:
            j = get(FL, {"where": f"CO_NO={co} AND DOR_UC='{uc}' AND OBJECTID>{last}", "outFields": "OBJECTID,PHY_ADDR1,PHY_ADDR2,PHY_CITY,PHY_ZIPCD,DOR_UC,TOT_LVG_AR,ACT_YR_BLT,NO_RES_UNT",
                         "returnGeometry": "false", "orderByFields": "OBJECTID", "resultRecordCount": 2000, "f": "json"})
            feats = j.get('features', [])
            if not feats:
                break
            rows = []
            for f in feats:
                a = f['attributes']
                last = max(last, a['OBJECTID'])
                addr, unit = split_unit(a.get('PHY_ADDR1'), a.get('PHY_ADDR2'))
                zip5 = num(a.get('PHY_ZIPCD'))[:5]
                if not addr or len(zip5) != 5 or not addr[0].isdigit():
                    continue
                rows.append({"k": f"{addr}|{unit}|{zip5}", "a": addr, "u": unit, "c": norm(a.get('PHY_CITY')), "z": zip5, "co": name,
                             "dor": uc, "b": "", "ba": "", "s": num(a.get('TOT_LVG_AR')), "y": num(a.get('ACT_YR_BLT')), "n": num(a.get('NO_RES_UNT'))})
            total += push(rows)
            print(name, uc, last, len(feats), total, flush=True)
            if len(feats) < 2000 and not j.get('exceededTransferLimit'):
                break


if __name__ == '__main__':
    w = sys.argv[1]
    if w == 'lee':
        load_lee()
    elif w == 'collier':
        load_fl(21, 'Collier', sys.argv[2].split(','), int(sys.argv[3]) if len(sys.argv) > 3 else 0)
    elif w == 'charlotte':
        load_fl(18, 'Charlotte', sys.argv[2].split(','), int(sys.argv[3]) if len(sys.argv) > 3 else 0)
    print('DONE', w, flush=True)


def load_range(co, name, lo, hi, ucs="'002','003','004','005','008'"):
    total = 0
    a0 = lo
    while a0 < hi:
        j = get(FL, {"where": f"OBJECTID>{a0} AND OBJECTID<={a0 + 2000} AND CO_NO={co} AND DOR_UC IN ({ucs})",
                     "outFields": "OBJECTID,PHY_ADDR1,PHY_ADDR2,PHY_CITY,PHY_ZIPCD,DOR_UC,TOT_LVG_AR,ACT_YR_BLT,NO_RES_UNT",
                     "returnGeometry": "false", "resultRecordCount": 2000, "f": "json"})
        rows = []
        for f in j.get('features', []):
            a = f['attributes']
            addr, unit = split_unit(a.get('PHY_ADDR1'), a.get('PHY_ADDR2'))
            zip5 = num(a.get('PHY_ZIPCD'))[:5]
            if not addr or len(zip5) != 5 or not addr[0].isdigit():
                continue
            rows.append({"k": f"{addr}|{unit}|{zip5}", "a": addr, "u": unit, "c": norm(a.get('PHY_CITY')), "z": zip5, "co": name,
                         "dor": a.get('DOR_UC'), "b": "", "ba": "", "s": num(a.get('TOT_LVG_AR')), "y": num(a.get('ACT_YR_BLT')), "n": num(a.get('NO_RES_UNT'))})
        total += push(rows)
        a0 += 2000
        print(name, 'range', a0, len(rows), total, flush=True)
    print('DONE range', name, flush=True)


# Full refresh of all three counties:  INGEST_KEY=... python3 scripts/parcels_load.py all
if __name__ == '__main__' and sys.argv[1:] == ['all']:
    load_lee()
    load_range(21, 'Collier', 1900000, 2400000, "'001','002','003','004','005','008'")
    load_range(18, 'Charlotte', 1400000, 1700000, "'001','002','003','004','005','008'")
    print('DONE all', flush=True)
