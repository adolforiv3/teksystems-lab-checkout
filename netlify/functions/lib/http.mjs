export function json(data, status = 200, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store, no-cache, must-revalidate",
      ...extraHeaders,
    },
  });
}

// Wraps a Netlify Function handler so nothing can ever escape as a raw
// platform-level crash. Every route already has its own try/catch for
// *expected* failures (ApiError for business-rule violations,
// ConcurrentWriteError for write contention) - but each of those re-throws
// anything it doesn't recognize, on the assumption that "unexpected" means
// "let it surface." In practice, when it does escape, Netlify's runtime
// returns a bare 502 Bad Gateway with no body at all: the browser's network
// tab shows a status code and nothing else, which is exactly the dead end
// this app hit while tracking down the notes-save bug - a real error was
// happening, but there was no way to see what it actually said.
//
// This is the outermost safety net for exactly that case: a genuine bug, a
// dependency (e.g. the Blobs SDK) throwing a shape of error nobody
// anticipated, anything. It always converts that into a real JSON response
// carrying the actual error message, logged server-side too, so whatever
// happens is visible in the browser's console instead of vanishing into an
// opaque 502.
export function withErrorBoundary(handler) {
  return async (req) => {
    try {
      return await handler(req);
    } catch (err) {
      console.error(`unhandled error in ${req.method} ${req.url}:`, err);
      return json(
        { error: "internal error", detail: err && err.message ? String(err.message) : String(err) },
        500
      );
    }
  };
}
