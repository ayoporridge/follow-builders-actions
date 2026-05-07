#!/usr/bin/env node

// ============================================================================
// Follow Builders — GitHub Actions Runner
// ============================================================================
// 1. Fetches central feeds (tweets, podcasts, blogs)
// 2. Fetches prompts from GitHub
// 3. Calls Claude API to generate a Chinese digest
// 4. Sends digest to WeCom webhook
//
// Environment variables required:
//   ANTHROPIC_API_KEY  — Anthropic API key
//   WECOM_WEBHOOK_URL  — WeCom group bot webhook URL
// ============================================================================

import Anthropic from '@anthropic-ai/sdk';

// -- Config ------------------------------------------------------------------

const LANGUAGE = 'zh'; // change to 'en' or 'bilingual' if needed

const FEED_X_URL        = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json';
const FEED_PODCASTS_URL = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-podcasts.json';
const FEED_BLOGS_URL    = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-blogs.json';
const PROMPTS_BASE      = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/prompts';
const PROMPT_FILES      = ['summarize-podcast.md', 'summarize-tweets.md', 'summarize-blogs.md', 'digest-intro.md', 'translate.md'];

// -- Helpers -----------------------------------------------------------------

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

// WeCom has a 2048 char limit per message — split if needed
async function sendWecom(text, webhookUrl) {
  const MAX_LEN = 2048;
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
      body: JSON.stringify({ msgtype: 'text', text: { content: chunk } })
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
  const apiKey      = process.env.ANTHROPIC_API_KEY;
  const webhookUrl  = process.env.WECOM_WEBHOOK_URL;
  if (!apiKey)     throw new Error('ANTHROPIC_API_KEY is not set');
  if (!webhookUrl) throw new Error('WECOM_WEBHOOK_URL is not set');

  console.log('Fetching feeds and prompts...');
  const [feedX, feedPodcasts, feedBlogs, ...promptTexts] = await Promise.all([
    fetchJSON(FEED_X_URL),
    fetchJSON(FEED_PODCASTS_URL),
    fetchJSON(FEED_BLOGS_URL),
    ...PROMPT_FILES.map(f => fetchText(`${PROMPTS_BASE}/${f}`))
  ]);

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

  console.log('Calling Claude API...');
  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });

  const digest = message.content[0].text;
  console.log('Digest generated, sending to WeCom...');

  await sendWecom(digest, webhookUrl);
  console.log('Done! Digest sent to WeCom.');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
