/**
 * Node module-resolution hook for running src/ TypeScript directly (Node 22 strips types natively).
 * Our sources import siblings without an extension ('./ease'), which Node's ESM resolver rejects;
 * this retries such specifiers with '.ts'. Used by the no-GC test's child process.
 *
 * Synchronous (module.registerHooks), so it runs on the main thread: the off-thread hooks of
 * module.register() run in a second V8 isolate, whose own GCs (the memory reducer's, about 8 s
 * after start) would show up in the child's --trace-gc output.
 */
export function resolve(specifier, context, nextResolve) {
  try {
    return nextResolve(specifier, context);
  } catch (error) {
    const relative = specifier.startsWith('.') || specifier.startsWith('/');
    if (relative && !/\.[cm]?[jt]s$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw error;
  }
}
