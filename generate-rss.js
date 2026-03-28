const fs = require("fs");
const axios = require("axios");
const cheerio = require("cheerio");
const RSS = require("rss");

const baseURL = "https://spectator.com";
const flareSolverrURL = process.env.FLARESOLVERR_URL || "http://localhost:8191";
const MAX_ITEMS = 500;

const EDITIONS = {
  us: { url: "https://spectator.com/?set_edition=us", feedPath: "./feeds/spectator_us.xml" },
  en: { url: "https://spectator.com/?set_edition=en", feedPath: "./feeds/spectator_en.xml" },
};

fs.mkdirSync("./feeds", { recursive: true });

// ===== DATE PARSING =====
function parseItemDate(raw) {
  if (!raw || !raw.trim()) return new Date();
  const trimmed = raw.trim();
  const relMatch = trimmed.match(/^(\d+)\s+(minute|hour|day)s?\s+ago$/i);
  if (relMatch) {
    const n    = parseInt(relMatch[1], 10);
    const unit = relMatch[2].toLowerCase();
    const ms   = unit === "minute" ? n * 60_000
               : unit === "hour"   ? n * 3_600_000
               :                     n * 86_400_000;
    return new Date(Date.now() - ms);
  }
  const d = new Date(trimmed);
  if (!isNaN(d.getTime())) return d;
  console.warn(`⚠️  Could not parse date: "${trimmed}" — using now()`);
  return new Date();
}

// ===== LOAD EXISTING ITEMS FROM FEED =====
function loadExistingItems(feedPath) {
  if (!fs.existsSync(feedPath)) return [];
  try {
    const xml = fs.readFileSync(feedPath, "utf-8");
    const $ = cheerio.load(xml, { xmlMode: true });
    const items = [];
    $("item").each((_, el) => {
      const $el    = $(el);
      const title  = $el.find("title").first().text().trim();
      const link   = $el.find("link").first().text().trim()
                  || $el.find("guid").first().text().trim();
      const desc   = $el.find("description").first().text().trim();
      const author = $el.find("author").first().text().trim()
                  || $el.find("dc\\:creator").first().text().trim();
      const pubDate = $el.find("pubDate").first().text().trim();
      if (!title || !link) return;
      items.push({ title, link, description: desc, author, date: parseItemDate(pubDate) });
    });
    console.log(`📂 Loaded ${items.length} existing items from ${feedPath}`);
    return items;
  } catch (err) {
    console.warn(`⚠️  Could not parse existing feed: ${err.message} — starting fresh`);
    return [];
  }
}

// ===== FLARESOLVERR =====
async function fetchWithFlareSolverr(url) {
  console.log(`Fetching ${url} via FlareSolverr...`);
  const response = await axios.post(
    `${flareSolverrURL}/v1`,
    { cmd: "request.get", url, maxTimeout: 60000 },
    { headers: { "Content-Type": "application/json" }, timeout: 65000 }
  );
  if (response.data?.solution) {
    console.log("✅ FlareSolverr successfully bypassed protection");
    return response.data.solution.response;
  }
  throw new Error("FlareSolverr did not return a solution");
}

// ===== SCRAPE =====
function scrapeArticles($) {
  const newItems = [];
  const seen = new Set();

  function addItem(title, href, author, description) {
    if (!title || !href) return;
    // Only keep actual article URLs, skip YouTube / external links
    if (!href.includes("/article/")) return;
    const link = href.startsWith("http") ? href : baseURL + href;
    if (seen.has(link)) return;
    seen.add(link);
    newItems.push({ title, link, description, author, date: new Date() });
  }

  // ── Type 1: article.article ──────────────────────────────────────────────
  // Sections: magazine-minor, home-magazine, home-culture, rail articles, etc.
  // Selectors: a.article__title-link, a.article__author, span.article__kicker,
  //            p.article__excerpt-text
  $("article.article").each((_, el) => {
    const $a     = $(el);
    const titleEl = $a.find("a.article__title-link").first();
    const title   = titleEl.text().trim();
    const href    = titleEl.attr("href");
    const author  = $a.find("a.article__author").first().text().trim();
    const kicker  = $a.find("span.article__kicker").first().text().trim().replace(/\/$/, "").trim();
    const excerpt = $a.find("p.article__excerpt-text").first().text().trim();
    const desc    = excerpt || kicker || (author ? `By ${author}` : "");
    addItem(title, href, author, desc);
  });

  // ── Type 2: article.related-card__inner ──────────────────────────────────
  // Used in: "Most Popular" list
  // Selectors: a.related-card__title-link > span.related-card__title-text,
  //            a.related-card__author
  $("article.related-card__inner").each((_, el) => {
    const $a     = $(el);
    const titleEl = $a.find("a.related-card__title-link").first();
    const title   = $a.find("span.related-card__title-text").first().text().trim();
    const href    = titleEl.attr("href");
    const author  = $a.find("a.related-card__author").first().text().trim();
    addItem(title, href, author, author ? `By ${author}` : "");
  });

  // ── Type 3: article.writers-list-item__inner ─────────────────────────────
  // Used in: "Writers" section
  // Selectors: a.writers-list-item__title-link > span.writers-list-item__title-text,
  //            a.writers-list-item__author
  $("article.writers-list-item__inner").each((_, el) => {
    const $a     = $(el);
    const titleEl = $a.find("a.writers-list-item__title-link").first();
    const title   = $a.find("span.writers-list-item__title-text").first().text().trim();
    const href    = titleEl.attr("href");
    const author  = $a.find("a.writers-list-item__author").first().text().trim();
    addItem(title, href, author, author ? `By ${author}` : "");
  });

  // ── Excluded: article.spectator-tv-card ──────────────────────────────────
  // YouTube links — intentionally skipped

  return newItems;
}

// ===== MAIN =====
async function generateRSS(edition) {
  const { url, feedPath } = EDITIONS[edition];

  try {
    const htmlContent = await fetchWithFlareSolverr(url);
    const $ = cheerio.load(htmlContent);
    const newItems = scrapeArticles($);

    console.log(`🆕 [${edition}] Scraped ${newItems.length} articles from page`);

    const existingItems = loadExistingItems(feedPath);
    const existingByLink = new Map(existingItems.map(i => [i.link, i]));

    for (const item of newItems) {
      // Preserve existing date if we already have this article
      if (existingByLink.has(item.link)) {
        item.date = existingByLink.get(item.link).date;
      }
      existingByLink.set(item.link, item);
    }

    const merged = [...existingByLink.values()]
      .sort((a, b) => b.date - a.date)
      .slice(0, MAX_ITEMS);

    console.log(`📦 [${edition}] Total items after merge: ${merged.length}`);

    if (merged.length === 0) {
      merged.push({
        title:       "No articles found yet",
        link:        baseURL,
        description: "RSS feed could not scrape any articles.",
        author:      "",
        date:        new Date(),
      });
    }

    const feed = new RSS({
      title:       `The Spectator (${edition.toUpperCase()})`,
      description: `Latest articles from The Spectator (${edition.toUpperCase()} edition)`,
      feed_url:    baseURL,
      site_url:    baseURL,
      language:    "en",
      pubDate:     new Date().toUTCString(),
    });

    merged.forEach(item => {
      feed.item({
        title:       item.title,
        url:         item.link,
        description: item.description,
        author:      item.author || undefined,
        date:        item.date,
      });
    });

    fs.writeFileSync(feedPath, feed.xml({ indent: true }));
    console.log(`✅ [${edition}] RSS written with ${merged.length} items (max ${MAX_ITEMS}).`);

  } catch (err) {
    console.error(`❌ [${edition}] Error generating RSS: ${err.message}`);

    if (fs.existsSync(feedPath)) {
      console.log(`⚠️  [${edition}] Scrape failed — existing feed preserved as-is.`);
      return;
    }

    const feed = new RSS({
      title:       `The Spectator ${edition.toUpperCase()} (error fallback)`,
      description: "RSS feed could not scrape, showing placeholder",
      feed_url:    baseURL,
      site_url:    baseURL,
      language:    "en",
      pubDate:     new Date().toUTCString(),
    });
    feed.item({
      title:       "Feed generation failed",
      url:         baseURL,
      description: "An error occurred during scraping.",
      date:        new Date(),
    });
    fs.writeFileSync(feedPath, feed.xml({ indent: true }));
  }
}

(async () => {
  await generateRSS("us");
  await generateRSS("en");
})();
