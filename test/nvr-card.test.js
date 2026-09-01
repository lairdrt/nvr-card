import assert from "node:assert/strict";
import test from "node:test";

import {
  createTestHarness
} from "./helpers/nvr-card-harness.js";

function setup(t) {
  const harness = createTestHarness();
  t.after(() => harness.close());
  return harness;
}

function createHassWithCameraNames(harness, cameras, cameraNames) {
  const hass = harness.createHass(cameras);
  Object.entries(cameraNames).forEach(([entity, cameraName]) => {
    hass.states[entity].attributes.camera_name = cameraName;
  });
  return hass;
}

function assignments(card) {
  return Array.from(card._assignedCameras);
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
  const harness = setup(t);
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
  const harness = setup(t);
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
  const harness = setup(t);
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
    ["cameraImage", "hass", "config", "state"].forEach(property => {
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

test("Stage 2B preserves the safely mapped presentation through grid operations", t => {
  const harness = setup(t);
  const cameras = [
    { name: "Garage Display", entity: "camera.garage", active: true },
    { name: "Other", entity: "camera.other", active: true }
  ];
  const card = harness.createCard({
    cameras,
    hass: createHassWithCameraNames(
      harness,
      cameras,
      { "camera.garage": "garage" }
    )
  });

  card.assignCamera("Garage Display");
  card.assignCamera("Other");
  harness.flushAnimationFrames();

  const presentation = harness.getPlayer(card, "Garage Display");
  const physicalCell = presentation.closest(".video-cell");
  const otherPlayer = harness.getPlayer(card, "Other");
  assert.equal(card.querySelectorAll("nvr-live-presentation").length, 1);
  assert.equal(presentation._liveConfig.sourceId, "garage");
  assert.equal(
    physicalCell.querySelector(".cell-camera-name").textContent,
    "Garage Display"
  );
  assert.ok(otherPlayer);
  assert.equal(presentation.startCount, 1);
  assert.equal(presentation.connectedCount, 1);
  assert.equal(presentation.disconnectedCount, 0);

  card.moveCameraBetweenSlots(0, 3);
  harness.flushAnimationFrames();
  assert.strictEqual(harness.getPlayer(card, "Garage Display"), presentation);
  assert.strictEqual(presentation.closest(".video-cell"), physicalCell);
  assert.strictEqual(harness.getLogicalCell(card, 3), physicalCell);

  card.maximizeCameraSlot(3);
  harness.flushAnimationFrames();
  assert.ok(physicalCell.classList.contains("maximized-camera"));
  card.restoreMaximizedCamera();
  harness.flushAnimationFrames();
  assert.equal(physicalCell.classList.contains("maximized-camera"), false);

  card.repackAssignedCameras();
  harness.flushAnimationFrames();
  assert.strictEqual(harness.getPlayer(card, "Garage Display"), presentation);
  assert.strictEqual(presentation.closest(".video-cell"), physicalCell);
  assert.equal(presentation.startCount, 1);
  assert.equal(presentation.connectedCount, 1);
  assert.equal(presentation.disconnectedCount, 0);
  assert.strictEqual(harness.getPlayer(card, "Other"), otherPlayer);
});

test("runtime camera_name controls Stage 2A routing and missing metadata falls back", t => {
  const harness = setup(t);
  const cameras = [
    { name: "gArAgE Main Display", entity: "camera.garage", active: true },
    { name: "Drive Up Friendly Name", entity: "camera.drive_up", active: true },
    { name: "Missing Runtime ID", entity: "camera.unknown", active: true }
  ];
  const card = harness.createCard({
    cameras,
    hass: createHassWithCameraNames(harness, cameras, {
      "camera.garage": "garage",
      "camera.drive_up": "drive_up_main_exact"
    })
  });
  cameras.forEach(camera => card.assignCamera(camera.name));
  harness.flushAnimationFrames();

  assert.equal(card.querySelectorAll("nvr-live-presentation").length, 2);
  const presentations = [
    ["gArAgE Main Display", "garage"],
    ["Drive Up Friendly Name", "drive_up_main_exact"]
  ].map(([name, sourceId]) => {
    const presentation = harness.getPlayer(card, name);
    assert.equal(presentation.localName, "nvr-live-presentation");
    assert.equal(presentation._liveConfig.sourceId, sourceId);
    assert.equal(presentation.connectedCount, 1);
    assert.equal(presentation.disconnectedCount, 0);
    return presentation;
  });
  assert.equal(new Set(presentations).size, 2);
  const fallback = harness.getPlayer(card, "Missing Runtime ID");
  assert.equal(fallback.localName, "hui-image");
  assert.equal(fallback.dataset.entity, "camera.unknown");
});

test("later camera_name metadata promotes only the legacy assigned cell", t => {
  const harness = setup(t);
  const cameras = [
    { name: "Garage Display", entity: "camera.garage", active: true }
  ];
  const initialHass = harness.createHass(cameras);
  const card = harness.createCard({ cameras, hass: initialHass });

  card.assignCamera("Garage Display");
  harness.flushAnimationFrames();

  const fallback = harness.getPlayer(card, "Garage Display");
  const physicalCell = fallback.closest(".video-cell");
  assert.equal(fallback.localName, "hui-image");

  const liveHass = createHassWithCameraNames(
    harness,
    cameras,
    { "camera.garage": "garage" }
  );
  card.hass = liveHass;
  harness.flushAnimationFrames();

  const presentation = harness.getPlayer(card, "Garage Display");
  assert.equal(presentation.localName, "nvr-live-presentation");
  assert.equal(presentation._liveConfig.sourceId, "garage");
  assert.strictEqual(presentation.closest(".video-cell"), physicalCell);
  assert.equal(presentation.connectedCount, 1);
  assert.equal(presentation.disconnectedCount, 0);

  card.hass = createHassWithCameraNames(
    harness,
    cameras,
    { "camera.garage": "garage" }
  );
  harness.flushAnimationFrames();

  assert.strictEqual(
    harness.getPlayer(card, "Garage Display"),
    presentation
  );
  assert.strictEqual(presentation.closest(".video-cell"), physicalCell);
  assert.equal(presentation.connectedCount, 1);
  assert.equal(presentation.disconnectedCount, 0);
});

test("Stage 2B camera-list drag assigns an unassigned camera to the viewing area", t => {
  const harness = setup(t);
  const cameras = [
    { name: "garage", entity: "camera.garage", active: true },
    { name: "Front Door", entity: "camera.front_door", active: true }
  ];
  const card = harness.createCard({
    cameras,
    hass: createHassWithCameraNames(
      harness,
      cameras,
      { "camera.garage": "garage" }
    )
  });
  const values = new Map();
  const dataTransfer = {
    types: [],
    effectAllowed: "none",
    dropEffect: "none",
    setData(type, value) {
      values.set(type, value);
      if (!this.types.includes(type)) this.types.push(type);
    },
    getData(type) {
      return values.get(type) ?? "";
    }
  };
  const dispatchDrag = (target, type) => {
    const event = new harness.window.Event(type, {
      bubbles: true,
      cancelable: true
    });
    Object.defineProperty(event, "dataTransfer", {
      value: dataTransfer
    });
    target.dispatchEvent(event);
    return event;
  };

  const cameraItem = card.querySelector(
    '.camera-item[data-camera="garage"]'
  );
  const targetCell = harness.getLogicalCell(card, 1);
  dispatchDrag(cameraItem, "dragstart");
  const dragOver = dispatchDrag(targetCell, "dragover");
  const drop = dispatchDrag(targetCell, "drop");
  harness.flushAnimationFrames();

  assert.equal(dragOver.defaultPrevented, true);
  assert.equal(drop.defaultPrevented, true);
  assert.equal(card._assignedCameras[1], "garage");
  const presentation = harness.getPlayer(card, "garage");
  assert.strictEqual(presentation.closest(".video-cell"), targetCell);
  assert.equal(presentation._liveConfig.cameraId, "garage");
  assert.equal(presentation._liveConfig.sourceId, "garage");
  assert.equal(targetCell.querySelector(".cell-camera-name").textContent, "garage");
});

test("Stage 2B click-target assigns and fully renders a safely mapped camera", t => {
  const harness = setup(t);
  const cameras = [
    { name: "garage", entity: "camera.garage", active: true }
  ];
  const card = harness.createCard({
    cameras,
    hass: createHassWithCameraNames(
      harness,
      cameras,
      { "camera.garage": "garage" }
    )
  });
  const cameraItem = card.querySelector(
    '.camera-item[data-camera="garage"]'
  );
  const targetCell = harness.getLogicalCell(card, 2);

  cameraItem.dispatchEvent(new harness.window.MouseEvent("click", {
    bubbles: true
  }));
  assert.equal(card._selectedCamera, "garage");

  targetCell.dispatchEvent(new harness.window.MouseEvent("click", {
    bubbles: true,
    detail: 1
  }));
  harness.flushAnimationFrames();

  assert.equal(card._selectedCamera, null);
  assert.equal(card._assignedCameras[2], "garage");
  assert.equal(targetCell.querySelector(".empty-cell-center"), null);
  assert.equal(targetCell.querySelector(".cell-camera-name").textContent, "garage");
  const presentation = targetCell.querySelector("nvr-live-presentation");
  assert.ok(presentation);
  assert.equal(presentation._liveConfig.cameraId, "garage");
  assert.equal(presentation._liveConfig.sourceId, "garage");
  assert.equal(presentation.connectedCount, 1);
  assert.equal(presentation.startCount, 1);
});
