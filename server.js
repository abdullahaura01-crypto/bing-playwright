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

    const textarea = page.locator('textarea, input[type="text"]').first();
    await textarea.waitFor({ timeout: 30000 });
    await textarea.fill(prompt);

    const createButton = page.getByRole('button', { name: /create|generate/i }).first();
    await createButton.click();

    await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {});
    await page.waitForTimeout(10000);

    const firstImage = page.locator('img').nth(0);
    let imageUrl = await firstImage.getAttribute('src');

    if (!imageUrl || !imageUrl.startsWith('http')) {
      const firstLink = page.locator('a').nth(0);
      imageUrl = await firstLink.getAttribute('href');
    }

    if (!imageUrl || !imageUrl.startsWith('http')) {
      return res.status(500).json({
        success: false,
        error: 'Could not extract imageUrl from Bing results'
      });
    }

    res.json({
      success: true,
      imageUrl,
      promptReceived: prompt
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