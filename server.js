const express = require('express');
const crypto = require('crypto');
const { chromium } = require('playwright');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const jobs = {};

function normalizeUrl(url) {
  if (!url || typeof url !== 'string') return '';
  return url.trim();
}

function isGeneratedBingImage(url) {
  const u = normalizeUrl(url).toLowerCase();
  return (
    u.startsWith('https://th.bing.com/th/id/oig') ||
    u.startsWith('http://th.bing.com/th/id/oig')
  );
}

async function runBingJob(jobId, prompt) {
  let browser;
  let context;
  let page;

  try {
    jobs[jobId] = {
      status: 'processing',
      prompt,
      imageUrl: null,
      imageUrls: [],
      error: null,
      createdAt: new Date().toISOString()
    };

    browser = await chromium.launch({
      headless: true,
      dumpio: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote'
      ]
    });

    context = await browser.newContext({
      viewport: { width: 1440, height: 900 }
    });

    const rawCookies = process.env.BING_COOKIES;
    if (rawCookies) {
      const cookies = JSON.parse(rawCookies);
      if (Array.isArray(cookies) && cookies.length > 0) {
        await context.addCookies(cookies);
      }
    }

    page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(60000);

    await page.goto('https://www.bing.com/images/create', {
      waitUntil: 'domcontentloaded'
    });

    await page.waitForTimeout(5000);
    await page.waitForLoadState('networkidle').catch(() => {});

    const dismissCandidates = [
      page.getByRole('button', { name: /accept|agree|continue|got it|okay|ok|allow/i }).first(),
      page.getByRole('button', { name: /skip|not now|maybe later/i }).first()
    ];

    for (const btn of dismissCandidates) {
      try {
        if (await btn.isVisible({ timeout: 2000 })) {
          await btn.click({ force: true });
          await page.waitForTimeout(1500);
        }
      } catch (_) {}
    }

    const inputCandidates = [
      page.getByRole('textbox').first(),
      page.getByPlaceholder(/describe|create|anything|prompt|image/i).first(),
      page.locator('textarea:visible').first(),
      page.locator('input[type="text"]:visible').first()
    ];

    let promptInput = null;

    for (const candidate of inputCandidates) {
      try {
        await candidate.waitFor({ state: 'visible', timeout: 5000 });
        promptInput = candidate;
        break;
      } catch (_) {}
    }

    if (!promptInput) {
      throw new Error('Could not find visible Bing prompt input');
    }

    const getCurrentOigUrls = async () => {
      const urls = await page.evaluate(() => {
        const collected = new Set();

        const isOig = (url) => {
          if (!url || typeof url !== 'string') return false;
          const u = url.toLowerCase();
          return u.startsWith('https://th.bing.com/th/id/oig') || u.startsWith('http://th.bing.com/th/id/oig');
        };

        document.querySelectorAll('img').forEach((img) => {
          const src = img.getAttribute('src') || img.src || '';
          if (isOig(src)) collected.add(src);
        });

        document.querySelectorAll('a').forEach((a) => {
          const href = a.getAttribute('href') || a.href || '';
          if (isOig(href)) collected.add(href);
        });

        return Array.from(collected);
      });

      return urls.filter(isGeneratedBingImage);
    };

    const beforeUrls = await getCurrentOigUrls();

    try {
      await promptInput.fill(String(prompt).trim());
    } catch (_) {
      await promptInput.click({ force: true });
      await promptInput.fill(String(prompt).trim());
    }

    const buttonCandidates = [
      page.getByRole('button', { name: /create|generate/i }).first(),
      page.locator('button:visible').filter({ hasText: /create|generate/i }).first(),
      page.locator('input[type="submit"]:visible').first()
    ];

    let createButton = null;

    for (const candidate of buttonCandidates) {
      try {
        await candidate.waitFor({ state: 'visible', timeout: 5000 });
        createButton = candidate;
        break;
      } catch (_) {}
    }

    if (!createButton) {
      throw new Error('Could not find visible Create/Generate button');
    }

    await createButton.click({ force: true });

    const maxWaitMs = 180000;
    const pollMs = 5000;
    const startTime = Date.now();

    let afterUrls = [];
    let newUrls = [];

    while (Date.now() - startTime < maxWaitMs) {
      await page.waitForTimeout(pollMs);

      afterUrls = await getCurrentOigUrls();
      newUrls = afterUrls.filter(url => !beforeUrls.includes(url));

      if (newUrls.length > 0) {
        break;
      }
    }

    if (!newUrls.length) {
      throw new Error('No new generated image URLs found for the current prompt');
    }

    jobs[jobId] = {
      ...jobs[jobId],
      status: 'done',
      imageUrl: newUrls[0],
      imageUrls: newUrls,
      finishedAt: new Date().toISOString()
    };
  } catch (error) {
    jobs[jobId] = {
      ...jobs[jobId],
      status: 'failed',
      error: error.message,
      finishedAt: new Date().toISOString()
    };
  } finally {
    try {
      if (page) await page.close();
    } catch (_) {}

    try {
      if (context) await context.close();
    } catch (_) {}

    try {
      if (browser) await browser.close();
    } catch (_) {}
  }
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    message: 'Playwright app is running'
  });
});

app.post('/generate-bing', async (req, res) => {
  const { prompt } = req.body;

  if (!prompt || !String(prompt).trim()) {
    return res.status(400).json({
      success: false,
      error: 'Prompt is required'
    });
  }

  const jobId = crypto.randomUUID();

  jobs[jobId] = {
    status: 'queued',
    prompt: String(prompt).trim(),
    imageUrl: null,
    imageUrls: [],
    error: null,
    createdAt: new Date().toISOString()
  };

  runBingJob(jobId, String(prompt).trim());

  return res.json({
    success: true,
    message: 'Job started',
    jobId,
    status: 'queued'
  });
});

app.get('/job-status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];

  if (!job) {
    return res.status(404).json({
      success: false,
      error: 'Job not found'
    });
  }

  return res.json({
    success: true,
    jobId,
    status: job.status,
    prompt: job.prompt,
    imageUrl: job.imageUrl,
    imageUrls: job.imageUrls,
    error: job.error,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt || null
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});