// Legacy compatibility helper for callers that explicitly import it.
//
// Normal Dola API entry points do not depend on this module. It validates only
// user-supplied runtime values and intentionally does not derive identifiers,
// mint tokens, inspect Cookie, access a browser, or make network requests.

const REQUIRED_API_CREDENTIALS = ['DOLA_COOKIE', 'DOLA_MS_TOKEN'];

export async function bootstrap() {
  const missing = REQUIRED_API_CREDENTIALS.filter((key) => !String(process.env[key] || '').trim());
  if (missing.length > 0) {
    throw new Error(`Dola API authentication is not configured: missing ${missing.join(', ')}.`);
  }

  return Object.fromEntries(REQUIRED_API_CREDENTIALS.map((key) => [key, process.env[key]]));
}