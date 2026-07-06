import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';

async function run() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn('Warning: GITHUB_TOKEN environment variable is not set. The script might fail if the IP is rate-limited.');
  }

  console.log('Launching headless browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });

    // Enable console logs from the page context to help debugging
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));

    console.log('Navigating to star-history.com to set up localStorage...');
    await page.goto('https://star-history.com/', { waitUntil: 'networkidle2' });

    if (token) {
      console.log('Injecting GitHub token into localStorage...');
      await page.evaluate((t) => {
        // star-history stores token as JSON-stringified value
        localStorage.setItem('accessTokenCache', JSON.stringify(t));
      }, token);
    }

    console.log('Navigating to the repository star history page...');
    await page.goto('https://star-history.com/#Rich627/whatsapp-claude-plugin&Date', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    console.log('Waiting 10 seconds for the chart to fetch and render...');
    await new Promise(resolve => setTimeout(resolve, 10000));

    console.log('Locating the chart SVG in the DOM...');
    const svgContent = await page.evaluate(() => {
      const svgs = Array.from(document.querySelectorAll('svg'));
      
      // Find the SVG that represents the chart (width > 500px or viewBox matches)
      const chartSvg = svgs.find(svg => {
        const viewBox = svg.getAttribute('viewBox') || '';
        const widthAttr = svg.getAttribute('width') || '';
        const width = svg.getBoundingClientRect().width;
        
        // The chart is large and has paths/text
        const isLarge = width > 500 || (widthAttr && parseInt(widthAttr) > 500) || viewBox.includes('0 0 800') || viewBox.includes('0 0 1000');
        const hasData = svg.innerHTML.includes('path') && svg.innerHTML.includes('text');
        
        return isLarge && hasData;
      });

      return chartSvg ? chartSvg.outerHTML : null;
    });

    if (!svgContent) {
      // If we failed to find it, let's dump the HTML body to understand what is shown
      const bodyHTML = await page.evaluate(() => document.body.innerHTML);
      console.log('Failed to find chart SVG. Page body HTML snippet:', bodyHTML.substring(0, 1000));
      throw new Error('No SVG chart found in the page DOM. Page might have failed to load or got rate-limited.');
    }

    const assetsDir = path.join(process.cwd(), 'assets');
    if (!fs.existsSync(assetsDir)) {
      fs.mkdirSync(assetsDir, { recursive: true });
    }

    const outputPath = path.join(assetsDir, 'star-history.svg');
    fs.writeFileSync(outputPath, svgContent, 'utf8');
    console.log(`Success! Saved official star-history SVG to ${outputPath}`);
  } catch (error) {
    console.error('Error during execution:', error);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

run();
