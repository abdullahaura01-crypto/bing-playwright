const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    message: 'Playwright app is running'
  });
});

app.post('/generate-bing', async (req, res) => {
  const { prompt } = req.body;

  if (!prompt) {
    return res.status(400).json({
      success: false,
      error: 'Prompt is required'
    });
  }

  let browser;
  let context;

  try {
    browser = await chromium.launch({
      headless: true,
      dumpio: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--no-zygote'
      ]
    });

    context = await browser.newContext();
    const page = await context.newPage();

    await page.goto('https://www.bing.com/images/create', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});

    const promptInput = page.locator('textarea, input[type="text"]').first();
    await promptInput.waitFor({ state: 'visible', timeout: 30000 });
    await promptInput.fill(prompt);

    const createButton = page.getByRole('button', { name: /create|generate/i }).first();
    await createButton.click();

    await page.waitForTimeout(15000);

    let imageUrls = [];

    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(5000);

      imageUrls = await page.evaluate(() => {
        const urls = new Set();

        document.querySelectorAll('img').forEach((img) => {
          const src = img.getAttribute('src') || '';
          if (src.startsWith('http')) urls.add(src);
        });

        document.querySelectorAll('a').forEach((a) => {
          const href = a.getAttribute('href') || '';
          if (href.startsWith('http')) urls.add(href);
        });

        return Array.from(urls);
      });

      imageUrls = imageUrls.filter(
        (url) =>
          url.startsWith('http') &&
          !url.includes('logo') &&
          !url.includes('avatar') &&
          !url.includes('icon') &&
          !url.includes('favicon')
      );

      if (imageUrls.length > 0) {
        break;
      }
    }

    if (!imageUrls.length) {
      return res.status(500).json({
        success: false,
        error: 'No image URLs found yet. Bing may still be generating or selectors may need adjustment.'
      });
    }

    res.json({
      success: true,
      promptReceived: prompt,
      imageUrl: imageUrls[0],
      imageUrls
    });
  } catch (error) {
    console.error('generate-bing error:', error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  } finally {
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