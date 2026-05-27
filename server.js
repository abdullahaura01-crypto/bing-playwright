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

    page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(60000);

    await page.goto('https://www.bing.com/images/create', {
      waitUntil: 'domcontentloaded'
    });

    await page.waitForLoadState('networkidle').catch(() => {});

    const dismissButtons = [
      page.getByRole('button', { name: /accept|agree|continue|got it|okay|ok|allow/i }).first(),
      page.getByRole('button', { name: /sign in later|maybe later|not now|skip/i }).first()
    ];

    for (const btn of dismissButtons) {
      try {
        if (await btn.isVisible({ timeout: 2000 })) {
          await btn.click();
          await page.waitForTimeout(1000);
        }
      } catch (_) {}
    }

    let promptInput = page.getByRole('textbox').filter({ visible: true }).first();

    try {
      await promptInput.waitFor({ state: 'visible', timeout: 8000 });
    } catch (_) {
      const candidates = [
        page.getByPlaceholder(/describe|create|image|anything/i).first(),
        page.locator('textarea:visible').first(),
        page.locator('input[type="text"]:visible').first()
      ];

      let found = false;
      for (const candidate of candidates) {
        try {
          await candidate.waitFor({ state: 'visible', timeout: 5000 });
          promptInput = candidate;
          found = true;
          break;
        } catch (_) {}
      }

      if (!found) {
        return res.status(500).json({
          success: false,
          error: 'Could not find visible Bing prompt input. You may need to confirm the page layout or login state.'
        });
      }
    }

    await promptInput.click();
    await promptInput.fill(String(prompt).trim());

    let createButton = page.getByRole('button', { name: /create|generate/i }).first();

    try {
      await createButton.waitFor({ state: 'visible', timeout: 8000 });
    } catch (_) {
      const fallbackButtons = [
        page.locator('button:visible').filter({ hasText: /create|generate/i }).first(),
        page.locator('input[type="submit"]:visible').first()
      ];

      let found = false;
      for (const candidate of fallbackButtons) {
        try {
          await candidate.waitFor({ state: 'visible', timeout: 5000 });
          createButton = candidate;
          found = true;
          break;
        } catch (_) {}
      }

      if (!found) {
        return res.status(500).json({
          success: false,
          error: 'Could not find Create/Generate button on Bing.'
        });
      }
    }

    await createButton.click();

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
          'bing.com/sa/',
          'th.bing.com/th/id/ODLS',
          'r.bing.com'
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
        error: 'No image URLs found. Bing may still be generating, the selector may need adjustment, or the result may require login/session cookies.',
        promptReceived: prompt
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
    } catch (e) {
      console.error('page close error:', e.message);
    }

    try {
      if (context) await context.close();
    } catch (e) {
      console.error('context close error:', e.message);
    }

    try {
      if (browser) await browser.close();
    } catch (e) {
      console.error('browser close error:', e.message);
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});