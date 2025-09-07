// scripts/fetch-jobs.mjs
import { writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import crypto from 'node:crypto';

const USER_AGENT =
  process.env.USER_AGENT ||
  'Mozilla/5.0 (compatible; RemotelyYouBot/1.0; +https://remotelyyou.com)';

const SOURCES = [
  // Stable RSS feeds that allow republishing
  {
    name: 'Remote OK - All',
    type: 'rss',
    url: 'https://remoteok.com/rss',
  },
  {
    name: 'Remote.co - All',
    type: 'rss',
    url: 'https://remote.co/remote-jobs/feed/',
  },
  {
    name: 'Jobicy - All',
    type: 'rss',
    url: 'https://jobicy.com/feed',
  },
  {
    name: 'Himalayas - Jobs',
    type: 'rss',
    url: 'https://himalayas.app/jobs/rss',
  },
  {
    name: 'We Work Remotely',
    type: 'rss',
    url: 'https://weworkremotely.com/remote-jobs.rss',
  },
  {
    name: 'AngelList Remote',
    type: 'rss',
    url: 'https://angel.co/jobs.rss?remote=true',
  }
];

const OUT_PATH = resolve('site/public/jobs.json');

// Keywords that indicate beginner-friendly roles
const BEGINNER_KEYWORDS = [
  'entry', 'junior', 'beginner', 'entry-level', 'trainee', 'associate', 'intern',
  'no experience', 'new grad', 'graduate', 'starter', 'assistant', 'coordinator'
];

// Keywords that indicate senior roles (to filter out)
const SENIOR_KEYWORDS = [
  'senior', 'lead', 'principal', 'director', 'manager', 'head of', 'chief',
  '5+ years', '3+ years', 'experienced', 'expert', 'architect'
];

async function safeFetch(url) {
  try {
    console.log(`Fetching: ${url}`);
    const res = await fetch(url, {
      headers: { 
        'user-agent': USER_AGENT, 
        accept: '*/*',
        'accept-encoding': 'gzip, deflate',
        'cache-control': 'no-cache'
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
    .trim();
}

function parseDate(s) {
  if (!s) return new Date().toISOString();
  const d = new Date(s);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function extractCompany(title, description) {
  // Try to extract company name from title patterns
  const patterns = [
    /at\s+([A-Z][a-zA-Z\s&.]+?)(?:\s*[-–—]|\s*$)/i,
    /\|\s*([A-Z][a-zA-Z\s&.]+?)(?:\s*[-–—]|\s*$)/i,
    /-\s*([A-Z][a-zA-Z\s&.]+?)(?:\s*[-–—]|\s*$)/i
  ];
  
  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match && match[1] && match[1].length < 50) {
      return match[1].trim();
    }
  }
  
  return undefined;
}

function isBeginnerFriendly(title, description, tags) {
  const text = (title + ' ' + description + ' ' + tags.join(' ')).toLowerCase();
  
  // Check for beginner indicators
  const hasBeginnerKeywords = BEGINNER_KEYWORDS.some(keyword => 
    text.includes(keyword.toLowerCase())
  );
  
  // Check for senior indicators (exclude these)
  const hasSeniorKeywords = SENIOR_KEYWORDS.some(keyword => 
    text.includes(keyword.toLowerCase())
  );
  
  // Include if has beginner keywords OR doesn't have senior keywords
  return hasBeginnerKeywords || !hasSeniorKeywords;
}

function categorizeJob(title, description, tags) {
  const text = (title + ' ' + description + ' ' + tags.join(' ')).toLowerCase();
  
  if (/customer.service|support|help.?desk|customer.success/i.test(text)) return 'customer-service';
  if (/marketing|social.media|seo|content.marketing|digital.marketing/i.test(text)) return 'marketing';
  if (/sales|account.manager|business.development|sdr|bdr/i.test(text)) return 'sales';
  if (/writer|content|copywriter|editor|blog|technical.writer/i.test(text)) return 'writing';
  if (/design|ui|ux|graphic|visual|figma|sketch/i.test(text)) return 'design';
  if (/developer|programmer|engineer|coding|software|frontend|backend/i.test(text)) return 'development';
  if (/data|analyst|analytics|sql|excel|tableau|bi/i.test(text)) return 'data';
  if (/virtual.assistant|va|admin|assistant|administrative/i.test(text)) return 'virtual-assistant';
  if (/project.manager|coordinator|scrum|agile|project.coordinator/i.test(text)) return 'project-management';
  
  return 'other';
}

function generateTags(title, description, category) {
  const tags = [];
  const text = (title + ' ' + description).toLowerCase();
  
  // Add experience level tags
  if (BEGINNER_KEYWORDS.some(keyword => text.includes(keyword.toLowerCase()))) {
    tags.push('entry-level');
  }
  if (/junior|1-2.years/i.test(text)) {
    tags.push('junior');
  }
  
  // Add job type tags
  if (/part.?time|parttime/i.test(text)) {
    tags.push('part-time');
  } else if (/contract|contractor|freelance/i.test(text)) {
    tags.push('contract');
  } else if (/intern|internship/i.test(text)) {
    tags.push('internship');
  } else {
    tags.push('full-time');
  }
  
  // Add remote tags
  if (/remote|anywhere|global|distributed/i.test(text)) {
    tags.push('remote');
  }
  
  // Add category tag
  if (category !== 'other') {
    tags.push(category);
  }
  
  // Add skill-based tags
  if (/no.experience|entry.level|beginner/i.test(text)) {
    tags.push('no-experience');
  }
  
  return tags.slice(0, 6); // Limit to 6 tags
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
    let link = strip(pick('link')) || strip(pick('guid')) || '';
    
    // Clean up the link
    link = link.replace(/\?.*$/, ''); // Remove query parameters
    if (!link.startsWith('http')) continue;
    
    const pubDate = parseDate(strip(pick('pubDate')) || strip(pick('date')));
    const description = strip(pick('description') || pick('content:encoded') || pick('summary'));
    
    // Extract categories from RSS
    const rssCategories = Array.from(
      block.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/gi)
    ).map(match => strip(match[1]));

    if (!title || !link) continue;
    
    // Filter for beginner-friendly jobs
    if (!isBeginnerFriendly(title, description, rssCategories)) {
      continue;
    }
    
    const company = extractCompany(title, description);
    const category = categorizeJob(title, description, rssCategories);
    const tags = generateTags(title, description, category);
    
    items.push({
      title,
      company,
      source: sourceName,
      source_url: link,
      posted_at: pubDate,
      tags,
      location: 'Remote',
      excerpt: description.slice(0, 200),
      category
    });
  }
  
  console.log(`${sourceName}: ${items.length} beginner-friendly items extracted`);
  return items;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((j) => {
    // Create a key based on title and company to avoid exact duplicates
    const normalizedTitle = (j.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const normalizedCompany = (j.company || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const key = crypto
      .createHash('md5')
      .update(normalizedTitle + '|' + normalizedCompany + '|' + (j.source_url || ''))
      .digest('hex');
      
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortAndLimit(jobs) {
  // Sort by posted date (newest first) and limit
  return jobs
    .sort((a, b) => new Date(b.posted_at) - new Date(a.posted_at))
    .slice(0, 2000); // Increased limit to get more jobs
}

async function main() {
  console.log('Starting job fetch process...');
  
  const allJobs = [];
  
  for (const src of SOURCES) {
    console.log(`\nProcessing source: ${src.name}`);
    const body = await safeFetch(src.url);
    
    if (!body) {
      console.error(`Source error ${src.name}: no body received`);
      continue;
    }
    
    const items = src.type === 'rss' ? rssToItems(body, src.name) : [];
    allJobs.push(...items);
  }

  console.log(`\nTotal raw jobs collected: ${allJobs.length}`);
  
  // Dedupe and sort
  let jobs = dedupe(allJobs);
  console.log(`After deduplication: ${jobs.length}`);
  
  jobs = sortAndLimit(jobs);
  console.log(`Final job count: ${jobs.length}`);

  const payload = {
    updated_at: new Date().toISOString(),
    total_jobs: jobs.length,
    sources: SOURCES.map(s => s.name),
    jobs
  };

  const nextContent = JSON.stringify(payload, null, 2);

  // Only write if content changed
  let prevContent = '';
  if (existsSync(OUT_PATH)) {
    try {
      prevContent = await readFile(OUT_PATH, 'utf8');
    } catch (err) {
      console.log('No existing jobs.json found, creating new file');
    }
  }

  if (prevContent.trim() !== nextContent.trim()) {
    await writeFile(OUT_PATH, nextContent, 'utf8');
    console.log(`\n✅ Successfully wrote ${jobs.length} jobs to ${OUT_PATH}`);
    console.log(`Updated at: ${new Date().toISOString()}`);
    process.exitCode = 0;
  } else {
    console.log('\n✅ No changes detected in jobs.json — skipping write');
    process.exitCode = 0;
  }
}

// Handle errors gracefully
main().catch((error) => {
  console.error('\n❌ Error in job fetch process:', error);
  process.exitCode = 1;
});