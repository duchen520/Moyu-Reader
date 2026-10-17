export interface MediaMetadataConfig {
  title: string;
  artist?: string;
  album?: string;
  artworkUrl?: string;
}

export interface MediaSessionHandlers {
  onPlay?: () => void;
  onPause?: () => void;
  onPreviousTrack?: () => void;
  onNextTrack?: () => void;
  onStop?: () => void;
  onSeekTo?: (details: MediaSessionActionDetails) => void;
}

const isMediaSessionSupported = typeof navigator !== 'undefined' && 'mediaSession' in navigator;

export function updateMediaSessionMetadata(config: MediaMetadataConfig) {
  if (!isMediaSessionSupported) return;
  try {
    const artwork: MediaImage[] = [];
    if (config.artworkUrl) {
      artwork.push({
        src: config.artworkUrl,
        sizes: '512x512',
        type: 'image/jpeg',
      });
    }

    navigator.mediaSession.metadata = new MediaMetadata({
      title: config.title || 'Tomato Reader',
      artist: config.artist || 'Tomato Reader',
      album: config.album || 'Tomato Reader',
      artwork,
    });
  } catch {
    /* ignore mediaSession metadata failure */
  }
}

export function setMediaSessionPlaybackState(state: 'none' | 'paused' | 'playing') {
  if (!isMediaSessionSupported) return;
  try {
    navigator.mediaSession.playbackState = state;
  } catch {
    /* ignore */
  }
}

export function setMediaSessionPosition(position: { duration: number; playbackRate?: number; position: number }) {
  if (!isMediaSessionSupported || !('setPositionState' in navigator.mediaSession)) return;
  try {
    if (
      Number.isFinite(position.duration) &&
      position.duration > 0 &&
      Number.isFinite(position.position) &&
      position.position >= 0 &&
      position.position <= position.duration
    ) {
      navigator.mediaSession.setPositionState({
        duration: position.duration,
        playbackRate: position.playbackRate ?? 1,
        position: position.position,
      });
    }
  } catch {
    /* ignore position errors */
  }
}

export function updateMediaSessionHandlers(handlers: MediaSessionHandlers) {
  if (!isMediaSessionSupported) return;

  const bind = (action: MediaSessionAction, handler?: (details: MediaSessionActionDetails) => void) => {
    try {
      if (handler) {
        navigator.mediaSession.setActionHandler(action, handler);
      } else {
        navigator.mediaSession.setActionHandler(action, null);
      }
    } catch {
      /* ignore action unsupported */
    }
  };

  bind('play', handlers.onPlay ? () => handlers.onPlay?.() : undefined);
  bind('pause', handlers.onPause ? () => handlers.onPause?.() : undefined);
  bind('previoustrack', handlers.onPreviousTrack ? () => handlers.onPreviousTrack?.() : undefined);
  bind('nexttrack', handlers.onNextTrack ? () => handlers.onNextTrack?.() : undefined);
  bind('stop', handlers.onStop ? () => handlers.onStop?.() : undefined);
  bind('seekto', handlers.onSeekTo ? details => handlers.onSeekTo?.(details) : undefined);
}

export function clearMediaSession() {
  if (!isMediaSessionSupported) return;
  try {
    navigator.mediaSession.playbackState = 'none';
    navigator.mediaSession.metadata = null;
    const actions: MediaSessionAction[] = ['play', 'pause', 'previoustrack', 'nexttrack', 'stop', 'seekto'];
    for (const action of actions) {
      try {
        navigator.mediaSession.setActionHandler(action, null);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}
