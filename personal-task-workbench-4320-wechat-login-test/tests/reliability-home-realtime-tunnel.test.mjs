// Run the actual mini-program receiver, scoped cache and app lifecycle through
// a real local relay, authenticated tunnel, HTTP server and notification socket.
// The model/WeChat runtime are synthetic; this is not a native/device acceptance.
process.env.MAINLINE_TEST_TUNNEL = 'true';
await import('./reliability-home-realtime.test.mjs');
