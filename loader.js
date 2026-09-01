const nvrLoadTimestamp = Date.now();

import(
  `/local/nvr-card/nvr-card.js?ts=${nvrLoadTimestamp}`
)
  .catch((error) => {
    console.error("Failed to load NVR card:", error);
  });
