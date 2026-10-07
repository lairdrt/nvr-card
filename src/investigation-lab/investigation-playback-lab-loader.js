const investigationLabLoadTimestamp = Date.now();

import(`/local/nvr-card/src/investigation-lab/investigation-playback-lab.js?ts=${investigationLabLoadTimestamp}`)
  .catch(error => {
    console.error("Failed to load Investigation Playback Lab:", error);
  });
