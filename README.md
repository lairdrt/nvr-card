# nvr-card
Home Assistant Network Video Recorder control card

## Camera live sources

`camera.entity` remains the logical/Frigate camera identity used by workspace state and Saved Views. Optional `camera.live.substream` selects the normal/grid HA live camera, and `camera.live.mainstream` selects the maximized HA live camera. Production ONVIF configurations use Sub1 for the grid and Main for maximize; Home Assistant still owns playback through the same `hui-image` presentation.

```yaml
cameras:
  - name: Garage
    entity: camera.garage
    active: true
    live:
      substream: camera.lorex_mediaprofile_channel1_substream1_3
      mainstream: camera.garage_garage_camera_lorex_mediaprofile_channel1_mainstream
```

`active` remains optional (default true). If `live` is supplied, it must be an object containing exactly both nonempty string fields shown above; surrounding source whitespace is trimmed. Without `live`, both modes fall back to `camera.entity`. There are no installation-specific JavaScript mappings or automatic profile substitutions. Add the corresponding Sub1/Main entities to each production camera's Lovelace YAML before deploying this migration. Live-mapping changes participate in normal camera configuration identity; auto-dim-only changes continue to preserve media.

## Tablet auto-dim

Auto-dim is optional and configured directly in the card's Lovelace YAML:

```yaml
auto_dim:
  enabled: true
  timeout: 300
  fade_duration: 8
  normal_brightness: 180
  dim_brightness: 0
  notify_service: notify.mobile_app_sm_x30
```

- `timeout`: inactivity period in seconds, clamped to 1..86400 (default 300).
- `fade_duration`: scheduled fade duration in seconds, clamped to 0..300 (default 8). Steps are serialized; HA request latency can extend the fade.
- `normal_brightness` and `dim_brightness`: brightness levels from 0 through 255 (defaults 180 and 0). Normal must exceed dim for an enabled configuration. Numeric strings remain supported; null, empty, and nonnumeric values use defaults.
- `notify_service`: notification action for the device that accepts Home Assistant Companion brightness and display commands.

To find the Companion action, go to **Settings -> Tools -> Actions**, search for `mobile_app`, and choose **Send a notification via <device>**. The action will look like `notify.mobile_app_sm_x30`. The configured endpoint must support the Companion brightness and display commands; the card does not discover or infer the correct device.

When enabled, NVR Card disables Android automatic brightness, enables Companion **Keep screen on**, establishes `normal_brightness`, and then manages inactivity dimming. Android may require the Home Assistant Companion permission **Allow this app to change system settings**. On the tested Galaxy tablet, `dim_brightness: 0` selects minimum brightness rather than turning the display off; use `1` or another small value if preferred.

Auto-dim is configured independently on each card; it has no device detection, shared runtime state, or persisted settings. Omitted/disabled configuration does not start ownership or activity tracking. Invalid configuration is blocked until corrected. Changing only `auto_dim` preserves camera media.

Startup and each usable reconnect/reattach run the ownership commands serially, then restore normal brightness. Inactivity starts only after that HA command succeeds. Wake cancels unsent fade work, waits behind any request already in flight, and restores normal brightness before restarting inactivity. The wake gesture and its matching click are consumed; suppression clears on cancellation, expires after release, and cannot remain waiting indefinitely for an unrelated click.

Disconnect/detach cancels pending work. Service failures suspend auto-dim without permanently blocking the configuration. It resumes on a genuine reconnect/reattach or a deliberate pointer/click recovery gesture, with no polling or automatic retry loop. A 15-second command/wait deadline suspends a stuck operation. An unresolved service request remains a serialization barrier until it settles; the card cannot cancel an already-delivered notification or safely overlap it with another request.

Disabling an active configuration while connected makes one bounded best-effort restoration to its previous normal brightness. It does not restore Android automatic-brightness or keep-screen-on settings, whose previous values are unknown. Logs report HA command completion and logical transitions, not observed physical brightness.

## Terminal stream recovery

Optional recovery uses the same configurable frame-silence window for a previously LIVE presentation and a newly attached presentation that has never produced its first genuine frame:

```yaml
live_recovery:
  enabled: true
  stall_after: 10
  reconnect_after: 360
```

Omitting `live_recovery` disables terminal recovery and retains the default 10-second passive stall window. Only boolean `enabled: true` enables terminal recovery. `stall_after` controls passive stall detection even when terminal recovery is disabled.

- `stall_after`: seconds without a genuine current-generation frame before STALLED. Defaults to 10; positive numbers and numeric strings are clamped to 5..300 seconds.
- `reconnect_after`: additional seconds of continuous STALLED time before the one-shot replacement. Defaults to 360; positive numbers and numeric strings are clamped to 60..86400 seconds.

Omitted or invalid durations (including zero, negative values, booleans, empty strings, and nonfinite numbers) use their respective defaults. With the example above, replacement occurs about 370 seconds after the last genuine frame, or after attachment when no frame arrives.

Each stall episode permits one replacement of the affected `hui-image`, retaining its cell, frame, UI, selected Sub1/Main source, and maximized fitting. The `mdi:loading` stalled spinner becomes an `mdi:sync` icon when recovery starts, retaining the same original white color, rotation, size, opacity, and `live_status.position` corner. Only an observed frame from the current presentation clears RECONNECTING and permits a future independent stall to recover. There is no retry loop or transport control.

Frames reset the stall window and cancel pending recovery. Hidden time is excluded: returning to visibility starts a fresh `stall_after` observation window. Source changes and disconnect cancel pending timers; reattach also starts a fresh observation window, including when no first frame has arrived. Recovery configuration changes preserve media. A changed `stall_after` recalculates a pending stall deadline from the current observation window's start; an already STALLED presentation retains its actual stall transition time. `reconnect_after` continues to measure from that transition, not from the configuration update.
