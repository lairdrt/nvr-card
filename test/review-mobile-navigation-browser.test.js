import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const repo = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Real browser mouse input, isolated local fixtures; no HA or media requests.
test("browser: narrow Review navigation, pointer destinations and compact transport", {
  skip: !existsSync(chrome) && "Local Chrome is unavailable",
  timeout: 45000
}, async t => {
  const page = `<!doctype html><style>
    body { margin:0; } #host { width:380px; height:850px; }
    nvr-card, ha-card { display:block; width:100%; }
  </style><div id="host"></div><script type="module">
    import '/nvr-card.js';
    const shadow = document.querySelector('#host').attachShadow({mode:'open'});
    const style = document.createElement('style');
    style.textContent='nvr-card, ha-card {display:block;width:100%}'; shadow.append(style);
    const card = document.createElement('nvr-card'); shadow.append(card);
    card.setConfig({ cameras:[{name:'Front',entity:'camera.front',active:true},
      {name:'Garage',entity:'camera.garage',active:true}] });
    card.hass={states:{'camera.front':{state:'idle'},'camera.garage':{state:'idle'}},
      user:{id:'fixture'}, callWS:async request=>request.type==='frigate_max/review/events'
        ? {schema:2,complete:true,items:[]} : {}, connection:{connected:true}};
    card.setApplicationMode('review');
    const c=card._reviewController;
    c.setSectionExpanded('cameras',true); c.setSectionExpanded('layouts',true);
    const commands=[];
    c.seekHistoricalRelative=seconds=>commands.push(seconds);
    c.snapToPreviousEvent=()=>commands.push('previous');
    c.snapToNextEvent=()=>commands.push('next');
    window.fixture={card,c,commands,cells:[...card.querySelectorAll('.review-layout-cell')]};
  </script>`;
  const server = createServer((req, res) => {
    if (req.url === "/") { res.setHeader("Content-Type", "text/html"); res.end(page); return; }
    const path = resolve(repo, "." + new URL(req.url, "http://fixture").pathname);
    if (!path.startsWith(repo + sep) || !existsSync(path)) { res.writeHead(404); res.end(); return; }
    res.setHeader("Content-Type", "text/javascript");
    if (path.endsWith("frigate-provider.js")) {
      res.end("export class FrigateProvider { constructor() {} }"); return;
    }
    res.end(readFileSync(path));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const profile = mkdtempSync(join(tmpdir(), "nvr-review-mobile-"));
  const process = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run",
    "--no-default-browser-check", "--disable-background-networking", "--disable-extensions",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"],
    { windowsHide: true, stdio: "ignore" });
  t.after(() => process.kill());
  const portFile = join(profile, "DevToolsActivePort");
  for (let attempt = 0; !existsSync(portFile) && attempt < 100; attempt++) await delay(100);
  assert.ok(existsSync(portFile), "Chrome remote debugging did not start");
  const port = readFileSync(portFile, "utf8").split(/\r?\n/)[0];
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const socket = new WebSocket(tabs.find(tab => tab.type === "page").webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener("open", resolve, { once: true }));
  t.after(() => socket.close());
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", event => {
    const result = JSON.parse(event.data);
    if (!result.id) return;
    const waiter = pending.get(result.id); pending.delete(result.id);
    result.error ? waiter.reject(new Error(result.error.message)) : waiter.resolve(result.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await call("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` });
  for (let attempt = 0; !await evaluate("!!window.fixture") && attempt < 100; attempt++) await delay(50);
  assert.equal(await evaluate("!!window.fixture"), true);
  const rect = selector => evaluate(`(()=>{const r=fixture.card.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height,left:r.left,right:r.right,top:r.top,bottom:r.bottom}})()`);
  const mouse = (type, point, pressed = false) => call("Input.dispatchMouseEvent", {
    type, x: point.x, y: point.y, button: type === "mouseMoved" ? "none" : "left",
    buttons: pressed ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1
  });
  const settle = () => evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))
    .then(()=>Promise.all(fixture.card.getAnimations({subtree:true}).map(animation=>animation.finished.catch(()=>{}))))`);
  const click = async selector => {
    const point = await rect(selector);
    await mouse("mousePressed", point, true); await mouse("mouseReleased", point);
    await settle();
  };
  assert.equal(await evaluate("fixture.card.querySelector('.review-control-rail').hidden"), true);
  const initialCells = await evaluate("fixture.cells.every((cell,i)=>fixture.card.querySelectorAll('.review-layout-cell')[i]===cell)");
  assert.equal(initialCells, true);
  await click(".mobile-navigation-toggle");
  assert.equal(await evaluate("fixture.card._mobileNavigationOpen"), true);
  assert.equal(await evaluate("getComputedStyle(fixture.card.querySelector('.review-control-rail')).backgroundColor"), "rgba(17, 22, 28, 0.85)");
  await click('.review-control-rail .camera-item[data-camera="Front"]');
  assert.equal(await evaluate("fixture.card._mobileNavigationOpen"), false);
  await click('.review-layout-cell[data-review-slot="1"]');
  assert.equal(await evaluate("fixture.c._reviewAssignments[1]"), "Front");
  for (const kind of ["camera", "layout"]) {
    await click(".mobile-navigation-toggle");
    const source = await rect(kind === "camera" ? '.review-control-rail .camera-item[data-camera="Garage"]'
      : '.review-control-rail .sidebar-layout-item[data-layout="2x2"]');
    const panel = await rect(".review-control-rail");
    assert.equal(await evaluate(`fixture.card.getRootNode().elementFromPoint(${source.x},${source.y})
      ?.closest('.camera-item, .sidebar-layout-item')!==null`), true, `${kind}: source is not hit-testable`);
    await mouse("mousePressed", source, true);
    assert.equal(await evaluate("fixture.card._mobileNavigationPointerDrag!==null"), true, `${kind}: pointer candidate missing`);
    await mouse("mouseMoved", { x: source.x + 12, y: source.y + 2 }, true);
    assert.equal(await evaluate("fixture.card._mobileNavigationPointerDrag?.active===true"), true, `${kind}: drag did not activate`);
    await mouse("mouseMoved", { x: panel.right + 20, y: 200 }, true);
    assert.equal(await evaluate("fixture.card._mobileNavigationOpen"), false, `${kind}: menu did not retract`);
    const target = await rect('.review-layout-cell[data-review-slot="0"]');
    await mouse("mouseMoved", target, true); await mouse("mouseReleased", target);
    assert.equal(await evaluate("fixture.card._mobileNavigationPointerDrag===null"), true);
    assert.equal(await evaluate(kind === "camera" ? "fixture.c._reviewAssignments[0]==='Garage'" : "fixture.c._reviewLayout==='2x2'"), true);
  }
  const more = await rect(".review-transport-more summary");
  const speed = await rect(".review-speed-select");
  const play = await rect(".review-play");
  assert.ok(play.right <= speed.left && speed.right <= more.left, "Primary controls overlap");
  await click(".review-transport-more summary");
  assert.equal(await evaluate("fixture.card.querySelector('.review-transport-more').open"), true);
  assert.equal(await evaluate("fixture.card.querySelector('.review-transport-more summary').getAttribute('aria-expanded')"), "true");
  assert.equal(await evaluate("fixture.card.querySelector('.review-transport-more summary').getAttribute('aria-label')"), "More playback controls");
  assert.equal(await evaluate("getComputedStyle(fixture.card.querySelector('.review-transport-more summary')).backgroundColor"), "rgb(74, 74, 74)");
  await evaluate("fixture.card.querySelector('.review-back-ten').disabled=false");
  await click(".review-back-ten");
  assert.deepEqual(await evaluate("fixture.commands"), [-10]);
  assert.equal(await evaluate("fixture.card.querySelector('.review-transport-more').open"), false);
  assert.equal(await evaluate("fixture.card.querySelector('.review-transport-more summary').getAttribute('aria-expanded')"), "false");
  await click(".mobile-navigation-toggle");
  await mouse("mousePressed", { x: 350, y: 150 }, true);
  await mouse("mouseReleased", { x: 350, y: 150 });
  assert.equal(await evaluate("fixture.card._mobileNavigationOpen"), false);
  await click(".mobile-navigation-toggle");
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  assert.equal(await evaluate("fixture.card._mobileNavigationOpen"), false);
  assert.equal(await evaluate("fixture.card.getRootNode().activeElement===fixture.card.querySelector('.mobile-navigation-toggle')"), true);
  assert.equal(await evaluate("fixture.cells.every((cell,i)=>fixture.card.querySelectorAll('.review-layout-cell')[i]===cell)"), true);
  // Container widths, including narrow cards in a wide browser, govern layout.
  for (const width of [320, 600, 601]) {
    await evaluate(`document.querySelector('#host').style.width='${width}px';fixture.card.updateResponsiveShell()`);
    assert.equal(await evaluate("fixture.card._phoneLayout"), width <= 600);
    if (width <= 600) {
      const controls = await rect(".review-transport-controls");
      assert.ok(controls.left >= 0 && controls.right <= width, "Transport clips at container edge");
      assert.equal(await evaluate("fixture.card.querySelector('.review-control-rail').hidden"), true);
    } else assert.equal(await evaluate("fixture.card.querySelector('.review-transport-more')===null"), true);
  }
  t.diagnostic("Chrome CDP actual mouse input in shadow root: select-target, camera/layout pointer drop, dismissal, focus, translucency, control geometry and 320/600/601px container checks passed. No HA runtime acceptance.");
});
