import {
  DEFAULT_RESOURCE_POLICY,
  assertStreamGateway,
  assertVideoEngine,
  selectTransports
} from "./contracts.js";

function widthOf(variant) {
  const width = variant.video?.width;
  return Number.isFinite(width) && width > 0 ? width : null;
}

/** Small, deterministic variant selector with one-boundary hysteresis. */
export function selectStreamVariant(
  variants,
  {
    qualityMode = DEFAULT_RESOURCE_POLICY.qualityMode,
    tileWidth = 0,
    devicePixelRatio = 1,
    customVariantId,
    previousVariant,
    hysteresis = 0.15
  } = {}
) {
  if (!variants.length) {
    throw new TypeError("At least one stream variant is required");
  }

  if (qualityMode === "custom") {
    return variants.find(variant => variant.id === customVariantId) ?? variants[0];
  }
  if (qualityMode === "main" || qualityMode === "sub") {
    return variants.find(variant => variant.role === qualityMode) ?? variants[0];
  }

  const target = Math.max(0, tileWidth * devicePixelRatio);
  const measured = variants
    .filter(variant => widthOf(variant) !== null)
    .sort((left, right) => widthOf(left) - widthOf(right));

  let selected;
  if (measured.length) {
    selected = measured.find(variant => widthOf(variant) >= target)
      ?? measured.at(-1);
  } else {
    selected = target <= 960
      ? variants.find(variant => variant.role === "sub") ?? variants[0]
      : variants.find(variant => variant.role === "main") ?? variants.at(-1);
  }

  if (previousVariant && previousVariant !== selected) {
    const previousWidth = widthOf(previousVariant);
    const selectedWidth = widthOf(selected);
    if (previousWidth && selectedWidth) {
      if (previousWidth < selectedWidth && target <= previousWidth * (1 + hysteresis)) {
        return previousVariant;
      }
      if (previousWidth > selectedWidth && target >= selectedWidth * (1 - hysteresis)) {
        return previousVariant;
      }
    }
  }

  return selected;
}

/** Pure count/quality planning. It never truncates visible assigned cameras. */
export function planVisiblePresentations(
  cameras,
  tileWidths,
  resourcePolicy = DEFAULT_RESOURCE_POLICY,
  previousVariants = new Map()
) {
  const visible = cameras.filter(camera => camera.visible && camera.assigned);
  const requested = resourcePolicy.liveMode === "selected-and-visible"
    ? visible.filter(camera => camera.selected)
    : resourcePolicy.liveMode === "custom" &&
        typeof resourcePolicy.includeCamera === "function"
      ? visible.filter(resourcePolicy.includeCamera)
      : visible;
  return requested.map(camera => ({
    camera,
    variant: selectStreamVariant(camera.descriptor.variants, {
      qualityMode: resourcePolicy.qualityMode,
      tileWidth: tileWidths.get(camera.descriptor.id) ?? 0,
      customVariantId: resourcePolicy.customVariantId,
      previousVariant: previousVariants.get(camera.descriptor.id)
    })
  }));
}

/**
 * Minimal controller for one persistent physical cell. It owns presentation
 * handoff only; the grid retains the cell and all assignment semantics.
 */
export class CameraPresentationController {
  constructor({ host, gateway, engine, transportPolicy }) {
    this.host = host;
    this.gateway = assertStreamGateway(gateway);
    this.engine = assertVideoEngine(engine);
    this.transportPolicy = transportPolicy;
    this.current = null;
    this.engine.attach(host);
  }

  async present(camera, variant, options = {}) {
    if (
      this.current?.cameraId === camera.id &&
      this.current.variant.id === variant.id &&
      this.engine.health().status === "healthy"
    ) {
      return this.current.session;
    }

    const descriptor = await this.gateway.resolve(variant.source, {
      cameraId: camera.id,
      variantId: variant.id
    });
    const transportOrder = selectTransports(
      this.transportPolicy,
      Object.keys(descriptor.transports)
    );
    const old = this.current;
    const session = old
      ? await this.engine.switchSource(descriptor, {
          ...options,
          transportOrder,
          preserveCurrentSurface: true
        })
      : await this.engine.open(descriptor, { ...options, transportOrder });

    await session.firstFrame;
    this.current = { cameraId: camera.id, variant, descriptor, session };

    if (old) {
      await old.session.destroy();
      await this.gateway.release(old.descriptor.handle);
    }
    return session;
  }

  async recover() {
    if (!this.current) return null;
    const { cameraId, variant } = this.current;
    const camera = { id: cameraId };
    const failed = this.current;
    this.current = null;
    const next = await this.present(camera, variant, { recovery: true });
    await failed.session.destroy();
    await this.gateway.release(failed.descriptor.handle);
    return next;
  }

  setVisible(visible) {
    this.engine.setVisible(visible);
  }

  async destroy() {
    const current = this.current;
    this.current = null;
    if (current) {
      await current.session.destroy();
      await this.gateway.release(current.descriptor.handle);
    }
    await this.engine.destroy();
  }
}

/** Deterministic, transport-independent presented-frame health state. */
export class VideoHealthMonitor {
  constructor({ suspectAfterMs = 2000, stallAfterMs = 4000 } = {}) {
    this.suspectAfterMs = suspectAfterMs;
    this.stallAfterMs = stallAfterMs;
    this.lastProgressAt = null;
    this.lastEvidence = null;
    this.status = "starting";
  }

  observe(sample) {
    if (
      !sample.playbackExpected ||
      !sample.visible ||
      !sample.documentVisible ||
      sample.pausedByPolicy ||
      sample.ended ||
      sample.seeking
    ) {
      this.status = "intentionally-idle";
      this.lastProgressAt = sample.now;
      this.lastEvidence = null;
      return this.health();
    }

    const evidence = [
      sample.presentedFrames,
      sample.currentTime,
      sample.totalVideoFrames
    ];
    const progressed =
      this.lastEvidence === null ||
      evidence.some((value, index) =>
        Number.isFinite(value) && value > (this.lastEvidence[index] ?? -Infinity)
      );

    if (progressed) {
      this.lastProgressAt = sample.now;
      this.lastEvidence = evidence;
      this.status = "healthy";
      return this.health();
    }

    const idleFor = sample.now - this.lastProgressAt;
    this.status = idleFor >= this.stallAfterMs
      ? "stalled"
      : idleFor >= this.suspectAfterMs
        ? "suspected-stall"
        : "healthy";
    return this.health();
  }

  health() {
    return Object.freeze({
      status: this.status,
      lastProgressAt: this.lastProgressAt
    });
  }
}
