import assert from "node:assert/strict";
import test from "node:test";

import {
  createTestHarness
} from "./helpers/nvr-card-harness.js";

function setup(t, options) {
  const harness = createTestHarness(options);
  t.after(() => harness.close());
  return harness;
}

function assignments(card) {
  return Array.from(card._assignedCameras);
}

function storedWorkspace(harness, card) {
  return harness.userStateBackend.get(
    card.getWorkspacePersistenceKey()
  );
}

function assertIdentityUnchanged(harness, card, cameraName, before) {
  const after =
    harness.capturePlayerIdentity(card, cameraName);

  assert.strictEqual(after.player, before.player);
  assert.strictEqual(after.cell, before.cell);
  assert.equal(after.player.isConnected, true);
  assert.equal(after.player.connectedCount, 1);
  assert.equal(after.player.disconnectedCount, 0);
  return after;
}

function captureIdentities(harness, card, cameraNames) {
  return new Map(
    cameraNames.map(cameraName => [
      cameraName,
      harness.capturePlayerIdentity(card, cameraName)
    ])
  );
}

function assertIdentitiesUnchanged(
  harness,
  card,
  cameraNames,
  before
) {
  cameraNames.forEach(cameraName => {
    assertIdentityUnchanged(
      harness,
      card,
      cameraName,
      before.get(cameraName)
    );
  });
}

function installAnonymousMediaTree(
  window,
  image,
  { transport = "none", videoState = null } = {}
) {
  const imageRoot = image.attachShadow({ mode: "open" });

  if (transport === "none") {
    return null;
  }

  const stream = window.document.createElement("ha-camera-stream");
  const streamRoot = stream.attachShadow({ mode: "open" });
  imageRoot.appendChild(stream);

  if (transport === "mjpeg") {
    streamRoot.appendChild(window.document.createElement("img"));
    return null;
  }

  if (transport === "unknown") {
    return null;
  }

  const player = window.document.createElement(
    transport === "hls"
      ? "ha-hls-player"
      : "ha-web-rtc-player"
  );
  const playerRoot = player.attachShadow({ mode: "open" });
  const video = window.document.createElement("video");
  streamRoot.appendChild(player);
  playerRoot.appendChild(video);

  if (videoState) {
    Object.defineProperties(video, {
      currentTime: {
        configurable: true,
        value: videoState.currentTime
      },
      readyState: {
        configurable: true,
        value: videoState.readyState
      },
      paused: {
        configurable: true,
        value: videoState.paused
      },
      ended: {
        configurable: true,
        value: videoState.ended
      },
      videoWidth: {
        configurable: true,
        value: videoState.videoWidth
      },
      videoHeight: {
        configurable: true,
        value: videoState.videoHeight
      }
    });
    video.getVideoPlaybackQuality = () => ({
      totalVideoFrames: videoState.totalFrames,
      droppedVideoFrames: videoState.droppedFrames
    });
  }

  return video;
}

function setAnonymousVideoState(video, state) {
  Object.entries(state).forEach(([property, value]) => {
    Object.defineProperty(video, property, {
      configurable: true,
      value
    });
  });
}

test("initial render creates 16 persistent cells with unique logical slots", t => {
  const harness = setup(t);

  assert.ok(
    harness.window.customElements.get("nvr-card")
  );

  const card = harness.createCard();
  const cells = harness.getPhysicalCells(card);
  const slots = cells.map(cell => Number(cell.dataset.slot));

  assert.equal(cells.length, 16);
  assert.equal(new Set(cells).size, 16);
  assert.deepEqual(slots, Array.from({ length: 16 }, (_, slot) => slot));
  assert.equal(card._layout, "2x2");
  assert.deepEqual(
    Array.from(card._assignedCameras),
    new Array(16).fill(null)
  );
  assert.equal(
    cells.filter(cell => !cell.classList.contains("hidden-slot")).length,
    4
  );
  assert.equal(card.querySelectorAll(".camera-frame").length, 0);
  assert.deepEqual(Array.from(card._savedViews), []);
  assert.equal(
    card.querySelector(".saved-views-list")?.textContent.trim(),
    "No saved views"
  );
});

test("card lifecycle diagnostics distinguish instances and config paths without changing state", t => {
  const harness = setup(t);
  const lifecycle = [];
  const originalInfo = harness.window.console.info;

  harness.window.console.info = (prefix, details) => {
    if (prefix === "[NVR card lifecycle]") {
      lifecycle.push(details);
    }
  };
  t.after(() => {
    harness.window.console.info = originalInfo;
  });

  const card = harness.createCard();
  const initialCells = harness.getPhysicalCells(card);
  const equivalentConfig = {
    cameras: card.config.cameras.map(camera => ({ ...camera }))
  };

  card.setConfig(equivalentConfig);

  const secondCard = harness.createCard();
  const firstConstructor = lifecycle.find(entry => {
    return entry.event === "constructor";
  });
  const secondConstructor = lifecycle.filter(entry => {
    return entry.event === "constructor";
  })[1];

  assert.match(firstConstructor.runtimeInstanceId, /^card-\d+$/);
  assert.match(secondConstructor.runtimeInstanceId, /^card-\d+$/);
  assert.notEqual(
    firstConstructor.runtimeInstanceId,
    secondConstructor.runtimeInstanceId
  );
  assert.ok(lifecycle.some(entry => {
    return (
      entry.runtimeInstanceId === firstConstructor.runtimeInstanceId &&
      entry.event === "layout-default-selected" &&
      entry.visibleCellCount === 4
    );
  }));
  assert.ok(lifecycle.some(entry => {
    return (
      entry.runtimeInstanceId === firstConstructor.runtimeInstanceId &&
      entry.event === "set-config-equivalent-no-op"
    );
  }));
  assert.deepEqual(harness.getPhysicalCells(card), initialCells);
  assert.equal(card._layout, "2x2");
  assert.deepEqual(
    Array.from(card._assignedCameras),
    new Array(16).fill(null)
  );
  assert.equal(secondCard._layout, "2x2");
});

test("changed config rebuilds an existing card as empty cells while retaining assignment state", t => {
  const harness = setup(t);
  const card = harness.createCard();

  card.assignCamera("Garage");
  const originalCell = harness.getLogicalCell(card, 0);

  card.setConfig({
    cameras: card.config.cameras.map(camera => ({ ...camera })),
    camera_aspect_ratio: "4:3"
  });

  assert.equal(card._layout, "2x2");
  assert.equal(card._assignedCameras[0], "Garage");
  assert.notStrictEqual(harness.getLogicalCell(card, 0), originalCell);
  assert.equal(
    card.querySelectorAll(".video-cell:not(.hidden-slot)").length,
    4
  );
  assert.equal(card.querySelectorAll(".camera-frame").length, 0);
});

test("view state restores layout, exact holes, moves, removals, maximize, and later unmaximize", t => {
  const harness = setup(t);
  const card = harness.createCard();

  card.selectLayout("3x3");
  card.assignCameraToSlot("Front", 0);
  card.assignCameraToSlot("Garage", 1);
  card.assignCameraToSlot("Hall", 2);
  card.moveCameraBetweenSlots(2, 5);
  card.removeCameraFromSlot(1);
  card.maximizeCameraSlot(5);

  const stored = storedWorkspace(harness, card).viewState;

  assert.deepEqual(stored, {
    version: 1,
    layout: "3x3",
    assignedCameras: [
      "camera.front",
      null,
      null,
      null,
      null,
      "camera.hall",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null
    ],
    maximizedSlot: 5
  });

  const replacement = harness.createCard();

  assert.equal(replacement._layout, "3x3");
  assert.deepEqual(Array.from(replacement._assignedCameras), [
    "Front", null, null, null, null, "Hall",
    null, null, null, null, null, null, null, null, null, null
  ]);
  assert.equal(replacement._maximizedSlot, 5);
  assert.equal(
    harness.getLogicalCell(replacement, 5)
      .querySelector(".cell-camera-name")?.textContent,
    "Hall"
  );
  assert.equal(
    replacement.querySelectorAll(".camera-frame").length,
    2
  );
  assert.ok(
    harness.getLogicalCell(replacement, 5)
      .classList.contains("maximized-camera")
  );

  replacement.restoreMaximizedCamera();
  const afterRestore = harness.createCard();

  assert.equal(afterRestore._maximizedSlot, null);
  assert.equal(
    afterRestore.querySelectorAll(".maximized-camera").length,
    0
  );
  assert.deepEqual(
    Array.from(afterRestore._assignedCameras),
    Array.from(replacement._assignedCameras)
  );
});

test("restored maximize uses the normal hui-image maximize source path", t => {
  const harness = setup(t);
  const card = harness.createCard();

  card.assignCamera("Garage");
  assert.equal(
    harness.getPlayer(card, "Garage").cameraImage,
    "camera.lorex_mediaprofile_channel1_substream1_3"
  );
  card.maximizeCameraSlot(0);

  const replacement = harness.createCard();
  const restoredImage = harness.getPlayer(replacement, "Garage");

  assert.equal(replacement._maximizedSlot, 0);
  assert.equal(
    restoredImage.cameraImage,
    "camera.garage_garage_camera_lorex_mediaprofile_channel1_mainstream"
  );
  assert.strictEqual(
    harness.getLogicalCell(replacement, 0)
      .querySelector("hui-image.nvr-live-camera"),
    restoredImage
  );
});

test("stale view state keeps valid slots, drops missing cameras, and clears invalid maximize", t => {
  const harness = setup(t);
  const card = harness.createCard();
  const key = card.getViewStatePersistenceKey();

  harness.window.localStorage.setItem(key, JSON.stringify({
    version: 1,
    layout: "3x3",
    assignedCameras: [
      "camera.front",
      null,
      "camera.garage",
      null,
      "camera.hall",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null
    ],
    maximizedSlot: 2
  }));

  const replacement = harness.createCard({
    cameras: card.config.cameras.filter(camera => {
      return camera.entity !== "camera.garage";
    })
  });

  assert.equal(replacement._layout, "3x3");
  assert.equal(replacement._assignedCameras[0], "Front");
  assert.equal(replacement._assignedCameras[2], null);
  assert.equal(replacement._assignedCameras[4], "Hall");
  assert.equal(replacement._maximizedSlot, null);
  assert.equal(
    harness.getLogicalCell(replacement, 4)
      .querySelector(".cell-camera-name")?.textContent,
    "Hall"
  );
  assert.equal(
    harness.getLogicalCell(replacement, 2)
      .querySelector(".camera-frame"),
    null
  );
});

test("view-state normalization adapts shorter and longer data to current capacity", t => {
  const harness = setup(t);
  const seed = harness.window.document.createElement("nvr-card");
  const key = seed.getViewStatePersistenceKey();

  harness.window.localStorage.setItem(key, JSON.stringify({
    version: 1,
    layout: "2x2",
    assignedCameras: ["camera.front", null],
    maximizedSlot: null
  }));

  const shorter = harness.createCard({ logicalCapacity: 4 });

  assert.deepEqual(assignments(shorter), [
    "Front", null, null, null
  ]);
  assert.equal(shorter.captureViewState().assignedCameras.length, 4);
  assert.deepEqual(
    Array.from(
      shorter.saveCurrentViewAs("Four Slots")
        .state.assignedCameras
    ),
    ["camera.front", null, null, null]
  );

  harness.window.localStorage.setItem(key, JSON.stringify({
    version: 1,
    layout: "2x2",
    assignedCameras: [
      "camera.front",
      null,
      "camera.garage",
      "camera.hall",
      "camera.patio"
    ],
    maximizedSlot: 4
  }));
  harness.userStateBackend.delete(
    shorter.getWorkspacePersistenceKey()
  );

  const longer = harness.createCard({ logicalCapacity: 4 });

  assert.deepEqual(assignments(longer), [
    "Front", null, "Garage", "Hall"
  ]);
  assert.equal(longer._maximizedSlot, null);
});

test("saved-view load reconciles only changed slots at current capacity", t => {
  const harness = setup(t);
  const card = harness.createCard({ logicalCapacity: 4 });

  card.assignCameraToSlot("Front", 0);
  card.assignCameraToSlot("Garage", 1);
  const saved = card.saveCurrentViewAs("Four Slots");
  const frontPlayer = harness.getPlayer(card, "Front");
  const sidebar = card.querySelector(".nvr-sidebar");

  card.removeCameraFromSlot(1);
  card.assignCameraToSlot("Hall", 1);

  const renderedSlots = [];
  const renderSlot = card.renderSlot.bind(card);
  card.renderSlot = slot => {
    renderedSlots.push(slot);
    renderSlot(slot);
  };

  assert.equal(card.loadSavedView(saved.id), true);
  assert.deepEqual(renderedSlots, [1]);
  assert.strictEqual(harness.getPlayer(card, "Front"), frontPlayer);
  assert.strictEqual(card.querySelector(".nvr-sidebar"), sidebar);
  assert.equal(card._assignedCameras.length, 4);
});

test("malformed persisted state falls back safely", t => {
  const harness = setup(t);
  const card = harness.window.document.createElement("nvr-card");
  const key = card.getViewStatePersistenceKey();

  harness.window.localStorage.setItem(key, "{malformed");
  harness.window.document.body.appendChild(card);

  assert.doesNotThrow(() => {
    card.setConfig({ cameras: [] });
  });
  assert.equal(card._layout, "2x2");
  assert.deepEqual(
    Array.from(card._assignedCameras),
    new Array(16).fill(null)
  );
  assert.equal(card._maximizedSlot, null);
});

test("replacement constructor cannot overwrite persisted state before restore", t => {
  const harness = setup(t);
  const oldCard = harness.createCard();

  oldCard.selectLayout("3x3");
  oldCard.assignCameraToSlot("Garage", 4);
  const key = oldCard.getViewStatePersistenceKey();
  const beforeReplacement =
    harness.window.localStorage.getItem(key);

  const replacement =
    harness.window.document.createElement("nvr-card");

  assert.notEqual(
    replacement._nvrInstanceId,
    oldCard._nvrInstanceId
  );
  assert.equal(
    harness.window.localStorage.getItem(key),
    beforeReplacement
  );

  harness.window.document.body.appendChild(replacement);
  replacement.setConfig({
    cameras: oldCard.config.cameras.map(camera => ({ ...camera }))
  });
  replacement.hass = harness.createHass(
    oldCard.config.cameras
  );

  assert.equal(replacement._layout, "3x3");
  assert.equal(replacement._assignedCameras[4], "Garage");
  assert.equal(
    harness.window.localStorage.getItem(key),
    beforeReplacement
  );
});

test("card workspace logic accepts a replaceable HA user-state adapter", t => {
  const harness = setup(t);
  const loads = [];
  const saves = [];
  const store = {
    load(key) {
      loads.push(key);
      return Promise.resolve({
        result: "loaded",
        value: {
          version: 1,
          viewState: {
            version: 1,
            layout: "3x3",
            assignedCameras: [
              null, null, "camera.hall",
              null, null, null, null, null,
              null, null, null, null, null, null, null, null
            ],
            maximizedSlot: null
          },
          savedViews: { version: 1, views: [] },
          preferences: {},
          customLayouts: {}
        }
      });
    },
    save(key, state) {
      saves.push({ key, state });
      return Promise.resolve();
    }
  };
  const card = harness.window.document.createElement("nvr-card");
  const cameras = [
    { name: "Front", entity: "camera.front", active: true },
    { name: "Garage", entity: "camera.garage", active: true },
    { name: "Hall", entity: "camera.hall", active: true }
  ];

  card._userStateStore = store;
  harness.window.document.body.appendChild(card);
  card.setConfig({ cameras });
  card.hass = harness.createHass(cameras);

  return card._workspaceHydration.then(() => {
    assert.equal(loads.length, 1);
    assert.equal(card._layout, "3x3");
    assert.equal(card._assignedCameras[2], "Hall");
    assert.equal(
      harness.getLogicalCell(card, 2)
        .querySelector(".cell-camera-name")?.textContent,
      "Hall"
    );

    card.removeCameraFromSlot(2);
    const savedView = card.saveCurrentViewAs("Adapter View");
    assert.equal(savedView.id, "view-1");
    assert.equal(saves.length, 2);
    assert.equal(saves[0].key, loads[0]);
    assert.deepEqual(Array.from(
      saves[1].state.savedViews.views,
      view => view.name
    ), ["Adapter View"]);
  });
});

test("HA user workspace uses stable frontend user-data messages without a user id", t => {
  const harness = setup(t);
  const card = harness.createCard();
  const key = card.getWorkspacePersistenceKey();

  assert.equal(key, "nvr-card:workspace:v1:%2F");
  assert.equal(key.includes("anonymous"), false);
  assert.equal(key.includes("user"), false);
  assert.deepEqual(harness.userStateCalls[0], {
    type: "frontend/get_user_data",
    key
  });

  card.selectLayout("3x3");
  const save = harness.userStateCalls.findLast(call => {
    return call.type === "frontend/set_user_data";
  });
  assert.equal(save.type, "frontend/set_user_data");
  assert.equal(save.key, key);
  assert.deepEqual(Object.keys(save.value), [
    "version", "viewState", "savedViews",
    "preferences", "customLayouts"
  ]);
});

test("save diagnostics read back without mutating workspace or exposing prohibited data", t => {
  const harness = setup(t);
  const diagnostics = [];
  const originalInfo = harness.window.console.info;

  harness.window.console.info = (prefix, details) => {
    if (prefix === "[NVR user state]") {
      diagnostics.push(details);
    }
  };
  t.after(() => {
    harness.window.console.info = originalInfo;
  });

  const card = harness.createCard();
  card.assignCameraToSlot("Front", 0);
  const stateAfterSave = JSON.stringify(card.captureWorkspace());
  const calls = harness.userStateCalls.slice(-2);

  assert.deepEqual(calls.map(call => call.type), [
    "frontend/set_user_data",
    "frontend/get_user_data"
  ]);
  assert.equal(JSON.stringify(card.captureWorkspace()), stateAfterSave);

  const events = diagnostics.map(entry => entry.event);
  assert.ok(events.includes("workspace-save-request"));
  assert.ok(events.includes("workspace-save-response"));
  assert.ok(events.includes("workspace-save-verify"));
  assert.ok(events.includes("workspace-hydration-interpretation"));
  assert.ok(events.includes("workspace-hydration-applied"));

  diagnostics.forEach(entry => {
    if (entry.event.startsWith("workspace-load") ||
        entry.event.startsWith("workspace-save")) {
      assert.equal(entry.workspaceKey, card.getWorkspacePersistenceKey());
    }
  });
  const serialized = JSON.stringify(diagnostics).toLowerCase();
  ["auth_token", "access_token", "cookie", "headers", "signed_url",
    "stream_url"].forEach(prohibited => {
    assert.equal(serialized.includes(prohibited), false);
  });
});

test("valid remote workspace is authoritative over legacy local storage", t => {
  const harness = setup(t);
  const seed = harness.window.document.createElement("nvr-card");
  const workspaceKey = seed.getWorkspacePersistenceKey();
  const legacyKey = seed.getViewStatePersistenceKey();

  harness.window.localStorage.setItem(legacyKey, JSON.stringify({
    version: 1,
    layout: "4x4",
    assignedCameras: ["camera.front"],
    maximizedSlot: null
  }));
  harness.userStateBackend.set(workspaceKey, {
    version: 1,
    viewState: {
      version: 1,
      layout: "3x3",
      assignedCameras: [null, "camera.garage"],
      maximizedSlot: null
    },
    savedViews: { version: 1, views: [] },
    preferences: {},
    customLayouts: {}
  });

  const card = harness.createCard();
  assert.equal(card._layout, "3x3");
  assert.equal(card._assignedCameras[0], null);
  assert.equal(card._assignedCameras[1], "Garage");
  assert.equal(harness.userStateCalls.filter(call => {
    return call.type === "frontend/set_user_data";
  }).length, 0);
});

test("legacy LAST VIEW and Saved Views migrate once into one workspace", t => {
  const harness = setup(t);
  const seed = harness.window.document.createElement("nvr-card");
  const viewKey = seed.getViewStatePersistenceKey();
  const savedKey = seed.getSavedViewsPersistenceKey();
  const legacyView = {
    version: 1,
    layout: "3x3",
    assignedCameras: ["camera.front", null, "camera.missing", "camera.front"],
    maximizedSlot: 2
  };
  const legacySaved = {
    version: 1,
    views: [{
      id: "view-1",
      name: "Legacy",
      state: legacyView
    }]
  };
  harness.window.localStorage.setItem(viewKey, JSON.stringify(legacyView));
  harness.window.localStorage.setItem(savedKey, JSON.stringify(legacySaved));

  const card = harness.createCard();
  const workspace = storedWorkspace(harness, card);
  assert.equal(card._layout, "3x3");
  assert.deepEqual(assignments(card).slice(0, 4), [
    "Front", null, null, null
  ]);
  assert.equal(card._maximizedSlot, null);
  assert.deepEqual(Array.from(card._savedViews, view => view.name), ["Legacy"]);
  assert.equal(workspace.version, 1);
  assert.equal(workspace.savedViews.views.length, 1);
  assert.equal(harness.userStateCalls.filter(call => {
    return call.type === "frontend/set_user_data";
  }).length, 1);
  assert.notEqual(harness.window.localStorage.getItem(viewKey), null);
  assert.notEqual(harness.window.localStorage.getItem(savedKey), null);
});

test("partial and malformed legacy migration use safe section defaults", t => {
  const harness = setup(t);
  const seed = harness.window.document.createElement("nvr-card");
  harness.window.localStorage.setItem(
    seed.getSavedViewsPersistenceKey(),
    JSON.stringify({
      version: 1,
      views: [{
        id: "view-2",
        name: "Saved Only",
        state: {
          version: 1,
          layout: "2x2",
          assignedCameras: [],
          maximizedSlot: null
        }
      }]
    })
  );
  harness.window.localStorage.setItem(
    seed.getViewStatePersistenceKey(),
    "{malformed"
  );

  const card = harness.createCard();
  assert.equal(card._layout, "2x2");
  assert.deepEqual(assignments(card), new Array(16).fill(null));
  assert.deepEqual(Array.from(card._savedViews, view => view.name), [
    "Saved Only"
  ]);
  assert.equal(storedWorkspace(harness, card).savedViews.views.length, 1);
});

test("two independent cards restore the same HA-user workspace without local storage", t => {
  const harness = setup(t);
  const first = harness.createCard();
  first.selectLayout("3x3");
  first.assignCameraToSlot("Hall", 5);
  first.maximizeCameraSlot(5);
  first.saveCurrentViewAs("Shared");

  harness.window.localStorage.clear();
  const second = harness.createCard();
  assert.equal(second._layout, "3x3");
  assert.equal(second._assignedCameras[5], "Hall");
  assert.equal(second._maximizedSlot, 5);
  assert.deepEqual(Array.from(second._savedViews, view => view.name), [
    "Shared"
  ]);
});

test("malformed remote workspace leaves current runtime state safe", t => {
  const harness = setup(t);
  const card = harness.window.document.createElement("nvr-card");
  harness.userStateBackend.set(
    card.getWorkspacePersistenceKey(),
    { version: 99, viewState: null }
  );
  harness.window.document.body.appendChild(card);
  card.setConfig({ cameras: [] });
  card.hass = harness.createHass([]);

  assert.equal(card._layout, "2x2");
  assert.deepEqual(assignments(card), new Array(16).fill(null));
  assert.deepEqual(
    harness.userStateBackend.get(card.getWorkspacePersistenceKey()),
    { version: 99, viewState: null }
  );
});

test("equivalent setConfig neither rehydrates nor prematurely saves defaults", t => {
  const harness = setup(t);
  const card = harness.createCard();
  const callsAfterHydration = harness.userStateCalls.length;
  const cells = harness.getPhysicalCells(card);

  card.setConfig({
    cameras: card.config.cameras.map(camera => ({ ...camera }))
  });

  assert.equal(harness.userStateCalls.length, callsAfterHydration);
  assert.deepEqual(harness.getPhysicalCells(card), cells);
  assert.equal(harness.userStateCalls.filter(call => {
    return call.type === "frontend/get_user_data";
  }).length, 1);
  assert.equal(harness.userStateCalls.filter(call => {
    return call.type === "frontend/set_user_data";
  }).length, 0);
});

test("named views preserve independent exact snapshots and load into LAST VIEW", t => {
  const harness = setup(t);
  const card = harness.createCard();

  card.selectLayout("3x3");
  card.assignCameraToSlot("Front", 0);
  card.assignCameraToSlot("Garage", 4);
  card.maximizeCameraSlot(4);

  const frontYard = card.saveCurrentViewAs("  Front Yard  ");
  const frontYardSnapshot = JSON.stringify(frontYard.state);

  card.restoreMaximizedCamera();
  card.removeCameraFromSlot(0);
  card.selectLayout("4x4");
  card.assignCameraToSlot("Patio", 6);
  const wideGrid = card.saveCurrentViewAs("Wide Grid");

  assert.equal(frontYard.name, "Front Yard");
  assert.equal(frontYard.id, "view-1");
  assert.equal(wideGrid.id, "view-2");
  assert.notDeepEqual(frontYard.state, wideGrid.state);
  assert.equal(JSON.stringify(frontYard.state), frontYardSnapshot);

  assert.equal(card.loadSavedView(frontYard.id), true);
  assert.equal(card._layout, "3x3");
  assert.equal(card._assignedCameras[0], "Front");
  assert.equal(card._assignedCameras[4], "Garage");
  assert.equal(card._assignedCameras[1], null);
  assert.equal(card._maximizedSlot, 4);
  assert.equal(
    harness.getPlayer(card, "Garage").cameraImage,
    "camera.garage_garage_camera_lorex_mediaprofile_channel1_mainstream"
  );

  const lastViewAfterLoad =
    storedWorkspace(harness, card).viewState;
  assert.deepEqual(
    lastViewAfterLoad,
    JSON.parse(JSON.stringify(frontYard.state))
  );

  const replacement = harness.createCard();

  assert.equal(replacement._layout, "3x3");
  assert.equal(replacement._assignedCameras[0], "Front");
  assert.equal(replacement._assignedCameras[4], "Garage");
  assert.equal(replacement._maximizedSlot, 4);
  assert.deepEqual(
    Array.from(replacement._savedViews, view => view.name),
    ["Front Yard", "Wide Grid"]
  );

  const savedCollection =
    storedWorkspace(harness, replacement).savedViews;
  assert.deepEqual(
    savedCollection.views.map(view => view.id),
    ["view-1", "view-2"]
  );

  const stableState = JSON.stringify(
    replacement._savedViews[0].state
  );
  assert.equal(
    replacement.renameSavedView(frontYard.id, "Entry Focus"),
    true
  );
  assert.equal(replacement._savedViews[0].id, frontYard.id);
  assert.equal(
    JSON.stringify(replacement._savedViews[0].state),
    stableState
  );

  replacement.loadSavedView(wideGrid.id);
  replacement.assignCameraToSlot("Hall", 8);
  assert.equal(replacement.overwriteSavedView(wideGrid.id), true);
  assert.equal(
    JSON.stringify(replacement._savedViews[0].state),
    stableState
  );
  assert.equal(
    replacement._savedViews[1].state.assignedCameras[8],
    "camera.hall"
  );

  const lastViewBeforeDelete = JSON.stringify(
    storedWorkspace(harness, replacement).viewState
  );
  assert.equal(replacement.deleteSavedView(frontYard.id), true);
  assert.deepEqual(
    Array.from(replacement._savedViews, view => view.id),
    [wideGrid.id]
  );
  assert.equal(JSON.stringify(
    storedWorkspace(harness, replacement).viewState
  ), lastViewBeforeDelete);
});

test("saved-view names reject empty and case-insensitive duplicates", t => {
  const harness = setup(t);
  const card = harness.createCard();

  assert.equal(card.saveCurrentViewAs("   "), null);
  const first = card.saveCurrentViewAs("Front Yard");
  assert.ok(first);
  assert.equal(card.saveCurrentViewAs(" front yard "), null);
  assert.equal(card._savedViews.length, 1);
  assert.equal(card.renameSavedView(first.id, "   "), false);

  const second = card.saveCurrentViewAs("Back Yard");
  assert.ok(second);
  assert.equal(
    card.renameSavedView(second.id, "FRONT YARD"),
    false
  );
  assert.equal(second.name, "Back Yard");
});

test("saved-view controls create and load through the existing VIEWS section", t => {
  const harness = setup(t);
  const card = harness.createCard();

  card.selectLayout("3x3");
  card.assignCameraToSlot("Garage", 4);
  harness.window.prompt = () => "Garage View";
  card.querySelector(".saved-view-save-current").click();

  assert.equal(card._savedViews.length, 1);
  assert.equal(
    card.querySelector(".saved-view-load")?.textContent,
    "Garage View"
  );

  card.selectLayout("2x2");
  card.querySelector(".saved-view-load").click();

  assert.equal(card._layout, "3x3");
  assert.equal(card._assignedCameras[4], "Garage");
});

test("saved-view actions preserve the sidebar container", t => {
  const harness = setup(t);
  const card = harness.createCard();
  const sidebar = card.querySelector(".nvr-sidebar");

  harness.window.prompt = () => "Garage View";
  card.querySelector(".saved-view-save-current").click();
  assert.equal(card.querySelector(".nvr-sidebar"), sidebar);

  harness.window.confirm = () => true;
  card.querySelector(
    '[data-saved-view-action="overwrite"]'
  ).click();
  assert.equal(card.querySelector(".nvr-sidebar"), sidebar);

  harness.window.prompt = () => "Renamed View";
  card.querySelector(
    '[data-saved-view-action="rename"]'
  ).click();
  assert.equal(card.querySelector(".nvr-sidebar"), sidebar);

  card.selectLayout("3x3");
  card.querySelector(
    '[data-saved-view-action="load"]'
  ).click();
  assert.equal(card.querySelector(".nvr-sidebar"), sidebar);

  card.querySelector(
    '[data-saved-view-action="delete"]'
  ).click();
  assert.equal(card.querySelector(".nvr-sidebar"), sidebar);
});

test("loading stale saved state preserves slots and clears invalid maximize", t => {
  const harness = setup(t);
  const seed = harness.window.document.createElement("nvr-card");
  const key = seed.getSavedViewsPersistenceKey();

  harness.window.localStorage.setItem(key, JSON.stringify({
    version: 1,
    views: [{
      id: "view-7",
      name: "Old View",
      state: {
        version: 1,
        layout: "3x3",
        assignedCameras: [
          "camera.front", null, "camera.missing", null,
          "camera.hall", null, null, null, null,
          null, null, null, null, null, null, null
        ],
        maximizedSlot: 2
      }
    }]
  }));

  const card = harness.createCard();

  assert.equal(card.loadSavedView("view-7"), true);
  assert.equal(card._layout, "3x3");
  assert.equal(card._assignedCameras[0], "Front");
  assert.equal(card._assignedCameras[2], null);
  assert.equal(card._assignedCameras[4], "Hall");
  assert.equal(card._maximizedSlot, null);
  assert.equal(
    harness.getLogicalCell(card, 2)
      .querySelector(".camera-frame"),
    null
  );
  assert.equal(
    harness.getLogicalCell(card, 4)
      .querySelector(".cell-camera-name")?.textContent,
    "Hall"
  );
});

test("malformed saved-view storage does not affect LAST VIEW restoration", t => {
  const harness = setup(t);
  const oldCard = harness.createCard();

  oldCard.selectLayout("3x3");
  oldCard.assignCameraToSlot("Garage", 4);
  harness.window.localStorage.setItem(
    oldCard.getSavedViewsPersistenceKey(),
    "{malformed"
  );

  const replacement = harness.createCard();

  assert.equal(replacement._layout, "3x3");
  assert.equal(replacement._assignedCameras[4], "Garage");
  assert.deepEqual(Array.from(replacement._savedViews), []);
  assert.equal(
    replacement.querySelector(".saved-views-list")
      ?.textContent.trim(),
    "No saved views"
  );
});

test("title keeps the build identifier adjacent and omits Clear Grid", t => {
  const harness = setup(t);
  const card = harness.createCard();
  const title = card.querySelector(".card-title");
  const build = card.querySelector(".build-identifier");

  assert.equal(title?.textContent, "NVR Card");
  assert.strictEqual(build?.previousElementSibling, title);
  assert.strictEqual(build?.parentElement, title?.parentElement);
  assert.equal(card.querySelector(".clear-button"), null);
});

test("equivalent setConfig preserves active provider players while changed config rebuilds", t => {
  const harness = setup(t, {
    useHaHuiImageExperiment: false
  });
  const cameras = [
    { name: "Garage", entity: "camera.garage", active: true },
    { name: "Front Door", entity: "camera.front_door", active: true }
  ];
  const hass = {
    states: {
      "camera.garage": {
        state: "streaming",
        attributes: { camera_name: "garage" }
      },
      "camera.front_door": {
        state: "streaming",
        attributes: { camera_name: "front_door" }
      }
    }
  };
  const card = harness.window.document.createElement("nvr-card");
  harness.window.document.body.appendChild(card);
  const originalRender = card.render.bind(card);
  let renderCount = 0;
  card.render = () => {
    renderCount += 1;
    return originalRender();
  };

  card.setConfig({
    cameras: cameras.map(camera => ({ ...camera }))
  });
  assert.equal(renderCount, 1);
  assert.equal(harness.getPhysicalCells(card).length, 16);

  card.hass = hass;
  card.assignCamera("Garage");
  card.assignCamera("Front Door");
  const garagePlayer = harness.getPlayer(card, "Garage");
  const frontDoorPlayer = harness.getPlayer(card, "Front Door");
  const cells = harness.getPhysicalCells(card);

  card.setConfig({
    cameras: cameras.map(camera => ({ ...camera }))
  });

  assert.equal(renderCount, 1);
  assert.strictEqual(harness.getPlayer(card, "Garage"), garagePlayer);
  assert.strictEqual(
    harness.getPlayer(card, "Front Door"),
    frontDoorPlayer
  );
  assert.equal(garagePlayer.closeCount, 0);
  assert.equal(frontDoorPlayer.closeCount, 0);
  assert.equal(card._providerPresentations.size, 2);
  assert.deepEqual(harness.getPhysicalCells(card), cells);

  card.setConfig({
    cameras: cameras.map(camera => ({ ...camera })),
    camera_aspect_ratio: "4:3"
  });

  assert.equal(renderCount, 2);
  assert.equal(garagePlayer.closeCount, 1);
  assert.equal(frontDoorPlayer.closeCount, 1);
  assert.equal(card._providerPresentations.size, 0);
  assert.notStrictEqual(harness.getPhysicalCells(card)[0], cells[0]);
});

test("initial camera assignment uses the first available visible slots", t => {
  const harness = setup(t);
  const card = harness.createCard();

  card.assignCamera("Front");
  card.assignCamera("Garage");
  harness.flushAnimationFrames();

  assert.deepEqual(assignments(card).slice(0, 4), [
    "Front",
    "Garage",
    null,
    null
  ]);

  const frontPlayer = harness.getPlayer(card, "Front");
  const garagePlayer = harness.getPlayer(card, "Garage");

  assert.ok(frontPlayer);
  assert.ok(garagePlayer);
  assert.strictEqual(
    frontPlayer.closest(".video-cell"),
    harness.getLogicalCell(card, 0)
  );
  assert.strictEqual(
    garagePlayer.closest(".video-cell"),
    harness.getLogicalCell(card, 1)
  );
  assert.equal(frontPlayer.cameraImage, "camera.front");
  assert.equal(frontPlayer.cameraView, "live");
});

test("removal leaves a hole without compacting unaffected cameras", t => {
  const harness = setup(t);
  const card = harness.createCard();

  card.assignCamera("Front");
  card.assignCamera("Garage");
  card.assignCamera("Patio");
  harness.flushAnimationFrames();

  const frontBefore =
    harness.capturePlayerIdentity(card, "Front");
  const patioBefore =
    harness.capturePlayerIdentity(card, "Patio");

  card.removeCameraFromSlot(1);

  assert.deepEqual(assignments(card).slice(0, 4), [
    "Front",
    null,
    "Patio",
    null
  ]);
  assert.equal(harness.getPlayer(card, "Garage"), null);
  assertIdentityUnchanged(harness, card, "Front", frontBefore);
  assertIdentityUnchanged(harness, card, "Patio", patioBefore);
  assert.strictEqual(
    harness.getLogicalCell(card, 2),
    patioBefore.cell
  );
});

test("camera cell-to-cell move preserves player and physical-cell identity", t => {
  const harness = setup(t);
  const card = harness.createCard();

  card.assignCamera("Front");
  harness.flushAnimationFrames();

  const before =
    harness.capturePlayerIdentity(card, "Front");

  assert.ok(before.player);
  assert.ok(before.cell);
  assert.equal(before.connectedCount, 1);

  card.moveCameraBetweenSlots(0, 2);
  harness.flushAnimationFrames();

  const after =
    harness.capturePlayerIdentity(card, "Front");

  assert.strictEqual(after.player, before.player);
  assert.strictEqual(after.cell, before.cell);
  assert.strictEqual(harness.getLogicalCell(card, 2), before.cell);
  assert.equal(after.player.isConnected, true);
  assert.equal(after.player.connectedCount, 1);
  assert.equal(after.player.disconnectedCount, 0);
});

test("moving onto an occupied target replaces it and preserves unaffected players", t => {
  const harness = setup(t);
  const card = harness.createCard();

  card.assignCamera("Front");
  card.assignCamera("Garage");
  card.assignCamera("Patio");
  harness.flushAnimationFrames();

  const frontBefore =
    harness.capturePlayerIdentity(card, "Front");
  const garageBefore =
    harness.capturePlayerIdentity(card, "Garage");
  const patioBefore =
    harness.capturePlayerIdentity(card, "Patio");

  card.moveCameraBetweenSlots(0, 1);
  harness.flushAnimationFrames();

  assert.deepEqual(assignments(card).slice(0, 4), [
    null,
    "Front",
    "Patio",
    null
  ]);

  const frontAfter = assertIdentityUnchanged(
    harness,
    card,
    "Front",
    frontBefore
  );
  assert.strictEqual(frontAfter.cell, harness.getLogicalCell(card, 1));

  assert.equal(harness.getPlayer(card, "Garage"), null);
  assert.equal(garageBefore.player.isConnected, false);
  assert.equal(garageBefore.player.connectedCount, 1);
  assert.equal(garageBefore.player.disconnectedCount, 1);

  assertIdentityUnchanged(harness, card, "Patio", patioBefore);
  assert.strictEqual(
    harness.getLogicalCell(card, 2),
    patioBefore.cell
  );
});

test("layout repacking across holes preserves every surviving player and cell", t => {
  const harness = setup(t);
  const card = harness.createCard();

  ["Front", "Garage", "Patio", "Hall"].forEach(cameraName => {
    card.assignCamera(cameraName);
  });
  harness.flushAnimationFrames();

  card.removeCameraFromSlot(1);

  const survivors = ["Front", "Patio", "Hall"];
  const before = new Map(
    survivors.map(cameraName => [
      cameraName,
      harness.capturePlayerIdentity(card, cameraName)
    ])
  );

  card.repackAssignedCameras();
  card.applyLayout();
  harness.flushAnimationFrames();

  assert.deepEqual(assignments(card).slice(0, 4), [
    "Front",
    "Patio",
    "Hall",
    null
  ]);

  survivors.forEach((cameraName, logicalSlot) => {
    const identity = assertIdentityUnchanged(
      harness,
      card,
      cameraName,
      before.get(cameraName)
    );
    assert.strictEqual(
      identity.cell,
      harness.getLogicalCell(card, logicalSlot)
    );
  });
});

test("maximize then restore preserves assignments, layout, players, and cells", t => {
  const harness = setup(t);
  const card = harness.createCard();

  ["Front", "Garage", "Patio"].forEach(cameraName => {
    card.assignCamera(cameraName);
  });
  harness.flushAnimationFrames();

  const cameraNames = ["Front", "Garage", "Patio"];
  const identityBefore = new Map(
    cameraNames.map(cameraName => [
      cameraName,
      harness.capturePlayerIdentity(card, cameraName)
    ])
  );
  const assignmentsBefore = assignments(card);
  const physicalCellsBefore = harness.getPhysicalCells(card);
  const logicalSlotsBefore = physicalCellsBefore.map(
    cell => cell.dataset.slot
  );
  const grid = card.querySelector(".video-grid");
  const gridColumnsBefore = grid.style.gridTemplateColumns;
  const gridRowsBefore = grid.style.gridTemplateRows;

  card.maximizeCameraSlot(1);
  harness.flushAnimationFrames();

  assert.equal(card._maximizedSlot, 1);
  assert.equal(grid.classList.contains("camera-maximized"), true);
  assert.equal(
    harness.getLogicalCell(card, 1).classList.contains(
      "maximized-camera"
    ),
    true
  );

  [0, 2].forEach(slot => {
    const siblingCell = harness.getLogicalCell(card, slot);
    const siblingStyle =
      harness.window.getComputedStyle(siblingCell);

    assert.notEqual(siblingStyle.display, "none");
    assert.equal(siblingStyle.visibility, "hidden");
    assert.equal(siblingStyle.pointerEvents, "none");
    assertIdentityUnchanged(
      harness,
      card,
      cameraNames[slot],
      identityBefore.get(cameraNames[slot])
    );
  });

  card.restoreMaximizedCamera();
  harness.flushAnimationFrames();

  assert.equal(card._maximizedSlot, null);
  assert.equal(grid.classList.contains("camera-maximized"), false);
  assert.equal(
    card.querySelectorAll(".video-cell.maximized-camera").length,
    0
  );
  assert.deepEqual(assignments(card), assignmentsBefore);
  assert.equal(card._layout, "2x2");
  assert.equal(grid.style.gridTemplateColumns, gridColumnsBefore);
  assert.equal(grid.style.gridTemplateRows, gridRowsBefore);

  [0, 2].forEach(slot => {
    const siblingStyle = harness.window.getComputedStyle(
      harness.getLogicalCell(card, slot)
    );

    assert.notEqual(siblingStyle.visibility, "hidden");
    assert.notEqual(siblingStyle.pointerEvents, "none");
  });

  const physicalCellsAfter = harness.getPhysicalCells(card);
  physicalCellsBefore.forEach((cell, index) => {
    assert.strictEqual(physicalCellsAfter[index], cell);
    assert.equal(cell.dataset.slot, logicalSlotsBefore[index]);
  });

  cameraNames.forEach(cameraName => {
    assertIdentityUnchanged(
      harness,
      card,
      cameraName,
      identityBefore.get(cameraName)
    );
  });
});

test("maximize defers fitting until the scheduled animation frame", t => {
  const harness = setup(t);
  const card = harness.createCard();

  card.assignCamera("Front");
  harness.flushAnimationFrames();

  const identityBefore =
    harness.capturePlayerIdentity(card, "Front");
  const fitLiveCameras =
    card.fitLiveCameras.bind(card);
  let fitCount = 0;

  card.fitLiveCameras = (...args) => {
    fitCount += 1;
    return fitLiveCameras(...args);
  };

  card.maximizeCameraSlot(0);

  assert.equal(fitCount, 0);
  assert.notEqual(card._cameraFitFrame, null);
  assertIdentityUnchanged(
    harness,
    card,
    "Front",
    identityBefore
  );

  harness.flushAnimationFrames();

  assert.equal(fitCount, 1);
  assert.equal(card._cameraFitFrame, null);
  assertIdentityUnchanged(
    harness,
    card,
    "Front",
    identityBefore
  );
});

test("maximize transforms without changing fitted player dimensions", t => {
  const harness = setup(t);
  const card = harness.createCard();

  card.assignCamera("Front");
  harness.flushAnimationFrames();

  const identityBefore =
    harness.capturePlayerIdentity(card, "Front");
  const player = identityBefore.player;
  const cell = identityBefore.cell;
  const frame = cell.querySelector(".camera-frame");
  const setFrameSize = (width, height) => {
    Object.defineProperties(frame, {
      clientWidth: {
        configurable: true,
        value: width
      },
      clientHeight: {
        configurable: true,
        value: height
      }
    });
  };

  setFrameSize(500, 300);
  card.fitLiveCameras();

  const normalWidth = player.style.width;
  const normalHeight = player.style.height;
  assert.equal(normalWidth, "500px");
  assert.equal(normalHeight, "281px");

  card.maximizeCameraSlot(0);
  setFrameSize(1000, 600);
  harness.flushAnimationFrames();

  assert.equal(player.style.width, normalWidth);
  assert.equal(player.style.height, normalHeight);
  assert.equal(player.style.transform, "scale(2)");
  assert.equal(player.style.transformOrigin, "center");
  assert.strictEqual(
    harness.getLogicalCell(card, 0),
    cell
  );
  assertIdentityUnchanged(
    harness,
    card,
    "Front",
    identityBefore
  );

  setFrameSize(400, 300);
  card.restoreMaximizedCamera();
  harness.flushAnimationFrames();

  assert.equal(player.style.transform, "");
  assert.equal(player.style.transformOrigin, "");
  assert.equal(player.style.width, "400px");
  assert.equal(player.style.height, "225px");
  assert.strictEqual(
    harness.getLogicalCell(card, 0),
    cell
  );
  assertIdentityUnchanged(
    harness,
    card,
    "Front",
    identityBefore
  );
});

test("maximize flight recorder is ordered, bounded, and read-only", t => {
  const harness = setup(t);
  const card = harness.createCard();

  ["Front", "Garage"].forEach(cameraName => {
    card.assignCamera(cameraName);
  });
  harness.flushAnimationFrames();

  const identityBefore = captureIdentities(
    harness,
    card,
    ["Front", "Garage"]
  );
  const assignmentsBefore = assignments(card);

  card.clearNvrFlightRecorder();
  card.maximizeCameraSlot(0);

  assert.deepEqual(
    Array.from(
      harness.window.dumpNvrFlightRecorder(),
      record => record.event
    ),
    [
      "maximize-start",
      "maximize-classes-applied",
      "fit-request"
    ]
  );

  harness.flushAnimationFrames();
  card.restoreMaximizedCamera();
  harness.flushAnimationFrames();

  const expectedEvents = [
    "fit-execution",
    "fit-start",
    "fit-end",
    "restore-start",
    "restore-classes-removed",
    "layout-start",
    "layout-end"
  ];
  const recordedEvents =
    harness.window.dumpNvrFlightRecorder()
      .map(record => record.event);
  let previousIndex = -1;

  expectedEvents.forEach(event => {
    const index = recordedEvents.indexOf(
      event,
      previousIndex + 1
    );
    assert.notEqual(index, -1);
    previousIndex = index;
  });

  const dumped = harness.window.dumpNvrFlightRecorder();
  const originalFirstEvent = dumped[0].event;
  dumped[0].event = "changed-copy";

  assert.equal(
    harness.window.dumpNvrFlightRecorder()[0].event,
    originalFirstEvent
  );
  assert.deepEqual(assignments(card), assignmentsBefore);
  assertIdentitiesUnchanged(
    harness,
    card,
    ["Front", "Garage"],
    identityBefore
  );

  card.clearNvrFlightRecorder();
  for (let slot = 0; slot < 300; slot += 1) {
    card.recordNvrFlight("test-event", slot);
  }

  const bounded = harness.window.dumpNvrFlightRecorder();
  assert.equal(bounded.length, 256);
  assert.equal(bounded[0].slot, 44);
  assert.equal(bounded[255].slot, 299);
});

test("flight recorder survives card reconstruction with instance lifecycle", t => {
  const harness = setup(t);
  const firstCard = harness.createCard();
  const firstInstanceId = firstCard._nvrInstanceId;

  firstCard.clearNvrFlightRecorder();
  firstCard.remove();
  harness.window.document.body.appendChild(firstCard);
  firstCard.remove();

  const secondCard = harness.createCard();
  const secondInstanceId = secondCard._nvrInstanceId;
  const allRecords =
    harness.window.dumpNvrFlightRecorder();
  const lifecycle = Array.from(
    allRecords
      .filter(record => {
        return (
          record.event === "card-connected" ||
          record.event === "card-disconnected"
        );
      }),
    record => ({
      event: record.event,
      instanceId: record.instanceId
    })
  );

  assert.equal(secondInstanceId, firstInstanceId + 1);
  for (let index = 1; index < allRecords.length; index += 1) {
    assert.ok(
      allRecords[index].time >=
        allRecords[index - 1].time
    );
  }
  assert.deepEqual(lifecycle, [
    {
      event: "card-disconnected",
      instanceId: firstInstanceId
    },
    {
      event: "card-connected",
      instanceId: firstInstanceId
    },
    {
      event: "card-disconnected",
      instanceId: firstInstanceId
    },
    {
      event: "card-connected",
      instanceId: secondInstanceId
    }
  ]);

  assert.ok(
    allRecords
      .some(record => {
        return record.instanceId === firstInstanceId;
      })
  );
  assert.ok(
    allRecords
      .some(record => {
        return record.instanceId === secondInstanceId;
      })
  );
});

test("overflow cameras survive smaller layouts and reappear with identity intact", t => {
  const harness = setup(t);
  const cameras = [
    { name: "Front", entity: "camera.front", active: true },
    { name: "Garage", entity: "camera.garage", active: true },
    { name: "Patio", entity: "camera.patio", active: true },
    { name: "Hall", entity: "camera.hall", active: true },
    { name: "Drive", entity: "camera.drive", active: true },
    { name: "Yard", entity: "camera.yard", active: true }
  ];
  const cameraNames = cameras.map(camera => camera.name);
  const card = harness.createCard({ cameras });

  card.selectLayout("3x3");
  cameraNames.forEach(cameraName => {
    card.assignCamera(cameraName);
  });
  harness.flushAnimationFrames();

  const before = captureIdentities(
    harness,
    card,
    cameraNames
  );

  card.selectLayout("2x2");
  harness.flushAnimationFrames();

  assert.equal(card._layout, "2x2");
  assert.deepEqual(assignments(card).slice(0, 6), cameraNames);
  assert.equal(
    harness.getLogicalCell(card, 4).classList.contains("hidden-slot"),
    true
  );
  assert.equal(
    harness.getLogicalCell(card, 5).classList.contains("hidden-slot"),
    true
  );
  assertIdentitiesUnchanged(
    harness,
    card,
    cameraNames,
    before
  );

  card.selectLayout("3x3");
  harness.flushAnimationFrames();

  assert.equal(card._layout, "3x3");
  assert.deepEqual(assignments(card).slice(0, 6), cameraNames);
  assert.equal(
    harness.getLogicalCell(card, 4).classList.contains("hidden-slot"),
    false
  );
  assert.equal(
    harness.getLogicalCell(card, 5).classList.contains("hidden-slot"),
    false
  );
  assertIdentitiesUnchanged(
    harness,
    card,
    cameraNames,
    before
  );
});

test("unassigned camera replacement keeps the maximized slot and unaffected players", t => {
  const harness = setup(t);
  const card = harness.createCard();

  ["Front", "Garage", "Patio"].forEach(cameraName => {
    card.assignCamera(cameraName);
  });
  harness.flushAnimationFrames();

  const unaffectedNames = ["Front", "Patio"];
  const unaffectedBefore = captureIdentities(
    harness,
    card,
    unaffectedNames
  );
  const garageBefore =
    harness.capturePlayerIdentity(card, "Garage");
  const maximizedCell = harness.getLogicalCell(card, 1);

  card.maximizeCameraSlot(1);
  card.replaceMaximizedCamera("Hall");
  harness.flushAnimationFrames();

  assert.equal(card._maximizedSlot, 1);
  assert.equal(card._assignedCameras[1], "Hall");
  assert.strictEqual(harness.getLogicalCell(card, 1), maximizedCell);
  assert.equal(maximizedCell.classList.contains("maximized-camera"), true);
  assert.equal(
    card.querySelector(".video-grid").classList.contains(
      "camera-maximized"
    ),
    true
  );
  assert.equal(garageBefore.player.isConnected, false);
  assert.equal(garageBefore.player.disconnectedCount, 1);
  assert.equal(harness.getPlayer(card, "Garage"), null);
  assert.ok(harness.getPlayer(card, "Hall"));
  assertIdentitiesUnchanged(
    harness,
    card,
    unaffectedNames,
    unaffectedBefore
  );

  card.restoreMaximizedCamera();
  harness.flushAnimationFrames();

  assert.equal(card._maximizedSlot, null);
  assert.equal(card._layout, "2x2");
  assert.equal(card._assignedCameras[1], "Hall");
  assert.strictEqual(
    harness.getPlayer(card, "Hall").closest(".video-cell"),
    maximizedCell
  );
  assertIdentitiesUnchanged(
    harness,
    card,
    unaffectedNames,
    unaffectedBefore
  );
});

test("assigned camera replacement transfers maximize state and self replacement is a no-op", t => {
  const harness = setup(t);
  const card = harness.createCard();

  ["Front", "Garage", "Patio", "Hall"].forEach(cameraName => {
    card.assignCamera(cameraName);
  });
  harness.flushAnimationFrames();

  const patioBefore =
    harness.capturePlayerIdentity(card, "Patio");
  const garageBefore =
    harness.capturePlayerIdentity(card, "Garage");
  const unaffectedNames = ["Front", "Hall"];
  const unaffectedBefore = captureIdentities(
    harness,
    card,
    unaffectedNames
  );

  card.maximizeCameraSlot(1);
  card.replaceMaximizedCamera("Patio");
  harness.flushAnimationFrames();

  assert.deepEqual(assignments(card).slice(0, 4), [
    "Front",
    "Patio",
    null,
    "Hall"
  ]);
  assert.equal(card._maximizedSlot, 1);
  assert.strictEqual(harness.getLogicalCell(card, 1), patioBefore.cell);
  assert.strictEqual(harness.getPlayer(card, "Patio"), patioBefore.player);
  assert.equal(patioBefore.cell.classList.contains("maximized-camera"), true);
  assert.equal(garageBefore.player.isConnected, false);
  assert.equal(garageBefore.player.disconnectedCount, 1);
  assert.equal(harness.getPlayer(card, "Garage"), null);
  assertIdentityUnchanged(harness, card, "Patio", patioBefore);
  assertIdentitiesUnchanged(
    harness,
    card,
    unaffectedNames,
    unaffectedBefore
  );

  const assignmentsBeforeNoOp = assignments(card);
  const patioBeforeNoOp =
    harness.capturePlayerIdentity(card, "Patio");
  const maximizedCellsBefore = [
    ...card.querySelectorAll(".video-cell.maximized-camera")
  ];

  card.replaceMaximizedCamera("Patio");
  harness.flushAnimationFrames();

  assert.deepEqual(assignments(card), assignmentsBeforeNoOp);
  assert.equal(card._maximizedSlot, 1);
  assert.deepEqual(
    [...card.querySelectorAll(".video-cell.maximized-camera")],
    maximizedCellsBefore
  );
  assertIdentityUnchanged(
    harness,
    card,
    "Patio",
    patioBeforeNoOp
  );
  assertIdentitiesUnchanged(
    harness,
    card,
    unaffectedNames,
    unaffectedBefore
  );
});

test("layout change while maximized restores first and then repacks", t => {
  const harness = setup(t);
  const card = harness.createCard();

  ["Front", "Garage", "Patio", "Hall"].forEach(cameraName => {
    card.assignCamera(cameraName);
  });
  harness.flushAnimationFrames();
  card.removeCameraFromSlot(1);

  const survivorNames = ["Front", "Patio", "Hall"];
  const survivorBefore = captureIdentities(
    harness,
    card,
    survivorNames
  );

  card.maximizeCameraSlot(2);
  card.restoreMaximizedCamera();
  card.selectLayout("3x3");
  harness.flushAnimationFrames();

  assert.equal(card._maximizedSlot, null);
  assert.equal(
    card.querySelector(".video-grid").classList.contains(
      "camera-maximized"
    ),
    false
  );
  assert.equal(
    card.querySelectorAll(".video-cell.maximized-camera").length,
    0
  );
  assert.equal(card._layout, "3x3");
  assert.deepEqual(assignments(card).slice(0, 4), [
    "Front",
    "Patio",
    "Hall",
    null
  ]);

  survivorNames.forEach((cameraName, logicalSlot) => {
    const identity = assertIdentityUnchanged(
      harness,
      card,
      cameraName,
      survivorBefore.get(cameraName)
    );
    assert.strictEqual(
      identity.cell,
      harness.getLogicalCell(card, logicalSlot)
    );
  });
});

test("sidebar and 600px responsive transitions preserve every player and cell", t => {
  const harness = setup(t);
  const card = harness.createCard({ shellWidth: 601 });

  ["Front", "Garage", "Patio"].forEach(cameraName => {
    card.assignCamera(cameraName);
  });
  harness.flushAnimationFrames();

  const cameraNames = ["Front", "Garage", "Patio"];
  const before = captureIdentities(
    harness,
    card,
    cameraNames
  );
  const shell = card.querySelector(".nvr-shell");
  const sidebar = card.querySelector(".nvr-sidebar");
  const toggle = card.querySelector(".sidebar-toggle");

  assert.equal(shell.classList.contains("phone-layout"), false);
  assert.equal(shell.classList.contains("sidebar-collapsed"), false);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(sidebar.getAttribute("aria-hidden"), "false");

  harness.setShellWidth(card, 600);
  harness.flushAnimationFrames();

  assert.equal(shell.classList.contains("phone-layout"), true);
  assert.equal(shell.classList.contains("sidebar-collapsed"), true);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(sidebar.getAttribute("aria-hidden"), "true");
  assertIdentitiesUnchanged(harness, card, cameraNames, before);

  harness.setShellWidth(card, 601);
  harness.flushAnimationFrames();

  assert.equal(shell.classList.contains("phone-layout"), false);
  assert.equal(shell.classList.contains("sidebar-collapsed"), false);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(sidebar.getAttribute("aria-hidden"), "false");

  toggle.click();
  harness.flushAnimationFrames();

  assert.equal(shell.classList.contains("sidebar-collapsed"), true);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(sidebar.getAttribute("aria-hidden"), "true");
  assertIdentitiesUnchanged(harness, card, cameraNames, before);

  toggle.click();
  harness.flushAnimationFrames();

  assert.equal(shell.classList.contains("sidebar-collapsed"), false);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(sidebar.getAttribute("aria-hidden"), "false");
  assertIdentitiesUnchanged(harness, card, cameraNames, before);
});

test("3x3 diagnostic mode keeps exactly logical slots 0 through 3 live", t => {
  const harness = setup(t, {
    useHaHuiImageExperiment: false
  });
  const cameras = Array.from({ length: 9 }, (_, index) => ({
    name: `Camera ${index}`,
    entity: `camera.test_${index}`,
    active: true
  }));
  const cameraNames = cameras.map(camera => camera.name);
  const card = harness.createCard({ cameras });

  card.selectLayout("3x3");
  cameraNames.forEach(cameraName => {
    card.assignCamera(cameraName);
  });
  harness.flushAnimationFrames();

  const players = Array.from({ length: 9 }, (_, slot) => {
    return harness
      .getLogicalCell(card, slot)
      .querySelector("hui-image.nvr-live-camera");
  });
  const identitiesBefore = captureIdentities(
    harness,
    card,
    cameraNames
  );
  const liveCount = () => {
    return Array.from(
      card.querySelectorAll("hui-image.nvr-live-camera")
    ).filter(image => image.cameraView === "live").length;
  };

  assert.deepEqual(assignments(card).slice(0, 9), cameraNames);
  players.forEach((player, slot) => {
    assert.ok(player);
    assert.equal(player.cameraImage, cameras[slot].entity);
    assert.equal(player.cameraView, slot < 4 ? "live" : "auto");
  });
  assert.equal(liveCount(), 4);

  card.maximizeCameraSlot(2);
  harness.flushAnimationFrames();
  assert.equal(liveCount(), 4);

  card.restoreMaximizedCamera();
  harness.flushAnimationFrames();
  assert.equal(liveCount(), 4);
  assertIdentitiesUnchanged(
    harness,
    card,
    cameraNames,
    identitiesBefore
  );

  card.removeCameraFromSlot(5);
  const movingIdentity =
    harness.capturePlayerIdentity(card, "Camera 0");
  card.moveCameraBetweenSlots(0, 5);
  harness.flushAnimationFrames();

  assert.strictEqual(harness.getPlayer(card, "Camera 0"), movingIdentity.player);
  assert.strictEqual(harness.getLogicalCell(card, 5), movingIdentity.cell);
  assert.equal(movingIdentity.player.cameraView, "auto");

  card.moveCameraBetweenSlots(5, 0);
  harness.flushAnimationFrames();

  assert.strictEqual(harness.getPlayer(card, "Camera 0"), movingIdentity.player);
  assert.strictEqual(harness.getLogicalCell(card, 0), movingIdentity.cell);
  assert.equal(movingIdentity.player.cameraView, "live");
  assert.equal(movingIdentity.player.connectedCount, 1);
  assert.equal(movingIdentity.player.disconnectedCount, 0);
});

test("layout repacking reapplies diagnostic live mode by logical slot", t => {
  const harness = setup(t, {
    useHaHuiImageExperiment: false
  });
  const cameras = Array.from({ length: 9 }, (_, index) => ({
    name: `Camera ${index}`,
    entity: `camera.test_${index}`,
    active: true
  }));
  const cameraNames = cameras.map(camera => camera.name);
  const card = harness.createCard({ cameras });

  card.selectLayout("3x3");
  cameraNames.forEach(cameraName => {
    card.assignCamera(cameraName);
  });
  harness.flushAnimationFrames();
  card.removeCameraFromSlot(1);

  const survivors = cameraNames.filter(cameraName => cameraName !== "Camera 1");
  const before = captureIdentities(harness, card, survivors);

  card.selectLayout("3x3");
  harness.flushAnimationFrames();

  survivors.forEach((cameraName, slot) => {
    const identity = assertIdentityUnchanged(
      harness,
      card,
      cameraName,
      before.get(cameraName)
    );
    assert.strictEqual(identity.cell, harness.getLogicalCell(card, slot));
    assert.equal(
      identity.player.cameraView,
      slot < 4 ? "live" : "auto"
    );
  });
  assert.equal(
    Array.from(
      card.querySelectorAll("hui-image.nvr-live-camera")
    ).filter(image => image.cameraView === "live").length,
    4
  );
});

test("anonymous media snapshots classify transports and capture safe video state", t => {
  const harness = setup(t);
  const card = harness.createCard();
  ["Front", "Garage", "Patio", "Hall"].forEach(cameraName => {
    card.assignCamera(cameraName);
  });
  harness.flushAnimationFrames();

  const hlsVideo = installAnonymousMediaTree(
    harness.window,
    harness.getPlayer(card, "Front"),
    {
      transport: "hls",
      videoState: {
        currentTime: 123.45,
        readyState: 4,
        paused: false,
        ended: false,
        videoWidth: 1920,
        videoHeight: 1080,
        totalFrames: 12345,
        droppedFrames: 12
      }
    }
  );
  installAnonymousMediaTree(
    harness.window,
    harness.getPlayer(card, "Garage"),
    { transport: "webrtc" }
  );
  installAnonymousMediaTree(
    harness.window,
    harness.getPlayer(card, "Patio"),
    { transport: "mjpeg" }
  );
  installAnonymousMediaTree(
    harness.window,
    harness.getPlayer(card, "Hall"),
    { transport: "none" }
  );

  const listenerCounts = new Map();
  let consoleCalls = 0;
  ["log", "debug", "warn", "error"].forEach(method => {
    harness.window.console[method] = () => {
      consoleCalls += 1;
    };
  });
  const addEventListener = hlsVideo.addEventListener.bind(hlsVideo);
  hlsVideo.addEventListener = (type, listener, options) => {
    listenerCounts.set(type, (listenerCounts.get(type) ?? 0) + 1);
    addEventListener(type, listener, options);
  };

  card.clearNvrFlightRecorder();
  card.recordNvrFlight("maximize-start");
  card.recordNvrFlight("maximize-classes-applied");

  assert.deepEqual(
    Object.fromEntries(listenerCounts),
    { waiting: 1, stalled: 1, playing: 1 }
  );

  hlsVideo.dispatchEvent(new harness.window.Event("waiting"));
  hlsVideo.dispatchEvent(new harness.window.Event("stalled"));
  hlsVideo.dispatchEvent(new harness.window.Event("playing"));

  const records = harness.window.dumpNvrFlightRecorder();
  const media = records.at(-1).media;
  const hls = media.find(snapshot => snapshot.slot === 0);

  assert.deepEqual(
    Array.from(media, snapshot => snapshot.transport),
    ["hls", "webrtc", "mjpeg", "none"]
  );
  assert.deepEqual(
    {
      hasVideo: hls.hasVideo,
      currentTime: hls.currentTime,
      readyState: hls.readyState,
      paused: hls.paused,
      ended: hls.ended,
      videoWidth: hls.videoWidth,
      videoHeight: hls.videoHeight,
      totalFrames: hls.totalFrames,
      droppedFrames: hls.droppedFrames
    },
    {
      hasVideo: true,
      currentTime: 123.45,
      readyState: 4,
      paused: false,
      ended: false,
      videoWidth: 1920,
      videoHeight: 1080,
      totalFrames: 12345,
      droppedFrames: 12
    }
  );
  assert.equal(typeof hls.lastWaitingTime, "number");
  assert.equal(typeof hls.lastStalledTime, "number");
  assert.equal(typeof hls.lastPlayingTime, "number");
  assert.equal(consoleCalls, 0);

  const serialized = JSON.stringify(media);
  [
    "camera.front",
    "camera.garage",
    "camera.patio",
    "camera.hall",
    "cameraImage",
    "entity",
    "src",
    "currentSrc",
    "config",
    "state"
  ].forEach(forbidden => {
    assert.equal(serialized.includes(forbidden), false);
  });

  media[0].transport = "changed-copy";
  assert.equal(
    harness.window.dumpNvrFlightRecorder().at(-1).media[0].transport,
    "hls"
  );
});

test("3x3 media capture is one bounded anonymous record with logical slots", t => {
  const harness = setup(t, {
    useHaHuiImageExperiment: false
  });
  const cameras = Array.from({ length: 9 }, (_, index) => ({
    name: `Camera ${index}`,
    entity: `camera.test_${index}`,
    active: true
  }));
  const card = harness.createCard({ cameras });

  card.selectLayout("3x3");
  cameras.forEach(camera => card.assignCamera(camera.name));
  harness.flushAnimationFrames();
  Array.from({ length: 9 }, (_, slot) => {
    installAnonymousMediaTree(
      harness.window,
      harness.getPlayer(card, cameras[slot].name),
      { transport: slot === 0 ? "hls" : "none" }
    );
  });

  card.clearNvrFlightRecorder();
  card.recordNvrFlight("maximize-start");

  const records = harness.window.dumpNvrFlightRecorder();
  assert.equal(records.length, 1);
  assert.deepEqual(
    Array.from(records[0].media, snapshot => snapshot.slot),
    [0, 1, 2, 3, 4, 5, 6, 7, 8]
  );
  assert.deepEqual(
    Array.from(
      records[0].media,
      snapshot => Object.keys(snapshot).sort()
    ),
    [
      [
        "currentTime", "droppedFrames", "ended", "hasVideo",
        "lastPlayingTime", "lastStalledTime", "lastWaitingTime",
        "paused", "readyState", "slot", "totalFrames", "transport",
        "videoHeight", "videoWidth"
      ].sort(),
      ...Array.from(
        { length: 8 },
        () => ["hasVideo", "slot", "transport"]
      )
    ]
  );
  assert.deepEqual(
    Array.from({ length: 9 }, (_, slot) => {
      return harness
        .getLogicalCell(card, slot)
        .querySelector("hui-image.nvr-live-camera")
        .cameraView;
    }),
    ["live", "live", "live", "live", "auto", "auto", "auto", "auto", "auto"]
  );
});

test("maximize sampler captures one selected video for a bounded eight seconds", t => {
  const harness = setup(t);
  const card = harness.createCard();
  card.assignCamera("Front");
  card.assignCamera("Garage");
  harness.flushAnimationFrames();

  const selectedImage = harness.getPlayer(card, "Front");
  const otherImage = harness.getPlayer(card, "Garage");
  const selectedVideo = installAnonymousMediaTree(
    harness.window,
    selectedImage,
    {
      transport: "hls",
      videoState: {
        currentTime: 0,
        readyState: 4,
        paused: false,
        ended: false,
        videoWidth: 1920,
        videoHeight: 1080,
        totalFrames: 0,
        droppedFrames: 0
      }
    }
  );
  const otherVideo = installAnonymousMediaTree(
    harness.window,
    otherImage,
    {
      transport: "webrtc",
      videoState: {
        currentTime: 10,
        readyState: 4,
        paused: false,
        ended: false,
        videoWidth: 1280,
        videoHeight: 720,
        totalFrames: 300,
        droppedFrames: 1
      }
    }
  );
  let otherCurrentTimeReads = 0;
  Object.defineProperty(otherVideo, "currentTime", {
    configurable: true,
    get() {
      otherCurrentTimeReads += 1;
      return 10;
    }
  });
  [selectedVideo, otherVideo].forEach(video => {
    ["src", "currentSrc"].forEach(property => {
      Object.defineProperty(video, property, {
        configurable: true,
        get() {
          throw new Error(`${property} must not be read`);
        }
      });
    });
  });
  [selectedImage, otherImage].forEach(image => {
    Object.defineProperty(image, "cameraImage", {
      configurable: true,
      get() {
        throw new Error("cameraImage must not be read");
      },
      set() {}
    });
    ["hass", "config", "state"].forEach(property => {
      Object.defineProperty(image, property, {
        configurable: true,
        get() {
          throw new Error(`${property} must not be read`);
        }
      });
    });
  });

  card.maximizeCameraSlot(0);
  const otherReadsAfterMaximize = otherCurrentTimeReads;

  assert.ok(card._activeMaximizeMediaSession);
  assert.equal(card._activeMaximizeMediaSession.slot, 0);
  assert.equal(card._activeMaximizeMediaSession.samples.length, 1);

  harness.advanceTime(250);
  setAnonymousVideoState(selectedVideo, {
    currentTime: 0.25,
    readyState: 2,
    paused: true
  });
  selectedVideo.getVideoPlaybackQuality = () => ({
    totalVideoFrames: 8,
    droppedVideoFrames: 2
  });
  harness.advanceTime(250);
  selectedVideo.dispatchEvent(new harness.window.Event("waiting"));
  selectedVideo.dispatchEvent(new harness.window.Event("stalled"));
  selectedVideo.dispatchEvent(new harness.window.Event("playing"));
  harness.setDocumentVisibility("hidden");
  harness.advanceTime(250);
  harness.setDocumentVisibility("visible");
  harness.advanceTime(7250);

  assert.equal(card._activeMaximizeMediaSession, null);
  assert.equal(otherCurrentTimeReads, otherReadsAfterMaximize);

  const sessions =
    harness.window.dumpNvrMaximizeMediaSessions();
  assert.equal(sessions.length, 1);

  const session = sessions[0];
  assert.equal(session.slot, 0);
  assert.equal(session.sessionId, 1);
  assert.equal(session.startTime, 0);
  assert.equal(session.completionReason, "duration");
  assert.equal(session.completionTime, 8000);
  assert.equal(session.samples.length, 32);
  assert.equal(session.samples[0].elapsed, 0);
  assert.equal(session.samples.at(-1).elapsed, 7750);
  assert.equal(session.samples[2].currentTime, 0.25);
  assert.equal(session.samples[2].readyState, 2);
  assert.equal(session.samples[2].paused, true);
  assert.equal(session.samples[2].totalFrames, 8);
  assert.equal(session.samples[2].droppedFrames, 2);
  assert.deepEqual(Array.from(session.events.waiting), [500]);
  assert.deepEqual(Array.from(session.events.stalled), [500]);
  assert.deepEqual(Array.from(session.events.playing), [500]);
  assert.deepEqual(
    Array.from(session.visibility, entry => ({ ...entry })),
    [
      { elapsed: 0, state: "visible" },
      { elapsed: 500, state: "hidden" },
      { elapsed: 750, state: "visible" }
    ]
  );

  const serialized = JSON.stringify(session);
  [
    "camera.front", "camera.garage", "cameraImage", "entity",
    "src", "currentSrc", "config", "WebSocket", "subscription"
  ].forEach(forbidden => {
    assert.equal(serialized.includes(forbidden), false);
  });

  session.samples[0].currentTime = 999;
  session.events.waiting.push(999);
  session.visibility[0].state = "changed-copy";
  const freshDump =
    harness.window.dumpNvrMaximizeMediaSessions()[0];
  assert.equal(freshDump.samples[0].currentTime, 0);
  assert.deepEqual(Array.from(freshDump.events.waiting), [500]);
  assert.equal(freshDump.visibility[0].state, "visible");
});

test("new maximize replaces the active sampler and disconnection ends its successor", t => {
  const harness = setup(t);
  const card = harness.createCard();
  card.assignCamera("Front");
  card.assignCamera("Garage");
  harness.flushAnimationFrames();

  installAnonymousMediaTree(
    harness.window,
    harness.getPlayer(card, "Front"),
    { transport: "hls" }
  );
  const secondVideo = installAnonymousMediaTree(
    harness.window,
    harness.getPlayer(card, "Garage"),
    { transport: "webrtc" }
  );

  card.maximizeCameraSlot(0);
  harness.advanceTime(500);
  card.restoreMaximizedCamera();
  card.maximizeCameraSlot(1);

  let sessions = harness.window.dumpNvrMaximizeMediaSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].slot, 0);
  assert.equal(sessions[0].completionReason, "replaced");
  assert.equal(card._activeMaximizeMediaSession.slot, 1);

  secondVideo.remove();
  harness.advanceTime(250);

  sessions = harness.window.dumpNvrMaximizeMediaSessions();
  assert.equal(sessions.length, 2);
  assert.equal(sessions[1].slot, 1);
  assert.equal(sessions[1].completionReason, "disconnected");
  assert.equal(card._activeMaximizeMediaSession, null);
});

test("maximize media-session history retains only the latest ten sessions", t => {
  const harness = setup(t);
  const card = harness.createCard();
  card.assignCamera("Front");
  harness.flushAnimationFrames();
  installAnonymousMediaTree(
    harness.window,
    harness.getPlayer(card, "Front"),
    { transport: "hls" }
  );

  for (let attempt = 0; attempt < 11; attempt += 1) {
    card.maximizeCameraSlot(0);
    card.restoreMaximizedCamera();
  }
  harness.advanceTime(8000);

  const sessions =
    harness.window.dumpNvrMaximizeMediaSessions();
  assert.equal(sessions.length, 10);
  assert.deepEqual(
    Array.from(sessions, session => session.sessionId),
    [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
  );
  assert.equal(sessions.at(-1).completionReason, "duration");
});

test("HA hui-image experiment renders all 11 cameras without provider media or duplicate presentations", t => {
  const harness = setup(t);
  const substreamEntities = new Map([
    ["camera.garage", "camera.lorex_mediaprofile_channel1_substream1_3"],
    ["camera.front_door", "camera.lorex_mediaprofile_channel1_substream1_9"],
    ["camera.front_entry", "camera.lorex_mediaprofile_channel1_substream1_1"],
    ["camera.drive_up", "camera.lorex_mediaprofile_channel1_substream1_10"],
    ["camera.drive_down", "camera.lorex_mediaprofile_channel1_substream1_4"],
    ["camera.side_gate", "camera.lorex_mediaprofile_channel1_substream1_11"],
    ["camera.ac", "camera.lorex_mediaprofile_channel1_substream1_6"],
    ["camera.patio", "camera.lorex_mediaprofile_channel1_substream1_5"],
    ["camera.backyard", "camera.lorex_mediaprofile_channel1_substream1_2"],
    ["camera.fireplace", "camera.lorex_mediaprofile_channel1_substream1_8"],
    ["camera.patio_roof", "camera.lorex_mediaprofile_channel1_substream1_7"]
  ]);
  const mainstreamEntities = new Map([
    ["camera.garage", "camera.garage_garage_camera_lorex_mediaprofile_channel1_mainstream"],
    ["camera.front_door", "camera.frontyard_front_door_camera_lorex_mediaprofile_channel1_mainstream"],
    ["camera.front_entry", "camera.frontyard_front_entry_camera_mediaprofile_channel1_mainstream"],
    ["camera.drive_up", "camera.frontyard_drive_up_camera_lorex_mediaprofile_channel1_mainstream"],
    ["camera.drive_down", "camera.frontyard_drive_down_camera_lorex_mediaprofile_channel1_mainstream"],
    ["camera.side_gate", "camera.backyard_side_gate_camera_lorex_mediaprofile_channel1_mainstream"],
    ["camera.ac", "camera.backyard_ac_camera_lorex_mediaprofile_channel1_mainstream"],
    ["camera.patio", "camera.backyard_patio_camera_lorex_mediaprofile_channel1_mainstream"],
    ["camera.backyard", "camera.backyard_backyard_camera_lorex_mediaprofile_channel1_mainstream"],
    ["camera.fireplace", "camera.backyard_fireplace_camera_lorex_mediaprofile_channel1_mainstream"],
    ["camera.patio_roof", "camera.backyard_patio_roof_camera_lorex_mediaprofile_channel1_mainstream"]
  ]);
  const cameras = [...substreamEntities.keys()].map((entity, index) => ({
    name: `Camera ${index + 1}`,
    entity,
    active: true
  }));
  const hass = {
    states: Object.fromEntries(
      cameras.map(camera => [
        camera.entity,
        {
          state: "streaming",
          attributes: {
            camera_name: camera.entity.slice("camera.".length)
          }
        }
      ])
    )
  };
  const card = harness.createCard({ cameras, hass });

  card.selectLayout("4x4");
  cameras.forEach(camera => card.assignCamera(camera.name));
  harness.flushAnimationFrames();

  const identities = captureIdentities(
    harness,
    card,
    cameras.map(camera => camera.name)
  );
  const assertSingleHaPresentationPerCamera = () => {
    const images = [
      ...card.querySelectorAll("hui-image.nvr-live-camera")
    ];

    assert.equal(images.length, 11);
    assert.equal(card.querySelectorAll("nvr-go2rtc-video").length, 0);
    assert.equal(card.querySelectorAll("nvr-live-presentation").length, 0);
    assert.equal(card._providerPresentations.size, 0);
    assert.equal(harness.providerOpenCalls.length, 0);
    cameras.forEach(camera => {
      const image = harness.getPlayer(card, camera.name);
      assert.equal(image.localName, "hui-image");
      assert.equal(
        image.cameraImage,
        substreamEntities.get(camera.entity)
      );
      assert.equal(image.cameraView, "live");
      assert.equal(image.dataset.entity, camera.entity);
      assert.strictEqual(image.hass, hass);
      assert.equal(
        image.closest(".video-cell")
          .querySelector(".cell-camera-name")?.textContent,
        camera.name
      );
    });
  };

  assertSingleHaPresentationPerCamera();

  cameras.forEach(camera => {
    const image = harness.getPlayer(card, camera.name);
    const slot = card._assignedCameras.indexOf(camera.name);

    card.maximizeCameraSlot(slot);
    assert.strictEqual(harness.getPlayer(card, camera.name), image);
    assert.equal(
      image.cameraImage,
      mainstreamEntities.get(camera.entity)
    );
    assert.notEqual(image.cameraImage, camera.entity);
    card.restoreMaximizedCamera();
    assert.strictEqual(harness.getPlayer(card, camera.name), image);
    assert.equal(
      image.cameraImage,
      substreamEntities.get(camera.entity)
    );
  });

  const moved = identities.get("Camera 1");
  card.moveCameraBetweenSlots(0, 11);
  harness.flushAnimationFrames();
  assert.strictEqual(harness.getLogicalCell(card, 11), moved.cell);
  assertSingleHaPresentationPerCamera();

  card.maximizeCameraSlot(11);
  harness.flushAnimationFrames();
  assert.strictEqual(harness.getPlayer(card, "Camera 1"), moved.player);
  assert.equal(
    moved.player.cameraImage,
    mainstreamEntities.get("camera.garage")
  );
  card.restoreMaximizedCamera();
  harness.flushAnimationFrames();
  assert.strictEqual(harness.getPlayer(card, "Camera 1"), moved.player);
  assert.equal(
    moved.player.cameraImage,
    substreamEntities.get("camera.garage")
  );
  assertSingleHaPresentationPerCamera();

  card.repackAssignedCameras();
  harness.flushAnimationFrames();
  assertSingleHaPresentationPerCamera();
  assertIdentitiesUnchanged(
    harness,
    card,
    cameras.map(camera => camera.name),
    identities
  );
});

test("live-transition diagnostics document the ONVIF Main maximize source without rebuilding", t => {
  const harness = setup(t, {
    liveTransitionDiagnostics: true
  });
  const card = harness.createCard({
    cameras: [{
      name: "Garage",
      entity: "camera.garage",
      active: true
    }]
  });

  card.assignCamera("Garage");
  const image = harness.getPlayer(card, "Garage");
  const cell = image.closest(".video-cell");
  const sidebar = card.querySelector(".nvr-sidebar");
  const events = [];
  const originalInfo = harness.window.console.info;

  harness.window.console.info = (prefix, payload) => {
    if (prefix === "[NVR live transition]") {
      events.push(payload);
    }
  };
  t.after(() => {
    harness.window.console.info = originalInfo;
  });

  assert.equal(
    card.classifyLivePresentationEntity(image.cameraImage),
    "ONVIF_SUB1"
  );
  card.render = () => {
    throw new Error("maximize diagnostics must not render");
  };

  card.maximizeCameraSlot(0);

  assert.strictEqual(harness.getPlayer(card, "Garage"), image);
  assert.strictEqual(image.closest(".video-cell"), cell);
  assert.strictEqual(card.querySelector(".nvr-sidebar"), sidebar);
  assert.equal(
    image.cameraImage,
    "camera.garage_garage_camera_lorex_mediaprofile_channel1_mainstream"
  );
  assert.equal(
    card.classifyLivePresentationEntity(image.cameraImage),
    "ONVIF_MAIN"
  );
  assert.deepEqual(
    events.map(event => event.event),
    [
      "maximize-requested",
      "source-selected",
      "source-properties-changed",
      "source-property-confirmed",
      "media-signal-unavailable"
    ]
  );
  events.forEach(event => {
    assert.equal(event.camera, "Garage");
    assert.equal(event.slot, 0);
    assert.equal(
      event.fromEntity,
      "camera.lorex_mediaprofile_channel1_substream1_3"
    );
    assert.equal(
      event.toEntity,
      "camera.garage_garage_camera_lorex_mediaprofile_channel1_mainstream"
    );
    assert.equal(event.presentationState, "maximize");
    assert.equal(event.fromSourceType, "ONVIF_SUB1");
    assert.equal(event.toSourceType, "ONVIF_MAIN");
    assert.equal(event.sourceType, "ONVIF_MAIN");
    assert.equal(typeof event.timeMs, "number");
    assert.equal(typeof event.elapsedMs, "number");
  });

  events.length = 0;
  card.restoreMaximizedCamera();
  assert.strictEqual(harness.getPlayer(card, "Garage"), image);
  assert.equal(
    image.cameraImage,
    "camera.lorex_mediaprofile_channel1_substream1_3"
  );
  assert.equal(events[0].event, "restore-requested");
  events.forEach(event => {
    assert.equal(event.fromSourceType, "ONVIF_MAIN");
    assert.equal(event.toSourceType, "ONVIF_SUB1");
    assert.equal(event.sourceType, "ONVIF_SUB1");
  });
});

test("ONVIF registry discovery pairs profiles only by authoritative registry identity", async t => {
  const harness = setup(t);
  const calls = [];
  const registry = [
    {
      entity_id:
        "camera.lorex_mediaprofile_channel1_substream1_3",
      platform: "onvif",
      device_id: "garage-device",
      config_entry_id: "garage-entry",
      original_name: "Garage MediaProfile_Channel1_SubStream1"
    },
    {
      entity_id: "camera.garage_onvif_main",
      platform: "onvif",
      device_id: "garage-device",
      config_entry_id: "garage-entry",
      original_name: "Garage MediaProfile_Channel1_MainStream"
    },
    {
      entity_id: "camera.front_door_similar_main",
      platform: "onvif",
      device_id: "unrelated-device",
      config_entry_id: "unrelated-entry",
      original_name: "Garage MediaProfile_Channel1_MainStream"
    },
    {
      entity_id:
        "camera.lorex_mediaprofile_channel1_substream1_9",
      platform: "onvif",
      device_id: "front-door-device",
      config_entry_id: "front-door-entry",
      original_name:
        "Front Door MediaProfile_Channel1_SubStream1"
    }
  ];
  const hass = {
    states: {},
    async callWS(message) {
      calls.push(message);
      return registry;
    }
  };
  const card = harness.createCard({
    cameras: [
      { name: "Garage", entity: "camera.garage", active: true },
      {
        name: "Front Door",
        entity: "camera.front_door",
        active: true
      }
    ],
    hass
  });
  card.assignCamera("Garage");
  card.assignCamera("Front Door");
  const imagesBefore = [
    ...card.querySelectorAll("hui-image.nvr-live-camera")
  ];
  const sourcesBefore = imagesBefore.map(image => image.cameraImage);
  const originalInfo = harness.window.console.info;

  harness.window.console.info = () => {};
  t.after(() => {
    harness.window.console.info = originalInfo;
  });
  card.render = () => {
    throw new Error("registry discovery must not render");
  };

  const mappings = await card.discoverOnvifProfileMappings();
  const garage = mappings.find(mapping => {
    return mapping.frigateEntity === "camera.garage";
  });
  const frontDoor = mappings.find(mapping => {
    return mapping.frigateEntity === "camera.front_door";
  });

  const registryCalls = calls.filter(message => {
    return message.type === "config/entity_registry/list";
  });
  assert.equal(registryCalls.length, 1);
  assert.equal(garage.mainEntity, "camera.garage_onvif_main");
  assert.equal(garage.confidence, "authoritative");
  assert.equal(frontDoor.mainEntity, null);
  assert.equal(frontDoor.confidence, "unresolved");
  assert.equal(
    mappings.some(mapping => {
      return mapping.mainEntity ===
        "camera.front_door_similar_main";
    }),
    false
  );
  const imagesAfter = [
    ...card.querySelectorAll("hui-image.nvr-live-camera")
  ];
  assert.deepEqual(imagesAfter, imagesBefore);
  assert.deepEqual(
    imagesAfter.map(image => image.cameraImage),
    sourcesBefore
  );
});

test("HA hui-image experiment leaves an unmapped camera on its configured entity", t => {
  const harness = setup(t);
  const camera = {
    name: "Unmapped",
    entity: "camera.unmapped",
    active: true
  };
  const card = harness.createCard({ cameras: [camera] });

  card.assignCamera(camera.name);
  harness.flushAnimationFrames();

  const image = harness.getPlayer(card, camera.name);
  assert.equal(image.cameraImage, camera.entity);

  card.maximizeCameraSlot(0);
  card.restoreMaximizedCamera();
  harness.flushAnimationFrames();

  assert.strictEqual(harness.getPlayer(card, camera.name), image);
  assert.equal(image.cameraImage, camera.entity);
});

test("limited WebRTC experiment preserves included players and leaves excluded cameras inert", t => {
  const harness = setup(t, {
    useHaHuiImageExperiment: false
  });
  const cameras = [
    { name: "Garage", entity: "camera.garage", active: true },
    { name: "Front Door", entity: "camera.front_door", active: true },
    { name: "Drive Up", entity: "camera.drive_up", active: true }
  ];
  const excludedCamera = {
    name: "Not Configured",
    entity: "camera.not_configured",
    active: true
  };
  const createHass = () => ({
    states: {
      "camera.garage": {
        state: "streaming",
        attributes: { camera_name: "garage" }
      },
      "camera.front_door": {
        state: "streaming",
        attributes: { camera_name: "front_door" }
      },
      "camera.drive_up": {
        state: "streaming",
        attributes: { camera_name: "drive_up" }
      },
      "camera.not_configured": {
        state: "streaming",
        attributes: { camera_name: "not_configured" }
      }
    }
  });
  const card = harness.createCard({
    cameras: [...cameras, excludedCamera],
    hass: createHass()
  });

  card.assignCamera("Garage");
  card.assignCamera("Front Door");
  card.assignCamera("Drive Up");
  card.assignCamera("Not Configured");
  harness.flushAnimationFrames();

  const presentation = card.querySelector("nvr-go2rtc-video");
  const physicalCell = presentation.closest(".video-cell");
  const title = physicalCell.querySelector(".cell-camera-name");
  const playerIdentities = new Map(
    cameras.map(camera => [
      camera.name,
      harness.getPlayer(card, camera.name)
    ])
  );
  assert.equal(card.querySelectorAll("nvr-go2rtc-video").length, 3);
  assert.equal(card._providerPresentations.size, 3);
  assert.equal(harness.getPlayer(card, "Not Configured"), null);
  assert.equal(
    card.querySelector('[data-entity="camera.not_configured"]'),
    null
  );
  assert.deepEqual(
    cameras.map(camera =>
      harness.getPlayer(card, camera.name).dataset.stream
    ),
    ["garage", "front_door", "drive_up"]
  );
  cameras.forEach(camera => {
    const player = playerIdentities.get(camera.name);
    assert.equal(
      player.closest(".video-cell")
        .querySelector(".cell-camera-name")?.textContent,
      camera.name
    );
  });
  assert.equal(title?.textContent, "Garage");
  assert.equal(presentation.connectedCount, 1);
  assert.equal(presentation.disconnectedCount, 0);

  card.moveCameraBetweenSlots(0, 3);
  harness.flushAnimationFrames();
  assert.strictEqual(card.querySelector("nvr-go2rtc-video"), presentation);
  assert.strictEqual(presentation.closest(".video-cell"), physicalCell);
  assert.strictEqual(
    physicalCell.querySelector(".cell-camera-name"),
    title
  );
  assert.strictEqual(harness.getLogicalCell(card, 3), physicalCell);

  card.maximizeCameraSlot(3);
  harness.flushAnimationFrames();
  assert.ok(physicalCell.classList.contains("maximized-camera"));
  card.restoreMaximizedCamera();
  harness.flushAnimationFrames();
  assert.equal(physicalCell.classList.contains("maximized-camera"), false);

  card.repackAssignedCameras();
  harness.flushAnimationFrames();
  assert.strictEqual(card.querySelector("nvr-go2rtc-video"), presentation);
  assert.strictEqual(presentation.closest(".video-cell"), physicalCell);
  assert.equal(presentation.connectedCount, 1);
  assert.equal(presentation.disconnectedCount, 0);
  cameras.forEach(camera => {
    assert.strictEqual(
      harness.getPlayer(card, camera.name),
      playerIdentities.get(camera.name)
    );
  });

  card.hass = createHass();

  assert.equal(card._providerPresentations.size, 3);
  assert.strictEqual(card.querySelector("nvr-go2rtc-video"), presentation);
  assert.strictEqual(
    physicalCell.querySelector(".cell-camera-name"),
    title
  );
  assert.equal(harness.providerOpenCalls.length, 3);
  assert.equal(presentation.closeCount, 0);

  card.removeCameraFromSlot(Number(physicalCell.dataset.slot));

  assert.equal(presentation.closeCount, 1);
  assert.equal(harness.getPlayer(card, "Garage"), null);
  assert.strictEqual(
    harness.getPlayer(card, "Front Door"),
    playerIdentities.get("Front Door")
  );
  assert.strictEqual(
    harness.getPlayer(card, "Drive Up"),
    playerIdentities.get("Drive Up")
  );
});
