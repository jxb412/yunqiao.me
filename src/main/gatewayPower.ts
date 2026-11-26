import type { powerSaveBlocker } from 'electron';
import type { Settings } from '../core/store/types.js';

/** One Electron power request per shared desktop gateway, including while its window is in the tray. */
export function createGatewayPowerPolicy(blocker: Pick<typeof powerSaveBlocker, 'start' | 'stop'>) {
  let id: number | undefined;
  return (settings: Pick<Settings, 'lanShare' | 'keepAwakeWhileSharing'>, gateway?: { running: boolean; host: string }) => {
    const active = settings.keepAwakeWhileSharing === true && settings.lanShare === true && gateway?.running
      && (gateway.host === '0.0.0.0' || gateway.host === '::');
    if (active && id === undefined) {
      id = blocker.start('prevent-app-suspension');
    } else if (!active && id !== undefined) {
      blocker.stop(id);
      id = undefined;
    }
  };
}
