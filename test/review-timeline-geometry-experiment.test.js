import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFile } from "node:child_process";

const chrome = process.env.NVR_TIMELINE_GEOMETRY_CHROME ??
  "C:/Program Files/Google/Chrome/Application/chrome.exe";

// A local layout experiment, with the real controller and production timeline CSS.
// No HA requests, media players, or production writes occur.
test("browser experiment: repeated zoom/pan shares one marker, TI, and tick pixel mapping", {
  skip: !existsSync(chrome) && "Set NVR_TIMELINE_GEOMETRY_CHROME to a local Chrome executable",
  timeout: 30000
}, async t => {
  const card = readFileSync(new URL("../nvr-card.js", import.meta.url), "utf8");
  const cssStart = card.indexOf("      .review-timeline {");
  const cssEnd = card.indexOf("      @media (max-width: 1099px)", cssStart);
  assert.ok(cssStart > 0 && cssEnd > cssStart);
  const css = card.slice(cssStart, cssEnd);
  let report;
  const page = `<!doctype html><style>${css}
    .review-surface { width:470px; height:650px; }
    .review-rhs-content { display:flex; height:100%; }
  </style><section class="review-surface"><div class="review-rhs-content"></div>
    <div class="review-time-truth"><time class="review-clock-display"></time></div>
  </section><script type="module">
    import { ReviewController, formatNvrClockTime } from '/src/review/review-controller.js';
    const root = document.querySelector('.review-surface');
    const base = 1800000000;
    const when = { from:base - 7200, to:base + 7200 };
    const events = [
      {camera_id:'drive_up', start_time:base-120.25, end_time:base+90.75, type:'person'},
      {camera_id:'drive_down', start_time:base+600.125, end_time:base+600.135, type:'dog'},
      {camera_id:'drive_down', start_time:base-6500.5, end_time:base-6200.25, type:'person'},
      {camera_id:'drive_up', start_time:base+6800.25, end_time:base+7400.5, type:'person'}
    ];
    const result = { snapshots:0, markers:0, ticks:0, cursors:0, clipped:0,
      minimumPixelMarkers:0, maxMarkerErrorPx:0, maxTickErrorPx:0, maxCursorErrorPx:0,
      maxPointerEpochErrorSeconds:0, maxPointerErrorPx:0, worstPointer:null,
      queries:0, failures:[] };
    const check = (ok, message) => { if (!ok) result.failures.push(message); };
    try {
      let elapsed = 0;
      const c = new ReviewController({documentRef:document, now:()=>elapsed,
        wallClock:()=>when.to*1000});
      c._root = root;
      c._cameras = [{name:'Drive Up', entity:'camera.drive_up', active:true},
        {name:'Drive Down', entity:'camera.drive_down', active:true}];
      c._selectedCameraNames = ['Drive Up','Drive Down'];
      c._reviewRange = {...when}; c._desiredReviewRange = {...when};
      c._reviewPosition = base; c._debugEnabled = true;
      c._hass = { config:{time_zone:'UTC'}, states:{
        'camera.drive_up':{attributes:{camera_name:'drive_up'}},
        'camera.drive_down':{attributes:{camera_name:'drive_down'}}},
        callWS:async () => { result.queries++; return {schema:2, complete:true, items:events}; }
      };
      await c.refreshReviewQuery();
      const initialItems = JSON.stringify(c._timeline.items);
      c._presentationMode = 'historical'; c.clock.setAbsolute(base);
      const sample = name => {
        c.updateTimelineCursor();
        const view = c.ensureTimelineViewport();
        const axis = root.querySelector('.review-timeline-axis');
        const rect = axis.getBoundingClientRect();
        const origin = rect.top + axis.clientTop;
        // CSS percentages use the actual layout height, including fractional pixels.
        const height = rect.height;
        const y = epoch => origin + height * Math.min(1, Math.max(0,
          (view.to-epoch)/(view.to-view.from)));
        check(height > 0, name+': zero layout height');
        result.snapshots++;
        for (const lane of axis.querySelectorAll('.review-timeline-lane')) {
          const lr = lane.getBoundingClientRect();
          check(Math.abs(lr.top-origin)<0.04 && Math.abs(lr.height-height)<0.04,
            name+': lane and axis origins/heights differ');
        }
        const expectedEvents = events.filter(e => e.start_time<=view.to && e.end_time>=view.from);
        const markers = [...axis.querySelectorAll('.review-timeline-marker')];
        check(markers.length===expectedEvents.length, name+': stale/missing marker count');
        for (const marker of markers) {
          const start = Number(marker.dataset.startEpoch), end = Number(marker.dataset.endEpoch);
          const point = marker.classList.contains('point');
          const expectedTop = point ? y(end) : Math.min(y(end), origin+height-1);
          const expectedHeight = point ? 3 : Math.max(y(start)-y(end),1);
          const mr = marker.getBoundingClientRect();
          const error = Math.max(Math.abs(mr.top-expectedTop), Math.abs(mr.height-expectedHeight));
          result.maxMarkerErrorPx = Math.max(result.maxMarkerErrorPx,error);
          result.markers++;
          if(start<view.from || end>view.to) result.clipped++;
          if(y(start)-y(end)<1) result.minimumPixelMarkers++;
          check(error<0.04, name+': marker geometry error '+error);
        }
        [...axis.querySelectorAll('.review-timeline-tick')].forEach((tick,index) => {
          const epoch = view.to-(view.to-view.from)*index/4;
          const error = Math.abs(tick.getBoundingClientRect().top-y(epoch));
          result.maxTickErrorPx = Math.max(result.maxTickErrorPx,error); result.ticks++;
          check(error<0.04, name+': tick geometry error '+error);
          check(tick.textContent===formatNvrClockTime(epoch,'UTC',c._timeFormat),
            name+': stale tick label');
        });
        const cursor = axis.querySelector('.review-timeline-cursor');
        const ti = c.reviewPosition, visible = ti>=view.from && ti<=view.to;
        check(cursor.hidden!==visible, name+': cursor visibility');
        if(visible) {
          // Production CSS shifts the 2px TI line up 1px to center it at its epoch.
          const error = Math.abs(cursor.getBoundingClientRect().top+1-y(ti));
          result.maxCursorErrorPx = Math.max(result.maxCursorErrorPx,error); result.cursors++;
          check(error<0.04, name+': cursor geometry error '+error);
        }
        const pointerY = origin+height*0.37;
        const pointerError = Math.abs(c.getTimelinePointerEpoch(axis,pointerY)-
          (view.to-0.37*(view.to-view.from)));
        const pointerPixelError = pointerError*height/(view.to-view.from);
        result.maxPointerErrorPx = Math.max(result.maxPointerErrorPx,pointerPixelError);
        if(pointerError>result.maxPointerEpochErrorSeconds) result.worstPointer = {
          height, clientHeight:axis.clientHeight, spanSeconds:view.to-view.from
        };
        result.maxPointerEpochErrorSeconds = Math.max(result.maxPointerEpochErrorSeconds,pointerError);
        check(pointerPixelError<0.51,name+': pointer error exceeds clientHeight rounding');
        check(JSON.stringify(c._timeline.items)===initialItems, name+': mutated event epochs');
        check(c._displayedReviewQuery.range.from===when.from &&
          c._displayedReviewQuery.range.to===when.to, name+': mutated When');
      };
      sample('initial');
      for(const edge of [events[0].start_time,events[0].end_time]) {
        c.clock.setAbsolute(edge); c.updateTimelineCursor(); sample('event-edge-'+edge);
      }
      c.clock.setAbsolute(base);
      for(let i=0;i<80;i++) {
        if(i===40) c.clock.start();
        elapsed+=50;
        root.style.height = [317.5,650,983.25][i%3]+'px';
        root.style.width = i%2 ? '280px':'470px';
        c._timeFormat = i%2 ? '12-hour':'24-hour';
        c.updateRhs();
        let axis = root.querySelector('.review-timeline-axis'), r=axis.getBoundingClientRect();
        axis.dispatchEvent(new WheelEvent('wheel', {bubbles:true,cancelable:true,
          clientY:r.top+r.height*[0.25,0.5,0.75][i%3], deltaY:i%5===0?180:-120}));
        sample('zoom-'+i);
        axis = root.querySelector('.review-timeline-axis'); r=axis.getBoundingClientRect();
        const content=root.querySelector('.review-rhs-content');
        const downY=r.top+r.height/2, moveY=downY+(i%2?35:-27);
        axis.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true,button:0,
          pointerId:i+1,clientY:downY}));
        content.dispatchEvent(new PointerEvent('pointermove', {bubbles:true,cancelable:true,
          pointerId:i+1,clientY:moveY}));
        sample('pan-'+i);
        content.dispatchEvent(new PointerEvent('pointerup', {bubbles:true,
          pointerId:i+1,clientY:moveY}));
        c.updateClockDisplay(); sample('follow-'+i);
      }
      check(result.queries===1,'zoom/pan re-queried events');
    } catch(error) { result.failures.push(error.stack); }
    await fetch('/report',{method:'POST',body:JSON.stringify(result)});
  </script>`;
  const server = createServer(async (req, res) => {
    if (req.url === "/report") {
      let body = ""; for await (const chunk of req) body += chunk;
      report = JSON.parse(body); res.end("ok"); return;
    }
    if (req.url === "/") { res.setHeader("Content-Type", "text/html"); res.end(page); return; }
    const modules = ["/src/review/review-controller.js", "/src/review/historical-presentation.js",
      "/src/vendor/flatpickr/flatpickr-4.6.13.min.js"];
    if (!modules.includes(req.url)) { res.writeHead(404); res.end(); return; }
    res.setHeader("Content-Type", "text/javascript");
    res.end(readFileSync(new URL(`..${req.url}`, import.meta.url)));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  // Keep the isolated profile in TEMP; never launch the user's normal browser profile.
  const profile = mkdtempSync(join(tmpdir(), "nvr-timeline-geometry-"));
  await new Promise((resolve, reject) => execFile(chrome, ["--headless=new", "--disable-gpu",
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--disable-extensions", `--user-data-dir=${profile}`, "--dump-dom",
    "--virtual-time-budget=5000", `http://127.0.0.1:${server.address().port}/`],
    { windowsHide:true, timeout:25000, maxBuffer:2*1024*1024 },
    error => error ? reject(error) : resolve()));
  assert.ok(report, "Browser did not submit geometry measurements");
  t.diagnostic(JSON.stringify(report));
  assert.deepEqual(report.failures, []);
  assert.equal(report.snapshots, 243);
  assert.ok(report.markers > 0 && report.clipped > 0 && report.minimumPixelMarkers > 0);
});
