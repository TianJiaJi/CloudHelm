/** Opt-in only: the legacy advanced identity entry point is hidden unless the
 * operator explicitly enables it for this desktop process. Normal root work
 * uses run_remote privilege=root and never needs this switch. Read at runner
 * construction so tests and process startup share one evaluation point. */
export function legacyRootSessionsEnabled(): boolean {
  return process.env.CLOUDHELM_LEGACY_ROOT_SESSIONS === '1';
}
