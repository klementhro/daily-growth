const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium, webkit } = require("playwright");

const root = process.cwd();
const mime = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png" };
const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  const target = path.resolve(root, pathname === "/" ? "index.html" : `.${pathname}`);
  if (!target.startsWith(root) || !fs.existsSync(target)) { response.writeHead(404).end(); return; }
  response.setHeader("Content-Type", mime[path.extname(target)] || "application/octet-stream");
  response.end(fs.readFileSync(target));
});

const sample = {
  "2026-08-26": {
    english: [{ minutes: 45, content: "阅读" }],
    lacquer: [{ minutes: 80, content: "髹漆" }],
    dance: [{ title: "练书法", minutes: 30 }, { title: "看电影", minutes: 120 }]
  },
  "2026-08-25": { english: [{ minutes: 30, content: "听力" }] }
};

(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const engines = [
    ["Edge", chromium, { executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", headless: true }],
    ["WebKit", webkit, { headless: true }]
  ];
  for (const [name, engine, launchOptions] of engines) {
    let browser;
    try { browser = await engine.launch(launchOptions); }
    catch (error) { console.log(`${name}: unavailable (${error.message.split("\n")[0]})`); continue; }
    for (const width of [375, 390, 393, 402, 430]) {
      const context = await browser.newContext({ viewport: { width, height: 844 } });
      const page = await context.newPage();
      await page.addInitScript((records) => localStorage.setItem("daily-growth:v1", JSON.stringify(records)), sample);
      await page.goto(url);
      await page.waitForSelector(".project-card");
      const home = await page.evaluate(() => {
        const cards = [...document.querySelectorAll(".project-card")].map((card) => card.getBoundingClientRect());
        return { count: cards.length, vertical: cards.every((card, index) => !index || card.top > cards[index - 1].bottom), overflow: document.documentElement.scrollWidth > innerWidth };
      });
      if (home.count !== 3 || !home.vertical || home.overflow) throw new Error(`${name} ${width}px home layout failed`);
      await page.getByRole("button", { name: "历史" }).click();
      await page.waitForSelector(".history-row");
      const history = await page.evaluate(() => {
        const card = document.querySelector(".history-row");
        const groups = [...card.querySelectorAll(".day-project")].map((group) => group.getBoundingClientRect());
        return { groups: groups.length, vertical: groups.every((group, index) => !index || group.top >= groups[index - 1].bottom), misc: card.querySelectorAll(".misc-summary-list > div").length, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      if (history.groups !== 3 || !history.vertical || history.misc !== 2 || history.overflow) throw new Error(`${name} ${width}px history layout failed`);
      await page.getByRole("button", { name: "筛选" }).click();
      if (!await page.locator("#filter-sheet").isVisible() || !await page.locator(".sheet-handle").isVisible()) throw new Error(`${name} ${width}px filter sheet failed`);
      await page.waitForTimeout(280);
      if (name === "Edge" && width === 390 && process.env.UI_SCREENSHOT) await page.screenshot({ path: process.env.UI_SCREENSHOT, fullPage: true });
      await page.getByRole("button", { name: "关闭筛选" }).click();
      await context.close();
    }
    await browser.close();
    console.log(`${name}: 375/390/393/402/430px passed`);
  }
  server.close();
})().catch((error) => { server.close(); console.error(error); process.exit(1); });
