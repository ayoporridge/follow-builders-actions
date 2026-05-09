#!/usr/bin/env node

// ============================================================================
// Follow Builders — GitHub Actions Runner
// ============================================================================
// 1. Fetches central feeds (tweets, podcasts, blogs)
// 2. Fetches prompts from GitHub
// 3. Calls DeepSeek API to generate a Chinese digest
// 4. Sends digest to WeCom webhook
//
// Environment variables required:
//   DEEPSEEK_API_KEY  — DeepSeek API key (platform.deepseek.com)
//   WECOM_WEBHOOK_URL — WeCom group bot webhook URL
// ============================================================================

// -- Config ------------------------------------------------------------------

const LANGUAGE = 'zh'; // change to 'en' or 'bilingual' if needed

const FEED_X_URL        = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json';
const FEED_PODCASTS_URL = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-podcasts.json';
const FEED_BLOGS_URL    = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-blogs.json';
const PROMPTS_BASE      = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/prompts';
const PROMPT_FILES      = ['summarize-podcast.md', 'summarize-tweets.md', 'summarize-blogs.md', 'digest-intro.md', 'translate.md'];

// Extra RSS blogs to merge in addition to the central feed-blogs.json
const EXTRA_RSS_BLOGS = [
  { name: '乔木博客', rssUrl: 'https://blog.qiaomu.ai/feed.xml' },
];

// -- Helpers -----------------------------------------------------------------

// Parse an RSS/Atom feed XML and return posts from the last 72 hours.
// Returns array of { title, url, publishedAt, summary, author, blogName }
async function fetchRssBlog({ name, rssUrl }, lookbackHours = 72) {
  const res = await fetch(rssUrl);
  if (!res.ok) throw new Error(`Failed to fetch RSS ${rssUrl}: ${res.status}`);
  const xml = await res.text();

  const cutoff = Date.now() - lookbackHours * 60 * 60 * 1000;
  const posts = [];

  // Match <item> (RSS) or <entry> (Atom) blocks
  const itemPattern = /<item[\s>]([\s\S]*?)<\/item>|<entry[\s>]([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = itemPattern.exec(xml)) !== null) {
    const block = match[1] || match[2];
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i'));
      return m ? m[1].trim() : '';
    };
    const title = get('title');
    const link  = get('link') || (block.match(/<link[^>]+href="([^"]+)"/) || [])[1] || '';
    const pubDate = get('pubDate') || get('published') || get('updated') || get('dc:date');
    const summary = get('description') || get('summary') || get('content') || '';

    if (!title || !link) continue;
    const ts = pubDate ? new Date(pubDate).getTime() : 0;
    if (ts && ts < cutoff) continue;

    posts.push({
      title,
      url: link,
      publishedAt: pubDate || '',
      summary: summary.replace(/<[^>]+>/g, '').slice(0, 300),
      author: name,
      blogName: name,
    });
  }

  return posts;
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.text();
}

// Convert standard Markdown to WeCom-compatible format.
// WeCom group bot only supports: **bold**, >quote, <font color>
// It does NOT support: # headings, ---, [text](url) links
function toWecomMarkdown(text) {
  return text
    // ### Heading → **Heading**
    .replace(/^#{1,6}\s+(.+)$/gm, '**$1**')
    // [link text](url) → link text: url
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1: $2')
    // --- horizontal rule → blank line
    .replace(/^---+$/gm, '')
    // collapse 3+ consecutive blank lines into 2
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// WeCom markdown messages have a 4096 char limit — split if needed
async function sendWecom(text, webhookUrl) {
  text = toWecomMarkdown(text);
  const MAX_LEN = 4096;
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LEN) { chunks.push(remaining); break; }
    let splitAt = remaining.lastIndexOf('\n', MAX_LEN);
    if (splitAt < MAX_LEN * 0.5) splitAt = MAX_LEN;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  for (const chunk of chunks) {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content: chunk } })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(`WeCom API error: ${err.errmsg || JSON.stringify(err)}`);
    }
    if (chunks.length > 1) await new Promise(r => setTimeout(r, 500));
  }
}

// -- Main --------------------------------------------------------------------

async function main() {
  const apiKey      = process.env.DEEPSEEK_API_KEY;
  const webhookUrl  = process.env.WECOM_WEBHOOK_URL;
  if (!apiKey)     throw new Error('DEEPSEEK_API_KEY is not set');
  if (!webhookUrl) throw new Error('WECOM_WEBHOOK_URL is not set');

  console.log('Fetching feeds and prompts...');
  const [feedX, feedPodcasts, feedBlogs, ...promptTexts] = await Promise.all([
    fetchJSON(FEED_X_URL),
    fetchJSON(FEED_PODCASTS_URL),
    fetchJSON(FEED_BLOGS_URL),
    ...PROMPT_FILES.map(f => fetchText(`${PROMPTS_BASE}/${f}`))
  ]);

  // Fetch and merge extra RSS blogs
  const extraPosts = (await Promise.all(EXTRA_RSS_BLOGS.map(b => fetchRssBlog(b).catch(err => {
    console.warn(`Warning: failed to fetch RSS for ${b.name}: ${err.message}`);
    return [];
  })))).flat();
  if (extraPosts.length > 0) {
    feedBlogs.blogs = [...(feedBlogs.blogs || []), ...extraPosts];
    console.log(`Merged ${extraPosts.length} extra RSS post(s) from: ${EXTRA_RSS_BLOGS.map(b => b.name).join(', ')}`);
  }

  const prompts = Object.fromEntries(
    PROMPT_FILES.map((f, i) => [f.replace('.md', '').replace(/-/g, '_'), promptTexts[i]])
  );

  const stats = {
    podcastEpisodes: feedPodcasts?.podcasts?.length || 0,
    xBuilders:       feedX?.x?.length || 0,
    totalTweets:     (feedX?.x || []).reduce((s, a) => s + a.tweets.length, 0),
    blogPosts:       feedBlogs?.blogs?.length || 0,
  };
  console.log(`Content: ${stats.xBuilders} builders, ${stats.totalTweets} tweets, ${stats.podcastEpisodes} podcasts, ${stats.blogPosts} blogs`);

  if (stats.xBuilders === 0 && stats.podcastEpisodes === 0 && stats.blogPosts === 0) {
    console.log('No content today, skipping.');
    return;
  }

  // Build prompt for Claude
  const today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });

  const systemPrompt = `你是一个 AI 领域内容策展人，负责每日生成 AI Builders Digest 摘要。
今天的日期是 ${today}（北京时间）。
语言设置：${LANGUAGE === 'zh' ? '全部用中文输出' : LANGUAGE === 'bilingual' ? '中英双语，逐段交替' : '全部用英文输出'}。

以下是摘要规则：

${prompts.digest_intro}

推文摘要规则：
${prompts.summarize_tweets}

播客摘要规则：
${prompts.summarize_podcast}

博客摘要规则：
${prompts.summarize_blogs}

翻译规则（如需翻译）：
${prompts.translate}`;

  const userPrompt = `请根据以下数据生成今日摘要。

<feeds>
${JSON.stringify({ podcasts: feedPodcasts?.podcasts || [], x: feedX?.x || [], blogs: feedBlogs?.blogs || [] }, null, 2)}
</feeds>

要求：
- 仅使用以上数据中的内容，不要捏造任何信息
- 每条内容必须附上原始链接
- 语言：${LANGUAGE === 'zh' ? '全部中文' : LANGUAGE === 'bilingual' ? '中英双语逐段交替' : '全部英文'}`;

  console.log('Calling DeepSeek API...');
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      max_tokens: 4096,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt }
      ]
    })
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(`DeepSeek API error: ${err.error?.message || JSON.stringify(err)}`);
  }
  const data = await res.json();
  const digest = data.choices[0].message.content;
  console.log('Digest generated, sending to WeCom...');

  await sendWecom(digest, webhookUrl);
  console.log('Done! Digest sent to WeCom.');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
