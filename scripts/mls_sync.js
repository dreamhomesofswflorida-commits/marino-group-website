// Marino Group – MLS sold-homes sync for the Home Value address lookup.
// Run inside a signed-in Matrix tab (https://matrix.swflamls.com/Matrix/Home) via the
// built-in browser's javascript tool. Set window.IK = '<ingest key>' first, then paste this
// file, then call:  await MLS_SYNC.start(10)   (days back)   and poll  MLS_SYNC.status()
// It exports closed Residential + Residential Income sales (UAD CSV) and upserts them
// into Supabase prop_facts through the ingest_props RPC. Read-only on the MLS side.
(() => {
  const SB = 'https://ssbnylpqoxnzwxhsmomc.supabase.co/rest/v1/rpc/ingest_props';
  const AK = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNzYm55bHBxb3huend4aHNtb21jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU4MzYyMTUsImV4cCI6MjExMTQxMjIxNX0.qFqwkKv7lpcNrm7_VzhBbGcNkafxh0PymWhCtAJjYh0';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const until = async (fn, ms = 90000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(500); } throw 'until timeout'; };
  const mkFrame = () => { let f = document.getElementById('xf'); if (f) f.remove(); f = document.createElement('iframe'); f.id = 'xf'; f.style.cssText = 'width:1200px;height:800px;position:fixed;left:-3000px;top:0'; document.body.appendChild(f); return f; };

  const CLASSES = [
    { name: 'residential', path: '/Matrix/Search/Residential/Residential', st: 'Fm10_Ctrl30_LB', days: 'FmFm10_Ctrl30_104_Ctrl30_TB', fmt: 'sd3225' },
    { name: 'income', path: '/Matrix/Search/ResidentialIncome', st: 'Fm13_Ctrl70_LB', days: 'FmFm13_Ctrl70_104_Ctrl70_TB', fmt: 'sd3226' },
  ];

  async function exportCsv(c, range) {
    const f = mkFrame(); f.src = c.path;
    await until(() => f.contentDocument?.getElementById(c.days) && f.contentDocument.readyState == 'complete'); await sleep(1500);
    let D = f.contentDocument, W = f.contentWindow;
    D.querySelectorAll(`input[name="${c.st}"]`).forEach(i => { const want = i.value == '104'; if (i.checked != want) i.click(); });
    const d = D.getElementById(c.days); d.value = range; d.dispatchEvent(new W.Event('change', { bubbles: true })); await sleep(2500);
    const cnt = D.getElementById('m_ucSearchButtons_m_lbLiveCount').innerText;
    if (/^0 /.test(cnt)) return { cnt, txt: '' };
    D.getElementById('m_ucSearchButtons_m_lbSearch').click();
    await until(() => f.contentDocument?.getElementById('m_lnkCheckAllLink') && f.contentDocument.readyState == 'complete'); await sleep(1500);
    f.contentDocument.getElementById('m_lnkCheckAllLink').click();
    await until(() => /Checked [1-9]/.test(f.contentDocument.getElementById('m_lblCheckedCount')?.innerText || '')); await sleep(1000);
    f.contentDocument.getElementById('m_lbExport').click();
    await until(() => f.contentDocument?.getElementById('m_ddExport') && f.contentDocument.readyState == 'complete');
    D = f.contentDocument; D.getElementById('m_ddExport').value = c.fmt;
    const form = D.forms[0]; const fd = new FormData(form); fd.set('__EVENTTARGET', 'm_btnExport'); fd.set('__EVENTARGUMENT', '');
    const txt = await (await fetch(form.action, { method: 'POST', body: fd, credentials: 'include' })).text();
    return { cnt, txt };
  }

  const parseCSV = t => { const rows = []; let r = [], f = '', q = false; for (let i = 0; i < t.length; i++) { const c = t[i]; if (q) { if (c == '"') { if (t[i + 1] == '"') { f += '"'; i++ } else q = false } else f += c } else if (c == '"') q = true; else if (c == ',') { r.push(f); f = '' } else if (c == '\n') { r.push(f.replace(/\r$/, '')); rows.push(r); r = []; f = '' } else f += c } if (f || r.length) { r.push(f); rows.push(r) } return rows };
  const ptype = d => /Single/i.test(d) ? 'Single family' : /Rise|Condo/i.test(d) ? 'Condo' : /Town/i.test(d) ? 'Townhouse' : /Villa/i.test(d) ? 'Villa' : /Manuf|Mobile/i.test(d) ? 'Manufactured' : /Duplex|Triplex|Quad|Multi/i.test(d) ? 'Multifamily' : d;
  const n = s => { const v = parseInt(String(s).replace(/[^\d]/g, '')); return isNaN(v) ? '' : String(v) };

  function toRows(txt, income) {
    const a = parseCSV(txt); if (!a.length) return [];
    const h = a[0].map(s => s.trim()); const g = (r, k) => (r[h.indexOf(k)] || '').trim();
    // Residential UAD uses CamelCase headers, Income UAD uses spaced headers.
    const F = income
      ? { num: 'Street Number', pre: 'Street Dir Prefix', name: 'Street Name', suf: 'Street Suffix', post: 'Street Dir Suffix', unit: 'Unit Number', zip: 'Zip Code', city: 'City', design: 'Building Design', beds: 'Bedrooms', bf: 'Baths Full', bh: 'Baths Half', sqft: '-', year: 'Year Built', sub: 'Sub Condo Name', date: 'Sold Date', price: '-' }
      : { num: 'StreetNumber', pre: 'StreetDirPrefix', name: 'StreetName', suf: 'StreetSuffix', post: 'StreetDirSuffix', unit: 'UnitNumber', zip: 'PostalCode', city: 'City', design: 'BuildingDesign', beds: 'Bedrooms', bf: 'BathsFull', bh: 'BathsHalf', sqft: 'ApproxLivingArea', year: 'YearBuilt', sub: 'SubCondoName', date: 'CloseDate', price: 'ClosePrice' };
    const out = new Map();
    a.slice(1).filter(r => r.length > 5).forEach(r => {
      const addr = [g(r, F.num), g(r, F.pre), g(r, F.name), g(r, F.suf), g(r, F.post)].filter(Boolean).join(' ').toUpperCase().replace(/\s+/g, ' ');
      const unit = g(r, F.unit).toUpperCase(), zip = g(r, F.zip).slice(0, 5); if (!addr || !zip) return;
      const m = g(r, F.date).match(/(\d+)\/(\d+)\/(\d{4})/); const ds = m ? m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0') : '';
      const d = g(r, F.design);
      const row = { k: addr + '|' + unit + '|' + zip, a: addr, u: unit, c: g(r, F.city).toUpperCase(), z: zip, t: income ? 'Multifamily' : ptype(d), d, b: n(g(r, F.beds)), bf: n(g(r, F.bf)), bh: n(g(r, F.bh)), s: n(g(r, F.sqft)), y: n(g(r, F.year)), cm: g(r, F.sub).toUpperCase(), ds, p: n(g(r, F.price)), src: 'mls' };
      const o = out.get(row.k); if (!o || row.ds > o.ds) out.set(row.k, row);
    });
    return [...out.values()];
  }

  async function ingest(rows) {
    let total = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const r = await fetch(SB, { method: 'POST', headers: { apikey: AK, Authorization: 'Bearer ' + AK, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_key: window.IK, p_rows: rows.slice(i, i + 500) }) });
      const t = await r.text(); if (!r.ok) throw 'ingest ' + t.slice(0, 200); total += +t;
    }
    return total;
  }

  const S = { log: [], done: false };
  window.MLS_SYNC = {
    status: () => ({ done: S.done, log: S.log }),
    start(daysBack = 10) {
      if (!window.IK) throw 'set window.IK first';
      S.log = []; S.done = false;
      (async () => {
        for (const c of CLASSES) {
          // 30-day slices keep each export under Matrix's 5,000-row limit
          for (let s = 0; s < daysBack; s += 30) {
            const range = s + '-' + Math.min(s + 29, daysBack - 1);
            for (let tries = 0; tries < 2; tries++) {
              try { const x = await exportCsv(c, range); const rows = toRows(x.txt, c.name == 'income'); const up = rows.length ? await ingest(rows) : 0; S.log.push(`${c.name} ${range}: ${x.cnt}, saved ${up}`); break; }
              catch (e) { S.log.push(`${c.name} ${range}: ERROR ${String(e).slice(0, 120)}`); await sleep(5000); }
            }
          }
        }
        document.getElementById('xf')?.remove(); S.done = true;
      })();
      return 'started';
    },
  };
})();
