// Run with playwright-cli run-code --filename assets/demos/capture.cjs.
// Serve demo.html locally first. This visits only the isolated mock page.
async (page) => {
  await page.setViewportSize({ width: 1200, height: 740 });
  await page.goto('http://127.0.0.1:8786/demo.html');
  await page.evaluate(() => document.fonts.ready);
  for (const scene of ['cards', 'dag', 'import']) {
    for (let frame = 0; frame < 90; frame++) {
      const time = frame / 10;
      await page.evaluate(([scene, time]) => window.renderFrame(scene, time), [scene, time]);
      await page.screenshot({ path: `assets/demos/frames/${scene}/${String(frame).padStart(3, '0')}.png` });
    }
  }
}
