const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const FIXED_MODE = 'Image';
const FIXED_ASPECT_RATIO = '7:4';
const FIXED_MODEL = 'DALL-E 3';

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

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto('https://www.bing.com/images/create/ai-image-generator', {
      waitUntil: 'domcontentloaded'
    });

    res.json({
      success: true,
      promptReceived: prompt,
      fixedMode: FIXED_MODE,
      fixedAspectRatio: FIXED_ASPECT_RATIO,
      fixedModel: FIXED_MODEL
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});