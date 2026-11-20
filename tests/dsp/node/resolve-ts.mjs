/**
 * Node module-resolution hook for running src/ TypeScript directly (Node 22 strips types natively).
 * Our sources import siblings without an extension ('./ease'), which Node's ESM resolver rejects;
 * this retries such specifiers with '.ts'. Used by the no-GC test's child process.
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const relative = specifier.startsWith('.') || specifier.startsWith('/');
    if (relative && !/\.[cm]?[jt]s$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw error;
  }
}
