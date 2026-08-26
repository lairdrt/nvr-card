import(`/local/nvr-card/nvr-card.js?ts=${Date.now()}`).catch((error) => {
  console.error("Failed to load NVR card:", error);
});
