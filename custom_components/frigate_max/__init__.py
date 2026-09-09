"""Minimal YAML-loaded FrigateMax Prototype 0 integration."""

from __future__ import annotations

import voluptuous as vol

from homeassistant.const import CONF_PASSWORD, CONF_URL, CONF_USERNAME, CONF_VERIFY_SSL
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .client import FrigateProbeClient
from .websocket_api import async_register

DOMAIN = "frigate_max"

CONFIG_SCHEMA = vol.Schema(
    {
        vol.Optional(DOMAIN): vol.Schema(
            {
                vol.Required(CONF_URL): cv.url,
                vol.Required(CONF_USERNAME): cv.string,
                vol.Required(CONF_PASSWORD): cv.string,
                vol.Optional(CONF_VERIFY_SSL, default=True): cv.boolean,
            }
        )
    },
    extra=vol.ALLOW_EXTRA,
)


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Load the bounded probe from temporary YAML configuration."""
    if DOMAIN not in config:
        return True
    probe_config = config[DOMAIN]
    hass.data[DOMAIN] = FrigateProbeClient(
        async_get_clientsession(hass),
        probe_config[CONF_URL],
        probe_config[CONF_USERNAME],
        probe_config[CONF_PASSWORD],
        probe_config[CONF_VERIFY_SSL],
    )
    async_register(hass)
    return True
