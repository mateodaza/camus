// Hermetic test utility: hold the same Node-owned lock lease as production.
import { withCalibrationLock } from './lib/calibration-workspace.mjs';

export async function holdTestCalibrationLock(paths) {
  let release;
  const acquired = new Promise((resolve, reject) => {
    withCalibrationLock(paths, async () => {
      resolve();
      await new Promise((done) => { release = done; });
    }).catch(reject);
  });
  await acquired;
  return () => release();
}
