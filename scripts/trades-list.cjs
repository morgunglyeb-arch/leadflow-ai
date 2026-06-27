// One-off: pull a starter list of UK independent trades (with PHONE for manual
// WhatsApp/LinkedIn outreach) via Google Places (New). Standalone — does NOT touch
// the pipeline/icp.json. Output: /Users/a1/opero-trades-outreach.csv
require("dotenv").config();
const KEY = process.env.GOOGLE_PLACES_API_KEY || "";
if (!KEY) { console.error("GOOGLE_PLACES_API_KEY not set"); process.exit(1); }

const TRADES = ["plumber","electrician","heating engineer","roofer","builder","cleaning company","landscaper","kitchen fitter"];
const CITIES = ["Stockport","Bolton","Leeds","Bristol","Nottingham","Sheffield","Leicester","Coventry","Derby","Preston"];
const MASK = "places.displayName,places.websiteUri,places.nationalPhoneNumber,places.formattedAddress,places.userRatingCount";

function domain(u){ try { return new URL(u).hostname.replace(/^www\./,"").toLowerCase(); } catch { return ""; } }
const CHAINS = ["pimlicoplumbers","britishgas","checkatrade","mybuilder","ratedpeople","yell.com","trustatrader"];

async function search(trade, city){
  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText",{
      method:"POST",
      headers:{"Content-Type":"application/json","X-Goog-Api-Key":KEY,"X-Goog-FieldMask":MASK},
      body:JSON.stringify({textQuery:`independent ${trade} in ${city}, UK`, pageSize:15}),
    });
    if(!res.ok){ console.error(`  ${trade}/${city} HTTP ${res.status}`); return []; }
    const j = await res.json();
    return (j.places||[]).map(p=>({
      company:p.displayName?.text||"",
      trade, city,
      phone:p.nationalPhoneNumber||"",
      website:p.websiteUri||"",
      reviews:p.userRatingCount??"",
      address:p.formattedAddress||"",
    }));
  } catch(e){ console.error(`  ${trade}/${city} ERR ${e.message}`); return []; }
}

(async ()=>{
  const seen = new Set(); const rows = [];
  for(const trade of TRADES){
    for(const city of CITIES){
      const found = await search(trade, city);
      for(const r of found){
        const d = domain(r.website);
        const key = r.phone || d || r.company.toLowerCase();
        if(!key || seen.has(key)) continue;
        if(d && CHAINS.some(c=>d.includes(c))) continue;       // skip aggregators/chains
        if(!r.phone) continue;                                  // need phone for WhatsApp
        seen.add(key);
        rows.push(r);
      }
      process.stdout.write(`.`);
    }
  }
  console.log(`\n[trades] ${rows.length} unique trades with phone`);
  const cols = ["company","trade","city","phone","website","reviews","address"];
  const esc = v => { const s=String(v??""); return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; };
  const csv = "﻿"+cols.join(",")+"\n"+rows.map(r=>cols.map(c=>esc(r[c])).join(",")).join("\n")+"\n";
  require("fs").writeFileSync("/Users/a1/opero-trades-outreach.csv", csv, "utf8");
  console.log("→ /Users/a1/opero-trades-outreach.csv");
  // quick breakdown
  const byTrade={}; for(const r of rows) byTrade[r.trade]=(byTrade[r.trade]||0)+1;
  console.log("by trade:", JSON.stringify(byTrade));
  const withSite = rows.filter(r=>r.website).length;
  console.log(`with website: ${withSite}/${rows.length}`);
})();
