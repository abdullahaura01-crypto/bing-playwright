const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Fixed settings based on verified live Bing UI
const FIXED_MODE = 'Vivid storytelling';  // MAI-Image-2e model
const FIXED_ASPECT_RATIO = '1:1';         // Square - confirmed in live UI

// Parse BING_COOKIES env var - must be a JSON array of cookie objects
function parseCookies() {
  const raw = process.env.BING_COOKIES;
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error('Failed to parse BING_COOKIES:', e.message);
    return [];
  }
}

app.get('/health', (req, res) => {
  const cookies = parseCookies();
  res.json({
    ok: true,
    message: 'Playwright app is running',
    cookiesLoaded: cookies.length,
    fixedMode: FIXED_MODE,
    fixedAspectRatio: FIXED_ASPECT_RATIO
  });
});

app.post('/generate-bing', async (req, res) => {
  const { prompt } = req.body;

  if (!prompt) {
    return res.status(400).json({ success: false, error: 'Prompt is required' });
  }

  const cookies = parseCookies();
  if (cookies.length === 0) {
    return res.status(500).json({
      success: false,
      error: 'BING_COOKIES env variable is not set or empty. Cannot login to Bing.'
    });
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    });

    // Inject Bing session cookies
    await context.addCookies(cookies);

    const page = await context.newPage();

    console.log('Navigating to Bing Image Creator...');
    await page.goto('https://www.bing.com/images/create/ai-image-generator', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    // Check if logged in
    const signInBtn = await page.$('a[href*="login"], button:has-text("Sign in")');
    if (signInBtn) {
      throw new Error('Not logged in to Bing. Check BING_COOKIES value.');
    }

    console.log('Logged in. Filling prompt...');

    // Fill the prompt textarea
    const promptSelector = 'textarea#sb_form_q, textarea[placeholder*="Describe"], textarea[aria-label*="prompt"], #sb_form_q';
    await page.waitForSelector(promptSelector, { timeout: 15000 });
    await page.fill(promptSelector, prompt);

    // Select Mode: Vivid storytelling (click the mode dropdown and pick it)
    try {
      const modeBtn = await page.$('button:has-text("Mode:"), [aria-label*="Mode"]');
      if (modeBtn) {
        await modeBtn.click();
        await page.waitForTimeout(800);
        const vividOption = await page.$('li:has-text("Vivid storytelling"), [data-value*="vivid"], button:has-text("Vivid")');
        if (vividOption) {
          await vividOption.click();
          await page.waitForTimeout(500);
          console.log('Mode set to Vivid storytelling');
        }
      }
    } catch (e) {
      console.log('Could not set mode, using default:', e.message);
    }

    // Select Aspect Ratio: 1:1
    try {
      const arBtn = await page.$('button:has-text("Aspect ratio:"), [aria-label*="Aspect"]');
      if (arBtn) {
        await arBtn.click();
        await page.waitForTimeout(800);
        const squareOption = await page.$('li:has-text("1:1"), [data-value="1:1"], button:has-text("1:1")');
        if (squareOption) {
          await squareOption.click();
          await page.waitForTimeout(500);
          console.log('Aspect ratio set to 1:1');
        }
      }
    } catch (e) {
      console.log('Could not set aspect ratio, using default:', e.message);
    }

    // Click Create button
    console.log('Clicking Create...');
    const createBtn = await page.waitForSelector('button:has-text("Create"), #create_btn, button[aria-label*="Create"]', { timeout: 10000 });
    await createBtn.click();

    // Wait for generation to complete - wait for image results
    console.log('Waiting for image generation...');
    await page.waitForSelector(
      '.gil_img img, .mimg, img.rms_img, [class*="imageResult"] img, .img_cont img',
      { timeout: 120000 }
    );

    await page.waitForTimeout(2000);

    // Extract generated image URLs
    const imageUrls = await page.evaluate(() => {
      const imgs = document.querySelectorAll('.gil_img img, .mimg, img.rms_img, [class*="imageResult"] img');
      return Array.from(imgs)
        .map(img => img.src || img.getAttribute('src'))
        .filter(src => src && src.startsWith('http') && !src.includes('placeholder') && !src.includes('loading'))
        .slice(0, 4);
    });

    console.log(`Found ${imageUrls.length} images`);

    if (imageUrls.length === 0) {
      throw new Error('No images found after generation. The page may have changed or generation failed.');
    }

    await browser.close();

    return res.json({
      success: true,
      imageUrl: imageUrls[0],
      allImageUrls: imageUrls,
      message: `Generated ${imageUrls.length} image(s)`,
      selectedMode: FIXED_MODE,
      selectedAspectRatio: FIXED_ASPECT_RATIO,
      prompt: prompt
    });

  } catch (error) {
    console.error('Error:', error.message);
    if (browser) await browser.close();
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
