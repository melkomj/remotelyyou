import { writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import crypto from 'node:crypto';

const USER_AGENT = 'Mozilla/5.0 (compatible; RemotelyYouBot/1.0; +https://remotelyyou.com)';

const SOURCES = [
  {
    name: 'Remote OK',
    url: 'https://remoteok.com/rss',
  },
  {
    name: 'We Work Remotely',
    url: 'https://weworkremotely.com/remote-jobs.rss',
  },
  {
    name: 'Jobicy',
    url: 'https://jobicy.com/feed',
  },
  {
    name: 'Himalayas',
    url: 'https://himalayas.app/jobs/rss',
  },
  {
    name: 'Remote.co',
    url: 'https://remote.co/remote-jobs/feed/',
  }
];

const OUT_PATH = resolve('site/public/jobs.json');

async function safeFetch(url) {
  try {
    console.log(`Fetching: ${url}`);
    const res = await fetch(url, {
      headers: { 
        'user-agent': USER_AGENT, 
        accept: '*/*'
      },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.text();
  } catch (err) {
    console.error(`Fetch failed ${url}:`, err.message);
    return null;
  }
}

function strip(html = '') {
  return html
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '...')
    .trim();
}

function rssToItems(xml, sourceName) {
  if (!xml) return [];
  
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const pick = (tag) =>
      (block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i')) ||
        [])[1] || '';

    const title = strip(pick('title'));
    const link = strip(pick('link')) || strip(pick('guid')) || '';
    const pubDate = pick('pubDate') || pick('date') || new Date().toISOString();
    const description = strip(pick('description') || pick('summary'));

    if (!title || !link) continue;

    // Create proper tags based on job content
    const fullText = (title + ' ' + description).toLowerCase();
    const tags = [];
    
    // Experience level detection
    if (/\b(entry|junior|jr|associate|intern|trainee|graduate|new grad|no experience|beginner)\b/.test(fullText)) {
      tags.push('entry-level');
    }
    if (/\b(junior|jr|1-2 years)\b/.test(fullText)) {
      tags.push('junior');
    }
    if (/\b(senior|sr|lead|principal|staff|experienced|expert)\b/.test(fullText)) {
      tags.push('senior');
    }
    
    // Job type detection
    if (/\b(part.time|parttime)\b/.test(fullText)) {
      tags.push('part-time');
    } else if (/\b(contract|freelance|consultant)\b/.test(fullText)) {
      tags.push('contract');
    } else if (/\b(intern|internship)\b/.test(fullText)) {
      tags.push('internship');
    } else {
      tags.push('full-time');
    }
    
    // Always add remote tag
    tags.push('remote');

    // Clean and limit excerpt - this fixes the formatting issues
    let cleanExcerpt = description
      .replace(/\s+/g, ' ')  // Fix spacing issues
      .trim()
      .substring(0, 150);    // Limit to 150 characters instead of 200
    
    // Add ellipsis if truncated
    if (description.length > 150) {
      cleanExcerpt += '...';
    }

    items.push({
      title,
      company: undefined,
      source: sourceName,
      source_url: link,
      posted_at: new Date(pubDate).toISOString(),
      tags: tags,
      location: 'Remote',
      excerpt: cleanExcerpt
    });
  }
  
  console.log(`${sourceName}: ${items.length} items extracted`);
  return items;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((j) => {
    const key = crypto
      .createHash('md5')
      .update((j.title || '') + '|' + (j.source_url || ''))
      .digest('hex');
      
if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function main() {
  console.log('Starting job fetch process...');
  
  const allJobs = [];
  
  for (const src of SOURCES) {
    console.log(`Processing source: ${src.name}`);
    const body = await safeFetch(src.url);
    
    if (!body) {
      console.error(`Source error ${src.name}: no body received`);
      continue;
    }
    
    const items = rssToItems(body, src.name);
    allJobs.push(...items);
  }

  console.log(`Total raw jobs collected: ${allJobs.length}`);
  
  let jobs = dedupe(allJobs);
  console.log(`After deduplication: ${jobs.length}`);
  
  jobs = jobs.sort((a, b) => new Date(b.posted_at) - new Date(a.posted_at));

  const payload = {
    updated_at: new Date().toISOString(),
    total_jobs: jobs.length,
    sources: SOURCES.map(s => s.name),
    jobs
  };

  await writeFile(OUT_PATH, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`Successfully wrote ${jobs.length} jobs to ${OUT_PATH}`);
}

main().catch(console.error);