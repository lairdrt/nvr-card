# nvr-card
Home Assistant Network Video Recorder control card

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

- `timeout`: inactivity period in seconds.
- `fade_duration`: seconds used for the bounded brightness fade.
- `normal_brightness` and `dim_brightness`: brightness levels from 0 through 255.
- `notify_service`: notification action for the device that accepts Home Assistant Companion brightness and display commands.

To find the Companion action, go to **Settings -> Tools -> Actions**, search for `mobile_app`, and choose **Send a notification via <device>**. The action will look like `notify.mobile_app_sm_x30`. The configured endpoint must support the Companion brightness and display commands; the card does not discover or infer the correct device.

When enabled, NVR Card disables Android automatic brightness, enables Companion **Keep screen on**, establishes `normal_brightness`, and then manages inactivity dimming. Android may require the Home Assistant Companion permission **Allow this app to change system settings**. On the tested Galaxy tablet, `dim_brightness: 0` selects minimum brightness rather than turning the display off; use `1` or another small value if preferred.

If `auto_dim` is omitted, disabled, or invalid, the feature does not take display ownership or install activity tracking. A failed notify action disables auto-dim for that exact configuration after one warning. Correcting the YAML creates a fresh configuration and tries only the new endpoint.

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
