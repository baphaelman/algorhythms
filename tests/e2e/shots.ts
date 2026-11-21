import { mkdirSync } from 'node:fs';

/** Debug screenshots for humans: written only when ALGORHYTHMS_SHOTS_DIR is set. */
export async function shot(
  target: { screenshot(o: { path: string }): Promise<unknown> },
  name: string,
): Promise<void> {
  const dir = process.env.ALGORHYTHMS_SHOTS_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await target.screenshot({ path: `${dir}/${name}` });
}
