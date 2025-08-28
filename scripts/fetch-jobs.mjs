// scripts/fetch-jobs.mjs
// Node 18+ required (Node 20 recommended)

import fs from 'node:fs/promises';
import crypto from 'node:crypto';

// ---- SOURCES ----
// We mix RSS and a JSON API to increase reliability.
const SOURCES = [
  // RSS (WWR)
  {
    type: 'rss',
    name: 'We Work Remotely - Customer Support',
    url: 'https://weworkremotely.com/categories/remote-customer-support-jobs.rss',
    parse: parseGenericRSS
  },
  // JSON (Remotive official API)
  {
    type: 'json',
    name: 'Remotive - API',
    url: 'https://remotive.com/api/remote-jobs',
    parse: parseRemotiveJSON
  },
  // RSS (Remote.co by category)
  {
    type: 'rss',
    name: 'Remote.co - Customer Service',
    url: 'https://remote.co/remote-jobs/customer-service/feed/',
    parse: parseGenericRSS
  },
  // RSS (Working Nomads)
  {
    type: 'rss',
    name: 'Working Nomads - All',
    url: 'https://www.workingnomads.com/jobs.rss',
    parse: parseGenericRSS
  }
];

// ---------- Parsers ----------
async function parseGenericRSS(xml, sourceName) {
  const items = [...xml.matchAll(/<item>[\s\S]*?<\/item>/g)];
  return items.map(it => {
    const get = (tag) => {
      const m = it[0].match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return m ? decodeHTML(stripTags(m[1].trim())) : '';
    };
    const title = get('title');
    const link  = get('link');
    const pub   = get('pubDate') || get('updated') || get('dc:date') || '';
    const desc  = get('description') || '';

    // Try to infer company from patterns like "Company – Role" or "Company - Role"
    let company = '';
    for (const sep of [' – ', ' — ', ' - ']) {
      if (title.includes(sep)) { company = title.split(sep)[0].trim(); break; }
    }
    if (!company) {
      // Some RSS include company in description; very naive fallback:
      const m = desc.match(/<strong>(.*?)<\/strong>/i);
      if (m) company = stripTags(m[1]).trim();
    }

    return {
      source: sourceName,
      source_url: link,
      title,
      company,
      location: '',
      remote_type: 'remote',
      tags: [],
      salary: '',
      posted_at: pub
    };
  });
}

async function parseRemotiveJSON(jsonText, sourceName) {
  const data = JSON.parse(jsonText);
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  return jobs.map(j => ({
    source: sourceName,
    source_url: j.url || '',
    title: j.title || '',
    company: j.company_name || '',
    location: j.candidate_required_location || '',
    remote_type: 'remote',
    tags: Array.isArray(j.tags) ? j.tags.slice(0, 5) : [],
    salary: j.salary || '',
    posted_at: j.publication_date || ''
  }));
}

// ---------- Utils ----------
function stripTags(s){ return s.replace(/<[^>]*>/g,''); }
function decodeHTML(s){
  return s.replaceAll('&amp;','&').replaceAll('&lt;','<').replaceAll('&gt;','>')
          .replaceAll('&quot;','"').replaceAll('&#39;',"'");
}
function makeHash(job){
  const base = (job.title||'')+(job.company||'')+(job.source_url||'');
  return crypto.createHash('sha1').update(base.toLowerCase()).digest('hex');
}
function tagJob(job){
  // Add simple beginner-friendly tags by title/role
  const t=[]; const title=(job.title||'').toLowerCase();
  if(/support|customer|help\s?desk/.test(title)) t.push('Customer Support');
  if(/assistant|va|virtual assistant/.test(title)) t.push('Virtual Assistant');
  if(/data\s?entry/.test(title)) t.push('Data Entry');
  if(/social|content|community|copy|writer/.test(title)) t.push('Social / Content');
  if(/project\s?(coordinator|manager|pm)/.test(title)) t.push('Project Coord/PM (Jr)');
  // Keep Remotive tags too (if present)
  job.tags = Array.from(new Set([...(job.tags||[]), ...t]));
  return job;
}

// Robust fetchers for RSS and JSON
async function fetchText(url, depth = 0) {
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.7',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': new URL(url).origin
    }
  });

  if ([301, 302, 307, 308].includes(res.status)) {
    const loc = res.headers.get('location');
    if (!loc) throw new Error(`Redirect with no Location header for ${url}`);
    const next = new URL(loc, url).toString();
    if (depth > 5) throw new Error(`Too many redirects for ${url}`);
    return fetchText(next, depth + 1);
  }

  if (res.status === 403 && depth === 0) {
    await new Promise(r => setTimeout(r, 500));
    return fetchText(url, depth + 1);
  }

  if (!res.ok) throw new Error(`Fetch failed ${url}: ${res.status}`);
  return res.text();
}

async function fetchJSON(url) {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain;q=0.8, */*;q=0.7',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': new URL(url).origin
    }
  });
  if (!res.ok) throw new Error(`Fetch failed ${url}: ${res.status}`);
  return res.text();
}

// ---------- Main ----------
async function main(){
  const all = [];

  for(const s of SOURCES){
    try{
      let raw;
      if (s.type === 'json') {
        raw = await fetchJSON(s.url);
      } else {
        raw = await fetchText(s.url);
      }
      const items = await s.parse(raw, s.name);
      for(const j of items){ tagJob(j); j.hash=makeHash(j); all.push(j); }
    }catch(e){
      console.error('Source error', s.name, e.message);
    }
  }

  // De-dupe by hash
  const seen=new Set(), deduped=[];
  for(const j of all){ if(!seen.has(j.hash)){ seen.add(j.hash); deduped.push(j); } }

  // Sort newest first by posted_at (fallback to now)
  const now=Date.now();
  const toTs=(d)=>{ const ts=Date.parse(d||''); return Number.isFinite(ts)?ts:now; };
  deduped.sort((a,b)=>toTs(b.posted_at)-toTs(a.posted_at));

  await fs.mkdir('site/public', { recursive:true });
  await fs.writeFile('site/public/jobs.json', JSON.stringify({
    updated_at: new Date().toISOString(),
    jobs: deduped
  }, null, 2));
  console.log(`Wrote ${deduped.length} jobs to site/public/jobs.json`);
}

main().catch(err=>{ console.error(err); process.exit(1); });
