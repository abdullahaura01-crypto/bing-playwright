const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;

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

  let browser;
  let context;
  let page;

  try {
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

    const title = await page.title().catch(() => '');
    const currentUrl = page.url();
    const bodyText = await page.locator('body').innerText().catch(() => '');

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
      return res.status(500).json({
        success: false,
        error: 'Could not find visible Bing prompt input. Confirm login/cookies and page layout.',
        debug: {
          title,
          currentUrl,
          bodySnippet: bodyText.slice(0, 1500),
          hasCookies: !!rawCookies
        }
      });
    }

    try {
      await promptInput.fill(String(prompt).trim());
    } catch (_) {
      try {
        await promptInput.click({ force: true });
        await promptInput.fill(String(prompt).trim());
      } catch (e) {
        return res.status(500).json({
          success: false,
          error: 'Could not type into Bing prompt input.',
          debug: {
            title,
            currentUrl,
            bodySnippet: bodyText.slice(0, 1500),
            typingError: e.message
          }
        });
      }
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
      return res.status(500).json({
        success: false,
        error: 'Could not find visible Create/Generate button.',
        debug: {
          title,
          currentUrl,
          bodySnippet: bodyText.slice(0, 1500)
        }
      });
    }

    await createButton.click({ force: true });

    const maxWaitMs = 180000;
    const pollMs = 5000;
    const startTime = Date.now();
    let imageUrls = [];

    while (Date.now() - startTime < maxWaitMs) {
      await page.waitForTimeout(pollMs);

      imageUrls = await page.evaluate(() => {
        const urls = new Set();

        const badParts = [
          'logo',
          'avatar',
          'icon',
          'favicon',
          'sprite',
          'r.bing.com',
          'th.bing.com/th/id/odls'
        ];

        const isGood = (url) => {
          if (!url || typeof url !== 'string') return false;
          if (!url.startsWith('http')) return false;
          const lower = url.toLowerCase();
          return !badParts.some(part => lower.includes(part));
        };

        document.querySelectorAll('img').forEach((img) => {
          const src = img.getAttribute('src') || img.src || '';
          if (isGood(src)) urls.add(src);
        });

        document.querySelectorAll('a').forEach((a) => {
          const href = a.getAttribute('href') || a.href || '';
          if (isGood(href)) urls.add(href);
        });

        return Array.from(urls);
      });

      if (imageUrls.length > 0) {
        break;
      }
    }

    if (!imageUrls.length) {
      return res.status(500).json({
        success: false,
        error: 'No image URLs found after waiting.',
        debug: {
          title: await page.title().catch(() => ''),
          finalUrl: page.url(),
          bodySnippet: await page.locator('body').innerText().then(t => t.slice(0, 1500)).catch(() => '')
        }
      });
    }

    return res.json({
      success: true,
      promptReceived: prompt,
      imageUrl: imageUrls[0],
      imageUrls
    });
  } catch (error) {
    console.error('generate-bing error:', error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
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
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});