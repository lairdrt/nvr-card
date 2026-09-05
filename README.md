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
