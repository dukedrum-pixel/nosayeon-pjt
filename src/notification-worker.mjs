import { deliverResultNotifications } from './result-notifications.mjs';

export function startNotificationWorker({ backend, mailer, configuration, onResult = () => {}, intervalMs = 60000 }) {
  if (!configuration) return () => {};
  if (!Number.isInteger(intervalMs) || intervalMs < 60000) throw new Error('invalid_notification_interval');
  let running = false, stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const summary = await deliverResultNotifications({ backend, mailer, configuration });
      if (summary.checked) onResult(summary);
    } catch { onResult({ status: 'failed' }); }
    finally { running = false; }
  };
  // Newly pending rows only. Failed/sending/unknown rows are never candidates.
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}
