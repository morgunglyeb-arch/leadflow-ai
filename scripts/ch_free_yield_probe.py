#!/usr/bin/env python3
"""Measure the FREE Companies-House-seed yield: CH advanced-search -> guess/resolve
website (no paid API) -> scrape email. Answers: does the $0 path lose quality?"""
import os, re, sys, time, urllib.parse, urllib.request, ssl, json

CH = None
for line in open(os.path.join(os.path.dirname(__file__), "..", ".env")):
    if line.strip().startswith("COMPANIES_HOUSE_API_KEY="):
        CH = line.split("=", 1)[1].strip().strip('"').split("#")[0].strip()
        break

ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"

def get(url, headers=None, timeout=8):
    req = urllib.request.Request(url, headers=headers or {"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            return r.getcode(), r.read().decode("utf-8", "ignore")
    except Exception as e:
        return None, str(e)

def ch_search(sic, size=20):
    auth = urllib.request.Request(
        f"https://api.company-information.service.gov.uk/advanced-search/companies?sic_codes={sic}&company_status=active&size={size}",
        headers={"accept": "application/json"})
    import base64
    auth.add_header("Authorization", "Basic " + base64.b64encode(f"{CH}:".encode()).decode())
    try:
        with urllib.request.urlopen(auth, timeout=12) as r:
            return json.load(r).get("items", [])
    except Exception as e:
        print("CH error", e); return []

STOP = {"ltd","limited","llp","the","and","&","co","group","services","service","uk","solicitors","accountants","associates"}
def tokens(name):
    return [w for w in re.sub(r"[^a-z0-9 ]"," ",name.lower()).split() if len(w)>=3 and w not in STOP]

def domain_candidates(name):
    base = re.sub(r"\b(ltd|limited|llp)\b","",name.lower())
    base = re.sub(r"[^a-z0-9 ]"," ",base).split()
    joined = "".join(base); hyph = "-".join(base)
    cands = []
    for stem in [joined, hyph, "".join(base[:2]) if len(base)>1 else joined]:
        if not stem: continue
        for tld in [".co.uk",".com",".uk",".org.uk"]:
            cands.append(stem+tld)
    seen=set(); out=[]
    for c in cands:
        if c not in seen: seen.add(c); out.append(c)
    return out[:8]

EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")
def scrape_email(domain):
    for path in ["","/contact","/contact-us","/about"]:
        code, html = get(f"https://{domain}{path}", timeout=7)
        if code and code < 400 and isinstance(html, str):
            emails = [e for e in EMAIL_RE.findall(html) if not e.lower().endswith((".png",".jpg",".gif",".webp")) and "@" in e and domain.split(".")[0][:5] not in ("examp",)]
            emails = [e for e in emails if not re.search(r"(sentry|wixpress|\.png|\.jpg|example\.com)", e.lower())]
            if emails: return emails[0]
        time.sleep(0.3)
    return None

def resolve(name):
    toks = tokens(name)
    for cand in domain_candidates(name):
        code, html = get(f"https://{cand}", timeout=7)
        if code and code < 400 and isinstance(html, str):
            low = html.lower()
            if any(t in low for t in toks) or any(t in cand for t in toks):
                return cand
        time.sleep(0.2)
    # DDG fallback
    q = urllib.parse.quote(name + " UK")
    code, html = get(f"https://html.duckduckgo.com/html/?q={q}", timeout=8)
    if isinstance(html, str):
        for m in re.findall(r"uddg=(https?%3A%2F%2F[^\"&]+)", html)[:4]:
            url = urllib.parse.unquote(m)
            dom = urllib.parse.urlparse(url).netloc.replace("www.","")
            if dom and not any(b in dom for b in ["facebook","linkedin","gov.uk","yell","google","find-and-update","companieshouse","trustpilot","checkatrade"]):
                if any(t in dom for t in toks): return dom
    return None

SICS = {"69102":"solicitors","69201":"accountants","68310":"estate agents","66220":"insurance brokers"}
total=web=mail=0; rows=[]
for sic,label in SICS.items():
    for c in ch_search(sic, 15):
        name=c.get("company_name","")
        if not name: continue
        total+=1
        dom=resolve(name)
        em=scrape_email(dom) if dom else None
        if dom: web+=1
        if em: mail+=1
        rows.append((label,name[:32],dom or "-",em or "-"))
        print(f"[{total:2}] {label[:9]:9} {name[:30]:30} -> {dom or '(no site)'}  {em or ''}")
print("\n==== FREE CH-SEED YIELD ====")
print(f"companies tried:   {total}")
print(f"website resolved:  {web}  ({100*web//max(total,1)}%)")
print(f"email found:       {mail}  ({100*mail//max(total,1)}%)  <-- this is the qualified rate")
