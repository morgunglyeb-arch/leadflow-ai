import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

interface DemoLead {
  company: string;
  domain: string;
  name: string;
  role: string;
  fixture: string;
}

const LEADS: DemoLead[] = [
  {
    company: "Northwind Logistics",
    domain: "northwindlogistics.example",
    name: "Marcus Hale",
    role: "VP Operations",
    fixture: `Northwind Logistics
Smarter last-mile delivery for mid-market retailers.

We move 4M+ parcels a year across 14 regional hubs in the US Midwest. Our route-planning platform connects directly to Shopify and BigCommerce stores so SMB ecommerce brands can offer same-day in 30+ cities without negotiating with carriers themselves.

What we do
- Route optimization across owned drivers + 3PL partners
- Real-time delivery tracking for shoppers
- Carrier-neutral pricing built into checkout
- Returns pickup on the same route

For brands shipping 500-5,000 orders a week, we typically cut last-mile cost by 18-24% and lift on-time rate to 96%+. We're hiring dispatchers and senior backend engineers — careers page is open.`,
  },
  {
    company: "Lumen Health",
    domain: "lumenhealth.example",
    name: "Priya Anand",
    role: "Head of Product",
    fixture: `Lumen Health — Modern primary care for hybrid teams
Telehealth + in-person clinics in 6 metros.

Lumen Health partners with employers (200-5000 headcount) to give their teams unlimited primary care visits, mental health support, and care navigation. Our platform handles eligibility, scheduling, EHR integration, and claims, so HR teams don't have to.

Why customers pick us
- One vendor instead of stitching together three
- Patients get same-day video visits, not 3-week waits
- Employers see utilization dashboards by location

We just opened clinics in Austin and Raleigh, and we're hiring care coordinators. See careers.`,
  },
  {
    company: "Kestrel Analytics",
    domain: "kestrelanalytics.example",
    name: "Tomás Ribeiro",
    role: "Founder & CEO",
    fixture: `Kestrel Analytics
Pricing intelligence for B2B SaaS.

We scrape, parse and normalize public pricing pages for 12,000+ SaaS products and surface changes — new tiers, packaging shifts, deprecations — via a dashboard and API.

Customers are Series B-D SaaS companies doing competitive intel and packaging research. Pricing starts at $1,500/mo (Standard) or $4,000/mo (Enterprise with API access). We raised a Series A last year and are hiring a senior data engineer.

Blog and customer case studies are at /blog. Integrations with Slack, Notion, and Salesforce are live; HubSpot and Linear are in beta.`,
  },
  {
    company: "Brightwater Coffee",
    domain: "brightwatercoffee.example",
    name: "Hannah Okafor",
    role: "Director of Ecommerce",
    fixture: `Brightwater Coffee
Specialty single-origin coffee, roasted weekly.

We're a direct-to-consumer roaster shipping fresh beans from our Portland roastery. Subscriptions are our biggest channel — 11,000 active subscribers — plus a Shopify storefront with cart and checkout for one-off bags. Wholesale to ~60 cafés on the West Coast.

Our blog covers brewing guides and producer stories. We do not currently have an iOS app. Shipping is flat-rate and we offer carbon-neutral delivery.`,
  },
  {
    company: "Arbor Legal",
    domain: "arborlegal.example",
    name: "Daniel Whitcombe",
    role: "Managing Partner",
    fixture: `Arbor Legal — Boutique corporate law for founders
Series Seed through Series B.

We represent ~140 venture-backed startups in SF and NYC. Practice areas: incorporation, fundraising (SAFE / priced rounds), commercial contracts, employment, and M&A on the sell side. Flat-fee packages for incorporation and seed rounds, hourly for everything else.

We don't take litigation work. Our team is 11 attorneys + 4 paralegals. No careers page open right now.`,
  },
  {
    company: "Pinecrest Manufacturing",
    domain: "pinecrestmfg.example",
    name: "Robert Greaves",
    role: "Plant Manager",
    fixture: `Pinecrest Manufacturing
Precision sheet-metal fabrication since 1978.

Family-owned shop in Akron, Ohio. We run 4 laser cutters, 3 press brakes, and a robotic welding cell. Customers are HVAC OEMs, food-service equipment makers, and contract assemblers — typical run sizes 500-25,000 parts.

We quote from STEP / DXF files within 48 hours and ship same-week on stocked materials. We don't have an online portal — orders come in by email or EDI. No careers page; we hire through local referrals.`,
  },
  {
    company: "Mosaic Education",
    domain: "mosaicedu.example",
    name: "Aisha Bello",
    role: "VP Schools",
    fixture: `Mosaic Education
Curriculum platform for K-8 schools.

Mosaic gives elementary and middle school teachers a single platform for lesson plans, standards-aligned assessments, and student progress dashboards. We're in 1,400 schools across 11 US states, sold annually per-student.

We integrate with Clever and ClassLink for rostering. Our content team writes original ELA and math units; STEM is partnered with a third-party provider. Hiring: account executives (Midwest), curriculum writers, and a senior engineer for our parent app.`,
  },
  {
    company: "Tideline Insurance",
    domain: "tidelineinsurance.example",
    name: "Olivia Park",
    role: "Head of Operations",
    fixture: `Tideline Insurance Brokers
Commercial insurance for restaurants, cafés and food trucks.

We're an independent brokerage placing general liability, workers comp, property, and liquor liability for ~3,200 hospitality SMBs across California and Arizona. Most policies come through our online quote flow; complex risks go to one of our 9 producers.

We do not sell personal lines (no auto, no homeowners). Pricing varies by carrier — we represent 11. Renewals are 60-day rolling. No public blog or careers page.`,
  },
  {
    company: "Polaris Robotics",
    domain: "polarisrobotics.example",
    name: "Henrik Voss",
    role: "VP Engineering",
    fixture: `Polaris Robotics
Autonomous mobile robots (AMRs) for warehouses.

We design and manufacture pallet-moving AMRs for 3PLs and high-velocity ecommerce fulfilment centers. Our fleet manager handles 200+ robots per site with ROS 2 under the hood and a cloud control plane.

Customers include three of the top-15 US 3PLs. Pricing is robots-as-a-service: per-robot monthly fee, no capex. We closed a Series B and are hiring across hardware, perception, and field-deploy roles. AI / LLM work is on our roadmap for natural-language operator interfaces.`,
  },
  {
    company: "Vellum Studio",
    domain: "vellumstudio.example",
    name: "Mei Lin",
    role: "Creative Director",
    fixture: `Vellum Studio
Brand and product design agency.

We're a 14-person studio in Brooklyn working with consumer startups on brand identity, packaging, and digital product design. Recent work: a DTC haircare relaunch, a fintech onboarding redesign, and a podcast network rebrand.

Engagements run 6-14 weeks, retainer or project. No careers page; we hire when projects line up. We don't do paid media, performance creative, or motion-heavy ad work.`,
  },
  {
    company: "Quill Bookkeeping",
    domain: "quillbookkeeping.example",
    name: "Jonas Albrecht",
    role: "Founder",
    fixture: `Quill Bookkeeping
Monthly bookkeeping + accrual cleanup for B2B SaaS startups.

We run the books for ~80 venture-backed SaaS companies between $500K and $20M ARR. Monthly close, GAAP-friendly accrual, board-ready reporting in Mosaic or Causal, and audit-prep when you're heading into Series B.

We're a 9-person remote team. Pricing is tiered by revenue (Starter $750/mo, Growth $1,500/mo, Series $2,800/mo). We don't do personal taxes or non-SaaS verticals.`,
  },
  {
    company: "Harborlight Hotels",
    domain: "harborlighthotels.example",
    name: "Renée Doucet",
    role: "Director of Revenue",
    fixture: `Harborlight Hotels
Independent boutique hotels on the Atlantic coast.

We operate 6 small hotels (28-72 rooms) in Maine, New Hampshire, and Nova Scotia. Direct bookings come through our website; we also distribute via OTAs (Booking, Expedia) and one wholesaler.

We sell rooms, F&B, spa packages, and wedding venue contracts. No app, no loyalty program. Peak season May-October. Hiring seasonal F&B and front-desk roles every spring.`,
  },
  {
    company: "Cobalt Mining Co.",
    domain: "cobaltminingco.example",
    name: "Eduardo Salazar",
    role: "Head of IT",
    fixture: `Cobalt Mining Co.
Industrial cobalt extraction and refinement.

Operations in two regions, with three active mine sites and one refinery. Customers are battery cell manufacturers and specialty alloy producers. We sell on long-term offtake contracts, not spot.

Internal IT runs SAP and Maximo for asset management. We do not publish pricing, do not run a blog, and the careers page lists field-engineering roles only.`,
  },
  {
    company: "Glimmer Beauty",
    domain: "glimmerbeauty.example",
    name: "Sasha Romanov",
    role: "Head of CX",
    fixture: `Glimmer Beauty
Clean skincare, science-backed, no fluff.

We sell direct-to-consumer through our Shopify store and through Sephora retail. Our hero SKUs are a vitamin C serum, a retinol, and a niacinamide moisturizer. Subscribe-and-save converts at 38%.

CX team of 4 currently handles ~800 tickets a week (Gorgias). We don't have an outbound sales motion. Our blog covers ingredient science. We're hiring a CX team lead.`,
  },
  {
    company: "Steelbridge Capital",
    domain: "steelbridgecapital.example",
    name: "Margaret Yu",
    role: "Partner",
    fixture: `Steelbridge Capital
Private credit for lower-middle-market industrials.

We provide senior secured and unitranche debt ($10M-$75M) to family-owned manufacturing, distribution, and industrial-services businesses. Sourcing is relationship-driven through M&A advisors and regional banks; we do not have an inbound funnel.

No careers page. No blog. Limited public information is by design.`,
  },
];

async function main(): Promise<void> {
  const csvPath = "data/leads.csv";
  const fixtureDir = "data/fixtures";
  const header = "company,domain,name,role,email";
  const lines = [header];
  for (const lead of LEADS) {
    const emailLocal = lead.name.toLowerCase().replace(/[^a-z]/g, ".");
    const email = `${emailLocal}@${lead.domain}`;
    lines.push(`${csvField(lead.company)},${lead.domain},${csvField(lead.name)},${csvField(lead.role)},${email}`);
  }

  await mkdir(dirname(csvPath), { recursive: true });
  await writeFile(csvPath, lines.join("\n") + "\n", "utf8");
  console.log(`Wrote ${LEADS.length} leads → ${csvPath}`);

  await mkdir(fixtureDir, { recursive: true });
  for (const lead of LEADS) {
    const path = join(fixtureDir, `${lead.domain}.txt`);
    await writeFile(path, lead.fixture.trim() + "\n", "utf8");
  }
  console.log(`Wrote ${LEADS.length} fixtures → ${fixtureDir}/`);
}

function csvField(s: string): string {
  if (s.includes(",") || s.includes('"')) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
