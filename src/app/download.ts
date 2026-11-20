/** Hands a Blob to the browser as a download (an anchor with a `download` name). */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  // Give the browser time to start reading the Blob before releasing it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
